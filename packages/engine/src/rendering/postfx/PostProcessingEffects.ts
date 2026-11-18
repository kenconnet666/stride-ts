/**
 * 后处理（Stride 的 PostProcessingEffects，前向渲染器的 PostEffects），默认值同 Stride，顺序同它的 DrawCore：
 *   FXAA（在 HDR 画面上，前后做范围压缩和解压：Stride 的 Bloom 默认 StableConvolution，FXAA 排在最前）→ 量平均亮度
 *   （色调映射用，在叠加之前量）→ 亮部提取 → 泛光、光芒、镜头光晕依次叠加到画面上 → 色调映射写进后备缓冲。enabled 为 false 时只做色调映射（Stride 是原样拷贝 HDR 画面，
 * 但我们的后备缓冲是 8 位的，不映射就没法看）。
 * 临时的渲染目标每帧从池里借，参数每次绘制各占一段 uniform（见 ImageEffect.ts）。
 */
import { Bloom } from './Bloom';
import { BrightFilter } from './BrightFilter';
import { Fxaa } from './Fxaa';
import { GaussianBlur } from './GaussianBlur';
import { RenderTargetPool, UniformArena } from './ImageEffect';
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

  constructor(device: GPUDevice, linearClamp: GPUSampler) {
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

  /** input 是 HDR 画面（rgba16float，可以被改写：泛光加在它上面），结果写进 output；elapsed 是这一帧的秒数。 */
  draw(encoder: GPUCommandEncoder, input: GPUTexture, output: GPUTextureView, outputFormat: GPUTextureFormat, elapsed: number): void {
    this.#pool.recycle();
    this.#arena.reset();
    const current = this.enabled && this.antialiasing.enabled ? this.antialiasing.drawHdr(encoder, this.#pool, this.#arena, input) : input;
    this.toneMap.measure(encoder, current, elapsed);
    if (this.enabled && this.brightFilter.enabled && (this.bloom.enabled || this.lightStreak.enabled || this.lensFlare.enabled)) {
      const bright = this.#pool.acquire(current.width, current.height, current.format, 'BrightFilter');
      this.brightFilter.draw(encoder, this.#arena, current, bright);
      const effects = [this.bloom, this.lightStreak, this.lensFlare] as const;
      for (const effect of effects) {
        if (effect.enabled) effect.draw(encoder, this.#pool, this.#arena, this.#scaler, this.#blur, bright, current);
      }
    }
    this.toneMap.draw(encoder, current, output, outputFormat);
    // 参数在提交之前一次写进 GPU
    this.#arena.flush();
  }

  destroy(): void {
    this.toneMap.destroy();
    this.#pool.destroy();
    this.#arena.destroy();
  }
}
