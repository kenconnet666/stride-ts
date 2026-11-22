import { describe, expect, test } from 'vitest';
import type { PileFile } from '../../src/content/formats/pileFormat';
import type { ProductFile } from '../../src/content/formats/productFormat';
import { pileCell, pileContainer, pileModel, pileSpawn } from '../../src/modeling/pile';

const products = new Map<string, ProductFile>([
  ['P/Garlic', { name: 'Garlic', shape: 'garlic', size: [0.055, 0.05, 0], seed: 1 }],
  ['P/Onion', { name: 'Onion', shape: 'onion', size: [0.08, 0.085, 0], seed: 2 }],
]);
const bin: PileFile = { name: 'Bin', container: { size: [0.6, 0.2, 0.4] }, items: [{ product: 'P/Garlic', count: 40 }, { product: 'P/Onion', count: 20, variants: 2 }], seed: 3 };
const sources = { products, font: () => undefined };

describe('物理堆放', () => {
  test('容器：底和四壁围住里面的尺寸', () => {
    const boards = pileContainer(bin);
    expect(boards).toHaveLength(5);
    const floor = boards[0]!;
    expect(floor.center[1] + floor.size[1] / 2).toBeCloseTo(0, 9);
    // 左右两壁的内侧在 ±w/2
    expect(boards[1]!.center[0] + boards[1]!.size[0] / 2).toBeCloseTo(-0.3, 9);
    expect(boards[2]!.center[0] - boards[2]!.size[0] / 2).toBeCloseTo(0.3, 9);
  });

  test('倒之前：每件都在容器上方、容器的范围里，数量和变体对，种子一样就一样', () => {
    const spawn = pileSpawn(bin, products);
    expect(spawn).toHaveLength(60);
    expect(spawn.filter((item) => item.product === 'P/Onion').every((item) => item.variant < 2)).toBe(true);
    for (const { position: [x, y, z], rotation } of spawn) {
      expect(Math.abs(x)).toBeLessThanOrEqual(0.3);
      expect(Math.abs(z)).toBeLessThanOrEqual(0.2);
      expect(y).toBeGreaterThan(0.2);
      expect(Math.hypot(...rotation)).toBeCloseTo(1, 6);
    }
    expect(pileSpawn(bin, products)).toEqual(spawn);
    expect(() => pileSpawn({ ...bin, items: [{ product: 'P/Missing', count: 1 }] }, products)).toThrow(/Missing/);
  });

  test('标签很大、只有几张时图集照样每张一格（装箱放不进的那块是空位，不能当成装下了）', () => {
    const potato: ProductFile = { name: 'Potato', shape: 'tuber', size: [0.11, 0.055, 0.07], seed: 5 };
    const few: PileFile = { name: 'Few', container: { size: [0.6, 0.12, 0.4] }, items: [{ product: 'P/Potato', count: 9, variants: 3 }], seed: 1 };
    const lookup = new Map([['P/Potato', potato]]);
    const settled = pileSpawn(few, lookup).map((item) => ({ ...item, position: [item.position[0], 0.03, item.position[2]] as const }));
    expect(pileModel(few, { products: lookup, font: () => undefined }, settled).items).toBe(9);
  });

  test('合成：落到容器外面的不要，图集里每个用到的变体一格', () => {
    const settled = pileSpawn(bin, products).map((item, i) => ({ ...item, position: [i === 0 ? 5 : item.position[0], 0.03, item.position[2]] as const }));
    const model = pileModel(bin, sources, settled);
    expect(model.items).toBe(59);
    expect(model.indices.length % 3).toBe(0);
    const used = new Set(settled.slice(1).map((item) => `${item.variant}|${item.product}`)).size;
    expect(model.colorSvg.match(/<svg x=/g)?.length).toBe(used);
  });

  test('分格：隔板、每格倒自己的东西；格子号不对时报错', () => {
    const bulk: PileFile = {
      name: 'Bulk', container: { size: [0.8, 0.15, 0.4], cells: [4, 2] },
      items: [{ product: 'P/Garlic', count: 10, cell: 0 }, { product: 'P/Onion', count: 6, cell: 7 }], seed: 2,
    };
    // 底、四壁，加 3 块竖的、1 块横的隔板
    expect(pileContainer(bulk)).toHaveLength(9);
    const [x0, x1, z0, z1] = pileCell(bulk, 0);
    expect(x0).toBeCloseTo(-0.4, 9);
    expect(z0).toBeCloseTo(-0.2, 9);
    expect(x1).toBeLessThan(-0.2);
    expect(z1).toBeLessThan(0);
    for (const item of pileSpawn(bulk, products)) {
      const [cx0, cx1, cz0, cz1] = pileCell(bulk, item.product === 'P/Garlic' ? 0 : 7);
      expect(item.position[0]).toBeGreaterThanOrEqual(cx0);
      expect(item.position[0]).toBeLessThanOrEqual(cx1);
      expect(item.position[2]).toBeGreaterThanOrEqual(cz0);
      expect(item.position[2]).toBeLessThanOrEqual(cz1);
    }
    expect(() => pileSpawn({ ...bulk, items: [{ product: 'P/Garlic', count: 1, cell: 8 }] }, products)).toThrow(/cell 8/);
  });

  test('细粒的堆画进它那一格、中间鼓起来；透明盖进玻璃的网格', () => {
    const bulk: PileFile = {
      name: 'Bulk', container: { size: [0.8, 0.15, 0.4], cells: [2, 1], lids: true }, items: [],
      heaps: [{ cell: 1, color: '#e0b63a', level: 0.5 }], seed: 2,
    };
    const model = pileModel(bulk, sources, []);
    expect(model.glass?.indices.length).toBe(2 * 2 * 6);
    // 堆的顶点在第 1 格里，最高的比边上高
    const [x0, x1] = pileCell(bulk, 1);
    let top = 0;
    for (let i = 0; i < model.vertices.length; i += 8) {
      const x = model.vertices[i]!, y = model.vertices[i + 1]!;
      if (y > 0.075 + 1e-6 && y < 0.2 && x > x0 && x < x1) top = Math.max(top, y);
    }
    expect(top).toBeGreaterThan(0.08);
    expect(model.colorSvg).toContain('<ellipse');
  });
});
