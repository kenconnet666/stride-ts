import { describe, expect, test } from 'vitest';
import { inflateSync } from 'node:zlib';
import { applyColorKey, bleedTransparentColors, encodePng, maskAlpha } from '../src/image.ts';

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

describe('PNG 编码', () => {
  test('RGBA8 原样存进去：文件头、尺寸，解压出来每行前面一个滤波字节 0', () => {
    const pixels = rgba([1, 2, 3, 255], [4, 5, 6, 0], [7, 8, 9, 128], [10, 11, 12, 255]);
    const png = encodePng(pixels, 2, 2);
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const view = new DataView(png.buffer, png.byteOffset);
    // IHDR：宽、高、8 位、RGBA
    expect([view.getUint32(16), view.getUint32(20), png[24], png[25]]).toEqual([2, 2, 8, 6]);
    const idatLength = view.getUint32(33);
    expect(new TextDecoder().decode(png.subarray(37, 41))).toBe('IDAT');
    expect([...inflateSync(png.subarray(41, 41 + idatLength))]).toEqual([0, 1, 2, 3, 255, 4, 5, 6, 0, 0, 7, 8, 9, 128, 10, 11, 12, 255]);
  });
});
