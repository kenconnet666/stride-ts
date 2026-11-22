import { describe, expect, test } from 'vitest';
import { checkWater, WATER_MAX_OUTLINE } from '../src/content/waterFormat';
import { RIVER_VERTEX_FLOATS, riverRibbon, underWater } from '../src/water/Water';
import { splineMeshes } from '../src/modeling/spline';

describe('水体', () => {
  test('检查：岸线至少三个点、不超过上限，清澈度、浪的参数', () => {
    expect(checkWater({ name: 'Lake', outline: [[0, 0], [10, 0], [0, 10]] }).name).toBe('Lake');
    expect(() => checkWater({ name: 'L', outline: [[0, 0], [1, 1]] })).toThrow('outline needs at least 3 points');
    expect(() => checkWater({ name: 'L', outline: Array.from({ length: WATER_MAX_OUTLINE + 1 }, (_, i) => [Math.cos(i), Math.sin(i)] as [number, number]) })).toThrow(`at most ${WATER_MAX_OUTLINE} points`);
    expect(() => checkWater({ name: 'L', clarity: 0 })).toThrow('clarity must be positive');
    expect(() => checkWater({ name: 'L', waves: { choppiness: 2 } })).toThrow('waves.choppiness must be in 0..1');
  });

  test('河：沿样条的带子按样条的宽、比样条低 level，流向顺着样条；河道样条不出几何', () => {
    const spline = { name: 'R', materials: [], profile: { type: 'river' as const, width: 10 }, points: [{ position: [0, 5, 0] as [number, number, number] }, { position: [40, 3, 0] as [number, number, number] }] };
    const ribbon = riverRibbon(spline, 0.5);
    expect(ribbon.length % (RIVER_VERTEX_FLOATS * 6)).toBe(0);
    for (let i = 0; i < ribbon.length; i += RIVER_VERTEX_FLOATS) {
      // 两边离中心线 5 米（沿 z），水面在样条下面 0.5 米，流向是 +x
      expect(Math.abs(ribbon[i + 2]!)).toBeCloseTo(5);
      expect(ribbon[i + 1]!).toBeLessThanOrEqual(5 - 0.5 + 1e-4);
      expect(ribbon[i + 4]!).toBeCloseTo(1);
      expect(Math.abs(ribbon[i + 6]!)).toBe(1);
    }
    expect(underWater([{ level: Number.NaN, outline: undefined, river: { line: [[0, 4.5, 0], [40, 2.5, 0]], halfWidth: 5 } }], 20, 3, 2)).toBe(true);
    expect(underWater([{ level: Number.NaN, outline: undefined, river: { line: [[0, 4.5, 0], [40, 2.5, 0]], halfWidth: 5 } }], 20, 3, 9)).toBe(false);
    expect(splineMeshes(spline)).toEqual([]);
  });

  test('水下：低于水面而且在岸线里；海是哪儿都算', () => {
    const lake = { level: -5, outline: [[0, 0], [10, 0], [10, 10], [0, 10]] as [number, number][] };
    expect(underWater([lake], 5, -6, 5)).toBe(true);
    expect(underWater([lake], 5, -4, 5)).toBe(false);
    expect(underWater([lake], 15, -6, 5)).toBe(false);
    expect(underWater([{ level: 0, outline: undefined }], 1000, -1, -1000)).toBe(true);
    expect(underWater([], 0, -100, 0)).toBe(false);
  });
});
