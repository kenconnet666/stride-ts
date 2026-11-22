import { describe, expect, test } from 'vitest';
import type { SplatNode } from '../../src/content/splatFile';
import { selectSplatNodes } from '../../src/rendering/splats/splatLod';

const node = (min: number[], max: number[], first: number, count: number, firstChild: number, childCount: number, detail: number): SplatNode => ({
  min: min as [number, number, number], max: max as [number, number, number], first, count, firstChild, childCount, detail,
});

/** 根盖住 0..2（100 个，粗 0.5 米），两个叶子各 0..1、1..2（各 300 个）。 */
const nodes = [
  node([0, 0, 0], [2, 1, 1], 0, 100, 1, 2, 0.5),
  node([0, 0, 0], [1, 1, 1], 100, 300, 0, 0, 0),
  node([1, 0, 0], [2, 1, 1], 400, 300, 0, 0, 0),
];
const limits = { budget: 1_000_000, pixelError: 1 };

describe('高斯泼溅选细节层次', () => {
  test('远处画根那一级，近处细分到叶子', () => {
    const out: number[] = [];
    // 0.5 米的粗细、1000 像素的焦距：1000 米远时半个像素，不细分
    expect(selectSplatNodes(nodes, { eye: [1, 0.5, 1000], pixelsPerUnit: 1000 }, limits, out)).toBe(100);
    expect(out).toEqual([0]);
    expect(selectSplatNodes(nodes, { eye: [1, 0.5, 10], pixelsPerUnit: 1000 }, limits, out)).toBe(600);
    expect(out.sort((a, b) => a - b)).toEqual([1, 2]);
  });

  test('细分会超出预算时留在粗的一级', () => {
    const out: number[] = [];
    expect(selectSplatNodes(nodes, { eye: [1, 0.5, 10], pixelsPerUnit: 1000 }, { budget: 500, pixelError: 1 }, out)).toBe(100);
    expect(out).toEqual([0]);
  });

  test('视锥外的子节点不画（只看 x < 1 的半边）', () => {
    const out: number[] = [];
    // 一个平面 -x + 1 ≥ 0
    const planes = new Float32Array([-1, 0, 0, 0.99]);
    expect(selectSplatNodes(nodes, { eye: [0.5, 0.5, 10], pixelsPerUnit: 1000, planes }, limits, out)).toBe(300);
    expect(out).toEqual([1]);
    expect(selectSplatNodes(nodes, { eye: [0.5, 0.5, 10], pixelsPerUnit: 1000, planes: new Float32Array([1, 0, 0, -5]) }, limits, out)).toBe(0);
    expect(out).toEqual([]);
  });
});
