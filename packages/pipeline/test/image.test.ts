import { describe, expect, test } from 'vitest';
import { bleedTransparentColors } from '../src/image.ts';

const rgba = (...pixels: number[][]) => new Uint8Array(pixels.flat());

describe('alpha 渗色', () => {
  test('全透明像素取最近的不透明像素的颜色，alpha 不变', () => {
    // 4x1：红（不透明）、白透明、黑透明、蓝（半透明）
    const pixels = rgba([255, 0, 0, 255], [255, 255, 255, 0], [0, 0, 0, 0], [0, 0, 255, 128]);
    expect([...bleedTransparentColors(pixels, 4, 1)]).toEqual([255, 0, 0, 255, 255, 0, 0, 0, 0, 0, 255, 0, 0, 0, 255, 128]);
    expect(pixels[4]).toBe(255);
  });

  test('按行列铺开（2x2，只有左上角不透明）', () => {
    const pixels = rgba([10, 20, 30, 255], [0, 0, 0, 0], [0, 0, 0, 0], [255, 255, 255, 0]);
    expect([...bleedTransparentColors(pixels, 2, 2)]).toEqual([10, 20, 30, 255, 10, 20, 30, 0, 10, 20, 30, 0, 10, 20, 30, 0]);
  });

  test('全透明或全不透明时原样返回', () => {
    const clear = rgba([1, 2, 3, 0], [4, 5, 6, 0]);
    const opaque = rgba([1, 2, 3, 9], [4, 5, 6, 9]);
    expect(bleedTransparentColors(clear, 2, 1)).toBe(clear);
    expect(bleedTransparentColors(opaque, 2, 1)).toBe(opaque);
  });
});
