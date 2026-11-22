/**
 * 离线渲染（成片导出的画面部分）：接管游戏的帧循环（Game.takeOverFrames，不等 requestAnimationFrame，能跑多快跑多快，窗口被挡住
 * 时也不慢），按固定的时间步一子帧一子帧地走，每个输出帧由 samples 个子帧平均而成——
 * 子帧在像素内抖动（Halton 序列，抗锯齿）、在快门开着的那段时间里均匀分布（真的运动模糊：物体、相机、粒子、动画都按各自
 * 的运动糊开）。画面按 width × height 画（和窗口无关），读回成 sRGB 的 RGBA 字节，交给编码器（VideoExport）或存成图片。
 *
 * 渲染期间：TAA、屏幕空间的运动模糊、FXAA 关掉（子帧已经做了它们的事；只有一个子帧时 FXAA 照旧），开始前的设置渲染完还原。
 * 子帧的时刻：第 i 帧的第 k 个子帧在 (i + shutter · (k + 0.5) / samples) / fps 秒（相对开始），快门为 0 时子帧都在帧的开头、
 * 只做抗锯齿。和 Stride 不同：Stride 没有离线渲染（录屏是实时的，帧率不稳时动作快慢不匀）。
 */
import type { Game } from '../engine/Game';
import { FULLSCREEN_VERTEX } from '../rendering/wgsl';
import { halton } from '../rendering/screenspace/TemporalAntialiasing';
import { AudioRecorder } from '../audio/AudioRecorder';

export interface OfflineRenderOptions {
  /** 画面的宽高（像素）。 */
  readonly width: number;
  readonly height: number;
  /** 每秒几帧。 */
  readonly fps: number;
  /** 每帧几个子帧（≥ 1）：越多越平滑、越慢。 */
  readonly samples?: number | undefined;
  /** 快门开着的那部分帧间隔（0 到 1，180° 快门是 0.5）；0 只抗锯齿、不做运动模糊。 */
  readonly shutter?: number | undefined;
  /**
   * 漫反射的间接光用路径追踪（RenderSystem.pathTracing，代替辐照度体、天空盒光、环境光）：每个输出帧的子帧一起累积，子帧越多越
   * 干净。
   */
  readonly pathTracing?: boolean | undefined;
}

/** 读回的一帧：sRGB 的 RGBA，一行紧挨一行。 */
export interface RenderedFrame {
  readonly index: number;
  /** 这一帧的开始时刻（相对开始渲染，秒）。 */
  readonly time: number;
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8Array<ArrayBuffer>;
}

const ACCUMULATION_FORMAT: GPUTextureFormat = 'rgba16float';
const OUTPUT_FORMAT: GPUTextureFormat = 'rgba8unorm-srgb';

const ACCUMULATE_SHADER = /* wgsl */ `${FULLSCREEN_VERTEX}
@group(0) @binding(0) var image: texture_2d<f32>;
@group(0) @binding(1) var<uniform> weight: vec4f;
@fragment fn fs(in: FullscreenVaryings) -> @location(0) vec4f {
  return vec4f(textureLoad(image, vec2i(in.position.xy), 0).rgb * weight.x, 1.0);
}`;

const RESOLVE_SHADER = /* wgsl */ `${FULLSCREEN_VERTEX}
@group(0) @binding(0) var image: texture_2d<f32>;
@fragment fn fs(in: FullscreenVaryings) -> @location(0) vec4f {
  return vec4f(textureLoad(image, vec2i(in.position.xy), 0).rgb, 1.0);
}`;

/** 渲染期间改掉、结束时还原的设置。 */
interface SavedState {
  readonly releaseFrames: () => void;
  readonly fixedSize: readonly [number, number] | undefined;
  readonly temporal: boolean;
  readonly motionBlur: boolean;
  readonly fxaa: boolean;
  readonly masterVolume: number;
  readonly pathTracing: boolean;
}

export class OfflineRenderer {
  readonly game: Game;
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly samples: number;
  readonly shutter: number;
  /** 漫反射的间接光用路径追踪。 */
  readonly pathTracing: boolean;
  /** 放了的声音（相对开始渲染的时刻），导出时混音用。 */
  readonly audio = new AudioRecorder();
  #frame = 0;
  /** 上一个子帧的时刻（相对开始，秒）。 */
  #time = 0;
  #saved: SavedState | undefined;
  #gpu: Gpu | undefined;

  constructor(game: Game, { width, height, fps, samples = 1, shutter = 0.5, pathTracing = false }: OfflineRenderOptions) {
    if (!(width >= 1 && height >= 1 && fps > 0)) throw new Error(`OfflineRenderer: invalid size ${width}x${height} or fps ${fps}`);
    this.game = game;
    this.width = Math.round(width);
    this.height = Math.round(height);
    this.fps = fps;
    this.samples = Math.max(1, Math.round(samples));
    this.shutter = Math.min(Math.max(shutter, 0), 1);
    this.pathTracing = pathTracing;
  }

  /** 下一帧的序号（已经渲染了几帧）。 */
  get frame(): number {
    return this.#frame;
  }

  /** 开始：接管帧循环（正在跑的那一帧跑完以后）、画布固定成导出的大小、关掉和子帧重复的效果、开始录音。 */
  async begin(): Promise<void> {
    if (this.#saved) throw new Error('OfflineRenderer.begin: already rendering');
    const { game } = this;
    const compositor = game.graphicsCompositor;
    const releaseFrames = await game.takeOverFrames();
    this.#saved = {
      releaseFrames, fixedSize: game.graphicsDevice.fixedSize,
      temporal: compositor.temporalAntialiasing.enabled, motionBlur: compositor.motionBlur.enabled, fxaa: compositor.postEffects.antialiasing.enabled,
      masterVolume: game.audio.masterVolume, pathTracing: game.renderSystem.pathTracing.enabled,
    };
    game.renderSystem.pathTracing.enabled = this.pathTracing;
    game.graphicsDevice.fixedSize = [this.width, this.height];
    game.graphicsDevice.backBufferCopySource = true;
    compositor.temporalAntialiasing.enabled = false;
    if (this.samples > 1) {
      compositor.motionBlur.enabled = false;
      compositor.postEffects.antialiasing.enabled = false;
    }
    // 实时的扬声器静音（离线渲染的快慢和墙上的时钟无关），声音按游戏时间录下来另外混
    game.audio.masterVolume = 0;
    game.audio.recorder = this.audio;
    this.#gpu = new Gpu(game.graphicsDevice.device, game.graphicsDevice.backBufferFormat, game.graphicsDevice.backBufferViewFormat, this.width, this.height);
    this.#frame = 0;
    this.#time = 0;
    this.audio.time = 0;
  }

  /** 渲染下一帧（samples 个子帧平均）并读回。 */
  async renderFrame(): Promise<RenderedFrame> {
    const gpu = this.#gpu;
    if (!gpu) throw new Error('OfflineRenderer.renderFrame: call begin() first');
    const { game, samples } = this;
    const index = this.#frame;
    const compositor = game.graphicsCompositor;
    for (let k = 0; k < samples; k++) {
      const time = (index + (this.shutter * (k + 0.5)) / samples) / this.fps;
      const step = time - this.#time;
      // 一个像素里的抖动：只有一个子帧时不抖（画面和实时的一样）
      compositor.subpixelJitter = samples > 1 ? [halton(k + 1, 2) - 0.5, halton(k + 1, 3) - 0.5] : undefined;
      // 画完马上（同一个任务里）拷后备缓冲：浏览器呈现画布以后它就失效了
      const copied = game.debug.afterNextDraw(() => gpu.accumulate(game.graphicsDevice.currentBackBuffer(), k === 0, 1 / samples));
      // 路径追踪：每个输出帧从头累积
      if (k === 0) game.renderSystem.pathTracing.reset();
      const advance = step > 1e-9 ? step : 0;
      if (advance > 0) this.#time = this.audio.time = time;
      await game.runFrame(advance);
      await copied;
    }
    compositor.subpixelJitter = undefined;
    const rgba = await gpu.resolve();
    this.#frame++;
    return { index, time: index / this.fps, width: this.width, height: this.height, rgba };
  }

  /** 结束：还原开始前的设置，停止录音。 */
  end(): void {
    const saved = this.#saved;
    if (!saved) return;
    const { game } = this;
    const compositor = game.graphicsCompositor;
    compositor.subpixelJitter = undefined;
    saved.releaseFrames();
    game.graphicsDevice.backBufferCopySource = false;
    game.graphicsDevice.fixedSize = saved.fixedSize;
    compositor.temporalAntialiasing.enabled = saved.temporal;
    compositor.motionBlur.enabled = saved.motionBlur;
    compositor.postEffects.antialiasing.enabled = saved.fxaa;
    game.renderSystem.pathTracing.enabled = saved.pathTracing;
    game.audio.masterVolume = saved.masterVolume;
    if (game.audio.recorder === this.audio) game.audio.recorder = undefined;
    this.#gpu?.destroy();
    this.#gpu = undefined;
    this.#saved = undefined;
  }
}

/** GPU 上的那部分：后备缓冲的拷贝、累积（线性的 HDR 浮点）、输出（sRGB 8 位）和读回。 */
class Gpu {
  readonly #device: GPUDevice;
  readonly #width: number;
  readonly #height: number;
  /** 后备缓冲的拷贝（同格式，用 sRGB 的视图读出线性值）。 */
  readonly #copy: GPUTexture;
  readonly #accumulation: GPUTexture;
  readonly #output: GPUTexture;
  readonly #readback: GPUBuffer;
  readonly #bytesPerRow: number;
  readonly #weight: GPUBuffer;
  readonly #accumulate: GPURenderPipeline;
  readonly #resolve: GPURenderPipeline;
  readonly #accumulateGroup: GPUBindGroup;
  readonly #resolveGroup: GPUBindGroup;

  constructor(device: GPUDevice, backBufferFormat: GPUTextureFormat, backBufferViewFormat: GPUTextureFormat, width: number, height: number) {
    this.#device = device;
    this.#width = width;
    this.#height = height;
    const size = { width, height };
    this.#copy = device.createTexture({ label: 'OfflineRenderer copy', size, format: backBufferFormat, viewFormats: [backBufferViewFormat], usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING });
    this.#accumulation = device.createTexture({ label: 'OfflineRenderer accumulation', size, format: ACCUMULATION_FORMAT, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
    this.#output = device.createTexture({ label: 'OfflineRenderer output', size, format: OUTPUT_FORMAT, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    this.#bytesPerRow = Math.ceil((width * 4) / 256) * 256;
    this.#readback = device.createBuffer({ label: 'OfflineRenderer readback', size: this.#bytesPerRow * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    this.#weight = device.createBuffer({ label: 'OfflineRenderer weight', size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const pipeline = (label: string, code: string, format: GPUTextureFormat, blend?: GPUBlendState) => {
      const module = device.createShaderModule({ label, code });
      return device.createRenderPipeline({
        label, layout: 'auto',
        vertex: { module, entryPoint: 'fullscreenVertex' },
        fragment: { module, entryPoint: 'fs', targets: [{ format, ...(blend ? { blend } : {}) }] },
      });
    };
    const add: GPUBlendComponent = { operation: 'add', srcFactor: 'one', dstFactor: 'one' };
    this.#accumulate = pipeline('OfflineRenderer accumulate', ACCUMULATE_SHADER, ACCUMULATION_FORMAT, { color: add, alpha: add });
    this.#resolve = pipeline('OfflineRenderer resolve', RESOLVE_SHADER, OUTPUT_FORMAT);
    this.#accumulateGroup = device.createBindGroup({
      layout: this.#accumulate.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: this.#copy.createView({ format: backBufferViewFormat }) }, { binding: 1, resource: { buffer: this.#weight } }],
    });
    this.#resolveGroup = device.createBindGroup({ layout: this.#resolve.getBindGroupLayout(0), entries: [{ binding: 0, resource: this.#accumulation.createView() }] });
  }

  /** 把这一帧的后备缓冲按 weight 加进累积（first 时先清零）。 */
  accumulate(backBuffer: GPUTexture, first: boolean, weight: number): void {
    if (backBuffer.width !== this.#width || backBuffer.height !== this.#height) {
      throw new Error(`OfflineRenderer: the back buffer is ${backBuffer.width}x${backBuffer.height}, expected ${this.#width}x${this.#height}`);
    }
    const device = this.#device;
    device.queue.writeBuffer(this.#weight, 0, new Float32Array([weight, 0, 0, 0]));
    const encoder = device.createCommandEncoder({ label: 'OfflineRenderer accumulate' });
    encoder.copyTextureToTexture({ texture: backBuffer }, { texture: this.#copy }, { width: this.#width, height: this.#height });
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: this.#accumulation.createView(), loadOp: first ? 'clear' : 'load', storeOp: 'store', clearValue: [0, 0, 0, 0] }],
    });
    pass.setPipeline(this.#accumulate);
    pass.setBindGroup(0, this.#accumulateGroup);
    pass.draw(3);
    pass.end();
    device.queue.submit([encoder.finish()]);
  }

  /** 累积的结果写成 sRGB 8 位、读回（一行紧挨一行）。 */
  async resolve(): Promise<Uint8Array<ArrayBuffer>> {
    const device = this.#device;
    const encoder = device.createCommandEncoder({ label: 'OfflineRenderer resolve' });
    const pass = encoder.beginRenderPass({ colorAttachments: [{ view: this.#output.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
    pass.setPipeline(this.#resolve);
    pass.setBindGroup(0, this.#resolveGroup);
    pass.draw(3);
    pass.end();
    encoder.copyTextureToBuffer({ texture: this.#output }, { buffer: this.#readback, bytesPerRow: this.#bytesPerRow }, { width: this.#width, height: this.#height });
    device.queue.submit([encoder.finish()]);
    await this.#readback.mapAsync(GPUMapMode.READ);
    const mapped = new Uint8Array(this.#readback.getMappedRange());
    const row = this.#width * 4;
    const rgba = new Uint8Array(row * this.#height);
    if (row === this.#bytesPerRow) rgba.set(mapped.subarray(0, rgba.length));
    else for (let y = 0; y < this.#height; y++) rgba.set(mapped.subarray(y * this.#bytesPerRow, y * this.#bytesPerRow + row), y * row);
    this.#readback.unmap();
    return rgba;
  }

  destroy(): void {
    for (const texture of [this.#copy, this.#accumulation, this.#output]) texture.destroy();
    this.#readback.destroy();
    this.#weight.destroy();
  }
}
