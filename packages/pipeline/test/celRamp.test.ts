import { expect, test } from 'vitest';
import { simplifyRamp } from '../src/stride/celRamp.ts';

/** 节点间线性插值（同网格着色器的 celRamp）。 */
function sample(stops: readonly (readonly number[])[], x: number): number[] {
  if (x <= stops[0]![0]!) return stops[0]!.slice(1);
  for (let i = 1; i < stops.length; i++) {
    const a = stops[i - 1]!, b = stops[i]!;
    if (x < b[0]!) return [1, 2, 3].map((c) => a[c]! + (b[c]! - a[c]!) * (x - a[0]!) / (b[0]! - a[0]!));
  }
  return stops.at(-1)!.slice(1);
}

test('三档的台阶：每个台阶两边的纹素中心留下，台阶之间是 1 个纹素宽的直线（同线性采样）', () => {
  const width = 16;
  const level = (j: number) => (j < 5 ? 0 : j < 11 ? 0.5 : 1);
  const row = Array.from({ length: width * 3 }, (_, i) => level(Math.floor(i / 3)));
  const stops = simplifyRamp(row, width, 8);
  expect(stops.map((s) => s[0] * width - 0.5)).toEqual([0, 4, 5, 10, 11, 15]);
  for (let j = 0; j < width; j++) expect(sample(stops, (j + 0.5) / width)[0]).toBeCloseTo(level(j));
});

test('平滑的渐变：节点不超过上限，每个纹素中心的误差在容差以内（这条曲线 8 个节点够）', () => {
  const width = 64;
  const value = (j: number) => ((j + 0.5) / width) ** 2;
  const row = Array.from({ length: width * 3 }, (_, i) => value(Math.floor(i / 3)));
  const stops = simplifyRamp(row, width, 8, 0.02);
  expect(stops.length).toBeLessThanOrEqual(8);
  for (let j = 0; j < width; j++) expect(Math.abs(sample(stops, (j + 0.5) / width)[0]! - value(j))).toBeLessThan(0.02);
});
