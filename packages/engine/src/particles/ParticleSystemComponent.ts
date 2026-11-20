/**
 * 粒子系统组件（Stride 的 ParticleSystemComponent）：实体上的一个粒子系统，加上整体的颜色和速度。场景里的组件由
 * ContentManager 加上并 load；脚本里 `entity.require(ParticleSystemComponent).particleSystem.play()` 这样控制。
 *
 * 粒子在变换更新之后模拟（`game.particles`，Stride 的 ParticleSystemSimulationProcessor，它在 Draw 里按绘制的时间做）：
 * 粒子系统的位置、旋转按实体的世界矩阵，统一缩放取世界矩阵 X 轴的长度。
 * 和 Stride 不同：组件的 Control（ResetSeconds、播放状态）只在 Stride 的编辑器里起作用，这里不导入运行时。
 */
import type { ParticleModuleFile } from '../content/format';
import type { Game } from '../games/Game';
import { DEPTH_FORMAT } from '../rendering/ForwardRenderer';
import type { RenderView } from '../rendering/RenderSystem';
import { Transform, transformSlot } from '../engine/transform';
import { StartupScript } from '../engine/scripts';
import { Matrix } from '../mathematics/Matrix';
import { value, type ParticleContext } from './modules';
import { ParticleRenderer } from './ParticleRenderer';
import { ParticleSystem } from './ParticleSystem';

export class ParticleSystemComponent extends StartupScript {
  static override scriptName = 'ParticleSystemComponent';
  particleSystem = new ParticleSystem();
  /** 乘在所有粒子上的颜色（线性，预乘前）。 */
  color: [number, number, number, number] = [1, 1, 1, 1];
  /** 模拟的速度倍数。 */
  speed = 1;
  /** 渲染组（Stride 的 RenderGroup，0 到 31）：视图的掩码里没有这一组时不画。 */
  renderGroup = 0;
  /** load 用的文件和上下文，克隆时照着再建一个粒子系统。 */
  #loaded: readonly [file: ParticleModuleFile, context: ParticleContext | undefined] | undefined;

  /** 按导入的组件文件建粒子系统；context 给出贴图和场景里的实体。 */
  load(file: ParticleModuleFile, context?: ParticleContext): void {
    this.#loaded = [file, context];
    this.particleSystem = new ParticleSystem((file['particleSystem'] as ParticleModuleFile | undefined) ?? {}, context);
    this.color = [...value(file, 'color', [1, 1, 1, 1])] as [number, number, number, number];
    this.speed = value(file, 'speed', 1);
    // 导入的文件里是枚举的名字（group4）
    this.renderGroup = Number(/[0-9]+$/.exec(String(value<string | number>(file, 'renderGroup', 0)))?.[0] ?? 0);
  }

  /** 克隆的实体有自己的粒子系统（同样的设置，从头模拟），颜色和速度照抄现在的值。用代码建的粒子系统（没经过 load）不跟着。 */
  override cloneFrom(source: this): void {
    if (source.#loaded) this.load(...source.#loaded);
    this.color = [...source.color];
    this.speed = source.speed;
    this.renderGroup = source.renderGroup;
  }

  override start(): void {
    this.game.particles.add(this);
    this.disposables.defer(() => this.game.particles.remove(this));
  }
}

/**
 * 所有粒子系统（`game.particles`）：每帧变换更新之后模拟；在前向渲染器的透明阶段里画，合成器要粒子画在 UI 上面时
 * （UIParticles）在 UI 之后画进画面，和场景的深度比较。
 */
export class ParticleSystems {
  readonly #components = new Set<ParticleSystemComponent>();
  #renderer: ParticleRenderer | undefined;
  #pickingRenderer: ParticleRenderer | undefined;

  /** @internal ParticleSystemComponent 启动时登记。 */
  add(component: ParticleSystemComponent): void {
    this.#components.add(component);
  }

  /** @internal */
  remove(component: ParticleSystemComponent): void {
    this.#components.delete(component);
  }

  get components(): readonly ParticleSystemComponent[] {
    return [...this.#components];
  }

  /** @internal 画进 pass（前向渲染器的透明阶段）。 */
  draw(game: Game, pass: GPURenderPassEncoder, view: RenderView, colorFormat: GPUTextureFormat, depthFormat: GPUTextureFormat): void {
    this.#renderer ??= new ParticleRenderer(game.graphicsDevice.device, game.renderSystem.resources);
    this.#renderer.draw(pass, view, this.components, colorFormat, depthFormat, game.updateTime.total);
  }

  /** @internal 画进点选的编号缓冲（ScenePicker，颜色格式 r32uint）：写粒子系统所在实体的变换槽位加一。 */
  drawPicking(game: Game, pass: GPURenderPassEncoder, view: RenderView, colorFormat: GPUTextureFormat, depthFormat: GPUTextureFormat): void {
    if (this.#components.size === 0) return;
    this.#pickingRenderer ??= new ParticleRenderer(game.graphicsDevice.device, game.renderSystem.resources, { pickId: (component) => transformSlot(component.entity) + 1 });
    this.#pickingRenderer.draw(pass, view, this.components, colorFormat, depthFormat, game.updateTime.total);
  }

  /** @internal Game 在画完 UI 之后调用：合成器要粒子画在 UI 上面时画进后备缓冲。 */
  drawOverUI(game: Game): void {
    const compositor = game.graphicsCompositor;
    const view = compositor.mainView, depth = compositor.mainDepth;
    if (!compositor.particlesOverUI || !view || !depth || this.#components.size === 0) return;
    const device = game.graphicsDevice;
    const pass = device.frameEncoder.beginRenderPass({
      label: 'Particles over UI',
      colorAttachments: [{ view: device.currentBackBufferView(), loadOp: 'load', storeOp: 'store' }],
      depthStencilAttachment: { view: depth.createView(), depthReadOnly: true },
    });
    this.draw(game, pass, view, device.backBufferViewFormat, DEPTH_FORMAT);
    pass.end();
  }

  destroy(): void {
    this.#renderer?.destroy();
    this.#renderer = undefined;
    this.#pickingRenderer?.destroy();
    this.#pickingRenderer = undefined;
    this.#components.clear();
  }

  /** @internal Game 每帧在变换更新之后调用。 */
  update(dt: number): void {
    for (const component of this.#components) {
      if (!component.enabled) continue;
      const system = component.particleSystem;
      const { translation, rotation, scale } = Matrix.decompose(component.entity.require(Transform).world);
      system.translation = translation;
      system.rotation = rotation;
      system.uniformScale = scale[0];
      system.update(dt * component.speed);
    }
  }
}
