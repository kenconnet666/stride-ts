/**
 * 色调映射（Stride 的 PostProcessingEffects 里的 ToneMap，默认设置）：把线性的 HDR 画面映射到显示范围，写进
 * 后备缓冲的 sRGB 视图。分两步，同 Stride：measure 在泛光叠加之前量平均亮度（LuminanceEffect），draw 最后映射。
 * - 平均亮度（LuminanceEffect）：HDR 画面按 Rec.601 的亮度取 log2（至少 0.001）写进 S×S 的 R16F 图
 *   （S = min(nextPow2(宽), nextPow2(高)) / 2），再一级级 2x2 平均到 1x1，就是对数平均（几何平均）；
 * - 适应（TemporalAdaptation）：adapted += (平均亮度 - adapted) · (1 - e^(-dt · AdaptationRate))，第一帧直接取当前值。
 *   Stride 在 CPU 上做（要回读平均亮度），这里放在 GPU 上（1x1 的两张纹理轮流读写），没有回读；
 * - 曝光（AutoExposure、AutoKeyValue）：key = 1.03 - 2 / (2 + log10(adapted + 1))，曝光 = key / adapted；
 * - 算子：Hejl2（白点 5）。亮度、对比度是 0 时只剩 max(color, 0.0001)。
 * 泛光等效果的层在映射之前加上（见 AdditiveLayers.ts）。
 * 和 Stride 不同：输出是 8 位的 sRGB 时加不到一个灰阶的抖动（dither，默认开）。暗的渐变（夜空、雾）量化成 8 位以后相邻的带只差
 * 一个灰阶，是一圈圈看得见的色带；抖动把它打散成看不出来的噪声。图案是固定的（按像素坐标），画面不动时每帧一样。
 */
import { GRADIENT_NOISE } from '../shaders/noise';
import { GpuProfiler } from '../../graphics/GpuProfiler';
import { FULLSCREEN_VERTEX } from '../shaders/fullscreen';
import { additiveLayerResources, additiveLayersShader, type AdditiveLayer } from './AdditiveLayers';
import { fullscreenPipeline, isGraphTexture, warmFullscreenPipeline, type EffectFrame, type Image, type UniformArena } from './ImageEffect';

const LUMINANCE_SHADER = /* wgsl */ `
${FULLSCREEN_VERTEX}
@group(0) @binding(0) var hdr: texture_2d<f32>;

@fragment fn fs(in: FullscreenVaryings) -> @location(0) vec4f {
  let size = vec2f(textureDimensions(hdr));
  let color = textureLoad(hdr, vec2u(min(in.uv * size, size - 1.0)), 0).rgb;
  let luminance = max(dot(color, vec3f(0.299, 0.587, 0.114)), 0.001);
  return vec4f(log2(luminance), 0.0, 0.0, 1.0);
}`;

/** 2x2 平均：输出纹素中心正好落在 4 个源纹素中间，线性采样一次就是平均。 */
const DOWNSCALE_SHADER = /* wgsl */ `
${FULLSCREEN_VERTEX}
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var linearClamp: sampler;

@fragment fn fs(in: FullscreenVaryings) -> @location(0) vec4f {
  return textureSampleLevel(source, linearClamp, in.uv, 0.0);
}`;

const ADAPT_SHADER = /* wgsl */ `
${FULLSCREEN_VERTEX}
struct Adapt { factor: f32, reset: f32 };
@group(0) @binding(0) var<uniform> adapt: Adapt;
@group(0) @binding(1) var averageLog: texture_2d<f32>;
@group(0) @binding(2) var previous: texture_2d<f32>;

@fragment fn fs(in: FullscreenVaryings) -> @location(0) vec4f {
  let average = exp2(textureLoad(averageLog, vec2u(0u), i32(textureNumLevels(averageLog)) - 1).r);
  let last = select(textureLoad(previous, vec2u(0u), 0).r, average, adapt.reset > 0.5);
  return vec4f(last + (average - last) * adapt.factor, 0.0, 0.0, 1.0);
}`;

const TONEMAP_SHADER = /* wgsl */ `
${FULLSCREEN_VERTEX}
struct Settings { keyValue: f32, exposure: f32, autoKeyValue: f32, autoExposure: f32, whitePoint: f32, enabled: f32, dither: f32 };
@group(0) @binding(0) var<uniform> settings: Settings;
@group(0) @binding(1) var hdr: texture_2d<f32>;
@group(0) @binding(2) var adapted: texture_2d<f32>;
${additiveLayersShader(3)}

fn hejl2(color: vec3f, whitePoint: f32) -> vec3f {
  var w = 1.425 * whitePoint + 0.05;
  w = ((whitePoint * w + 0.004) / (whitePoint * (w + 0.55) + 0.0491)) - 0.0821;
  let va = 1.425 * color + 0.05;
  let vf = ((color * va + 0.004) / (color * (va + 0.55) + 0.0491)) - 0.0821;
  return vf / w;
}

${GRADIENT_NOISE}

/**
 * 输出的抖动：在 sRGB 编码后的值上加 ±半个灰阶的噪声（三个通道各用一份，不相关），再换回线性（目标是 sRGB 视图，写进去时
 * GPU 再编码一次）。要在编码后的空间里加：一个灰阶在线性空间里的大小暗处和亮处差几十倍。
 */
fn dither(color: vec3f, pixel: vec2f) -> vec3f {
  let c = saturate(color);
  let encoded = select(1.055 * pow(c, vec3f(1.0 / 2.4)) - 0.055, c * 12.92, c <= vec3f(0.0031308));
  let noise = vec3f(gradientNoise(pixel), gradientNoise(pixel + vec2f(47.0, 17.0)), gradientNoise(pixel + vec2f(101.0, 59.0))) - 0.5;
  let e = saturate(encoded + noise / 255.0);
  return select(pow((e + 0.055) / 1.055, vec3f(2.4)), e / 12.92, e <= vec3f(0.04045));
}

@fragment fn fs(in: FullscreenVaryings) -> @location(0) vec4f {
  var color = max(textureLoad(hdr, vec2u(in.position.xy), 0).rgb + additiveLayers(in.uv), vec3f(0.0001));
  if (settings.enabled != 0.0) {
    let luminance = max(textureLoad(adapted, vec2u(0u), 0).r, 0.0001);
    let keyValue = select(settings.keyValue, 1.03 - 2.0 / (2.0 + log2(luminance + 1.0) / log2(10.0)), settings.autoKeyValue > 0.5);
    let exposure = select(settings.exposure, max(keyValue / luminance, 0.0001), settings.autoExposure > 0.5);
    color = hejl2(color * exposure, settings.whitePoint);
  }
  if (settings.dither != 0.0) { color = dither(color, in.position.xy); }
  return vec4f(color, 1.0);
}`;

/** 跟着输入尺寸的资源：对数亮度图（带到 1x1 的 mip 链）和每一级读上一级的绑定组（第 0 级读输入，不在这里）。 */
interface LuminanceTargets {
  readonly width: number;
  readonly height: number;
  readonly luminance: GPUTexture;
  /** 第 1 级起各级读上一级的绑定组；执行时才建（要 downscale 的管线，录制时它可能还在后台编）。 */
  bindGroups: readonly (GPUBindGroup | undefined)[] | undefined;
}

type ToneMapStep = 'luminance' | 'downscale' | 'adapt' | 'tonemap';
/** 各步的着色器和目标格式（映射这一步画进后备缓冲，格式用到时才知道）。 */
const STEPS: Record<ToneMapStep, readonly [label: string, code: string, format: GPUTextureFormat | undefined]> = {
  luminance: ['ToneMap luminance', LUMINANCE_SHADER, 'r16float'],
  downscale: ['ToneMap downscale', DOWNSCALE_SHADER, 'r16float'],
  adapt: ['ToneMap adapt', ADAPT_SHADER, 'r32float'],
  tonemap: ['ToneMap', TONEMAP_SHADER, undefined],
};

export class ToneMap {
  /** 关掉时（Stride 的 ToneMap.Enabled）不量亮度、不曝光也不映射，只加上叠加层。 */
  enabled = true;
  // Stride 的 ToneMap 的默认值
  autoExposure = true;
  autoKeyValue = true;
  /** 不自动算 key 时用它。 */
  keyValue = 0.18;
  /** 不自动曝光时的曝光，单位是档（乘 2^exposure）。 */
  exposure = 0;
  temporalAdaptation = true;
  adaptationRate = 1;
  /** Hejl2 算子的白点。 */
  whitePoint = 5;
  /** 输出是 8 位的 sRGB 时加抖动（见文件头）。和桌面 Stride 的截图逐像素比对时关掉。 */
  dither = true;

  readonly #device: GPUDevice;
  readonly #sampler: GPUSampler;
  readonly #settings: GPUBuffer;
  readonly #adaptUniform: GPUBuffer;
  /** 两张 1x1 的适应亮度，轮流读写。 */
  readonly #adapted: [GPUTexture, GPUTexture];
  #current = 0;
  #reset = true;
  #targets: LuminanceTargets | undefined;
  readonly #sourceGroups = new WeakMap<GPUTexture, GPUBindGroup>();
  /** measure 写好的适应亮度，draw 读它。 */
  #measured: GPUTexture | undefined;

  constructor(device: GPUDevice, sampler: GPUSampler) {
    this.#device = device;
    this.#sampler = sampler;
    this.#settings = device.createBuffer({ label: 'ToneMap settings', size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.#adaptUniform = device.createBuffer({ label: 'ToneMap adapt', size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const adapted = () => device.createTexture({ label: 'ToneMap adapted luminance', size: [1, 1], format: 'r32float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT });
    this.#adapted = [adapted(), adapted()];
  }

  /** 量 input（rgba16float 的 HDR 画面）的平均亮度并做时间上的适应；elapsed 是这一帧的秒数。 */
  measure(frame: EffectFrame, input: Image, elapsed: number): void {
    this.#device.queue.writeBuffer(this.#settings, 0, new Float32Array([this.keyValue, 2 ** this.exposure, this.autoKeyValue ? 1 : 0, this.autoExposure ? 1 : 0, this.whitePoint, this.enabled ? 1 : 0]));
    // 关掉时 draw 照样绑一张适应亮度（着色器不读它）；重新打开时从当前亮度开始适应
    if (!this.enabled) {
      this.#measured = this.#adapted[this.#current];
      this.#reset = true;
      return;
    }
    const targets = this.#targetsFor(input.width, input.height);
    const factor = this.temporalAdaptation ? 1 - Math.exp(-elapsed * this.adaptationRate) : 1;
    this.#device.queue.writeBuffer(this.#adaptUniform, 0, new Float32Array([factor, this.#reset || !this.temporalAdaptation ? 1 : 0]));
    this.#reset = false;
    const levels = targets.luminance.mipLevelCount;
    // 适应：读上一帧的结果，写另一张
    const previous = this.#adapted[this.#current]!;
    const next = this.#adapted[1 - this.#current]!;
    this.#current = 1 - this.#current;
    this.#measured = next;
    // 写的是自己留到下一帧的贴图（亮度的 mip 链、适应后的亮度），渲染图看不见：算副作用
    frame.pass('ToneMap measure', (pass) => {
      if (isGraphTexture(input)) pass.read(input);
      pass.sideEffect();
    }, (real) => {
      const { encoder } = frame;
      const luminance = this.#pipeline('luminance'), downscale = this.#pipeline('downscale'), adapt = this.#pipeline('adapt');
      // 对数亮度和 2x2 平均链；第一级读输入
      const source = this.#sourceGroup(isGraphTexture(input) ? real.texture(input) : input);
      for (let level = 0; level < levels; level++) {
        this.#fullscreen(encoder, level === 0 ? luminance : downscale, level === 0 ? source : this.#levelGroups(targets, downscale)[level]!, targets.luminance.createView({ baseMipLevel: level, mipLevelCount: 1 }));
      }
      this.#fullscreen(encoder, adapt, this.#device.createBindGroup({
        layout: adapt.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.#adaptUniform } },
          { binding: 1, resource: targets.luminance.createView() },
          { binding: 2, resource: previous.createView() },
        ],
      }), next.createView());
    }, () => this.#warm(['luminance', 'downscale', 'adapt']));
  }

  /** 按 measure 量出的亮度把 input 加上 layers（已经 prefilterLayers 过）映射后画进 output。 */
  draw(frame: EffectFrame, arena: UniformArena, input: Image, layers: readonly AdditiveLayer[], output: GPUTextureView, outputFormat: GPUTextureFormat): void {
    const adapted = this.#measured;
    if (!adapted) throw new Error("ToneMap.draw: call measure first in the frame");
    const layerResources = additiveLayerResources(arena, layers, input, this.#sampler);
    frame.pass('ToneMap', (pass) => {
      // 输入和叠加的各层可以是这一帧的临时贴图；输出在渲染图外面
      if (isGraphTexture(input)) pass.read(input);
      for (const resource of layerResources) if (isGraphTexture(resource)) pass.read(resource);
      pass.sideEffect();
    }, (real) => {
      const tonemap = this.#pipeline('tonemap', outputFormat);
      // 抖动只对 8 位的 sRGB 输出做（后备缓冲、8 位的渲染目标）；浮点的输出没有量化
      this.#device.queue.writeBuffer(this.#settings, 24, new Float32Array([this.dither && /8unorm-srgb$/.test(outputFormat) ? 1 : 0]));
      const actual = <T extends object>(resource: T) => (isGraphTexture(resource) ? real.texture(resource) : resource);
      this.#fullscreen(frame.encoder, tonemap, this.#device.createBindGroup({
        layout: tonemap.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.#settings } },
          { binding: 1, resource: (actual(input) as GPUTexture).createView() },
          { binding: 2, resource: adapted.createView() },
          ...layerResources.map((resource, i) => {
            const item = actual(resource);
            return { binding: 3 + i, resource: item instanceof GPUTexture ? item.createView() : item as GPUSampler | GPUBufferBinding };
          }),
        ],
      }), output);
    }, () => this.#warm(['tonemap'], outputFormat));
  }

  /** 下一帧重新从当前亮度开始适应（比如切场景）。 */
  resetAdaptation(): void {
    this.#reset = true;
  }

  destroy(): void {
    this.#targets?.luminance.destroy();
    for (const texture of this.#adapted) texture.destroy();
    this.#settings.destroy();
    this.#adaptUniform.destroy();
  }

  #fullscreen(encoder: GPUCommandEncoder, pipeline: GPURenderPipeline, bindGroup: GPUBindGroup, target: GPUTextureView): void {
    const timestampWrites = GpuProfiler.of(this.#device)?.passTimestamps(pipeline.label);
    const pass = encoder.beginRenderPass({ label: pipeline.label, colorAttachments: [{ view: target, loadOp: 'clear', storeOp: 'store' }], ...(timestampWrites ? { timestampWrites } : {}) });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();
  }

  /** 一步的管线（全屏管线按设备共用，见 fullscreenPipeline）；映射这一步画进 outputFormat。 */
  #pipeline(step: ToneMapStep, outputFormat?: GPUTextureFormat): GPURenderPipeline {
    const [label, code, format] = STEPS[step];
    return fullscreenPipeline(this.#device, label, code, [format ?? outputFormat!]);
  }

  #warm(steps: readonly ToneMapStep[], outputFormat?: GPUTextureFormat): Promise<void> | undefined {
    const pending = steps.map((step) => {
      const [label, code, format] = STEPS[step];
      return warmFullscreenPipeline(this.#device, label, code, [format ?? outputFormat!]);
    }).filter((warming) => warming !== undefined);
    return pending.length > 0 ? Promise.all(pending).then(() => undefined) : undefined;
  }

  /** 亮度图和它各级之间的绑定组跟着输入的尺寸（画布尺寸变了）重建。 */
  #targetsFor(width: number, height: number): LuminanceTargets {
    if (this.#targets?.width === width && this.#targets.height === height) return this.#targets;
    this.#targets?.luminance.destroy();
    const nextPow2 = (n: number) => 2 ** Math.ceil(Math.log2(Math.max(1, n)));
    const size = Math.max(1, Math.min(nextPow2(width), nextPow2(height)) / 2);
    const levels = Math.log2(size) + 1;
    const luminance = this.#device.createTexture({ label: 'ToneMap luminance', size: [size, size], format: 'r16float', mipLevelCount: levels, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT });
    this.#reset = true;
    return (this.#targets = { width, height, luminance, bindGroups: undefined });
  }

  /** 各级读上一级的绑定组（第 0 级读输入，绑定组按输入的贴图另存，见 #sourceGroup）。 */
  #levelGroups(targets: LuminanceTargets, downscale: GPURenderPipeline): readonly (GPUBindGroup | undefined)[] {
    if (targets.bindGroups) return targets.bindGroups;
    const bindGroups: (GPUBindGroup | undefined)[] = [undefined];
    for (let level = 1; level < targets.luminance.mipLevelCount; level++) {
      bindGroups.push(this.#device.createBindGroup({
        layout: downscale.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: targets.luminance.createView({ baseMipLevel: level - 1, mipLevelCount: 1 }) },
          { binding: 1, resource: this.#sampler },
        ],
      }));
    }
    return (targets.bindGroups = bindGroups);
  }

  /** 读这张输入贴图的绑定组。输入是池里的贴图，每帧可能不是同一张：按贴图存，贴图销毁后跟着回收。 */
  #sourceGroup(input: GPUTexture): GPUBindGroup {
    let group = this.#sourceGroups.get(input);
    if (!group) {
      group = this.#device.createBindGroup({ layout: this.#pipeline('luminance').getBindGroupLayout(0), entries: [{ binding: 0, resource: input.createView() }] });
      this.#sourceGroups.set(input, group);
    }
    return group;
  }
}
