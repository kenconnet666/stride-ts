/**
 * 后处理（Stride 的 PostProcessingEffects，前向渲染器的 PostEffects），默认值同 Stride，顺序同它的 DrawCore：
 *   FXAA（在 HDR 画面上，前后做范围压缩和解压：Stride 的 Bloom 默认 StableConvolution，FXAA 排在最前）→ 量平均亮度
 *   （色调映射用，在叠加之前量）→ 亮部提取 → 泛光、光芒、镜头光晕 → 叠加到画面上 → 色调映射写进后备缓冲。
 * 和 Stride 不同的几处只为省全分辨率的通道，结果不变：FXAA 的范围压缩和解压并进 FXAA 那一遍（见 Fxaa.ts）；光芒和镜头光晕
 * 共用一张缩到 1/2 的亮部图（两边都是线性缩小）；三个效果的结果不单独叠加，在色调映射里加上（见 AdditiveLayers.ts）。enabled 为 false 时只做色调映射（Stride 是原样拷贝 HDR 画面，
 * 但我们的后备缓冲是 8 位的，不映射就没法看）。
 * 临时的渲染目标每帧从池里借，参数每次绘制各占一段 uniform（见 ImageEffect.ts）。
 */
import { GpuProfiler } from '../../graphics/GpuProfiler';
import { prefilterLayers, type AdditiveLayer } from './AdditiveLayers';
import { Bloom } from './Bloom';
import { BrightFilter } from './BrightFilter';
import { Fxaa } from './Fxaa';
import { GaussianBlur } from './GaussianBlur';
import { RenderTargetPool, UniformArena, type ImageEffectContext } from './ImageEffect';
import { ImageScaler } from './ImageScaler';
import { LensFlare } from './LensFlare';
import { LightStreak } from './LightStreak';
import { ToneMap } from './ToneMap';

export class PostProcessingEffects {
  enabled = true;
  readonly brightFilter: BrightFilter;
  readonly bloom = new Bloom();
  readonly lightStreak: LightStreak;
  readonly lensFlare: LensFlare;
  readonly antialiasing: Fxaa;
  readonly toneMap: ToneMap;
  readonly #pool: RenderTargetPool;
  readonly #arena: UniformArena;
  readonly #scaler: ImageScaler;
  readonly #blur: GaussianBlur;
  readonly #device: GPUDevice;

  constructor(device: GPUDevice, linearClamp: GPUSampler) {
    this.#device = device;
    this.brightFilter = new BrightFilter(device);
    this.lightStreak = new LightStreak(device, linearClamp);
    this.lensFlare = new LensFlare(device, linearClamp);
    this.antialiasing = new Fxaa(device, linearClamp);
    this.toneMap = new ToneMap(device, linearClamp);
    this.#pool = new RenderTargetPool(device);
    this.#arena = new UniformArena(device);
    this.#scaler = new ImageScaler(device, linearClamp);
    this.#blur = new GaussianBlur(device, linearClamp);
  }

  /** input 是 HDR 画面（rgba16float），结果写进 output；elapsed 是这一帧的秒数。 */
  draw(encoder: GPUCommandEncoder, input: GPUTexture, output: GPUTextureView, outputFormat: GPUTextureFormat, elapsed: number): void {
    this.#pool.recycle();
    this.#arena.reset();
    // GPU 耗时按效果分组（GpuProfiler 打开时）
    const profiler = GpuProfiler.of(this.#device);
    const scope = (name: string) => {
      if (profiler) profiler.scope = name;
    };
    scope('FXAA');
    const current = this.enabled && this.antialiasing.enabled ? this.antialiasing.drawHdr(encoder, this.#pool, this.#arena, input) : input;
    scope('ToneMap');
    this.toneMap.measure(encoder, current, elapsed);
    let layers: AdditiveLayer[] = [];
    if (this.enabled && this.brightFilter.enabled && (this.bloom.enabled || this.lightStreak.enabled || this.lensFlare.enabled)) {
      const context: ImageEffectContext = { encoder, pool: this.#pool, arena: this.#arena, scaler: this.#scaler, blur: this.#blur };
      const bright = this.#pool.acquire(current.width, current.height, current.format, 'BrightFilter');
      scope('BrightFilter');
      this.brightFilter.draw(encoder, this.#arena, current, bright);
      let half: GPUTexture | undefined;
      if (this.lightStreak.enabled || this.lensFlare.enabled) {
        half = this.#pool.acquire(Math.max(1, bright.width >> 1), Math.max(1, bright.height >> 1), bright.format, 'BrightFilter half');
        this.#scaler.draw(encoder, this.#arena, bright, half, { expanded: false });
      }
      // 作用域用写死的名字：构建后类名会被压缩
      scope('Bloom');
      if (this.bloom.enabled) layers.push(this.bloom.draw(context, bright));
      scope('LightStreak');
      const streak = half && this.lightStreak.enabled ? this.lightStreak.draw(context, half) : undefined;
      if (streak) layers.push(streak);
      scope('LensFlare');
      if (half && this.lensFlare.enabled) layers.push(this.lensFlare.draw(context, half));
      scope('AdditiveLayers');
      layers = prefilterLayers(context, layers);
    }
    scope('ToneMap');
    this.toneMap.draw(encoder, this.#arena, current, layers, output, outputFormat);
    scope('');
    // 参数在提交之前一次写进 GPU
    this.#arena.flush();
  }

  destroy(): void {
    this.toneMap.destroy();
    this.#pool.destroy();
    this.#arena.destroy();
  }
}
