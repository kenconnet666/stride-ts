import { describe, expect, test } from 'vitest';
import { Matrix } from '../src/data/Matrix';
import { halton, jitterProjection } from '../src/rendering/screenspace/TemporalAntialiasing';

describe('时间抗锯齿的抖动', () => {
  test('Halton(2, 3) 的前几项', () => {
    expect([1, 2, 3, 4].map((i) => halton(i, 2))).toEqual([0.5, 0.25, 0.75, 0.125]);
    expect([1, 2, 3].map((i) => +halton(i, 3).toFixed(6))).toEqual([0.333333, 0.666667, 0.111111]);
  });

  test('挪过的投影把点在屏幕上挪了给的像素数（透视和正交都对）', () => {
    const width = 800, height = 600;
    const toPixels = (projection: Float32Array, point: readonly number[]) => {
      const [x, y, , w] = [0, 1, 2, 3].map((row) => projection[row]! * point[0]! + projection[4 + row]! * point[1]! + projection[8 + row]! * point[2]! + projection[12 + row]!);
      return [((x! / w! + 1) / 2) * width, ((1 - y! / w!) / 2) * height];
    };
    for (const projection of [Matrix.perspectiveFovRH(Matrix.identity(), 1, width / height, 0.1, 100), Matrix.orthoRH(Matrix.identity(), 10, 7.5, 0.1, 100)]) {
      const point = [1.5, -0.7, -12];
      const before = toPixels(projection, point);
      const jittered = projection.slice();
      jitterProjection(jittered, 0.25, -0.375, width, height);
      const after = toPixels(jittered, point);
      expect([+(after[0]! - before[0]!).toFixed(5), +(after[1]! - before[1]!).toFixed(5)]).toEqual([0.25, -0.375]);
    }
  });
});
