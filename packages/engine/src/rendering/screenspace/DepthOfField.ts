/**
 * 景深（物理相机，见 Camera 组件的 physical）：弥散圆按薄透镜算——直径（传感器上）= 孔径 · 焦距 / (对焦距离 − 焦距) · |z − 对焦距离| / z，
 * 孔径 = 焦距 / 光圈，再按传感器的高换成像素。和 Stride 不同：Stride 的 DepthOfField 是手调的"清楚的距离范围"加几种散景的形状，
 * 不跟镜头参数走；这里镜头参数改了（拍片时跟焦、拉焦距）景深跟着对。
 *
 * 做法照 Dennis Gustafsson 的 "Bokeh depth of field in a single pass"（2018），分三遍：
 * 1. 半分辨率：颜色（按亮度压一下，免得一个亮点糊成一大片亮斑）和带符号的弥散圆（近处为负），四个像素里取最大的那个，近处的
 *    边缘跟着糊开；
 * 2. 半分辨率的散景：黄金角螺旋上取 SAMPLES 个样本，样本自己的弥散圆盖得到这个像素才算进来（"散射当收集"）；比这个像素远的
 *    样本，弥散圆不超过这个像素的两倍——清楚的前景不会被后面的背景糊上；
 * 3. 全分辨率合成：按这个像素的弥散圆在清楚的画面和糊的画面之间插值；近处的模糊（半分辨率里插出来的负的弥散圆）盖到清楚的
 *    背景上，前景的轮廓是软的。
 */
import { Matrix } from '../../data/Matrix';
import { FullscreenShader, UniformArena, type EffectFrame, type Image } from '../postfx/ImageEffect';
import type { GraphTexture } from '../RenderGraph';
import type { CameraLens, RenderView } from '../RenderSystem';

const HDR_FORMAT: GPUTextureFormat = 'rgba16float';
/** 散景一个像素取多少样本。 */
const SAMPLES = 48;

const COMMON = /* wgsl */ `
struct Dof {
  inverseProjection: mat4x4f,
  /** xy：全分辨率的宽高；z：弥散圆的系数（像素 · 米）；w：对焦距离（米）。 */
  params: vec4f,
  /** x：最大的弥散圆（全分辨率像素）。 */
  limits: vec4f,
};
@group(0) @binding(0) var<uniform> dof: Dof;

/** 视空间里离相机多远（米，沿视线）。 */
fn viewDistance(uv: vec2f, z: f32) -> f32 {
  let p = dof.inverseProjection * vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, z, 1.0);
  return max(-p.z / p.w, 0.0001);
}

/** 带符号的弥散圆（全分辨率像素的直径）：近处为负，远处为正，限在最大值以内。 */
fn coc(distance: f32) -> f32 {
  return clamp(dof.params.z * (distance - dof.params.w) / distance, -dof.limits.x, dof.limits.x);
}
`;

/** 第 1 遍：半分辨率的颜色和弥散圆（a）。 */
const PREFILTER_SHADER = /* wgsl */ `${COMMON}
@group(0) @binding(1) var color: texture_2d<f32>;
@group(0) @binding(2) var depth: texture_depth_2d;
@fragment fn fs(in: FullscreenVaryings) -> @location(0) vec4f {
  let size = vec2i(dof.params.xy);
  let origin = vec2i(in.position.xy) * 2;
  var sum = vec3f(0.0);
  var weight = 0.0;
  var best = 0.0;
  for (var i = 0; i < 4; i++) {
    let p = min(origin + vec2i(i & 1, i >> 1), size - 1);
    let c = textureLoad(color, p, 0).rgb;
    // 按亮度压（Karis 平均）：一个特别亮的像素不会把半分辨率的整块抬亮
    let w = 1.0 / (1.0 + max(c.r, max(c.g, c.b)));
    sum += c * w;
    weight += w;
    let uv = (vec2f(p) + 0.5) / dof.params.xy;
    let r = coc(viewDistance(uv, textureLoad(depth, p, 0)));
    if (abs(r) > abs(best)) { best = r; }
  }
  // 半分辨率：弥散圆按半分辨率的像素
  return vec4f(sum / weight, best * 0.5);
}`;

/** 第 2 遍：半分辨率的散景（黄金角螺旋上收集）。 */
const BOKEH_SHADER = /* wgsl */ `${COMMON}
@group(0) @binding(1) var half: texture_2d<f32>;
@group(0) @binding(2) var linearClamp: sampler;
const GOLDEN_ANGLE = 2.39996323;
@fragment fn fs(in: FullscreenVaryings) -> @location(0) vec4f {
  let texel = 1.0 / vec2f(textureDimensions(half));
  let uv = in.position.xy * texel;
  let center = textureSampleLevel(half, linearClamp, uv, 0.0);
  let centerSize = abs(center.a);
  let radius = dof.limits.x * 0.5;
  var color = center.rgb;
  var count = 1.0;
  for (var i = 0; i < ${SAMPLES}; i++) {
    let r = radius * sqrt((f32(i) + 0.5) / ${SAMPLES}.0);
    let angle = f32(i) * GOLDEN_ANGLE;
    let s = textureSampleLevel(half, linearClamp, uv + vec2f(cos(angle), sin(angle)) * r * texel, 0.0);
    var size = abs(s.a);
    // 比这个像素远的样本不糊到清楚的前景上
    if (s.a > center.a) { size = min(size, centerSize * 2.0); }
    let m = smoothstep(r - 0.5, r + 0.5, size);
    color += mix(color / count, s.rgb, m);
    count += 1.0;
  }
  return vec4f(color / count, center.a);
}`;

/** 第 3 遍：全分辨率合成。 */
const COMPOSITE_SHADER = /* wgsl */ `${COMMON}
@group(0) @binding(1) var color: texture_2d<f32>;
@group(0) @binding(2) var depth: texture_depth_2d;
@group(0) @binding(3) var blurred: texture_2d<f32>;
@group(0) @binding(4) var linearClamp: sampler;
@fragment fn fs(in: FullscreenVaryings) -> @location(0) vec4f {
  let pixel = vec2i(in.position.xy);
  let uv = in.position.xy / dof.params.xy;
  let sharp = textureLoad(color, pixel, 0);
  let soft = textureSampleLevel(blurred, linearClamp, uv, 0.0);
  let own = abs(coc(viewDistance(uv, textureLoad(depth, pixel, 0))));
  // 弥散圆不到一个像素的是清楚的；近处的模糊（插出来的负的弥散圆）盖过来
  let t = max(smoothstep(0.5, 2.0, own), smoothstep(0.5, 2.0, -soft.a * 2.0));
  return vec4f(mix(sharp.rgb, soft.rgb, t), sharp.a);
}`;

export class DepthOfField {
  /** 最大的弥散圆（全分辨率像素的直径）：再糊的地方也不超过它（样本只取到这么远）。 */
  maxCoc = 48;

  readonly #prefilter: FullscreenShader;
  readonly #bokeh: FullscreenShader;
  readonly #composite: FullscreenShader;
  readonly #arena: UniformArena;
  readonly #uniforms = new Float32Array(24);
  readonly #inverseProjection = Matrix.identity();
  readonly #sampler: GPUSampler;

  constructor(device: GPUDevice) {
    this.#prefilter = new FullscreenShader(device, 'DepthOfField prefilter', PREFILTER_SHADER);
    this.#bokeh = new FullscreenShader(device, 'DepthOfField bokeh', BOKEH_SHADER);
    this.#composite = new FullscreenShader(device, 'DepthOfField', COMPOSITE_SHADER);
    this.#arena = new UniformArena(device, 1024);
    this.#sampler = device.createSampler({ label: 'DepthOfField', magFilter: 'linear', minFilter: 'linear' });
  }

  /** 全分辨率像素的弥散圆系数：直径 = 系数 · (z − 对焦距离) / z。 */
  static cocScale(lens: CameraLens, imageHeight: number): number {
    const f = lens.focalLength / 1000, focus = Math.max(lens.focusDistance, f * 1.001);
    const aperture = f / lens.aperture;
    return ((aperture * f) / (focus - f)) * (imageHeight / (lens.sensorHeight / 1000));
  }

  /** 往这一帧的渲染图里加景深的通道：color 是 HDR 画面，depth 是它的深度，view 的 lens 是主画面相机的镜头。返回糊过的画面。 */
  record(frame: EffectFrame, color: Image, depth: GPUTexture, view: RenderView, lens: CameraLens): GraphTexture {
    this.#arena.reset();
    const { width, height } = color;
    if (!Matrix.invert(this.#inverseProjection, view.projection)) Matrix.setIdentity(this.#inverseProjection);
    const u = this.#uniforms;
    u.set(this.#inverseProjection, 0);
    u.set([width, height, DepthOfField.cocScale(lens, height), lens.focusDistance], 16);
    u.set([this.maxCoc, 0, 0, 0], 20);
    const parameters = this.#arena.push(u);
    const halfWidth = Math.ceil(width / 2), halfHeight = Math.ceil(height / 2);
    const half = frame.acquire(halfWidth, halfHeight, HDR_FORMAT, 'DepthOfField half');
    this.#prefilter.draw(frame, half, [parameters, color, depth]);
    const bokeh = frame.acquire(halfWidth, halfHeight, HDR_FORMAT, 'DepthOfField bokeh');
    this.#bokeh.draw(frame, bokeh, [parameters, half, this.#sampler]);
    const output = frame.acquire(width, height, HDR_FORMAT, 'DepthOfField');
    this.#composite.draw(frame, output, [parameters, color, depth, bokeh, this.#sampler]);
    return output;
  }

  flush(): void {
    this.#arena.flush();
  }

  warm(): Promise<void> {
    return Promise.all([this.#prefilter.warm([HDR_FORMAT]), this.#bokeh.warm([HDR_FORMAT]), this.#composite.warm([HDR_FORMAT])]).then(() => undefined);
  }

  destroy(): void {
    this.#arena.destroy();
  }
}
