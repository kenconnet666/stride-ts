/**
 * 时间抗锯齿（TAA）加锐化：主画面的投影每帧挪一个亚像素（Halton(2, 3) 的 8 个点），把这一帧和重投影过来的历史画面混合，
 * 几帧下来每个像素就是多个采样点的平均。混合完再锐化一遍（历史里存的是没锐化的，锐化不会一帧帧累积）。
 *
 * - 重投影：网格画了运动向量（RenderStage.velocity：世界矩阵、蒙皮、形变都按上一帧的再算一次位置），会动的、蒙皮的物体
 *   都跟得上；没画运动向量的像素（天空）按深度缓冲还原到世界、用上一帧的视图投影投回去，只跟相机。
 * - 邻域裁剪：历史的颜色裁进这一帧 3x3 邻域的方差包围盒（YCoCg 空间，Salvi 2016 的 variance clipping），物体移开、
 *   被遮住的地方历史作废，不拖影。深度取 3x3 里最近的（边缘上用前景的运动）。
 * - 历史按 Catmull-Rom 采样（5 次双线性，Jimenez 2016），比双线性少糊。
 * - 混合在压缩过的颜色空间里做（c / (1 + 亮度)，Karis 2014）：特别亮的像素不会一闪一闪。
 * - 锐化：照 AMD 的 CAS（对比度自适应锐化）的做法，按邻域的对比度定锐化的量，平坦的地方不放大噪点。
 *
 * Stride 的样例都用 FXAA，所以默认还是 FXAA（照内容画），TAA 是选项。
 */
import { Matrix } from '../mathematics/Matrix';
import type { GraphTexture } from './graph/RenderGraph';
import { FullscreenShader, UniformArena, type EffectFrame, type Image } from './postfx/ImageEffect';
import type { RenderView } from './RenderSystem';

const HISTORY_FORMAT: GPUTextureFormat = 'rgba16float';
/** 抖动的点数：Halton(2, 3) 的前 8 个，8 帧一轮。 */
const JITTER_SAMPLES = 8;

const RESOLVE_SHADER = /* wgsl */ `
struct Taa {
  // 这一帧（挪过的）视图投影的逆：像素加深度还原到世界
  inverseViewProjection: mat4x4f,
  // 上一帧没挪过的视图投影：投回上一帧的画面
  previousViewProjection: mat4x4f,
  // 一个像素的大小（xy）、历史的权重、1 是这一帧不要历史
  params: vec4f,
  // 裁剪的包围盒宽几个标准差
  clip: vec4f,
};
@group(0) @binding(0) var<uniform> taa: Taa;
@group(0) @binding(1) var current: texture_2d<f32>;
@group(0) @binding(2) var depth: texture_depth_2d;
@group(0) @binding(3) var history: texture_2d<f32>;
@group(0) @binding(4) var linearClamp: sampler;
// 运动向量：上一帧的 UV 减这一帧的；没画的像素（天空）是 NO_VELOCITY
@group(0) @binding(5) var velocity: texture_2d<f32>;
const NO_VELOCITY = 4.0;

fn luma(c: vec3f) -> f32 { return dot(c, vec3f(0.2126, 0.7152, 0.0722)); }
// 压缩：亮的像素在混合、裁剪里不占太大分量（Karis 2014）
fn compress(c: vec3f) -> vec3f { return c / (1.0 + luma(c)); }
fn uncompress(c: vec3f) -> vec3f { return c / max(1.0 - luma(c), 1e-4); }
fn toYCoCg(c: vec3f) -> vec3f {
  return vec3f(dot(c, vec3f(0.25, 0.5, 0.25)), dot(c, vec3f(0.5, 0.0, -0.5)), dot(c, vec3f(-0.25, 0.5, -0.25)));
}
fn fromYCoCg(c: vec3f) -> vec3f { return vec3f(c.x + c.y - c.z, c.x + c.z, c.x - c.y - c.z); }

fn load(p: vec2i) -> vec3f {
  let size = vec2i(textureDimensions(current));
  return max(textureLoad(current, clamp(p, vec2i(0), size - 1), 0).rgb, vec3f(0.0));
}

// Catmull-Rom 的 5 次双线性（去掉四个角，Jimenez 2016）
fn sampleHistory(uv: vec2f) -> vec3f {
  let size = vec2f(textureDimensions(history));
  let position = uv * size;
  let center = floor(position - 0.5) + 0.5;
  let f = position - center;
  let w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  let w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  let w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  let w3 = f * f * (-0.5 + 0.5 * f);
  let w12 = w1 + w2;
  let tc0 = (center - 1.0) / size;
  let tc3 = (center + 2.0) / size;
  let tc12 = (center + w2 / w12) / size;
  var color = textureSampleLevel(history, linearClamp, vec2f(tc12.x, tc0.y), 0.0).rgb * (w12.x * w0.y);
  color += textureSampleLevel(history, linearClamp, vec2f(tc0.x, tc12.y), 0.0).rgb * (w0.x * w12.y);
  color += textureSampleLevel(history, linearClamp, tc12, 0.0).rgb * (w12.x * w12.y);
  color += textureSampleLevel(history, linearClamp, vec2f(tc3.x, tc12.y), 0.0).rgb * (w3.x * w12.y);
  color += textureSampleLevel(history, linearClamp, vec2f(tc12.x, tc3.y), 0.0).rgb * (w12.x * w3.y);
  let weight = w12.x * w0.y + w0.x * w12.y + w12.x * w12.y + w3.x * w12.y + w12.x * w3.y;
  return max(color / weight, vec3f(0.0));
}

// 把历史往邻域的平均值那边裁，裁进包围盒为止（Playdead 2016）
fn clipToBox(previous: vec3f, low: vec3f, high: vec3f) -> vec3f {
  let center = 0.5 * (high + low);
  let extent = 0.5 * (high - low) + 1e-5;
  let offset = previous - center;
  let units = abs(offset / extent);
  let largest = max(units.x, max(units.y, units.z));
  return select(previous, center + offset / largest, largest > 1.0);
}

@fragment fn fs(in: FullscreenVaryings) -> @location(0) vec4f {
  let pixel = vec2i(in.position.xy);
  let size = vec2i(textureDimensions(current));
  var m1 = vec3f(0.0);
  var m2 = vec3f(0.0);
  var closest = 1.0;
  var closestPixel = pixel;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let p = clamp(pixel + vec2i(x, y), vec2i(0), size - 1);
      let c = toYCoCg(compress(load(p)));
      m1 += c;
      m2 += c * c;
      let d = textureLoad(depth, p, 0);
      if (d < closest) {
        closest = d;
        closestPixel = p;
      }
    }
  }
  let centerColor = load(pixel);
  if (taa.params.w > 0.5) { return vec4f(centerColor, 1.0); }

  // 重投影：画了运动向量的像素（网格，连会动的、蒙皮的）照它，3x3 里最近的那个（边缘上跟前景走）；别的按深度还原到世界、
  // 投回上一帧（只跟相机）
  let motion = textureLoad(velocity, closestPixel, 0).xy;
  var previousUv = in.uv + motion;
  var behind = false;
  if (motion.x >= NO_VELOCITY * 0.5) {
    let ndc = vec2f(in.uv.x * 2.0 - 1.0, 1.0 - in.uv.y * 2.0);
    let world = taa.inverseViewProjection * vec4f(ndc, closest, 1.0);
    let previous = taa.previousViewProjection * vec4f(world.xyz / world.w, 1.0);
    let previousNdc = previous.xy / previous.w;
    previousUv = vec2f(previousNdc.x * 0.5 + 0.5, 0.5 - previousNdc.y * 0.5);
    behind = previous.w <= 0.0;
  }
  if (behind || any(previousUv < vec2f(0.0)) || any(previousUv > vec2f(1.0))) { return vec4f(centerColor, 1.0); }

  let mean = m1 / 9.0;
  let sigma = sqrt(max(m2 / 9.0 - mean * mean, vec3f(0.0)));
  let low = mean - taa.clip.x * sigma;
  let high = mean + taa.clip.x * sigma;
  let historyColor = clipToBox(toYCoCg(compress(sampleHistory(previousUv))), low, high);
  let blended = mix(toYCoCg(compress(centerColor)), historyColor, taa.params.z);
  return vec4f(uncompress(fromYCoCg(blended)), 1.0);
}`;

const SHARPEN_SHADER = /* wgsl */ `
// x：锐化的强度（0 到 1）
struct Sharpen { amount: vec4f };
@group(0) @binding(0) var<uniform> sharpen: Sharpen;
@group(0) @binding(1) var source: texture_2d<f32>;

fn luma(c: vec3f) -> f32 { return dot(c, vec3f(0.2126, 0.7152, 0.0722)); }
fn tap(p: vec2i) -> vec3f {
  let size = vec2i(textureDimensions(source));
  let c = max(textureLoad(source, clamp(p, vec2i(0), size - 1), 0).rgb, vec3f(0.0));
  return c / (1.0 + luma(c));
}

// CAS 的十字形：按邻域的最小、最大值定锐化的量，对比度高的地方少锐化（不出白边）
@fragment fn fs(in: FullscreenVaryings) -> @location(0) vec4f {
  let p = vec2i(in.position.xy);
  let e = tap(p);
  let b = tap(p + vec2i(0, -1));
  let d = tap(p + vec2i(-1, 0));
  let f = tap(p + vec2i(1, 0));
  let h = tap(p + vec2i(0, 1));
  let low = min(e, min(min(b, d), min(f, h)));
  let high = max(e, max(max(b, d), max(f, h)));
  let amp = sqrt(clamp(min(low, 1.0 - high) / max(high, vec3f(1e-4)), vec3f(0.0), vec3f(1.0)));
  let w = amp * (-1.0 / mix(8.0, 5.0, sharpen.amount.x));
  let sharpened = clamp((b + d + f + h) * w + e, vec3f(0.0), vec3f(0.9999)) / (1.0 + 4.0 * w);
  let c = clamp(sharpened, vec3f(0.0), vec3f(0.9999));
  return vec4f(c / max(1.0 - luma(c), 1e-4), 1.0);
}`;

/** Halton 序列的第 index 项（index 从 1 起）。 */
export function halton(index: number, base: number): number {
  let result = 0, fraction = 1 / base;
  for (let i = index; i > 0; i = Math.floor(i / base), fraction /= base) result += fraction * (i % base);
  return result;
}

/** 把投影在屏幕上挪 (x, y) 个像素：裁剪空间的 x、y 加上 w 的倍数，透视和正交的投影都对（列主序，m[列 * 4 + 行]）。 */
export function jitterProjection(projection: Float32Array, x: number, y: number, width: number, height: number): void {
  const dx = (2 * x) / width, dy = (-2 * y) / height;
  for (let column = 0; column < 4; column++) {
    projection[column * 4] = projection[column * 4]! + dx * projection[column * 4 + 3]!;
    projection[column * 4 + 1] = projection[column * 4 + 1]! + dy * projection[column * 4 + 3]!;
  }
}

export class TemporalAntialiasing {
  /** 开着时主画面用 TAA，后处理里的 FXAA 不做（合成器的抗锯齿和画质档位也要开着）。 */
  enabled = false;
  /** 历史的权重：越大越稳越糊、动起来拖影越长。 */
  feedback = 0.9;
  /** 裁剪的包围盒宽几个标准差：越小拖影越少、越容易闪。 */
  clipSigma = 1.25;
  /** 锐化的强度，0 到 1；0 不锐化（省一遍）。 */
  sharpness = 0.4;
  readonly #device: GPUDevice;
  readonly #resolve: FullscreenShader;
  readonly #sharpen: FullscreenShader;
  readonly #sampler: GPUSampler;
  readonly #arena: UniformArena;
  /** 两张历史，轮着读写。 */
  #history: [GPUTexture, GPUTexture] | undefined;
  #current = 0;
  /** 下一帧不用历史（刚开、尺寸变了、切了场景）。 */
  #reset = true;
  #frame = 0;
  /** 这一帧和上一帧没挪过的视图投影矩阵。 */
  readonly #viewProjection = Matrix.identity();
  readonly #previousViewProjection = Matrix.identity();
  /** 挪之前的投影：场景画完以后放回去（之后画的调试线、场景里的 UI 不抖）。 */
  readonly #projection = Matrix.identity();

  constructor(device: GPUDevice) {
    this.#device = device;
    this.#resolve = new FullscreenShader(device, 'TAA resolve', RESOLVE_SHADER);
    this.#sharpen = new FullscreenShader(device, 'TAA sharpen', SHARPEN_SHADER);
    this.#sampler = device.createSampler({ label: 'TAA history', magFilter: 'linear', minFilter: 'linear' });
    this.#arena = new UniformArena(device, 1024);
  }

  /** 下一帧从头开始积累（切场景、相机跳到别处时调）。 */
  reset(): void {
    this.#reset = true;
  }

  /**
   * 这一帧主画面的投影挪一个亚像素（在视图的矩阵算好以后、剔除和画之前调）。记下没挪过的视图投影，下一帧重投影用。
   */
  jitter(view: RenderView): void {
    this.#previousViewProjection.set(this.#viewProjection);
    this.#viewProjection.set(view.viewProjection);
    this.#projection.set(view.projection);
    // 运动向量用这两个（不带亚像素的抖动，否则静止的画面也有运动）
    view.unjitteredViewProjection.set(this.#viewProjection);
    view.previousViewProjection.set(this.#previousViewProjection);
    const index = (this.#frame++ % JITTER_SAMPLES) + 1;
    jitterProjection(view.projection, halton(index, 2) - 0.5, halton(index, 3) - 0.5, view.width, view.height);
    view.update();
  }

  /** 把 jitter 挪过的投影放回去。 */
  unjitter(view: RenderView): void {
    view.projection.set(this.#projection);
    view.update();
  }

  /**
   * 往这一帧的渲染图里加 TAA 的通道：color 是主画面（挪过的投影画的），depth 是它的深度缓冲（要带 TEXTURE_BINDING），
   * view 是主视图（jitter 之后的矩阵），velocity 是运动向量（ForwardRenderer 画的）。返回抗锯齿、锐化过的画面，交给后处理。
   */
  record(frame: EffectFrame, color: GraphTexture, depth: GPUTexture, view: RenderView, velocity: GraphTexture): Image {
    this.#arena.reset();
    const { width, height } = color;
    if (this.#history?.[0].width !== width || this.#history[0].height !== height) {
      this.#history?.forEach((texture) => texture.destroy());
      const create = (i: number) => this.#device.createTexture({ label: `TAA history ${i}`, size: [width, height], format: HISTORY_FORMAT, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
      this.#history = [create(0), create(1)];
      this.#reset = true;
    }
    const read = this.#history[this.#current]!, write = this.#history[1 - this.#current]!;
    this.#current = 1 - this.#current;
    const parameters = new Float32Array(40);
    parameters.set(view.inverseViewProjection, 0);
    parameters.set(this.#previousViewProjection, 16);
    parameters.set([1 / width, 1 / height, this.feedback, this.#reset ? 1 : 0, this.clipSigma, 0, 0, 0], 32);
    this.#reset = false;
    this.#resolve.draw(frame, write, [this.#arena.push(parameters), color, depth, read, this.#sampler, velocity]);
    if (this.sharpness <= 0) return write;
    const sharpened = frame.acquire(width, height, HISTORY_FORMAT, 'TAA sharpened');
    this.#sharpen.draw(frame, sharpened, [this.#arena.push([this.sharpness, 0, 0, 0]), write]);
    return sharpened;
  }

  /** 这一帧录的通道执行完以后调：参数写进 GPU。 */
  flush(): void {
    this.#arena.flush();
  }

  /** 在后台编好两条管线（运行中打开 TAA 的那一帧不用当场编译）。 */
  warm(): Promise<void> {
    return Promise.all([this.#resolve.warm([HISTORY_FORMAT]), this.#sharpen.warm([HISTORY_FORMAT])]).then(() => undefined);
  }

  destroy(): void {
    this.#history?.forEach((texture) => texture.destroy());
    this.#history = undefined;
    this.#arena.destroy();
  }
}
