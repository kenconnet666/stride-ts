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
 */
import { GpuProfiler } from '../../graphics/GpuProfiler';
import { FULLSCREEN_VERTEX } from '../fullscreen';
import { additiveLayerResources, additiveLayersShader, type AdditiveLayer } from './AdditiveLayers';
import type { UniformArena } from './ImageEffect';

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
struct Settings { keyValue: f32, exposure: f32, autoKeyValue: f32, autoExposure: f32, whitePoint: f32, enabled: f32 };
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

@fragment fn fs(in: FullscreenVaryings) -> @location(0) vec4f {
  let color = max(textureLoad(hdr, vec2u(in.position.xy), 0).rgb + additiveLayers(in.uv), vec3f(0.0001));
  if (settings.enabled == 0.0) {
    return vec4f(color, 1.0);
  }
  let luminance = max(textureLoad(adapted, vec2u(0u), 0).r, 0.0001);
  let keyValue = select(settings.keyValue, 1.03 - 2.0 / (2.0 + log2(luminance + 1.0) / log2(10.0)), settings.autoKeyValue > 0.5);
  let exposure = select(settings.exposure, max(keyValue / luminance, 0.0001), settings.autoExposure > 0.5);
  return vec4f(hejl2(color * exposure, settings.whitePoint), 1.0);
}`;

/** 跟着输入纹理的资源：对数亮度图（带到 1x1 的 mip 链）和每一级的绑定组。 */
interface LuminanceTargets {
  readonly input: GPUTexture;
  readonly luminance: GPUTexture;
  readonly bindGroups: readonly GPUBindGroup[];
}

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

  readonly #device: GPUDevice;
  readonly #sampler: GPUSampler;
  readonly #pipelines: { luminance: GPURenderPipeline; downscale: GPURenderPipeline; adapt: GPURenderPipeline; tonemap: GPURenderPipeline | undefined };
  readonly #tonemapModule: GPUShaderModule;
  #tonemapFormat: GPUTextureFormat | undefined;
  readonly #settings: GPUBuffer;
  readonly #adaptUniform: GPUBuffer;
  /** 两张 1x1 的适应亮度，轮流读写。 */
  readonly #adapted: [GPUTexture, GPUTexture];
  #current = 0;
  #reset = true;
  #targets: LuminanceTargets | undefined;
  /** measure 写好的适应亮度，draw 读它。 */
  #measured: GPUTexture | undefined;

  constructor(device: GPUDevice, sampler: GPUSampler) {
    this.#device = device;
    this.#sampler = sampler;
    const pipeline = (label: string, code: string, format: GPUTextureFormat) => {
      const module = device.createShaderModule({ label, code });
      return device.createRenderPipeline({ label, layout: 'auto', vertex: { module, entryPoint: 'fullscreenVertex' }, fragment: { module, entryPoint: 'fs', targets: [{ format }] } });
    };
    this.#pipelines = {
      luminance: pipeline('ToneMap luminance', LUMINANCE_SHADER, 'r16float'),
      downscale: pipeline('ToneMap downscale', DOWNSCALE_SHADER, 'r16float'),
      adapt: pipeline('ToneMap adapt', ADAPT_SHADER, 'r32float'),
      tonemap: undefined,
    };
    this.#tonemapModule = device.createShaderModule({ label: 'ToneMap', code: TONEMAP_SHADER });
    this.#settings = device.createBuffer({ label: 'ToneMap settings', size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.#adaptUniform = device.createBuffer({ label: 'ToneMap adapt', size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const adapted = () => device.createTexture({ label: 'ToneMap adapted luminance', size: [1, 1], format: 'r32float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT });
    this.#adapted = [adapted(), adapted()];
  }

  /** 量 input（rgba16float 的 HDR 画面）的平均亮度并做时间上的适应；elapsed 是这一帧的秒数。 */
  measure(encoder: GPUCommandEncoder, input: GPUTexture, elapsed: number): void {
    this.#device.queue.writeBuffer(this.#settings, 0, new Float32Array([this.keyValue, 2 ** this.exposure, this.autoKeyValue ? 1 : 0, this.autoExposure ? 1 : 0, this.whitePoint, this.enabled ? 1 : 0]));
    // 关掉时 draw 照样绑一张适应亮度（着色器不读它）；重新打开时从当前亮度开始适应
    if (!this.enabled) {
      this.#measured = this.#adapted[this.#current];
      this.#reset = true;
      return;
    }
    const targets = this.#targetsFor(input);
    const factor = this.temporalAdaptation ? 1 - Math.exp(-elapsed * this.adaptationRate) : 1;
    this.#device.queue.writeBuffer(this.#adaptUniform, 0, new Float32Array([factor, this.#reset || !this.temporalAdaptation ? 1 : 0]));
    this.#reset = false;

    // 对数亮度和 2x2 平均链
    const levels = targets.luminance.mipLevelCount;
    for (let level = 0; level < levels; level++) {
      this.#fullscreen(encoder, level === 0 ? this.#pipelines.luminance : this.#pipelines.downscale, targets.bindGroups[level]!, targets.luminance.createView({ baseMipLevel: level, mipLevelCount: 1 }));
    }
    // 适应：读上一帧的结果，写另一张
    const previous = this.#adapted[this.#current]!;
    const next = this.#adapted[1 - this.#current]!;
    this.#current = 1 - this.#current;
    this.#fullscreen(encoder, this.#pipelines.adapt, this.#device.createBindGroup({
      layout: this.#pipelines.adapt.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.#adaptUniform } },
        { binding: 1, resource: targets.luminance.createView() },
        { binding: 2, resource: previous.createView() },
      ],
    }), next.createView());
    this.#measured = next;
  }

  /** 按 measure 量出的亮度把 input 加上 layers（已经 prefilterLayers 过）映射后画进 output。 */
  draw(encoder: GPUCommandEncoder, arena: UniformArena, input: GPUTexture, layers: readonly AdditiveLayer[], output: GPUTextureView, outputFormat: GPUTextureFormat): void {
    const adapted = this.#measured;
    if (!adapted) throw new Error("ToneMap.draw: call measure first in the frame");
    const tonemap = this.#tonemapPipeline(outputFormat);
    this.#fullscreen(encoder, tonemap, this.#device.createBindGroup({
      layout: tonemap.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.#settings } },
        { binding: 1, resource: input.createView() },
        { binding: 2, resource: adapted.createView() },
        ...additiveLayerResources(arena, layers, input, this.#sampler).map((resource, i) => ({ binding: 3 + i, resource: resource instanceof GPUTexture ? resource.createView() : resource })),
      ],
    }), output);
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

  #tonemapPipeline(format: GPUTextureFormat): GPURenderPipeline {
    if (!this.#pipelines.tonemap || this.#tonemapFormat !== format) {
      this.#tonemapFormat = format;
      this.#pipelines.tonemap = this.#device.createRenderPipeline({
        label: 'ToneMap',
        layout: 'auto',
        vertex: { module: this.#tonemapModule, entryPoint: 'fullscreenVertex' },
        fragment: { module: this.#tonemapModule, entryPoint: 'fs', targets: [{ format }] },
      });
    }
    return this.#pipelines.tonemap;
  }

  /** 亮度图和各级的绑定组跟着输入纹理（画布尺寸变了就是新的）重建。 */
  #targetsFor(input: GPUTexture): LuminanceTargets {
    if (this.#targets?.input === input) return this.#targets;
    this.#targets?.luminance.destroy();
    const nextPow2 = (n: number) => 2 ** Math.ceil(Math.log2(Math.max(1, n)));
    const size = Math.max(1, Math.min(nextPow2(input.width), nextPow2(input.height)) / 2);
    const levels = Math.log2(size) + 1;
    const luminance = this.#device.createTexture({ label: 'ToneMap luminance', size: [size, size], format: 'r16float', mipLevelCount: levels, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT });
    const bindGroups = [this.#device.createBindGroup({ layout: this.#pipelines.luminance.getBindGroupLayout(0), entries: [{ binding: 0, resource: input.createView() }] })];
    for (let level = 1; level < levels; level++) {
      bindGroups.push(this.#device.createBindGroup({
        layout: this.#pipelines.downscale.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: luminance.createView({ baseMipLevel: level - 1, mipLevelCount: 1 }) },
          { binding: 1, resource: this.#sampler },
        ],
      }));
    }
    this.#reset = true;
    return (this.#targets = { input, luminance, bindGroups });
  }
}
