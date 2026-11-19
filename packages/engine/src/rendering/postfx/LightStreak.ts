/**
 * 光芒（Stride 的 LightStreak，默认设置）：亮部图缩到 1/4（线性，两次减半；第一次的 1/2 和镜头光晕共用），沿 streakCount 个方向
 * （从 phase 度起均分一圈）各做 iterationCount 轮方向采样：每轮 4 个点，间距是 4^轮次，权重按 lerp(0.7, 1, attenuation)^距离
 * 衰减再归一，前三个点分别给 r、g、b 乘色差系数，越界的点算黑。各方向的结果乘 (1 / streakCount) · 0.2 · amount 累加，
 * 放大到 1/2、半径 3 的高斯模糊（σ 比 3），再加回画面（AdditiveLayers，在色调映射里）。变形镜头（isAnamorphic）多采上下两排。
 *
 * 和 Stride 的结果相同，通道的组织不同：Stride 每个方向每轮一个通道，再一个方向一个通道累加（默认 4 · 5 + 4 个）。
 * 这些通道都在 1/4 的小图上，耗时主要是通道本身的固定开销，所以这里一个通道同时算 4 个方向（4 个渲染目标），
 * 最后一轮直接把 4 个方向乘系数加起来写进累加缓冲（默认 5 个通道）。
 */
import type { AdditiveLayer } from './AdditiveLayers';
import { ADD_BLEND, FullscreenShader, type Image, type ImageEffectContext } from './ImageEffect';

const TAPS_PER_ITERATION = 4;
const MAX_STREAKS = 8;
/** 一个通道同时算的方向数（渲染目标数）。 */
const BATCH = 4;

const STREAK_COMMON = /* wgsl */ `
// directions：xy 方向，z 最后一轮求和时的系数（空着的槽位是 0）；texel：xy 一个像素的大小；
// aberration：xyz 色差系数，w 变形镜头的排数；taps：x 偏移（像素），y 权重；anamorphic：xy 偏移（像素），z 权重
struct Streak { directions: array<vec4f, ${BATCH}>, texel: vec4f, aberration: vec4f, taps: array<vec4f, ${TAPS_PER_ITERATION}>, anamorphic: array<vec4f, 3> };
@group(0) @binding(0) var<uniform> streak: Streak;
@group(0) @binding(1) var source0: texture_2d<f32>;
@group(0) @binding(2) var source1: texture_2d<f32>;
@group(0) @binding(3) var source2: texture_2d<f32>;
@group(0) @binding(4) var source3: texture_2d<f32>;
@group(0) @binding(5) var linearClamp: sampler;

fn streakTaps(source: texture_2d<f32>, direction: vec2f, uv: vec2f) -> vec3f {
  let texel = streak.texel.xy;
  let step = direction * texel;
  var color = vec3f(0.0);
  for (var a = 0u; a < u32(streak.aberration.w); a++) {
    let anamorphic = streak.anamorphic[a];
    for (var i = 0u; i < ${TAPS_PER_ITERATION}u; i++) {
      let at = uv + step * streak.taps[i].x + anamorphic.xy * texel;
      var tap = textureSampleLevel(source, linearClamp, at, 0.0).rgb;
      tap = select(tap, vec3f(0.0), any(at < vec2f(0.0)) || any(at > vec2f(1.0)));
      if (i == 0u) { tap.r *= streak.aberration.r; }
      else if (i == 1u) { tap.g *= streak.aberration.g; }
      else if (i == 2u) { tap.b *= streak.aberration.b; }
      color += tap * anamorphic.z * streak.taps[i].y;
    }
  }
  return color;
}`;

/** 中间的轮次：4 个方向各写一个目标。 */
const STREAK_SHADER = /* wgsl */ `
${STREAK_COMMON}
struct Streaks { @location(0) d0: vec4f, @location(1) d1: vec4f, @location(2) d2: vec4f, @location(3) d3: vec4f };

@fragment fn fs(in: FullscreenVaryings) -> Streaks {
  return Streaks(
    vec4f(streakTaps(source0, streak.directions[0].xy, in.uv), 1.0),
    vec4f(streakTaps(source1, streak.directions[1].xy, in.uv), 1.0),
    vec4f(streakTaps(source2, streak.directions[2].xy, in.uv), 1.0),
    vec4f(streakTaps(source3, streak.directions[3].xy, in.uv), 1.0),
  );
}`;

/** 最后一轮：4 个方向乘系数加起来（Stride 的 ColorCombiner 累加，输出的 alpha 是 1）。 */
const STREAK_SUM_SHADER = /* wgsl */ `
${STREAK_COMMON}

fn weighted(source: texture_2d<f32>, direction: vec4f, uv: vec2f) -> vec3f {
  if (direction.z == 0.0) {
    return vec3f(0.0);
  }
  return streakTaps(source, direction.xy, uv) * direction.z;
}

@fragment fn fs(in: FullscreenVaryings) -> @location(0) vec4f {
  let sum = weighted(source0, streak.directions[0], in.uv) + weighted(source1, streak.directions[1], in.uv)
    + weighted(source2, streak.directions[2], in.uv) + weighted(source3, streak.directions[3], in.uv);
  return vec4f(sum, 1.0);
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
  readonly #streak: FullscreenShader;
  readonly #sum: FullscreenShader;
  readonly #sampler: GPUSampler;

  constructor(device: GPUDevice, linearClamp: GPUSampler) {
    this.#streak = new FullscreenShader(device, 'LightStreak', STREAK_SHADER);
    this.#sum = new FullscreenShader(device, 'LightStreak sum', STREAK_SUM_SHADER);
    this.#sampler = linearClamp;
  }

  /** half 是缩到 1/2 的亮部图（线性），返回要加回画面的一层；没有方向或者轮数是 0 时是 undefined。 */
  draw({ frame, arena, scaler, blur }: ImageEffectContext, half: Image): AdditiveLayer | undefined {
    const streaks = Math.min(Math.max(0, Math.trunc(this.streakCount)), MAX_STREAKS);
    if (streaks === 0 || this.iterationCount <= 0) return undefined;
    const format = half.format;
    const quarter = frame.acquire(Math.max(1, half.width >> 1), Math.max(1, half.height >> 1), format, 'LightStreak quarter');
    scaler.draw(frame, arena, half, quarter, { expanded: false });
    const accumulation = frame.acquire(quarter.width, quarter.height, format, 'LightStreak accumulation');
    const scratch = (label: string) => Array.from({ length: BATCH }, () => frame.acquire(quarter.width, quarter.height, format, label));
    const pingPong = this.iterationCount > 1 ? [scratch('LightStreak scratch A'), scratch('LightStreak scratch B')] : [];

    const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
    const aberration = this.colorAberrationCoefficients.map((c) => lerp(1, c, this.colorAberrationStrength));
    const anamorphic = this.isAnamorphic ? [[0, 4, 0.05], [0, 0, 1], [0, -4, 0.05]] : [[0, 0, 1]];
    const decay = lerp(0.7, 1, this.attenuation);
    const factor = (1 / streaks) * 0.2 * this.amount;
    const parameters = new Float32Array(4 * BATCH + 8 + 4 * TAPS_PER_ITERATION + 12);
    parameters.set([1 / quarter.width, 1 / quarter.height, 0, 0, ...aberration, anamorphic.length], 4 * BATCH);
    anamorphic.forEach((row, i) => parameters.set(row, 4 * BATCH + 8 + 4 * TAPS_PER_ITERATION + i * 4));

    for (let first = 0; first < streaks; first += BATCH) {
      // 这一批的方向；不满 4 个时空着的槽位系数是 0（中间轮次照算，求和时跳过）
      for (let d = 0; d < BATCH; d++) {
        const s = first + d;
        const angle = (this.phase * Math.PI) / 180 + (s * 2 * Math.PI) / streaks;
        parameters.set(s < streaks ? [Math.cos(angle), Math.sin(angle), factor, 0] : [1, 0, 0, 0], d * 4);
      }
      let sources: readonly Image[] = Array.from({ length: BATCH }, () => quarter);
      for (let level = 0; level < this.iterationCount; level++) {
        const passLength = TAPS_PER_ITERATION ** level;
        const weights = Array.from({ length: TAPS_PER_ITERATION }, (_, i) => decay ** (i * passLength));
        const total = weights.reduce((sum, w) => sum + w, 0);
        weights.forEach((w, i) => parameters.set([i * passLength, w / total], 4 * BATCH + 8 + i * 4));
        const resources = [arena.push(parameters), ...sources, this.#sampler];
        if (level === this.iterationCount - 1) {
          // 第一批覆盖累加缓冲，之后的批次叠加
          this.#sum.draw(frame, accumulation, resources, first > 0 ? { blend: ADD_BLEND, load: true } : {});
        } else {
          const targets = pingPong[level % 2]!;
          this.#streak.draw(frame, targets, resources);
          sources = targets;
        }
      }
    }
    const upscaled = frame.acquire(half.width, half.height, format, 'LightStreak upscaled');
    scaler.draw(frame, arena, accumulation, upscaled, { expanded: false });
    blur.draw(frame, arena, upscaled, upscaled, 3, 3);
    return { texture: upscaled, expanded: false };
  }
}
