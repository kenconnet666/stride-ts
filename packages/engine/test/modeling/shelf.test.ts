import { describe, expect, test } from 'vitest';
import type { ProductFile } from '../../src/content/formats/productFormat';
import type { ShelfFile } from '../../src/content/formats/shelfFormat';
import { mergedMaterial } from '../../src/modeling/productBatch';
import { planShelf, shelfModel } from '../../src/modeling/shelf';

const products = new Map<string, ProductFile>([
  ['P/Water', { name: 'Water', shape: 'bottle', size: [0.065, 0.21, 0], seed: 1 }],
  ['P/Oil', { name: 'Oil', shape: 'bottle', size: [0.13, 0.32, 0], seed: 2 }],
  ['P/Cereal', { name: 'Cereal', shape: 'box', size: [0.19, 0.28, 0.07], seed: 3 }],
]);
const island: ShelfFile = {
  name: 'Island', sides: 2, length: 2, height: 1.6, depth: 0.4, levels: [0.15, 0.5, 0.85, 1.2],
  stock: { products: ['P/Water', 'P/Oil', 'P/Cereal'], variants: 3, gaps: 0 }, seed: 7,
};
const sources = { products, font: () => undefined };

describe('货架', () => {
  test('每一层只摆放得下的：高不超过到上一层层板的净空，都在架子里面、站在层板上', () => {
    const short: ShelfFile = { ...island, levels: [0.15, 0.4, 0.65, 1.2] };
    const { items } = planShelf(short, products);
    expect(items.length).toBeGreaterThan(50);
    for (const item of items) {
      const product = products.get(item.product)!;
      const level = short.levels.indexOf(item.position[1]);
      expect(level).toBeGreaterThanOrEqual(0);
      const above = short.levels[level + 1] ?? short.height;
      expect(item.position[1] + product.size[1]).toBeLessThanOrEqual(above);
      expect(Math.abs(item.position[0]) + product.size[0] / 2).toBeLessThanOrEqual(short.length / 2);
      expect(Math.abs(item.position[2])).toBeLessThanOrEqual(0.02 + short.depth);
    }
    // 0.4 → 0.65 的净空（0.215）只够水
    expect(new Set(items.filter((item) => item.position[1] === 0.4).map((item) => item.product))).toEqual(new Set(['P/Water']));
  });

  test('双面：两面都摆，背面的转半圈；同一个种子摆出来一样，换种子不一样', () => {
    const { items, tags } = planShelf(island, products);
    expect(items.some((item) => item.position[2] > 0 && item.yaw === 0)).toBe(true);
    expect(items.some((item) => item.position[2] < 0 && item.yaw === Math.PI)).toBe(true);
    expect(tags.some((tag) => tag.side === -1)).toBe(true);
    expect(planShelf(island, products)).toEqual({ items, tags });
    expect(planShelf({ ...island, seed: 8 }, products).items).not.toEqual(items);
  });

  test('单面只摆正面；没有货时是空架子；规则不对时报错', () => {
    expect(planShelf({ ...island, sides: 1 }, products).items.every((item) => item.position[2] > 0)).toBe(true);
    expect(planShelf((({ stock: _, ...rest }) => rest)(island), products).items).toEqual([]);
    expect(() => planShelf({ ...island, levels: [0.5, 0.3] }, products)).toThrow(/go up/);
    expect(() => planShelf({ ...island, levels: [0.15, 1.7] }, products)).toThrow(/below the height/);
  });

  test('空位：卖掉了的位子前面空着，后面还有', () => {
    const full = planShelf(island, products).items.length;
    const sold = planShelf({ ...island, stock: { ...island.stock!, gaps: 0.5 } }, products).items.length;
    expect(sold).toBeLessThan(full);
    expect(sold).toBeGreaterThan(full * 0.5);
  });

  test('网格和图集：一个网格，UV 都在图集里，图集里每个用到的变体一格', () => {
    const model = shelfModel(island, sources);
    expect(model.items).toBe(planShelf(island, products).items.length);
    expect(model.indices.length % 3).toBe(0);
    const vertexCount = model.vertices.length / 8;
    expect(model.indices.reduce((max, index) => Math.max(max, index), 0)).toBeLessThan(vertexCount);
    for (let i = 0; i < model.vertices.length; i += 8) {
      expect(model.vertices[i + 6]).toBeGreaterThanOrEqual(0);
      expect(model.vertices[i + 6]).toBeLessThanOrEqual(1);
      expect(model.vertices[i + 7]).toBeGreaterThanOrEqual(0);
      expect(model.vertices[i + 7]).toBeLessThanOrEqual(1);
    }
    const used = new Set(planShelf(island, products).items.map((item) => `${item.variant}|${item.product}`)).size;
    expect(model.colorSvg.match(/<svg x=/g)?.length).toBe(used);
    expect(model.surfaceSvg).toContain('rgb(0,');
  });

  test('冷柜：玻璃门进玻璃网格、灯带发光，只摆正面；冰柜的货在槽里、玻璃盖在上面', () => {
    const fridge = shelfModel({ ...island, type: 'fridge', sides: 2 }, sources);
    expect(fridge.glass?.indices.length).toBeGreaterThan(0);
    expect(fridge.emissive).toBeGreaterThan(0);
    expect(fridge.emissiveSvg).toContain('opacity');
    const freezer: ShelfFile = { ...island, type: 'freezer', length: 1.8, height: 0.85, depth: 0.9, levels: [0.45] };
    const model = shelfModel(freezer, sources);
    expect(model.glass?.indices.length).toBeGreaterThan(0);
    expect(model.items).toBeGreaterThan(0);
    // 货都在槽里：槽底以上、四壁以内
    for (let i = 0; i < model.vertices.length; i += 8) expect(Math.abs(model.vertices[i + 2]!)).toBeLessThanOrEqual(0.45 + 1e-6);
  });

  test('电子价签：每个价签多一个外壳（6 个面），屏比纸价签凸出来；图集里画了二维码的方块', () => {
    const paper = shelfModel(island, sources), electronic = shelfModel({ ...island, priceTags: 'electronic' }, sources);
    const tags = planShelf(island, products).tags.length;
    expect(electronic.vertices.length / 8 - paper.vertices.length / 8).toBe(tags * 24);
    expect((electronic.colorSvg.match(/fill="#151515"/g) ?? []).length).toBeGreaterThan(8 * 12);
  });

  test('材质：颜色图集加表面图集（G 粗糙度、B 金属度）；有发光的格子时加自发光图集', () => {
    expect(mergedMaterial('Island', 'Shop/Island', 2048).emissiveTexture).toBeUndefined();
    expect(mergedMaterial('Fridge', 'Shop/Fridge', 2048, 6)).toMatchObject({ emissive: [6, 6, 6], emissiveTexture: { texture: 'Shop/Fridge.emissive', encoding: 'svg' } });
    const material = mergedMaterial(island.name, 'Shop/Island', 2048);
    expect(material.baseColorTexture).toMatchObject({ texture: 'Shop/Island', encoding: 'svg', size: [2048, 2048] });
    expect(material.glossinessTexture).toMatchObject({ texture: 'Shop/Island.surface', channel: 'g', invert: true, metalnessChannel: 'b', srgb: false });
  });
});
