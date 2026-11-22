import { describe, expect, it } from 'vitest';
import { comparePhoto, photoComposite, ssim } from '../src/photo.ts';
import type { Image } from '../src/png.ts';

/** 按每个像素的函数生成一张图（RGB 0..255）。 */
function image(width: number, height: number, pixel: (x: number, y: number) => [number, number, number]): Image {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      data.set([r, g, b, 255], (y * width + x) * 4);
    }
  }
  return { width, height, data };
}

/** 线性亮度乘 factor 以后的 sRGB 值。 */
function scaleLinear(value: number, factor: number): number {
  const c = value / 255;
  const linear = (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4) * factor;
  const encoded = linear <= 0.0031308 ? linear * 12.92 : 1.055 * linear ** (1 / 2.4) - 0.055;
  return Math.round(Math.min(1, encoded) * 255);
}

describe('stride shot --photo：照片比对', () => {
  const textured = image(64, 64, (x, y) => {
    const v = 90 + ((x * 7 + y * 13) % 5) * 12 + (x % 8 < 4 ? 20 : 0);
    return [v, v, v];
  });

  it('一样的图：曝光差 0 档、细节比 1、SSIM 1、没有结论', () => {
    const result = comparePhoto(textured, textured);
    expect(result.exposureStops).toEqual({ median: 0, highlights: 0, shadows: 0 });
    expect(result.detailRatio).toBe(1);
    expect(result.ssim).toBeCloseTo(1, 3);
    expect(result.notes).toEqual([]);
    expect(result.grid).toHaveLength(16);
  });

  it('暗一档（线性亮度减半）：中位数差 −1 档，结论里说暗', () => {
    const darker = image(64, 64, (x, y) => {
      const v = scaleLinear(textured.data[(y * 64 + x) * 4]!, 0.5);
      return [v, v, v];
    });
    const result = comparePhoto(textured, darker);
    expect(result.exposureStops.median).toBeCloseTo(-1, 1);
    expect(result.notes.some((note) => note.includes('darker overall'))).toBe(true);
  });

  it('平的渲染对有纹理的照片：细节比很小，结论里说太干净，格子里也指出来', () => {
    const flat = image(64, 64, () => [110, 110, 110]);
    const result = comparePhoto(textured, flat);
    expect(result.detailRatio).toBeLessThan(0.1);
    expect(result.notes.some((note) => note.includes('too smooth or too clean'))).toBe(true);
    expect(result.grid.every((cell) => cell.detailRatio < 0.1)).toBe(true);
  });

  it('偏蓝的渲染：结论里说冷', () => {
    const blue = image(64, 64, (x, y) => {
      const v = textured.data[(y * 64 + x) * 4]!;
      return [Math.round(v * 0.8), v, Math.min(255, Math.round(v * 1.2))];
    });
    expect(comparePhoto(textured, blue).notes.some((note) => note.includes('cooler'))).toBe(true);
  });

  it('SSIM：一样的是 1，不相关的远小于 1；拼图三张并排', () => {
    const a = Float64Array.from({ length: 32 * 32 }, (_, i) => (i % 7) / 7);
    const b = Float64Array.from({ length: 32 * 32 }, (_, i) => ((i * 13) % 11) / 11);
    expect(ssim(a, a, 32, 32)).toBeCloseTo(1, 5);
    expect(ssim(a, b, 32, 32)).toBeLessThan(0.5);
    const composite = photoComposite(textured, textured, 32);
    expect([composite.width, composite.height]).toEqual([96, 32]);
  });

  it('大小不一样时报错', () => {
    expect(() => comparePhoto(textured, image(32, 32, () => [0, 0, 0]))).toThrow('64x64');
  });
});
