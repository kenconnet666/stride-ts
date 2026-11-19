import { describe, expect, test } from 'vitest';
import { applyColorKey, bleedTransparentColors, maskAlpha } from '../src/image.ts';

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

describe('颜色键（Stride 的 ColorKeyEnabled）', () => {
  test('四个分量都等于键的像素变成全透明的黑；别的不动，没有这样的像素时原样返回', () => {
    // 不透明的黑是键；半透明的黑、接近黑的不是
    const pixels = rgba([0, 0, 0, 255], [0, 0, 0, 128], [1, 0, 0, 255], [0, 0, 0, 255]);
    const keyed = applyColorKey(pixels, [0, 0, 0, 255]);
    expect([...keyed]).toEqual([0, 0, 0, 0, 0, 0, 0, 128, 1, 0, 0, 255, 0, 0, 0, 0]);
    expect(pixels[3]).toBe(255);
    expect(applyColorKey(pixels, [255, 0, 255, 255])).toBe(pixels);
  });
});

describe('1 位 alpha（Stride 的 Alpha: Mask）', () => {
  test('alpha 不到一半的变成全透明的黑，其余变成不透明；预乘时留下来的像素颜色先乘 alpha', () => {
    const pixels = rgba([200, 100, 50, 127], [200, 100, 50, 128], [10, 20, 30, 255], [9, 9, 9, 0]);
    expect([...maskAlpha(pixels, true)]).toEqual([0, 0, 0, 0, 100, 50, 25, 255, 10, 20, 30, 255, 9, 9, 9, 0]);
    expect([...maskAlpha(pixels, false)]).toEqual([0, 0, 0, 0, 200, 100, 50, 255, 10, 20, 30, 255, 9, 9, 9, 0]);
    const binary = rgba([1, 2, 3, 255], [4, 5, 6, 0]);
    expect(maskAlpha(binary, true)).toBe(binary);
  });
});
