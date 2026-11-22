/**
 * 粒子的随机数（Stride 的 RandomSeed 和 ParticleRandomSeedGenerator）：种子是 16 位的整数，同一个种子加上不同的偏移得到
 * 不相关的随机数，每个粒子存一个种子，寿命、大小、位置这些各用自己的偏移取，算法照 Stride，固定种子时和桌面版一样。
 */

const GELFOND = 23.14069263277927; // e 的 π 次方
const GELFOND_SCHNEIDER = 2.665144142690225; // 2 的 √2 次方
const NUMERATOR = 123456789;

/** 各属性取随机数用的偏移（Stride 的 RandomOffset）。 */
export const RandomOffset = {
  lifetime: 0,
  offset1A: 1112,
  offset2A: 2223,
  offset2B: 3334,
  offset3A: 4445,
  offset3B: 5556,
  offset3C: 6667,
} as const;

/** 存进粒子的种子（Stride 的 RandomSeed 构造时只留低 16 位）。 */
export function randomSeed(seed: number): number {
  return seed & 0xffff;
}

/** 种子 seed 在偏移 offset 处的随机数，[0, 1)（Stride 的 RandomSeed.GetFloat）。 */
export function seedFloat(seed: number, offset: number): number {
  const x = (seed + offset) >>> 0;
  const dot = Math.cos(x) * GELFOND + Math.sin(x) * GELFOND_SCHNEIDER;
  const remainder = NUMERATOR % (1e-7 + 256 * dot);
  return Math.fround(remainder - Math.floor(remainder));
}

/** 发射器的种子序列（Stride 的 ParticleRandomSeedGenerator）：每次取下一个整数当种子。 */
export class RandomSeedGenerator {
  #next: number;

  constructor(seed: number) {
    this.#next = seed >>> 0;
  }

  nextSeed(): number {
    const seed = randomSeed(this.#next);
    this.#next = (this.#next + 1) >>> 0;
    return seed;
  }
}
