/**
 * 后处理（Stride 的 PostProcessingEffects，前向渲染器的 PostEffects），默认值同 Stride，顺序同它的 DrawCore：
 *   FXAA（在 HDR 画面上，前后做范围压缩和解压：Stride 的 Bloom 默认 StableConvolution，FXAA 排在最前）→ 量平均亮度
 *   （色调映射用，在叠加之前量）→ 亮部提取 → 泛光、光芒、镜头光晕 → 叠加到画面上 → 色调映射写进后备缓冲。
 * 和 Stride 不同的几处只为省全分辨率的通道，结果不变：FXAA 的范围压缩和解压并进 FXAA 那一遍（见 Fxaa.ts）；光芒和镜头光晕
 * 共用一张缩到 1/2 的亮部图（两边都是线性缩小）；三个效果的结果不单独叠加，在色调映射里加上（见 AdditiveLayers.ts）。
 * enabled 为 false 时同 Stride（合成器的 PostEffects 是 null）：HDR 画面原样拷贝到输出，超过 1 的截断。
 * 临时的渲染目标每帧从池里借，参数每次绘制各占一段 uniform（见 ImageEffect.ts）。
 */
import type { ScenePostEffects } from '../../content/format';
import { GpuProfiler } from '../../graphics/GpuProfiler';
import { prefilterLayers, type AdditiveLayer } from './AdditiveLayers';
import { Bloom } from './Bloom';
import { BrightFilter } from './BrightFilter';
import { Fxaa } from './Fxaa';
import { GaussianBlur } from './GaussianBlur';
import { isGraphTexture, UniformArena, type EffectFrame, type Image, type ImageEffectContext } from './ImageEffect';
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
    this.#arena = new UniformArena(device);
    this.#scaler = new ImageScaler(device, linearClamp);
    this.#blur = new GaussianBlur(device, linearClamp);
  }

  /** 按场景的合成器设置开关各效果；null 是不做后处理。 */
  configure(settings: ScenePostEffects | null): void {
    this.enabled = settings !== null;
    if (!settings) return;
    this.brightFilter.enabled = settings.brightFilter;
    this.bloom.enabled = settings.bloom;
    this.lightStreak.enabled = settings.lightStreak;
    this.lensFlare.enabled = settings.lensFlare;
    this.toneMap.enabled = settings.toneMap;
    this.antialiasing.enabled = settings.antialiasing;
  }

  /**
   * 往这一帧的渲染图里加后处理的通道：input 是 HDR 画面（rgba16float；这一帧的临时贴图，或者一张真的贴图），结果写进
   * output；elapsed 是这一帧的秒数。调用方执行完渲染图以后要调 flush（uniform 的参数那时才写进 GPU）。
   */
  record(frame: EffectFrame, input: Image, output: GPUTextureView, outputFormat: GPUTextureFormat, elapsed: number): void {
    this.#arena.reset();
    // GPU 耗时按效果分组（GpuProfiler 打开时）
    const profiler = GpuProfiler.of(this.#device);
    const scope = (name: string) => {
      if (profiler) profiler.scope = name;
    };
    if (!this.enabled) {
      scope('Copy');
      frame.pass('Copy', (pass) => {
        if (isGraphTexture(input)) pass.read(input);
        pass.sideEffect();
      }, (real) => this.#scaler.copy(frame.encoder, this.#arena, isGraphTexture(input) ? real.texture(input) : input, output, outputFormat));
      scope('');
      return;
    }
    scope('FXAA');
    const current = this.antialiasing.enabled ? this.antialiasing.drawHdr(frame, this.#arena, input) : input;
    scope('ToneMap');
    this.toneMap.measure(frame, current, elapsed);
    let layers: AdditiveLayer[] = [];
    if (this.brightFilter.enabled && (this.bloom.enabled || this.lightStreak.enabled || this.lensFlare.enabled)) {
      const context: ImageEffectContext = { frame, arena: this.#arena, scaler: this.#scaler, blur: this.#blur };
      const bright = frame.acquire(current.width, current.height, current.format, 'BrightFilter');
      scope('BrightFilter');
      this.brightFilter.draw(frame, this.#arena, current, bright);
      let half: Image | undefined;
      if (this.lightStreak.enabled || this.lensFlare.enabled) {
        half = frame.acquire(Math.max(1, bright.width >> 1), Math.max(1, bright.height >> 1), bright.format, 'BrightFilter half');
        this.#scaler.draw(frame, this.#arena, bright, half, { expanded: false });
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
    this.toneMap.draw(frame, this.#arena, current, layers, output, outputFormat);
    scope('');
  }

  /** 这一帧录的通道执行完以后调：uniform 的参数在提交之前一次写进 GPU。 */
  flush(): void {
    this.#arena.flush();
  }

  destroy(): void {
    this.toneMap.destroy();
    this.#arena.destroy();
  }
}
