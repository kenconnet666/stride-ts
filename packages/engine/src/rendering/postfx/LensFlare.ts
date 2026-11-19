/**
 * 镜头光晕（Stride 的 LensFlare，默认设置）：亮部图缩到 1/2（线性，和光芒共用），半径 8 的高斯模糊（σ 比 3）；
 * - 鬼影（FlareArtifact）：8 个以画面中心缩放（倍数为负就是翻到对面）、再按 sin(到中心的距离^d) 桶形畸变的采样，
 *   靠近边缘 10% 渐隐，各乘自己的色差颜色（按 colorAberrationStrength 插值），和乘 amount · 0.0005；
 * - 复制（FlareReplicate）：鬼影图再按 1、2.5、4、-4.5、-8 倍缩放各采一次（边缘 18% 渐隐），加上模糊亮部图的
 *   光环（-1 倍乘 haloFactor、0.1 倍乘 haloFactor / 2）和 -0.05 倍的一点；
 * 结果加回画面（AdditiveLayers，在色调映射里）。
 */
import type { AdditiveLayer } from './AdditiveLayers';
import { FullscreenShader, type Image, type ImageEffectContext } from './ImageEffect';

const ARTIFACTS = 8;

const ARTIFACT_SHADER = /* wgsl */ `
// zoom：x 缩放，y 畸变的指数；aberration：xyz 颜色
struct Flare { amount: f32, strength: f32, pad0: f32, pad1: f32, zoom: array<vec4f, ${ARTIFACTS}>, aberration: array<vec4f, ${ARTIFACTS}> };
@group(0) @binding(0) var<uniform> flare: Flare;
@group(0) @binding(1) var source: texture_2d<f32>;
@group(0) @binding(2) var linearClamp: sampler;

@fragment fn fs(in: FullscreenVaryings) -> @location(0) vec4f {
  let distanceToCenter = length(in.uv - 0.5);
  var result = vec3f(0.0);
  for (var i = 0u; i < ${ARTIFACTS}u; i++) {
    let zoom = flare.zoom[i];
    let uv = (in.uv - 0.5) * zoom.x + 0.5;
    let distortion = sin(pow(distanceToCenter, zoom.y));
    let distorted = distortion * (uv - 0.5) + 0.5;
    var tap = textureSampleLevel(source, linearClamp, distorted, 0.0).rgb;
    let near = (0.5 - abs(distorted - 0.5)) / 0.1;
    let alpha = saturate(near.x * near.y);
    tap *= alpha * alpha;
    tap = select(tap, vec3f(0.0), any(distorted < vec2f(0.0)) || any(distorted > vec2f(1.0)));
    tap *= mix(vec3f(1.0), flare.aberration[i].rgb, flare.strength);
    result += tap;
  }
  return vec4f(result * flare.amount, 1.0);
}`;

const REPLICATE_SHADER = /* wgsl */ `
struct Replicate { amount: f32, halo: f32 };
@group(0) @binding(0) var<uniform> replicate: Replicate;
@group(0) @binding(1) var artifacts: texture_2d<f32>;
@group(0) @binding(2) var bright: texture_2d<f32>;
@group(0) @binding(3) var linearClamp: sampler;

fn softBorderTap(uv: vec2f) -> vec3f {
  let near = (0.5 - abs(uv - 0.5)) / 0.18;
  let alpha = saturate(near.x * near.y);
  let color = textureSampleLevel(artifacts, linearClamp, uv, 0.0).rgb * alpha;
  return select(color, vec3f(0.0), any(uv < vec2f(0.0)) || any(uv > vec2f(1.0)));
}

@fragment fn fs(in: FullscreenVaryings) -> @location(0) vec4f {
  let centered = in.uv - 0.5;
  var result = softBorderTap(in.uv);
  result += softBorderTap(centered * 2.5 + 0.5);
  result += softBorderTap(centered * 4.0 + 0.5);
  result += softBorderTap(centered * -4.5 + 0.5);
  result += softBorderTap(centered * -8.0 + 0.5);
  result += textureSampleLevel(bright, linearClamp, centered * -1.0 + 0.5, 0.0).rgb * replicate.halo;
  result += textureSampleLevel(bright, linearClamp, centered * -0.05 + 0.5, 0.0).rgb * replicate.amount;
  result += textureSampleLevel(bright, linearClamp, centered * 0.1 + 0.5, 0.0).rgb * replicate.halo * 0.5;
  return vec4f(result, 1.0);
}`;

const DISTORTION_FACTOR = 0.39;

export class LensFlare {
  enabled = true;
  amount = 1;
  colorAberrationStrength = 0.2;
  haloFactor = 1;
  /** 每个鬼影的（缩放，畸变指数）。 */
  zoomOffsetsDistortions: [number, number][] = [
    [-3.2 * DISTORTION_FACTOR, 1.4], [-5.6 * DISTORTION_FACTOR, 1.4], [-3.2 * DISTORTION_FACTOR, 0.5], [-0.96 * DISTORTION_FACTOR, -0.2],
    [-1.14 * DISTORTION_FACTOR, -0.2], [-1.14 * DISTORTION_FACTOR, -0.23], [-1.49 * DISTORTION_FACTOR, -0.2], [-1.52 * DISTORTION_FACTOR, -0.2],
  ];
  colorAberrations: [number, number, number][] = [
    [0.5, 0.6, 1.6], [0.8, 0.9, 1.2], [0.3, 1.0, 0.3], [0.5, 0.8, 1.5], [1.5, 0.5, 0.8], [1.5, 0.5, 0.8], [0.2, 1.5, 0.3], [0.2, 1.5, 0.3],
  ];
  readonly #artifact: FullscreenShader;
  readonly #replicate: FullscreenShader;
  readonly #sampler: GPUSampler;

  constructor(device: GPUDevice, linearClamp: GPUSampler) {
    this.#artifact = new FullscreenShader(device, 'LensFlare artifacts', ARTIFACT_SHADER);
    this.#replicate = new FullscreenShader(device, 'LensFlare replicate', REPLICATE_SHADER);
    this.#sampler = linearClamp;
  }

  /** half 是缩到 1/2 的亮部图（线性），返回要加回画面的一层。 */
  draw({ frame, arena, blur }: ImageEffectContext, half: Image): AdditiveLayer {
    if (this.zoomOffsetsDistortions.length !== ARTIFACTS || this.colorAberrations.length !== ARTIFACTS) {
      throw new RangeError(`LensFlare needs ${ARTIFACTS} zoomOffsetsDistortions and colorAberrations`);
    }
    const format = half.format;
    const blurred = frame.acquire(half.width, half.height, format, 'LensFlare blurred');
    blur.draw(frame, arena, half, blurred, 8, 3);

    const amount = this.amount * 0.0005;
    const parameters = new Float32Array(4 + ARTIFACTS * 8);
    parameters.set([amount, this.colorAberrationStrength]);
    this.zoomOffsetsDistortions.forEach((zoom, i) => parameters.set(zoom, 4 + i * 4));
    this.colorAberrations.forEach((color, i) => parameters.set(color, 4 + ARTIFACTS * 4 + i * 4));
    const artifacts = frame.acquire(half.width, half.height, format, 'LensFlare artifacts');
    this.#artifact.draw(frame, artifacts, [arena.push(parameters), blurred, this.#sampler]);

    const flare = frame.acquire(half.width, half.height, format, 'LensFlare');
    this.#replicate.draw(frame, flare, [arena.push([amount, amount * this.haloFactor]), artifacts, blurred, this.#sampler]);
    return { texture: flare, expanded: false };
  }
}
