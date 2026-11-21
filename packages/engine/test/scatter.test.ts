import { describe, expect, test } from 'vitest';
import { checkScatterFile, type ScatterLayerFile } from '../src/content/scatterFormat';
import { scatterCell, type GroundSample } from '../src/terrain/Scatter';

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
