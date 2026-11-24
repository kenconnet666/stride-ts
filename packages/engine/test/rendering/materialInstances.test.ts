import { describe, expect, test } from 'vitest';
import { SlotParams } from '../../src/rendering/mesh/MeshGpu';
import { Material } from '../../src/rendering/mesh/Material';

describe('材质实例（MaterialParams、Material.variation）', () => {
  test('按槽位存 tint 和种子：一样的不算改，槽位超出时长大并保留原来的', () => {
    const params = new SlotParams();
    params.dirty = false;
    params.set(3, 0xff0000ff, 7, 0x80);
    expect(params.dirty).toBe(true);
    expect([...params.values.subarray(12, 16)]).toEqual([0xff0000ff, 7, 0x80, 0]);
    params.dirty = false;
    params.set(3, 0xff0000ff, 7, 0x80);
    expect(params.dirty).toBe(false);
    // 只改状态层也算改了
    params.set(3, 0xff0000ff, 7, 0x8080);
    expect(params.dirty).toBe(true);
    params.set(5000, 1, 2, 0);
    expect(params.values.length).toBeGreaterThanOrEqual(5001 * 4);
    expect([...params.values.subarray(12, 14)]).toEqual([0xff0000ff, 7]);
    expect([...params.values.subarray(20000, 20002)]).toEqual([1, 2]);
  });

  test('材质的 variation 原样留着，没写时是 undefined', () => {
    expect(new Material('Plain').variation).toBeUndefined();
    expect(new Material('Clothes', { variation: { hue: 180, value: 0.4 } }).variation).toEqual({ hue: 180, value: 0.4 });
  });
});
