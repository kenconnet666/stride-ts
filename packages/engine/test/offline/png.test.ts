import { inflateSync } from 'node:zlib';
import { describe, expect, test } from 'vitest';
import { encodePng } from '../../src/offline/png';

describe('PNG 编码', () => {
  test('IHDR 写对宽高和格式，IDAT 解压、反过滤以后是原来的像素', async () => {
    const width = 5, height = 3;
    const rgba = Uint8Array.from({ length: width * height * 4 }, (_, i) => (i * 37 + (i >> 2) * 11) & 0xff);
    const png = await encodePng(rgba, width, height);
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const view = new DataView(png.buffer);
    expect(String.fromCharCode(...png.subarray(12, 16))).toBe('IHDR');
    expect([view.getUint32(16), view.getUint32(20), png[24], png[25]]).toEqual([width, height, 8, 6]);
    const idat = 8 + 25;
    expect(String.fromCharCode(...png.subarray(idat + 4, idat + 8))).toBe('IDAT');
    const raw = inflateSync(png.subarray(idat + 8, idat + 8 + view.getUint32(idat)));
    // 反 Paeth
    const row = width * 4, out = new Uint8Array(rgba.length);
    for (let y = 0; y < height; y++) {
      expect(raw[y * (row + 1)]).toBe(4);
      for (let i = 0; i < row; i++) {
        const a = i >= 4 ? out[y * row + i - 4]! : 0, b = y > 0 ? out[(y - 1) * row + i]! : 0, c = i >= 4 && y > 0 ? out[(y - 1) * row + i - 4]! : 0;
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        out[y * row + i] = (raw[y * (row + 1) + 1 + i]! + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
      }
    }
    expect(out).toEqual(rgba);
  });
});
