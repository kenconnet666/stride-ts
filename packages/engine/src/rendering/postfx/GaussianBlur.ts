/**
 * 可分离的高斯模糊（Stride 的 GaussianBlur）：先横后竖两遍。权重和偏移照 GaussianUtil.Calculate1D：σ = 半径 / sigmaRatio，
 * 相邻两个像素合成一次落在它们之间的线性采样，所以半径 r 只要 (r + 1) / 2 + 1 次采样（对称的两边各一次）。
 */
import { FullscreenShader, type RenderTargetPool, type UniformArena } from './ImageEffect';

/** 一遍最多的采样组数：半径到 2 · (MAX_TAPS - 1)。 */
const MAX_TAPS = 32;

const BLUR_SHADER = /* wgsl */ `
struct Blur { direction: vec2f, count: f32, pad: f32, offsetsWeights: array<vec4f, ${MAX_TAPS}> };
@group(0) @binding(0) var<uniform> blur: Blur;
@group(0) @binding(1) var source: texture_2d<f32>;
@group(0) @binding(2) var linearClamp: sampler;

@fragment fn fs(in: FullscreenVaryings) -> @location(0) vec4f {
  var value = textureSampleLevel(source, linearClamp, in.uv, 0.0).rgb * blur.offsetsWeights[0].y;
  for (var i = 1u; i < u32(blur.count); i++) {
    let tap = blur.offsetsWeights[i];
    value += textureSampleLevel(source, linearClamp, in.uv - blur.direction * tap.x, 0.0).rgb * tap.y;
    value += textureSampleLevel(source, linearClamp, in.uv + blur.direction * tap.x, 0.0).rgb * tap.y;
  }
  return vec4f(value, 1.0);
}`;

/** 每组 (偏移，权重)，第 0 组是中心（偏移 0）。权重的和（两边都算）是 1。 */
export function gaussianOffsetsWeights(radius: number, sigmaRatio: number): [number, number][] {
  const r = Math.max(1, radius);
  let sigma = r / sigmaRatio;
  if (Math.abs(sigma) < 1e-6) sigma = r / 2;
  const inner = 1 / (2 * sigma * sigma);
  const taps: [number, number][] = [[0, 1]];
  let total = 1;
  for (let i = 1; i <= r; i += 2) {
    const w0 = Math.exp(-(i * i) * inner);
    if (i === r) {
      taps.push([i, w0]);
      total += 2 * w0;
    } else {
      const w1 = Math.exp(-((i + 1) * (i + 1)) * inner);
      taps.push([i + w1 / (w0 + w1), w0 + w1]);
      total += 2 * (w0 + w1);
    }
  }
  return taps.map(([offset, weight]) => [offset, weight / total]);
}

export class GaussianBlur {
  readonly #shader: FullscreenShader;
  readonly #sampler: GPUSampler;

  constructor(device: GPUDevice, linearClamp: GPUSampler) {
    this.#shader = new FullscreenShader(device, 'GaussianBlur', BLUR_SHADER);
    this.#sampler = linearClamp;
  }

  /** input 模糊后写进 output（可以是同一张：横向的结果先写进借来的纹理）。 */
  draw(encoder: GPUCommandEncoder, pool: RenderTargetPool, arena: UniformArena, input: GPUTexture, output: GPUTexture, radius: number, sigmaRatio: number): void {
    const taps = gaussianOffsetsWeights(radius, sigmaRatio);
    if (taps.length > MAX_TAPS) throw new RangeError(`GaussianBlur supports a radius up to ${2 * (MAX_TAPS - 1)}, got ${radius}`);
    const packed = new Float32Array(4 + MAX_TAPS * 4);
    taps.forEach(([offset, weight], i) => packed.set([offset, weight], 4 + i * 4));
    const horizontal = pool.acquire(input.width, input.height, input.format, 'GaussianBlur horizontal');
    const pass = (source: GPUTexture, target: GPUTexture, dx: number, dy: number) => {
      packed.set([dx / source.width, dy / source.height, taps.length, 0]);
      this.#shader.draw(encoder, target, [arena.push(packed), source, this.#sampler]);
    };
    pass(input, horizontal, 1, 0);
    pass(horizontal, output, 0, 1);
  }
}
