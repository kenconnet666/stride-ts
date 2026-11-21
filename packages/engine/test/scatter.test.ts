import { describe, expect, test } from 'vitest';
import { checkScatterFile, type ScatterLayerFile } from '../src/content/scatterFormat';
import { grassBlades, gridGround, lodTier, scatterCell, type GroundSample } from '../src/terrain/Scatter';

const flat: GroundSample = () => ({ height: 5, normal: [0, 1, 0] });
const trees: ScatterLayerFile = { name: 'Trees', model: 'Models/Tree', density: 400 };

describe('程序化摆放', () => {
  test('密度：每公顷 400 个是 5 米的抖动网格，64 米的格子里大约 164 个，贴在地面上', () => {
    const instances = scatterCell(trees, 0, 1, 0, 0, 64, flat);
    expect(instances.length).toBeGreaterThan(150);
    expect(instances.length).toBeLessThanOrEqual(13 * 13);
    expect(instances.every((i) => i.position[1] === 5 && i.position[0] >= 0 && i.position[0] < 64)).toBe(true);
    expect(instances.every((i) => i.scale >= 0.8 && i.scale <= 1.2)).toBe(true);
  });

  test('确定：同样的种子撒出同样的实例；格子怎么切都一样（两个 32 米的格子拼起来等于一个 64 米的）', () => {
    const whole = scatterCell(trees, 0, 7, 0, 0, 64, flat);
    expect(scatterCell(trees, 0, 7, 0, 0, 64, flat)).toEqual(whole);
    const halves = [...scatterCell(trees, 0, 7, 0, 0, 32, flat), ...scatterCell(trees, 0, 7, 32, 0, 32, flat), ...scatterCell(trees, 0, 7, 0, 32, 32, flat), ...scatterCell(trees, 0, 7, 32, 32, 32, flat)];
    const key = (i: { position: readonly number[] }) => i.position.join();
    expect(new Set(halves.map(key))).toEqual(new Set(whole.map(key)));
    expect(scatterCell(trees, 0, 8, 0, 0, 64, flat)).not.toEqual(whole);
  });

  test('筛选：坡度、高度、离路、成片', () => {
    const steep: GroundSample = (x) => ({ height: x, normal: x < 32 ? [0, 1, 0] : [Math.sin(0.6), Math.cos(0.6), 0] });
    // 坡度 0..30°：右半边（34°）不撒
    expect(scatterCell({ ...trees, slope: [0, 30] }, 0, 1, 0, 0, 64, steep).every((i) => i.position[0] < 32)).toBe(true);
    expect(scatterCell({ ...trees, height: [0, 10] }, 0, 1, 0, 0, 64, steep).every((i) => i.position[1] <= 10)).toBe(true);
    expect(scatterCell(trees, 0, 1, 0, 0, 64, flat, (x) => x < 20).every((i) => i.position[0] >= 20)).toBe(true);
    // 成片：盖住三成左右的地面（大范围上看）
    const all = scatterCell(trees, 0, 1, 0, 0, 512, flat).length;
    const clumped = scatterCell({ ...trees, clump: { scale: 40, coverage: 0.3 } }, 0, 1, 0, 0, 512, flat).length;
    expect(clumped / all).toBeGreaterThan(0.2);
    expect(clumped / all).toBeLessThan(0.4);
  });

  test('顺着坡：1 时实例的上方是地面的法线，0 时竖直', () => {
    const slope: GroundSample = () => ({ height: 0, normal: [Math.sin(0.5), Math.cos(0.5), 0] });
    const up = (q: readonly number[]) => {
      // 四元数把 (0, 1, 0) 转到哪
      const [x, y, z, w] = q as [number, number, number, number];
      return [2 * (x * y - w * z), 1 - 2 * (x * x + z * z), 2 * (y * z + w * x)];
    };
    const [rock] = scatterCell({ ...trees, alignToSlope: 1 }, 0, 1, 0, 0, 16, slope);
    up(rock!.rotation).forEach((c, k) => expect(c).toBeCloseTo([Math.sin(0.5), Math.cos(0.5), 0][k]!, 6));
    const [tree] = scatterCell(trees, 0, 1, 0, 0, 16, slope);
    expect(up(tree!.rotation)[1]).toBeCloseTo(1, 9);
  });

  test('文件检查', () => {
    expect(() => checkScatterFile({ name: 'S', layers: [{ name: 'A', model: 'M', density: 0 }] }, 'S')).toThrow('layers[0].density must be positive');
    expect(() => checkScatterFile({ name: 'S', layers: [{ name: 'A', model: 'M', density: 1, slope: [40, 10] }] }, 'S')).toThrow('slope must be [min, max]');
  });
});

describe('撒草', () => {
  test('高度页插出地面：格点上是格点的高度、中间双线性，斜坡的法线朝着下坡', () => {
    // 4 × 4 的页、格距 1、原点 (-1, -1)：高度 = x（往 +x 每米升 1 米）
    const heights = Float32Array.from({ length: 16 }, (_, k) => (k % 4) - 1);
    const ground = gridGround(heights, -1, -1, 1, 4, 100);
    expect(ground(0, 0)!.height).toBeCloseTo(0, 6);
    expect(ground(0.5, 0.25)!.height).toBeCloseTo(0.5, 6);
    const n = ground(0.5, 0.5)!.normal;
    expect(n[0]).toBeCloseTo(-Math.SQRT1_2, 6);
    expect(n[1]).toBeCloseTo(Math.SQRT1_2, 6);
    expect(ground(200, 0)).toBeUndefined();
  });

  test('草叶合成一个网格：每片一个三角形，根在地上、梢在叶高处，UV 的 v 根 1 梢 0', () => {
    const grass: ScatterLayerFile = { name: 'Grass', density: 100_000, grass: { height: 0.5, width: 0.04, lean: 0 } };
    const instances = scatterCell(grass, 0, 1, 0, 0, 4, flat);
    const { vertices, indices } = grassBlades(grass, instances);
    expect(indices.length).toBe(instances.length * 3);
    for (let k = 0; k < instances.length; k++) {
      const v = (c: number) => Array.from(vertices.slice((k * 3 + c) * 8, (k * 3 + c) * 8 + 8));
      expect(v(0)[1]).toBe(5);
      expect(v(2)[1]).toBeCloseTo(5 + 0.5 * instances[k]!.scale, 5);
      expect([v(0)[7], v(1)[7], v(2)[7]]).toEqual([1, 1, 0]);
      expect([v(0)[4], v(2)[4]]).toEqual([1, 1]);
    }
    expect(() => checkScatterFile({ name: 'S', layers: [{ name: 'G', density: 1, grass: { height: 0, width: 1 } }] }, 'S')).toThrow('grass needs a positive height and width');
  });
});

describe('细节层次', () => {
  const layer: ScatterLayerFile = { ...trees, lods: [{ distance: 100, model: 'Models/TreeFar' }, { distance: 200, keep: 0.25 }] };

  test('按距离选层次，边界两边 4 米内不换', () => {
    expect(lodTier(layer, 50)).toBe(0);
    expect(lodTier(layer, 150)).toBe(1);
    expect(lodTier(layer, 250)).toBe(2);
    // 在 0 层、走到 102 米：还没超过边界 4 米，不换；106 米换
    expect(lodTier(layer, 102, 0)).toBe(0);
    expect(lodTier(layer, 106, 0)).toBe(1);
    // 在 1 层、回到 98 米：不换；95 米换回 0
    expect(lodTier(layer, 98, 1)).toBe(1);
    expect(lodTier(layer, 95, 1)).toBe(0);
  });

  test('远处只留一部分点：是近处那些点的子集，大约 keep 那么多', () => {
    const near = scatterCell(trees, 0, 1, 0, 0, 256, flat);
    const far = scatterCell(trees, 0, 1, 0, 0, 256, flat, undefined, 0.25);
    const key = (i: { position: readonly number[] }) => i.position.join();
    const nearKeys = new Set(near.map(key));
    expect(far.every((i) => nearKeys.has(key(i)))).toBe(true);
    expect(far.length / near.length).toBeGreaterThan(0.2);
    expect(far.length / near.length).toBeLessThan(0.3);
    expect(() => checkScatterFile({ name: 'S', layers: [{ ...trees, lods: [{ distance: 100 }, { distance: 50 }] }] }, 'S')).toThrow('lods[1].distance must be positive and increasing');
  });
});
