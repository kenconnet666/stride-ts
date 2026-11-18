/**
 * 光芒（Stride 的 LightStreak，默认设置）：亮部图缩到 1/4（线性，两次减半），沿 streakCount 个方向（从 phase 度起均分一圈）
 * 各做 iterationCount 轮方向采样：每轮 4 个点，间距是 4^轮次，权重按 lerp(0.7, 1, attenuation)^距离 衰减再归一，
 * 前三个点分别给 r、g、b 乘色差系数，越界的点算黑。各方向的结果乘 (1 / streakCount) · 0.2 · amount 累加，
 * 放大到 1/2、半径 3 的高斯模糊（σ 比 3），再加回画面。变形镜头（isAnamorphic）多采上下两排。
 */
import { ADDITIVE_BLEND, FullscreenShader, type RenderTargetPool, type UniformArena } from './ImageEffect';
import type { GaussianBlur } from './GaussianBlur';
import type { ImageScaler } from './ImageScaler';

const TAPS_PER_ITERATION = 4;
const MAX_STREAKS = 8;

const STREAK_SHADER = /* wgsl */ `
// direction：xy 方向，zw 一个像素的大小；aberration：xyz 色差系数，w 变形镜头的排数；
// taps：x 偏移（像素），y 权重；anamorphic：xy 偏移（像素），z 权重
struct Streak { direction: vec4f, aberration: vec4f, taps: array<vec4f, ${TAPS_PER_ITERATION}>, anamorphic: array<vec4f, 3> };
@group(0) @binding(0) var<uniform> streak: Streak;
@group(0) @binding(1) var source: texture_2d<f32>;
@group(0) @binding(2) var linearClamp: sampler;

@fragment fn fs(in: FullscreenVaryings) -> @location(0) vec4f {
  let texel = streak.direction.zw;
  let direction = streak.direction.xy * texel;
  var color = vec3f(0.0);
  for (var a = 0u; a < u32(streak.aberration.w); a++) {
    let anamorphic = streak.anamorphic[a];
    for (var i = 0u; i < ${TAPS_PER_ITERATION}u; i++) {
      let uv = in.uv + direction * streak.taps[i].x + anamorphic.xy * texel;
      var tap = textureSampleLevel(source, linearClamp, uv, 0.0).rgb;
      tap = select(tap, vec3f(0.0), any(uv < vec2f(0.0)) || any(uv > vec2f(1.0)));
      if (i == 0u) { tap.r *= streak.aberration.r; }
      else if (i == 1u) { tap.g *= streak.aberration.g; }
      else if (i == 2u) { tap.b *= streak.aberration.b; }
      color += tap * anamorphic.z * streak.taps[i].y;
    }
  }
  return vec4f(color, 1.0);
}`;

export class LightStreak {
  enabled = true;
  amount = 0.25;
  /** 方向数，0..8。 */
  streakCount = 4;
  iterationCount = 5;
  attenuation = 0.7;
  /** 第一个方向的角度（度）。 */
  phase = 30;
  colorAberrationStrength = 0.2;
  colorAberrationCoefficients: [number, number, number] = [1.2, 1.8, 2.8];
  isAnamorphic = false;
  readonly #shader: FullscreenShader;
  readonly #sampler: GPUSampler;

  constructor(device: GPUDevice, linearClamp: GPUSampler) {
    this.#shader = new FullscreenShader(device, 'LightStreak', STREAK_SHADER);
    this.#sampler = linearClamp;
  }

  /** bright 是亮部图，结果加到 output 上。 */
  draw(encoder: GPUCommandEncoder, pool: RenderTargetPool, arena: UniformArena, scaler: ImageScaler, blur: GaussianBlur, bright: GPUTexture, output: GPUTexture): void {
    const streaks = Math.min(Math.max(0, Math.trunc(this.streakCount)), MAX_STREAKS);
    if (streaks === 0 || this.iterationCount <= 0) return;
    const format = bright.format;
    const half = pool.acquire(Math.max(1, bright.width >> 1), Math.max(1, bright.height >> 1), format, 'LightStreak half');
    scaler.draw(encoder, arena, bright, half, { expanded: false });
    const quarter = pool.acquire(Math.max(1, half.width >> 1), Math.max(1, half.height >> 1), format, 'LightStreak quarter');
    scaler.draw(encoder, arena, half, quarter, { expanded: false });
    const accumulation = pool.acquire(quarter.width, quarter.height, format, 'LightStreak accumulation');
    const scratch = [pool.acquire(quarter.width, quarter.height, format, 'LightStreak scratch'), pool.acquire(quarter.width, quarter.height, format, 'LightStreak scratch')] as const;

    const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
    const aberration = this.colorAberrationCoefficients.map((c) => lerp(1, c, this.colorAberrationStrength));
    const anamorphic = this.isAnamorphic ? [[0, 4, 0.05], [0, 0, 1], [0, -4, 0.05]] : [[0, 0, 1]];
    const decay = lerp(0.7, 1, this.attenuation);
    const factor = (1 / streaks) * 0.2 * this.amount;
    let writeToA = true;
    for (let s = 0; s < streaks; s++) {
      const angle = (this.phase * Math.PI) / 180 + (s * 2 * Math.PI) / streaks;
      let current: GPUTexture = quarter;
      for (let level = 0; level < this.iterationCount; level++) {
        const passLength = TAPS_PER_ITERATION ** level;
        const weights = Array.from({ length: TAPS_PER_ITERATION }, (_, i) => decay ** (i * passLength));
        const total = weights.reduce((sum, w) => sum + w, 0);
        const parameters = new Float32Array(8 + 4 * TAPS_PER_ITERATION + 12);
        parameters.set([Math.cos(angle), Math.sin(angle), 1 / quarter.width, 1 / quarter.height, ...aberration, anamorphic.length]);
        weights.forEach((w, i) => parameters.set([i * passLength, w / total], 8 + i * 4));
        anamorphic.forEach((row, i) => parameters.set(row, 8 + 4 * TAPS_PER_ITERATION + i * 4));
        const target = writeToA ? scratch[0] : scratch[1];
        this.#shader.draw(encoder, target, [arena.push(parameters), current, this.#sampler]);
        current = target;
        writeToA = !writeToA;
      }
      // 第一个方向覆盖累加缓冲，之后的叠加（Stride 的 ColorCombiner：输出的 alpha 是 1）
      scaler.draw(encoder, arena, current, accumulation, { expanded: false, color: [factor, factor, factor, 1], ...(s > 0 ? { blend: ADDITIVE_BLEND, load: true } : {}) });
    }
    const upscaled = pool.acquire(half.width, half.height, format, 'LightStreak upscaled');
    scaler.draw(encoder, arena, accumulation, upscaled, { expanded: false });
    blur.draw(encoder, pool, arena, upscaled, upscaled, 3, 3);
    scaler.draw(encoder, arena, upscaled, output, { expanded: false, blend: ADDITIVE_BLEND, load: true });
  }
}
