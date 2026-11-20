/**
 * 运动模糊（Stride 没有）：按运动向量沿运动方向模糊，做法照 McGuire 等人的 "A Reconstruction Filter for Plausible Motion
 * Blur"（I3D 2012）：
 *
 * 1. 每 16x16 的块里最长的运动（tile max），再取 3x3 块里最长的（neighbor max）——快速移动的物体会糊到它原来不在的像素上，
 *    那些像素自己的运动向量是背景的，要从邻近的块知道附近有东西在动；
 * 2. 每个像素沿 neighbor max 的方向取 12 个样本，按深度分前景、背景：前景的样本按它自己的运动长度盖过来，背景的样本只在
 *    这个像素自己在动时混进来，所以物体的轮廓糊得自然，背景不会糊进静止的前景。
 *
 * 运动按快门（默认半帧，180 度快门）缩放，最长 32 像素。运动向量那一遍（ForwardRenderer 的 velocity）本来是 TAA 用的，开着
 * 运动模糊时不开 TAA 也画。没画到的像素（天空）按深度和上一帧的视图投影算（相机转动时天空也糊）。
 */
import { Matrix } from '../../data/Matrix';
import { FullscreenShader, UniformArena, type EffectFrame, type Image } from '../postfx/ImageEffect';
import type { GraphTexture } from '../RenderGraph';
import type { RenderView } from '../RenderSystem';

const TILE = 16;
const TILE_FORMAT: GPUTextureFormat = 'rg16float';
const HDR_FORMAT: GPUTextureFormat = 'rgba16float';
/** 运动向量里"这个像素没画"的标记（同 ForwardRenderer）。 */
const NO_VELOCITY = 4;

const COMMON = /* wgsl */ `
struct Blur {
  inverseViewProjection: mat4x4f,
  previousViewProjection: mat4x4f,
  inverseProjection: mat4x4f,
  /** xy：宽高（像素）；z：快门（运动乘它）；w：最长几个像素。 */
  params: vec4f,
  /** x：第几帧（样本错开用）。 */
  frame: vec4f,
};
@group(0) @binding(0) var<uniform> blur: Blur;
@group(0) @binding(1) var velocity: texture_2d<f32>;
@group(0) @binding(2) var depth: texture_depth_2d;

/** 这个像素在画面上动了多少像素（快门、最长都算上）。 */
fn motion(pixel: vec2i) -> vec2f {
  var v = textureLoad(velocity, pixel, 0).xy;
  if (v.x >= ${NO_VELOCITY / 2}.0) {
    // 没画的像素：按深度和上一帧的视图投影算
    let uv = (vec2f(pixel) + 0.5) / blur.params.xy;
    let z = textureLoad(depth, pixel, 0);
    let world = blur.inverseViewProjection * vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, z, 1.0);
    let previous = blur.previousViewProjection * vec4f(world.xyz / world.w, 1.0);
    if (previous.w <= 0.0) {
      return vec2f(0.0);
    }
    let ndc = previous.xy / previous.w;
    v = vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5) - uv;
  }
  let pixels = v * blur.params.xy * blur.params.z;
  let length = length(pixels);
  return select(pixels, pixels * (blur.params.w / length), length > blur.params.w);
}
`;

/** 每块里最长的运动。 */
const TILE_MAX_SHADER = /* wgsl */ `${COMMON}
@fragment fn fs(in: FullscreenVaryings) -> @location(0) vec4f {
  let origin = vec2i(in.position.xy) * ${TILE};
  let size = vec2i(blur.params.xy);
  var best = vec2f(0.0);
  for (var y = 0; y < ${TILE}; y++) {
    for (var x = 0; x < ${TILE}; x++) {
      let p = origin + vec2i(x, y);
      if (any(p >= size)) { continue; }
      let m = motion(p);
      if (dot(m, m) > dot(best, best)) { best = m; }
    }
  }
  return vec4f(best, 0.0, 1.0);
}`;

/** 3x3 块里最长的。 */
const NEIGHBOR_MAX_SHADER = /* wgsl */ `
@group(0) @binding(0) var tiles: texture_2d<f32>;
@fragment fn fs(in: FullscreenVaryings) -> @location(0) vec4f {
  let tile = vec2i(in.position.xy);
  let size = vec2i(textureDimensions(tiles));
  var best = vec2f(0.0);
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let m = textureLoad(tiles, clamp(tile + vec2i(x, y), vec2i(0), size - 1), 0).xy;
      if (dot(m, m) > dot(best, best)) { best = m; }
    }
  }
  return vec4f(best, 0.0, 1.0);
}`;

/** 重建：沿 neighbor max 的方向取样，按深度分前景、背景加权。 */
const RECONSTRUCT_SHADER = /* wgsl */ `${COMMON}
@group(0) @binding(3) var neighbors: texture_2d<f32>;
@group(0) @binding(4) var color: texture_2d<f32>;

const SAMPLES = 12;

fn viewDepth(pixel: vec2i) -> f32 {
  let z = textureLoad(depth, pixel, 0);
  let p = blur.inverseProjection * vec4f(0.0, 0.0, z, 1.0);
  return -p.z / p.w;
}

/** a 比 b 近（a 在前面）的程度，软的比较（1 厘米量级的过渡按深度放大）。 */
fn closer(a: f32, b: f32) -> f32 {
  return saturate(1.0 - (a - b) / max(0.01 * b, 0.0001));
}

fn cone(distance: f32, velocity: f32) -> f32 {
  return saturate(1.0 - distance / max(velocity, 0.0001));
}

fn cylinder(distance: f32, velocity: f32) -> f32 {
  return 1.0 - smoothstep(0.95 * velocity, 1.05 * velocity, distance);
}

@fragment fn fs(in: FullscreenVaryings) -> @location(0) vec4f {
  let pixel = vec2i(in.position.xy);
  let size = vec2i(blur.params.xy);
  let base = textureLoad(color, pixel, 0);
  let tileSize = vec2i(textureDimensions(neighbors));
  let vn = textureLoad(neighbors, min(pixel / ${TILE}, tileSize - 1), 0).xy;
  let vnLength = length(vn);
  // 附近都没在动（不到半个像素）：原样
  if (vnLength < 0.5) {
    return base;
  }
  let vc = motion(pixel);
  let vcLength = max(length(vc), 0.5);
  let zc = viewDepth(pixel);
  // 样本沿 [-1/2, 1/2] 的运动均匀分布，每个像素、每帧错开一点
  let jitter = fract(52.9829189 * fract(dot(vec2f(pixel), vec2f(0.06711056, 0.00583715)) + blur.frame.x * 0.618)) - 0.5;
  var weight = 1.0 / vcLength;
  var sum = base.rgb * weight;
  for (var i = 0; i < SAMPLES; i++) {
    let t = mix(-0.5, 0.5, (f32(i) + 0.5 + jitter) / f32(SAMPLES));
    let p = clamp(pixel + vec2i(round(vn * t)), vec2i(0), size - 1);
    let distance = abs(t) * vnLength;
    let zs = viewDepth(p);
    let vsLength = max(length(motion(p)), 0.5);
    let foreground = closer(zs, zc);
    let background = closer(zc, zs);
    let w = foreground * cone(distance, vsLength) + background * cone(distance, vcLength)
      + cylinder(distance, vsLength) * cylinder(distance, vcLength) * 2.0;
    sum += textureLoad(color, p, 0).rgb * w;
    weight += w;
  }
  return vec4f(sum / weight, base.a);
}`;

export class MotionBlur {
  /** 默认关：Stride 没有它。 */
  enabled = false;
  /** 快门：曝光占一帧的多少（0.5 是 180 度快门）。 */
  shutter = 0.5;
  /** 最长糊几个像素。 */
  maxPixels = 32;

  readonly #tileMax: FullscreenShader;
  readonly #neighborMax: FullscreenShader;
  readonly #reconstruct: FullscreenShader;
  readonly #arena: UniformArena;
  readonly #uniforms = new Float32Array(56);
  readonly #inverseProjection = Matrix.identity();
  #frame = 0;

  constructor(device: GPUDevice) {
    this.#tileMax = new FullscreenShader(device, 'MotionBlur tile max', TILE_MAX_SHADER);
    this.#neighborMax = new FullscreenShader(device, 'MotionBlur neighbor max', NEIGHBOR_MAX_SHADER);
    this.#reconstruct = new FullscreenShader(device, 'MotionBlur', RECONSTRUCT_SHADER);
    this.#arena = new UniformArena(device, 1024);
  }

  /**
   * 往这一帧的渲染图里加运动模糊的通道：color 是 HDR 画面，velocity 是运动向量，depth 是它的深度；view 的 previousViewProjection
   * 要是上一帧的（ForwardRenderer 维护）。返回模糊过的画面。
   */
  record(frame: EffectFrame, color: Image, depth: GPUTexture, velocity: GraphTexture, view: RenderView): GraphTexture {
    this.#arena.reset();
    const { width, height } = color;
    if (!Matrix.invert(this.#inverseProjection, view.projection)) Matrix.setIdentity(this.#inverseProjection);
    const u = this.#uniforms;
    u.set(view.inverseViewProjection, 0);
    u.set(view.previousViewProjection, 16);
    u.set(this.#inverseProjection, 32);
    u.set([width, height, this.shutter, this.maxPixels], 48);
    u.set([this.#frame++ % 64, 0, 0, 0], 52);
    const parameters = this.#arena.push(u);
    const tiles = frame.acquire(Math.ceil(width / TILE), Math.ceil(height / TILE), TILE_FORMAT, 'MotionBlur tiles');
    this.#tileMax.draw(frame, tiles, [parameters, velocity, depth]);
    const neighbors = frame.acquire(tiles.width, tiles.height, TILE_FORMAT, 'MotionBlur neighbors');
    this.#neighborMax.draw(frame, neighbors, [tiles]);
    const blurred = frame.acquire(width, height, HDR_FORMAT, 'MotionBlur');
    this.#reconstruct.draw(frame, blurred, [parameters, velocity, depth, neighbors, color]);
    return blurred;
  }

  flush(): void {
    this.#arena.flush();
  }

  warm(): Promise<void> {
    return Promise.all([this.#tileMax.warm([TILE_FORMAT]), this.#neighborMax.warm([TILE_FORMAT]), this.#reconstruct.warm([HDR_FORMAT])]).then(() => undefined);
  }

  destroy(): void {
    this.#arena.destroy();
  }
}

