import { describe, expect, test } from 'vitest';
import { checkWater, WATER_MAX_OUTLINE } from '../../src/content/formats/waterFormat';
import { RIVER_VERTEX_FLOATS, riverRibbon, underWater } from '../../src/world/Water';
import { splineMeshes } from '../../src/modeling/spline';
import { waterSurfaceAt } from '../../src/world/Buoyancy';
import { OCEAN_CASCADES, oceanSpectrum, windSeaHeight } from '../../src/world/OceanFFT';

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
    expect(underWater([{ level: Number.NaN, outline: undefined, river: { line: [[0, 4.5, 0], [40, 2.5, 0]], halfWidth: 5, speed: 1 } }], 20, 3, 2)).toBe(true);
    expect(underWater([{ level: Number.NaN, outline: undefined, river: { line: [[0, 4.5, 0], [40, 2.5, 0]], halfWidth: 5, speed: 1 } }], 20, 3, 9)).toBe(false);
    expect(splineMeshes(spline)).toEqual([]);
  });

  test('浮力找水面：湖是水位，河是中心线上那一点的水面和顺着河的流速，水外是 undefined', () => {
    const lake = { level: -5, outline: [[0, 0], [10, 0], [10, 10], [0, 10]] as [number, number][] };
    const river = { level: Number.NaN, outline: undefined, river: { line: [[100, 4, 0], [140, 2, 0]] as [number, number, number][], halfWidth: 5, speed: 2 } };
    expect(waterSurfaceAt([lake, river], 5, 5)).toEqual({ height: -5, flow: [0, 0, 0] });
    const inRiver = waterSurfaceAt([lake, river], 120, 3)!;
    expect(inRiver.height).toBeCloseTo(3);
    expect(inRiver.flow).toEqual([2, 0, 0]);
    expect(waterSurfaceAt([lake, river], 120, 8)).toBeUndefined();
    expect(waterSurfaceAt([lake], 50, 50)).toBeUndefined();
  });

  test('水下：低于水面而且在岸线里；海是哪儿都算', () => {
    const lake = { level: -5, outline: [[0, 0], [10, 0], [10, 10], [0, 10]] as [number, number][] };
    expect(underWater([lake], 5, -6, 5)).toBe(true);
    expect(underWater([lake], 5, -4, 5)).toBe(false);
    expect(underWater([lake], 15, -6, 5)).toBe(false);
    expect(underWater([{ level: 0, outline: undefined }], 1000, -1, -1000)).toBe(true);
    expect(underWater([], 0, -100, 0)).toBe(false);
  });

  test('海浪谱：频谱共轭对称（海面是实的），有效波高等于文件的浪高，同样的种子同样的浪', () => {
    const size = 32;
    const settings = { patch: 400, wind: 12, direction: 0.4, height: 3, choppiness: 1, seed: 5 };
    const out = oceanSpectrum(settings, size);
    const cells = size * size;
    let variance = 0;
    for (let c = 0; c < OCEAN_CASCADES; c++) {
      for (let m = 1; m < size; m++) {
        for (let n = 1; n < size; n++) {
          // H(k) = h₀(k) + h₀*(−k)；H(−k) 应是它的共轭
          const o = (c * cells + m * size + n) * 4, q = (c * cells + (size - m) * size + (size - n)) * 4;
          const re = out[o]! + out[o + 2]!, im = out[o + 1]! + out[o + 3]!;
          expect(out[q]! + out[q + 2]!).toBeCloseTo(re, 6);
          expect(out[q + 1]! + out[q + 3]!).toBeCloseTo(-im, 6);
          variance += re * re + im * im;
        }
      }
    }
    // Parseval：海面高度的方差 = Σ|H(k)|²；随机的一份和期望差得不多
    expect(4 * Math.sqrt(variance)).toBeGreaterThan(settings.height * 0.75);
    expect(4 * Math.sqrt(variance)).toBeLessThan(settings.height * 1.25);
    expect(oceanSpectrum(settings, size)).toEqual(out);
    expect(oceanSpectrum({ ...settings, seed: 6 }, size)).not.toEqual(out);
    expect(windSeaHeight(10)).toBeCloseTo(2.14, 2);
    expect(() => checkWater({ name: 'Sea', waves: { spectrum: { wind: 0 } } })).toThrow('waves.spectrum.wind must be positive');
    expect(() => checkWater({ name: 'Lake', caustics: -1 })).toThrow('caustics must not be negative');
  });
});
