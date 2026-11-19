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
import { Transform } from '../engine/transform';
import { StartupScript } from '../engine/scripts';
import { Matrix } from '../mathematics/Matrix';
import type { Texture } from '../rendering/Texture';
import { value } from './modules';
import { ParticleRenderer } from './ParticleRenderer';
import { ParticleSystem } from './ParticleSystem';

export class ParticleSystemComponent extends StartupScript {
  static override scriptName = 'ParticleSystemComponent';
  particleSystem = new ParticleSystem();
  /** 乘在所有粒子上的颜色（线性，预乘前）。 */
  color: [number, number, number, number] = [1, 1, 1, 1];
  /** 模拟的速度倍数。 */
  speed = 1;

  /** 按导入的组件文件建粒子系统；textures 按内容路径给加载好的贴图。 */
  load(file: ParticleModuleFile, textures?: (path: string) => Texture | undefined): void {
    this.particleSystem = new ParticleSystem((file['particleSystem'] as ParticleModuleFile | undefined) ?? {}, textures);
    this.color = [...value(file, 'color', [1, 1, 1, 1])] as [number, number, number, number];
    this.speed = value(file, 'speed', 1);
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
    this.#renderer.draw(pass, view, this.components, colorFormat, depthFormat);
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
