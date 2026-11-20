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
import { RenderGraph } from '../graph/RenderGraph';
import { EffectFrame, isGraphTexture, UniformArena, type Image, type ImageEffectContext } from './ImageEffect';
import { ImageScaler } from './ImageScaler';
import { LensFlare } from './LensFlare';
import { LightStreak } from './LightStreak';
import { QUALITY_TIERS, type QualitySettings } from '../Quality';
import { ToneMap } from './ToneMap';

/** 只录不执行的渲染图用：不会去要贴图。 */
const NO_ALLOCATOR = {
  acquire(): never {
    throw new Error('post-processing warm: the recorded frame is not executed');
  },
  release(): void {},
};

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
  readonly #linearClamp: GPUSampler;

  constructor(device: GPUDevice, linearClamp: GPUSampler) {
    this.#device = device;
    this.#linearClamp = linearClamp;
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
  record(frame: EffectFrame, input: Image, output: GPUTextureView, outputFormat: GPUTextureFormat, elapsed: number, quality: QualitySettings = QUALITY_TIERS.ultra): void {
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
      }, (real) => this.#scaler.copy(frame.encoder, this.#arena, isGraphTexture(input) ? real.texture(input) : input, output, outputFormat), () => this.#scaler.warmCopy(outputFormat));
      scope('');
      return;
    }
    scope('FXAA');
    // 各效果开不开：合成器的设置要开，画质档位也给
    const bloom = this.bloom.enabled && quality.bloom, lightStreak = this.lightStreak.enabled && quality.lightStreak, lensFlare = this.lensFlare.enabled && quality.lensFlare;
    const current = this.antialiasing.enabled && quality.antialiasing ? this.antialiasing.drawHdr(frame, this.#arena, input) : input;
    scope('ToneMap');
    this.toneMap.measure(frame, current, elapsed);
    let layers: AdditiveLayer[] = [];
    if (this.brightFilter.enabled && (bloom || lightStreak || lensFlare)) {
      const context: ImageEffectContext = { frame, arena: this.#arena, scaler: this.#scaler, blur: this.#blur };
      const bright = frame.acquire(current.width, current.height, current.format, 'BrightFilter');
      scope('BrightFilter');
      this.brightFilter.draw(frame, this.#arena, current, bright);
      let half: Image | undefined;
      if (lightStreak || lensFlare) {
        half = frame.acquire(Math.max(1, bright.width >> 1), Math.max(1, bright.height >> 1), bright.format, 'BrightFilter half');
        this.#scaler.draw(frame, this.#arena, bright, half, { expanded: false });
      }
      // 作用域用写死的名字：构建后类名会被压缩
      scope('Bloom');
      if (bloom) layers.push(this.bloom.draw(context, bright));
      scope('LightStreak');
      const streak = half && lightStreak ? this.lightStreak.draw(context, half) : undefined;
      if (streak) layers.push(streak);
      scope('LensFlare');
      if (half && lensFlare) layers.push(this.lensFlare.draw(context, half));
      scope('AdditiveLayers');
      layers = prefilterLayers(context, layers);
    }
    scope('ToneMap');
    this.toneMap.draw(frame, this.#arena, current, layers, output, outputFormat);
    scope('');
  }

  /**
   * 加载场景时预热：照 settings（场景合成器的后处理，null 是不做后处理只拷贝）空录一帧，会跑的通道要的管线在后台编好
   * （全屏管线按设备共用，见 ImageEffect.ts 的 fullscreenPipeline），第一次真画时不用当场编译着色器。空录用另一份效果，
   * 有状态的（色调映射的适应亮度）不受影响；录的东西不执行。
   */
  async warm(settings: ScenePostEffects | null, inputFormat: GPUTextureFormat, outputFormat: GPUTextureFormat, quality: QualitySettings): Promise<void> {
    const probe = new PostProcessingEffects(this.#device, this.#linearClamp);
    // 输出的视图只在执行时用到；给一张 1x1 的，空录完就销毁
    const output = this.#device.createTexture({ label: 'post-processing warm output', size: [1, 1], format: outputFormat, usage: GPUTextureUsage.RENDER_ATTACHMENT });
    try {
      probe.configure(settings);
      const graph = new RenderGraph(NO_ALLOCATOR);
      graph.beginFrame();
      // 不执行：encoder 用不到
      const frame = new EffectFrame(undefined as unknown as GPUCommandEncoder, graph, undefined);
      const input = graph.texture({ label: 'post-processing warm input', width: 256, height: 256, format: inputFormat });
      probe.record(frame, input, output.createView(), outputFormat, 0, quality);
      await graph.warm();
    } finally {
      probe.destroy();
      output.destroy();
    }
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
