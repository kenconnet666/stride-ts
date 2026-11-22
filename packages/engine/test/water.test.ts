import { describe, expect, test } from 'vitest';
import { checkWater, WATER_MAX_OUTLINE } from '../src/content/waterFormat';
import { underWater } from '../src/water/Water';

describe('水体', () => {
  test('检查：岸线至少三个点、不超过上限，清澈度、浪的参数', () => {
    expect(checkWater({ name: 'Lake', outline: [[0, 0], [10, 0], [0, 10]] }).name).toBe('Lake');
    expect(() => checkWater({ name: 'L', outline: [[0, 0], [1, 1]] })).toThrow('outline needs at least 3 points');
    expect(() => checkWater({ name: 'L', outline: Array.from({ length: WATER_MAX_OUTLINE + 1 }, (_, i) => [Math.cos(i), Math.sin(i)] as [number, number]) })).toThrow(`at most ${WATER_MAX_OUTLINE} points`);
    expect(() => checkWater({ name: 'L', clarity: 0 })).toThrow('clarity must be positive');
    expect(() => checkWater({ name: 'L', waves: { choppiness: 2 } })).toThrow('waves.choppiness must be in 0..1');
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
