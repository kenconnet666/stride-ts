import { describe, expect, test } from 'vitest';
import { ShadowAtlasAllocator, type PackedRectangle } from '../../src/rendering/lighting/ShadowAtlasAllocator';

const overlaps = (a: PackedRectangle, b: PackedRectangle) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

describe('ShadowAtlasAllocator', () => {
  test('分出来的块都在图集里、互不重叠', () => {
    const atlas = new ShadowAtlasAllocator(4096);
    // 四个级联、一盏点光的六个面、一盏聚光
    const placed = [1024, 1024, 1024, 1024, 512, 512, 512, 512, 512, 512, 256].map((size) => atlas.allocate(size)!);
    expect(placed.every(Boolean)).toBe(true);
    for (const [i, a] of placed.entries()) {
      expect(a.x >= 0 && a.y >= 0 && a.x + a.width <= 4096 && a.y + a.height <= 4096).toBe(true);
      for (const b of placed.slice(i + 1)) expect(overlaps(a, b)).toBe(false);
    }
  });

  test('正好铺满；再要就没有了', () => {
    const atlas = new ShadowAtlasAllocator(2048);
    for (let i = 0; i < 4; i++) expect(atlas.allocate(1024)).toBeDefined();
    expect(atlas.allocate(16)).toBeUndefined();
  });

  test('释放的块合回大块：切碎了再全部还回去，整张又能分出来', () => {
    const atlas = new ShadowAtlasAllocator(1024);
    const small = Array.from({ length: 16 }, () => atlas.allocate(256)!);
    expect(atlas.allocate(1024)).toBeUndefined();
    // 打乱顺序还
    for (const i of [5, 0, 15, 9, 3, 12, 1, 7, 14, 2, 11, 6, 10, 4, 13, 8]) atlas.release(small[i]!);
    expect(atlas.allocate(1024)).toEqual({ x: 0, y: 0, width: 1024, height: 1024 });
  });

  test('留着的块不动：别的块释放、重新分配时它的位置不变，新块不和它重叠', () => {
    const atlas = new ShadowAtlasAllocator(2048);
    const kept = atlas.allocate(512)!;
    const others = Array.from({ length: 6 }, () => atlas.allocate(512)!);
    for (const rect of others) atlas.release(rect);
    const again = Array.from({ length: 15 }, () => atlas.allocate(512)!);
    expect(again.every(Boolean)).toBe(true);
    for (const rect of again) expect(overlaps(rect, kept)).toBe(false);
    expect(atlas.allocate(512)).toBeUndefined();
  });

  test('clear 以后从头分', () => {
    const atlas = new ShadowAtlasAllocator(1024);
    expect(atlas.allocate(1024)).toEqual({ x: 0, y: 0, width: 1024, height: 1024 });
    expect(atlas.allocate(512)).toBeUndefined();
    atlas.clear();
    expect(atlas.allocate(512)).toEqual({ x: 0, y: 0, width: 512, height: 512 });
  });
});
