/**
 * 半分辨率光追结果的降噪（RayTracedLocalLights、RayTracedEmissive 共用）：追踪每个 2×2 块按帧号轮着打一个像素，写进半分辨率的
 * 贴图（rgb 三个估计）；这里
 * 1. 时间上累积（全分辨率）：按世界位置重投影上一帧，历史夹在所在块周围 3×3 块的范围里，按累积的帧数 1 / n 混合（最多
 *    MAX_HISTORY 帧，a 通道记帧数），相机不动时收敛；重投影到画面外、没有历史时从头数；
 * 2. 三遍 à-trous（步长 1、2、4，3×3，按视深挡边）；最后一遍交给调用方的 finish（WGSL）把滤好的 rgb 变成输出。
 * 追踪的 uniform 开头是 DENOISE_VIEW_WGSL 的四项（同一个缓冲给这里用）。
 */
import type { RenderView } from '../RenderSystem';
import { FullscreenShader, type EffectFrame } from '../postfx/ImageEffect';

/** 累积和中间结果的格式：rgb 是估计，a 是累积了几帧。 */
const FORMAT: GPUTextureFormat = 'rgba16float';
/** 时间累积最多平均多少帧。 */
const MAX_HISTORY = 32;
/** DENOISE_VIEW_WGSL 占几个 float（uniform 开头的这几项，追踪的 uniform 接在后面加自己的）。 */
export const DENOISE_VIEW_FLOATS = 40;

/** 追踪和降噪共用的 uniform 开头（这一帧和上一帧的矩阵、尺寸和帧号、相机）和几个函数。 */
export const DENOISE_VIEW_WGSL = /* wgsl */ `
struct DenoiseView {
  inverseViewProjection: mat4x4f,
  previousViewProjection: mat4x4f,
  // 宽、高、第几帧、上一帧的历史能不能用
  params: vec4f,
  // 相机的位置（渲染坐标）、w 由追踪自己用
  eye: vec4f,
};

fn worldAt(inverseViewProjection: mat4x4f, uv: vec2f, z: f32) -> vec3f {
  let clip = inverseViewProjection * vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, z, 1.0);
  return clip.xyz / clip.w;
}

/** 这一帧每个 2×2 块轮到的那个像素。 */
fn blockOffset(frame: f32) -> vec2i {
  let index = u32(frame);
  return vec2i(i32(index & 1u), i32((index >> 1u) & 1u));
}
`;

/**
 * 追踪用的几个函数：按深度还原的位置、法线（模块里要有叫 depth 的深度贴图），随机数（hash、random，种子是 private 的 seed）。
 * view 是 DenoiseView 在着色器里的写法（比如 'lights.view'）。
 */
export const traceSurfaceWgsl = (view: string) => /* wgsl */ `
fn worldAtPixel(pixel: vec2i) -> vec3f {
  let size = vec2i(${view}.params.xy);
  let p = clamp(pixel, vec2i(0), size - 1);
  return worldAt(${view}.inverseViewProjection, (vec2f(p) + 0.5) / ${view}.params.xy, textureLoad(depth, p, 0));
}

/** 按深度还原的法线；还原不出来时是零向量。 */
fn depthNormal(pixel: vec2i, center: vec3f) -> vec3f {
  let last = vec2i(${view}.params.xy) - 1;
  let right = worldAtPixel(pixel + vec2i(1, 0)) - center;
  let left = center - worldAtPixel(pixel - vec2i(1, 0));
  let down = worldAtPixel(pixel + vec2i(0, 1)) - center;
  let up = center - worldAtPixel(pixel - vec2i(0, 1));
  let dx = select(select(left, right, dot(right, right) < dot(left, left)), select(right, left, pixel.x == last.x), pixel.x == 0 || pixel.x == last.x);
  let dy = select(select(up, down, dot(down, down) < dot(up, up)), select(down, up, pixel.y == last.y), pixel.y == 0 || pixel.y == last.y);
  let c = cross(dy, dx);
  if (!(dot(c, c) > 1e-20)) { return vec3f(0.0); }
  var n = normalize(c);
  if (dot(n, ${view}.eye.xyz - center) < 0.0) { n = -n; }
  return n;
}

fn hash(value: u32) -> u32 {
  let state = value * 747796405u + 2891336453u;
  let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}

var<private> seed: u32;
fn random() -> f32 {
  seed = seed * 747796405u + 2891336453u;
  var word = ((seed >> ((seed >> 28u) + 4u)) ^ seed) * 277803737u;
  word = (word >> 22u) ^ word;
  return f32(word >> 8u) / 16777216.0;
}
`;

const TEMPORAL_SHADER = /* wgsl */ `
${DENOISE_VIEW_WGSL}
@group(0) @binding(0) var<uniform> denoise: DenoiseView;
@group(0) @binding(1) var depth: texture_depth_2d;
@group(0) @binding(2) var current: texture_2d<f32>;
@group(0) @binding(3) var history: texture_2d<f32>;
@group(0) @binding(4) var linearClamp: sampler;

@fragment fn fs(in: FullscreenVaryings) -> @location(0) vec4f {
  let pixel = vec2i(in.position.xy);
  let blocks = vec2i(textureDimensions(current));
  let block = min(pixel / 2, blocks - 1);
  let now = textureLoad(current, block, 0).rgb;
  let z = textureLoad(depth, pixel, 0);
  if (z <= 0.0) { return vec4f(0.0, 0.0, 0.0, 1.0); }
  var low = now;
  var high = now;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let v = textureLoad(current, clamp(block + vec2i(x, y), vec2i(0), blocks - 1), 0).rgb;
      low = min(low, v);
      high = max(high, v);
    }
  }
  let world = worldAt(denoise.inverseViewProjection, (vec2f(pixel) + 0.5) / denoise.params.xy, z);
  let previous = denoise.previousViewProjection * vec4f(world, 1.0);
  let uv = vec2f(previous.x / previous.w * 0.5 + 0.5, 0.5 - previous.y / previous.w * 0.5);
  if (previous.w <= 0.0 || any(uv < vec2f(0.0)) || any(uv > vec2f(1.0)) || denoise.params.w < 0.5) {
    return vec4f(now, 1.0);
  }
  let past = textureSampleLevel(history, linearClamp, uv, 0.0);
  let frames = min(past.a + 1.0, ${MAX_HISTORY}.0);
  return vec4f(mix(clamp(past.rgb, low, high), now, 1.0 / frames), frames);
}
`;

/** 一遍 à-trous（步长 step.x）；step.y 是 1 时最后一遍：滤好的交给 denoiseFinish。 */
const blurShader = (finish: string) => /* wgsl */ `
${DENOISE_VIEW_WGSL}
@group(0) @binding(0) var<uniform> denoise: DenoiseView;
@group(0) @binding(1) var depth: texture_depth_2d;
@group(0) @binding(2) var source: texture_2d<f32>;
@group(0) @binding(3) var<uniform> step: vec4f;
@group(0) @binding(4) var extra: texture_2d<f32>;

fn viewDistance(pixel: vec2i) -> f32 {
  let z = textureLoad(depth, pixel, 0);
  if (z <= 0.0) { return 1e9; }
  return length(denoise.eye.xyz - worldAt(denoise.inverseViewProjection, (vec2f(pixel) + 0.5) / denoise.params.xy, z));
}

${finish}

@fragment fn fs(in: FullscreenVaryings) -> @location(0) vec4f {
  let pixel = vec2i(in.position.xy);
  let size = vec2i(denoise.params.xy);
  let d = viewDistance(pixel);
  var sum = vec3f(0.0);
  var weight = 0.0;
  if (d < 1e9) {
    for (var y = -1; y <= 1; y++) {
      for (var x = -1; x <= 1; x++) {
        let p = clamp(pixel + vec2i(x, y) * i32(step.x), vec2i(0), size - 1);
        let gap = abs(viewDistance(p) - d) / (d * 0.02);
        let w = exp(-gap * gap) * select(select(0.25, 0.5, abs(x) + abs(y) == 1), 1.0, x == 0 && y == 0);
        sum += textureLoad(source, p, 0).rgb * w;
        weight += w;
      }
    }
  }
  let filtered = select(vec3f(0.0), sum / max(weight, 1e-6), weight > 0.0);
  // extra 总要静态地用到：finish 不读它时自动推的布局里也有这个绑定
  _ = textureDimensions(extra);
  if (step.y < 0.5) { return vec4f(filtered, 1.0); }
  return denoiseFinish(filtered, pixel);
}
`;

/** 一路光追结果的降噪：自己的历史、中间贴图和结果。 */
export class ScreenDenoiser {
  readonly #device: GPUDevice;
  readonly #label: string;
  readonly #outputFormat: GPUTextureFormat;
  readonly #sampler: GPUSampler;
  readonly #temporal: FullscreenShader;
  readonly #blur: FullscreenShader;
  #steps: GPUBuffer[] | undefined;
  #history: [GPUTexture, GPUTexture] | undefined;
  #current = 0;
  #result: GPUTexture | undefined;
  /** 没有 extra 贴图时绑的 1×1 白图。 */
  #white: GPUTexture | undefined;

  /**
   * finish 是 WGSL 的 `fn denoiseFinish(filtered: vec3f, pixel: vec2i) -> vec4f`（最后一遍的输出，可以读 extra：record 给的
   * 贴图，没给时是 1×1 的白图），outputFormat 是结果的格式。
   */
  constructor(device: GPUDevice, label: string, finish: string, outputFormat: GPUTextureFormat) {
    this.#device = device;
    this.#label = label;
    this.#outputFormat = outputFormat;
    this.#sampler = device.createSampler({ label, magFilter: 'linear', minFilter: 'linear' });
    this.#temporal = new FullscreenShader(device, `${label} temporal`, TEMPORAL_SHADER);
    this.#blur = new FullscreenShader(device, `${label} blur`, blurShader(finish));
  }

  /** 管线都编好了；没编时在后台开始编。 */
  ready(): boolean {
    const warming = [this.#temporal.warm([FORMAT]), this.#blur.warm([FORMAT]), this.#blur.warm([this.#outputFormat])];
    return warming.every((pending) => pending === undefined);
  }

  /**
   * 往渲染图里加降噪的几遍，返回全分辨率的结果（下一次 record 前一直有效）。uniforms 开头是 DenoiseView，traced 是半分辨率的
   * 追踪结果（rgb）；historyValid 为 false 时（第一帧、reset 之后）从头累积，由追踪的 uniform 的 params.w 决定。
   */
  record(frame: EffectFrame, depth: GPUTexture, uniforms: GPUBuffer, traced: GPUTexture, extra?: GPUTexture): GPUTexture {
    const device = this.#device;
    const { width, height } = depth;
    this.#resize(width, height);
    const previous = this.#history![1 - this.#current]!, next = this.#history![this.#current]!;
    this.#current = 1 - this.#current;
    const accumulated = frame.graph.import({ label: `${this.#label} history`, width, height, format: FORMAT }, next.createView(), { texture: next });
    this.#temporal.draw(frame, accumulated, [{ buffer: uniforms }, depth, traced, previous, this.#sampler]);
    const steps = (this.#steps ??= [[1, 0], [2, 0], [4, 1]].map((step) => {
      const buffer = device.createBuffer({ label: `${this.#label} blur ${step[0]}`, size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(buffer, 0, new Float32Array([step[0]!, step[1]!, 0, 0]));
      return buffer;
    }));
    const white = (this.#white ??= this.#createWhite());
    let source: Parameters<FullscreenShader['draw']>[2][number] = accumulated;
    for (let k = 0; k < steps.length - 1; k++) {
      const target = frame.acquire(width, height, FORMAT, `${this.#label} blur ${k + 1}`);
      this.#blur.draw(frame, target, [{ buffer: uniforms }, depth, source, { buffer: steps[k]! }, white]);
      source = target;
    }
    const result = this.#result!;
    const target = frame.graph.import({ label: this.#label, width, height, format: this.#outputFormat }, result.createView(), { texture: result });
    this.#blur.draw(frame, target, [{ buffer: uniforms }, depth, source, { buffer: steps[steps.length - 1]! }, extra ?? white]);
    return result;
  }

  #createWhite(): GPUTexture {
    const texture = this.#device.createTexture({ label: `${this.#label} white`, size: [1, 1], format: 'r8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    this.#device.queue.writeTexture({ texture }, new Uint8Array([255]), {}, [1, 1]);
    return texture;
  }

  #resize(width: number, height: number): void {
    if (this.#result?.width === width && this.#result.height === height) return;
    for (const texture of [...(this.#history ?? []), this.#result]) texture?.destroy();
    const create = (label: string, format: GPUTextureFormat) => this.#device.createTexture({ label: `${label} ${width}x${height}`, size: [width, height], format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
    this.#history = [create(`${this.#label} history`, FORMAT), create(`${this.#label} history`, FORMAT)];
    this.#result = create(this.#label, this.#outputFormat);
  }

  destroy(): void {
    for (const buffer of this.#steps ?? []) buffer.destroy();
    for (const texture of [...(this.#history ?? []), this.#result, this.#white]) texture?.destroy();
  }
}

/** 追踪的 uniform 开头的 DenoiseView 部分（eye.w 不动，追踪自己写）；previous 是上一帧的视图投影（调用方存着，写完换成这一帧的）。 */
export function writeDenoiseView(data: Float32Array, view: RenderView, previous: ArrayLike<number>, width: number, height: number, frame: number, historyValid: boolean): void {
  data.set(view.inverseViewProjection, 0);
  data.set(previous, 16);
  data.set([width, height, frame, historyValid ? 1 : 0], 32);
  data.set([view.eye.x, view.eye.y, view.eye.z], 36);
}
