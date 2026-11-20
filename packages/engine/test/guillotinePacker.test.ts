import { describe, expect, test } from 'vitest';
import { GuillotinePacker, type PackedRectangle } from '../src/rendering/lighting/GuillotinePacker';

const overlaps = (a: PackedRectangle, b: PackedRectangle) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

describe('GuillotinePacker', () => {
  test('分出来的矩形都在图集里、互不重叠', () => {
    const packer = new GuillotinePacker(4096, 4096);
    // 四个级联、一盏点光的六个面、一盏聚光
    const placed = [...packer.insert(1024, 1024, 4)!, ...packer.insert(512, 512, 6)!, ...packer.insert(256, 256)!];
    expect(placed).toHaveLength(11);
    for (const [i, a] of placed.entries()) {
      expect(a.x >= 0 && a.y >= 0 && a.x + a.width <= 4096 && a.y + a.height <= 4096).toBe(true);
      for (const b of placed.slice(i + 1)) expect(overlaps(a, b)).toBe(false);
    }
  });

  test('正好铺满；再要就没有了', () => {
    const packer = new GuillotinePacker(2048, 2048);
    expect(packer.insert(1024, 1024, 4)).toHaveLength(4);
    expect(packer.insert(1, 1)).toBeUndefined();
  });

  test('一组放不全时一块也不占', () => {
    const packer = new GuillotinePacker(2048, 2048);
    expect(packer.insert(1024, 1024, 5)).toBeUndefined();
    expect(packer.insert(1024, 1024, 4)).toHaveLength(4);
  });

  test('clear 以后从头分', () => {
    const packer = new GuillotinePacker(1024, 1024);
    expect(packer.insert(1024, 1024)).toEqual([{ x: 0, y: 0, width: 1024, height: 1024 }]);
    expect(packer.insert(512, 512)).toBeUndefined();
    packer.clear();
    expect(packer.insert(512, 512)).toEqual([{ x: 0, y: 0, width: 512, height: 512 }]);
  });
});
