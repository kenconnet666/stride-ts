import { describe, expect, test } from 'vitest';
import { checkCity, type CityFile } from '../src/content/formats/cityFormat';
import type { SplineFile } from '../src/content/formats/splineFormat';
import { cityLots, overlaps, segmentBoxDistance, type CityFootprint } from '../src/modeling/city';

/** 沿 x 的一条 200 米的直路，7 米宽（加路肩 8 米）。 */
const avenue: SplineFile = { name: 'Avenue', materials: [null], profile: { type: 'road', width: 7 }, points: [{ position: [-100, 0, 0] }, { position: [0, 0, 0] }, { position: [100, 0, 0] }] };
/** 一条横穿的路（在 x = 0 处相交）。 */
const cross: SplineFile = { name: 'Cross', materials: [null], profile: { type: 'road', width: 7 }, points: [{ position: [0, 0, -60] }, { position: [0, 0, 60] }] };
const footprints: CityFootprint[] = [{ width: 10, depth: 8, center: [0, 0] }, { width: 16, depth: 12, center: [0, 1] }];
const city: CityFile = { name: 'Town', roads: ['Avenue'], buildings: [{ model: 'A' }, { model: 'B', weight: 2 }], setback: 3, gap: 2 };

/** 楼的地块在本地坐标里的矩形（同 cityLots 的）。 */
function box(lot: { position: readonly [number, number]; yaw: number; building: number }) {
  const f = footprints[lot.building]!;
  const x = [Math.cos(lot.yaw), -Math.sin(lot.yaw)] as const, z = [Math.sin(lot.yaw), Math.cos(lot.yaw)] as const;
  const center = [lot.position[0] + x[0] * f.center[0] + z[0] * f.center[1], lot.position[1] + x[1] * f.center[0] + z[1] * f.center[1]] as const;
  return { center, axes: [x, z] as const, half: [f.width / 2, f.depth / 2] as const };
}

describe('城市：沿街摆楼', () => {
  test('路的两边都摆，楼不压路、互相不重叠，正面朝着路，离路边 setback', () => {
    const lots = cityLots(city, [avenue], footprints);
    expect(lots.length).toBeGreaterThan(14);
    const north = lots.filter((lot) => lot.position[1] > 0), south = lots.filter((lot) => lot.position[1] < 0);
    expect(north.length).toBeGreaterThan(5);
    expect(south.length).toBeGreaterThan(5);
    const boxes = lots.map(box);
    for (let i = 0; i < boxes.length; i++) {
      // 离路中心线 ≥ 半个路宽（含路肩）+ setback
      expect(segmentBoxDistance([-100, 0], [100, 0], boxes[i]!)).toBeGreaterThan(4 + 3 - 1e-6);
      for (let j = i + 1; j < boxes.length; j++) expect(overlaps(boxes[i]!, boxes[j]!)).toBe(false);
      // 本地 +Z（正面）朝着路：z 轴指向 z = 0
      const lot = lots[i]!;
      expect(Math.sign(Math.cos(lot.yaw))).toBe(-Math.sign(lot.position[1]));
    }
  });

  test('同样的文件摆出同样的城，换种子换楼', () => {
    expect(cityLots(city, [avenue], footprints)).toEqual(cityLots(city, [avenue], footprints));
    const other = cityLots({ ...city, seed: 7 }, [avenue], footprints);
    expect(other.map((lot) => lot.building)).not.toEqual(cityLots(city, [avenue], footprints).map((lot) => lot.building));
  });

  test('横穿的路上不摆楼；area 以外不摆', () => {
    const lots = cityLots({ ...city, roads: ['Avenue', 'Cross'] }, [avenue, cross], footprints);
    for (const lot of lots) expect(segmentBoxDistance([0, -60], [0, 60], box(lot))).toBeGreaterThan(4);
    const inArea = cityLots({ ...city, area: [[0, -50], [100, -50], [100, 50], [0, 50]] }, [avenue], footprints);
    expect(inArea.length).toBeGreaterThan(0);
    for (const lot of inArea) expect(box(lot).center[0]).toBeGreaterThan(0);
  });

  test('填街区：临街的后面还有楼，朝着最近的路，不出 maxDistance，都不重叠、不压路', () => {
    const front = cityLots(city, [avenue], footprints);
    const filled = cityLots({ ...city, fill: { spacing: 10, maxDistance: 60 } }, [avenue], footprints);
    // 临街的那排不变，后面多出来的在更远处
    expect(filled.slice(0, front.length)).toEqual(front);
    const extra = filled.slice(front.length);
    expect(extra.length).toBeGreaterThan(10);
    expect(Math.max(...extra.map((lot) => Math.abs(box(lot).center[1])))).toBeGreaterThan(25);
    const boxes = filled.map(box);
    for (let i = 0; i < boxes.length; i++) {
      expect(segmentBoxDistance([-100, 0], [100, 0], boxes[i]!)).toBeGreaterThan(4 + 1.5 - 1e-6);
      for (let j = i + 1; j < boxes.length; j++) expect(overlaps(boxes[i]!, boxes[j]!)).toBe(false);
    }
    for (const lot of extra) {
      const center = box(lot).center;
      // 离路最近的点在路的中间段时正面朝 ±z；中心离中心线不超过 60 米
      expect(Math.hypot(Math.max(Math.abs(center[0]) - 100, 0), center[1])).toBeLessThanOrEqual(60 + 1e-6);
      if (Math.abs(center[0]) < 95) expect(Math.sign(Math.cos(lot.yaw))).toBe(-Math.sign(center[1]));
    }
  });

  test('检查：没有路、没有楼、权重不对', () => {
    expect(() => checkCity({ ...city, roads: [] })).toThrow('roads needs at least one spline path');
    expect(() => checkCity({ ...city, buildings: [] })).toThrow('buildings needs at least one building');
    expect(() => checkCity({ ...city, buildings: [{ model: 'A', weight: 0 }] })).toThrow('buildings[0].weight must be positive');
  });
});
