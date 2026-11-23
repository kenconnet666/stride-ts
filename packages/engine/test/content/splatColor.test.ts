import { describe, expect, test } from 'vitest';
import type { SplatSource } from '../../src/content/splatFile';
import { applySplatColor, splatColorMatrix, splatColorPreview, splatEditMask } from '../../src/content/splatEdit';

const decode = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const encode = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);
const times = (m: readonly number[], v: readonly number[]) => [0, 1, 2].map((r) => m[r * 3]! * v[0]! + m[r * 3 + 1]! * v[1]! + m[r * 3 + 2]! * v[2]!);
const product = (a: readonly number[], b: readonly number[]) => [0, 1, 2].flatMap((i) => [0, 1, 2].map((j) => a[i * 3]! * b[j]! + a[i * 3 + 1]! * b[3 + j]! + a[i * 3 + 2]! * b[6 + j]!));

/** 两个泼溅：一个灰的、一个偏红的，带一阶球谐。 */
function splats(): SplatSource {
  return {
    count: 2,
    positions: new Float32Array(6),
    scales: new Float32Array([0.1, 0.1, 0.1, 0.1, 0.1, 0.1]),
    rotations: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1]),
    colors: new Float32Array([0.5, 0.5, 0.5, 1, 0.7, 0.3, 0.2, 1]),
    shBands: 1,
    // 每个泼溅 3 个系数 × 3 个通道（r 的、g 的、b 的）
    sh: new Float32Array([0.02, 0, 0, 0.02, 0, 0, 0.02, 0, 0, 0.01, 0.01, 0, 0.01, 0.01, 0, 0.01, 0.01, 0]),
  };
}

describe('扫描的调色', () => {
  test('默认值是恒等；曝光一档是线性的两倍', () => {
    splatColorMatrix({}).forEach((v, i) => expect(v).toBeCloseTo(i % 4 === 0 ? 1 : 0, 6));
    splatColorMatrix({ exposure: 1 }).forEach((v, i) => expect(v).toBeCloseTo(i % 4 === 0 ? 2 : 0, 6));
  });

  test('饱和度 0 时出来是灰的，亮度（Rec.709）不变', () => {
    const m = splatColorMatrix({ saturation: 0 }), color = [0.6, 0.2, 0.1];
    const out = times(m, color), luma = 0.2126 * 0.6 + 0.7152 * 0.2 + 0.0722 * 0.1;
    for (const c of out) expect(c).toBeCloseTo(luma, 6);
  });

  test('色温：那个色温的光照下的白调回白（暖光下偏黄的白，按低色温调了变得不黄）', () => {
    const warm = splatColorMatrix({ temperature: 3000 });
    const out = times(warm, [1, 0.8, 0.55]);
    // 红的压下、蓝的提上：比原来的 r/b 小得多
    expect(out[0]! / out[2]!).toBeLessThan((1 / 0.55) * 0.6);
  });

  test('烘焙：0 阶的颜色在线性空间里乘矩阵，高阶球谐按导数跟着变', () => {
    const m = splatColorMatrix({ exposure: 0.5, saturation: 0.8 }), source = splats();
    const out = applySplatColor(source, m);
    for (let i = 0; i < 2; i++) {
      const linear = times(m, [0, 1, 2].map((c) => decode(source.colors[i * 4 + c]!)));
      for (let c = 0; c < 3; c++) expect(out.colors[i * 4 + c]).toBeCloseTo(encode(Math.min(1, linear[c]!)), 5);
      expect(out.colors[i * 4 + 3]).toBe(1);
    }
    // 小偏移：调完的颜色加调完的球谐 ≈ 原来的颜色加球谐再调（一阶近似）
    const bumped = [0, 1, 2].map((c) => source.colors[4 + c]! + source.sh![9 + c * 3]!);
    const expected = times(m, bumped.map(decode)).map((c) => encode(c));
    for (let c = 0; c < 3; c++) expect(out.colors[4 + c]! + out.sh![9 + c * 3]!).toBeCloseTo(expected[c]!, 3);
  });

  test('编辑器的预览补的是从烘过的调色到现在的那一下', () => {
    expect(splatColorPreview({ exposure: 1 }, { exposure: 1 })).toBeUndefined();
    expect(splatColorPreview(undefined, {})).toBeUndefined();
    const baked = { exposure: 1, temperature: 4000 }, next = { exposure: -0.5, saturation: 1.3 };
    const preview = product(splatColorPreview(next, baked)!, splatColorMatrix(baked));
    preview.forEach((v, i) => expect(v).toBeCloseTo(splatColorMatrix(next)[i]!, 5));
  });

  test('遮罩：第一项的 w 标有没有调色，接着三行矩阵', () => {
    const m = splatColorMatrix({ exposure: 1 });
    const mask = splatEditMask({}, m);
    expect(mask.length).toBe(16);
    expect(mask[3]).toBe(1);
    expect(Array.from(mask.slice(4, 16))).toEqual([2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0]);
  });
});
