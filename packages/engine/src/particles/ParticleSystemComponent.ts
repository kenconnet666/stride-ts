/**
 * 粒子系统组件（Stride 的 ParticleSystemComponent）：实体上的一个粒子系统，加上整体的颜色和速度。场景里的组件由
 * ContentManager 加上并 load；脚本里 `entity.require(ParticleSystemComponent).particleSystem.play()` 这样控制。
 *
 * 粒子在变换更新之后模拟（`game.particles`，Stride 的 ParticleSystemSimulationProcessor，它在 Draw 里按绘制的时间做）：
 * 粒子系统的位置、旋转按实体的世界矩阵，统一缩放取世界矩阵 X 轴的长度。
 * 和 Stride 不同：组件的 Control（ResetSeconds、播放状态）只在 Stride 的编辑器里起作用，这里不导入运行时。
 */
import type { ParticleModuleFile } from '../content/format';
import type { Game } from '../engine/Game';
import { DEPTH_FORMAT } from '../rendering/ForwardRenderer';
import type { RenderView } from '../rendering/RenderSystem';
import { Transform, transformSlot } from '../engine/transform';
import { StartupScript } from '../engine/scripts';
import { Matrix } from '../data/Matrix';
import { value, type ParticleContext } from './modules';
import { ParticleRenderer } from './ParticleRenderer';
import { ParticleSystem } from './ParticleSystem';
import type { ParticleEmitter, ParticleSimulation } from './ParticleEmitter';
import { GpuEmitter } from './GpuEmitter';
import { gpuUnsupported } from './gpuKernel';
import { UpdaterWind } from './updaters';

/** simulation 是 auto 时，粒子池至少这么大的发射器放到 GPU 上（小的在 CPU 上更省：不用派发、不用排序的固定开销）。 */
export const AUTO_GPU_CAPACITY = 4096;

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
 *
 * 发射器可以放到 GPU 上模拟（particles/GpuEmitter.ts）：每帧先定每个发射器在哪（emitter.simulation，是 auto 时看这里的 simulation），
 * CPU 的照常 update；GPU 的 update 只算生成几个，之后在一个计算通道里派发模拟、按深度排序（排序用的相机是上一帧的主视图）。
 * 换地方时从头模拟。
 */
export class ParticleSystems {
  readonly #components = new Set<ParticleSystemComponent>();
  #renderer: ParticleRenderer | undefined;
  #pickingRenderer: ParticleRenderer | undefined;
  /**
   * 发射器的 simulation 是 auto 时放在哪（调试、对比用，`game.particles.simulation = 'gpu'`）：auto 是能放到 GPU 上、粒子池
   * 至少 AUTO_GPU_CAPACITY 个的放到 GPU 上，cpu、gpu 是都放到那边（gpu 时放不了的仍在 CPU 上）。
   */
  simulation: ParticleSimulation = 'auto';
  readonly #gpu = new Map<ParticleEmitter, { readonly state: GpuEmitter; readonly generation: number }>();
  readonly #warned = new Set<ParticleEmitter>();
  readonly #gpuOf = (emitter: ParticleEmitter): GpuEmitter | undefined => this.#gpu.get(emitter)?.state;

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
    this.#renderer ??= new ParticleRenderer(game.graphicsDevice.device, game.renderSystem.resources, { gpu: this.#gpuOf });
    this.#renderer.draw(pass, view, this.components, colorFormat, depthFormat, game.updateTime.total);
  }

  /** @internal 画进点选的编号缓冲（ScenePicker，颜色格式 r32uint）：写粒子系统所在实体的变换槽位加一。 */
  drawPicking(game: Game, pass: GPURenderPassEncoder, view: RenderView, colorFormat: GPUTextureFormat, depthFormat: GPUTextureFormat): void {
    if (this.#components.size === 0) return;
    this.#pickingRenderer ??= new ParticleRenderer(game.graphicsDevice.device, game.renderSystem.resources, { pickId: (component) => transformSlot(component.entity) + 1, gpu: this.#gpuOf });
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
    for (const { state } of this.#gpu.values()) state.destroy();
    this.#gpu.clear();
    this.#components.clear();
  }

  /** 发射器在 GPU 上的状态（还没建、不在 GPU 上时是 undefined）。 */
  gpuEmitter(emitter: ParticleEmitter): GpuEmitter | undefined {
    return this.#gpuOf(emitter);
  }

  /** @internal Game 每帧在变换更新之后调用。 */
  update(dt: number): void {
    let game: Game | undefined;
    const live = new Set<ParticleEmitter>();
    for (const component of this.#components) {
      if (!component.enabled) continue;
      game ??= component.game;
      const device = gpuDevice(component.game);
      const system = component.particleSystem;
      for (const emitter of system.emitters) {
        this.#place(emitter, device);
        live.add(emitter);
        for (const updater of emitter.updaters) if (updater instanceof UpdaterWind) updater.field = component.game.wind;
      }
      const { translation, rotation, scale } = Matrix.decompose(component.entity.require(Transform).world);
      system.translation = translation;
      system.rotation = rotation;
      system.uniformScale = scale[0];
      system.update(dt * component.speed);
    }
    // 不在了的（组件移除、换场景）发射器的 GPU 缓冲还掉
    for (const [emitter, { state }] of this.#gpu) {
      if (live.has(emitter)) continue;
      state.destroy();
      this.#gpu.delete(emitter);
    }
    if (game) this.#simulateOnGpu(game, dt);
  }

  /** 定发射器在哪模拟；变了就从头模拟（GPU 的状态在 #simulateOnGpu 里按代数重建）。 */
  #place(emitter: ParticleEmitter, device: GPUDevice | undefined): void {
    const wanted = device !== undefined && this.#wantsGpu(emitter);
    if (wanted === emitter.onGpu) return;
    emitter.onGpu = wanted;
    emitter.resetSimulation();
    if (!wanted) {
      this.#gpu.get(emitter)?.state.destroy();
      this.#gpu.delete(emitter);
    }
  }

  #wantsGpu(emitter: ParticleEmitter): boolean {
    const mode = emitter.simulation === 'auto' ? this.simulation : emitter.simulation;
    if (mode === 'cpu') return false;
    const reason = gpuUnsupported(emitter);
    if (reason !== undefined) {
      if (emitter.simulation === 'gpu' && !this.#warned.has(emitter)) {
        this.#warned.add(emitter);
        console.warn(`[stride] particle emitter '${emitter.name}' asked for GPU simulation but stays on the CPU: ${reason}`);
      }
      return false;
    }
    return mode === 'gpu' || emitter.targetCapacity >= AUTO_GPU_CAPACITY;
  }

  /** GPU 上的发射器：一个计算通道里派发模拟，按深度排序的再排序。 */
  #simulateOnGpu(game: Game, dt: number): void {
    const device = gpuDevice(game);
    if (!device) return;
    const back = cameraBack(game);
    let pass: GPUComputePassEncoder | undefined;
    for (const component of this.#components) {
      const system = component.particleSystem;
      if (!component.enabled || system.isPaused) continue;
      for (const emitter of system.emitters) {
        if (!emitter.onGpu || !emitter.enabled) continue;
        const state = this.#stateFor(emitter, device);
        if (!state) continue;
        if (!pass) {
          const timestampWrites = game.graphicsDevice.profiler.passTimestamps('GPU particles');
          pass = game.graphicsDevice.frameEncoder.beginComputePass({ label: 'GPU particles', ...(timestampWrites ? { timestampWrites } : {}) });
        }
        state.simulate(pass, dt * component.speed, emitter.gpuSpawn, game.updateTime.total);
        emitter.gpuSpawn = 0;
        if (back && emitter.sortingPolicy === 'byDepth') state.sort(pass, back);
      }
    }
    pass?.end();
  }

  /** 发射器的 GPU 状态：没有、重新开始过模拟、粒子池的大小变了时重建。粒子池是 0 时没有。 */
  #stateFor(emitter: ParticleEmitter, device: GPUDevice): GpuEmitter | undefined {
    const entry = this.#gpu.get(emitter);
    const capacity = emitter.targetCapacity;
    if (entry && entry.generation === emitter.simulationGeneration && entry.state.capacity === Math.max(1, capacity)) return entry.state;
    entry?.state.destroy();
    this.#gpu.delete(emitter);
    if (capacity <= 0) return undefined;
    const state = new GpuEmitter(device, emitter, capacity, emitter.initialSeed);
    this.#gpu.set(emitter, { state, generation: emitter.simulationGeneration });
    return state;
  }
}

/** 游戏的 GPU 设备；还没 run（单测里）时是 undefined。 */
function gpuDevice(game: Game): GPUDevice | undefined {
  return (game.graphicsDevice as Game['graphicsDevice'] | undefined)?.device;
}

/** 主视图的相机朝后的方向（世界）；还没有主视图时是 undefined。 */
function cameraBack(game: Game): [number, number, number] | undefined {
  const view = (game.graphicsCompositor as Game['graphicsCompositor'] | undefined)?.mainView;
  const world = new Float32Array(16);
  if (!view || !Matrix.invert(world, view.view)) return undefined;
  return [world[8]!, world[9]!, world[10]!];
}
