import { describe, expect, test } from 'vitest';
import { whiteBalanceMatrix } from '../../src/rendering/postfx/ToneMap';

/** 列主序 3×3 乘向量。 */
const apply = (m: readonly number[], v: readonly number[]) => [0, 1, 2].map((r) => m[r]! * v[0]! + m[3 + r]! * v[1]! + m[6 + r]! * v[2]!);

describe('白平衡', () => {
  test('6500 K、不偏色时是单位矩阵', () => {
    expect(whiteBalanceMatrix(6500, 0)).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  });

  test('相机设成 3200 K：3200 K 的光源的白变成中性的灰；比 6500 K 的白偏蓝', () => {
    // 3200 K 的白（色度按同一个近似）在线性 sRGB 里：x、y → XYZ → sRGB
    const t = 3200;
    const x = -0.2661239e9 / t ** 3 - 0.2343589e6 / t ** 2 + 0.8776956e3 / t + 0.17991;
    const y = -0.9549476 * x ** 3 - 1.37418593 * x ** 2 + 2.09137015 * x - 0.16748867;
    const X = x / y, Z = (1 - x - y) / y;
    const warm = [3.2404542 * X - 1.5371385 - 0.4985314 * Z, -0.969266 * X + 1.8760108 + 0.041556 * Z, 0.0556434 * X - 0.2040259 + 1.0572252 * Z];
    expect(warm[0]!).toBeGreaterThan(warm[2]!);
    const m = whiteBalanceMatrix(3200, 0);
    const balanced = apply(m, warm);
    expect(balanced[0]! / balanced[1]!).toBeCloseTo(1, 2);
    expect(balanced[2]! / balanced[1]!).toBeCloseTo(1, 2);
    const white = apply(m, [1, 1, 1]);
    expect(white[2]!).toBeGreaterThan(white[0]!);
  });
});
