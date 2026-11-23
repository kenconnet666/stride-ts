import { describe, expect, test } from 'vitest';
import type { ProductFile } from '../../src/content/formats/productFormat';
import type { ShelfFile } from '../../src/content/formats/shelfFormat';
import { mergedClearMaterial, mergedMaterial } from '../../src/modeling/productBatch';
import { deliLamps, planShelf, shelfModel } from '../../src/modeling/shelf';

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
    const again = planShelf(island, products);
    expect(again.items).toEqual(items);
    expect(again.tags).toEqual(tags);
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
  }, 30_000); // 合并几千件商品的网格和图集：机器忙（验证槽在跑）时要好几秒

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

  test('挂钩架：东西挂在钩子下面、一个排面一个钩子，挂得下才挂', () => {
    const peg: ShelfFile = { ...island, type: 'pegboard', sides: 1, depth: 0.25, levels: [0.6, 1.0, 1.4], stock: { products: ['P/Water', 'P/Cereal'], variants: 2 } };
    const { items, hooks } = planShelf(peg, products);
    expect(hooks.length).toBeGreaterThan(5);
    for (const item of items) {
      const product = products.get(item.product)!;
      const level = peg.levels.find((l) => Math.abs(item.position[1] + product.size[1] + 0.015 - l) < 1e-9);
      expect(level).toBeDefined();
      expect(hooks.some((hook) => Math.abs(hook.x - item.position[0]) < 1e-9 && hook.y === level)).toBe(true);
    }
    expect(shelfModel(peg, sources).items).toBe(items.length);
  });

  test('堆头：一块块码垛、往上一层四周收进去，都在台子上方、不超过高', () => {
    const stack: ShelfFile = { ...island, type: 'stack', length: 1.6, height: 1.2, depth: 0.6, levels: [0.12], stock: { products: ['P/Cereal', 'P/Oil'], variants: 2 } };
    const { items } = planShelf(stack, products);
    expect(items.length).toBeGreaterThan(20);
    const layers = new Set(items.map((item) => item.position[1].toFixed(4)));
    expect(layers.size).toBeGreaterThan(1);
    for (const item of items) {
      const product = products.get(item.product)!;
      expect(item.position[1]).toBeGreaterThanOrEqual(0.12);
      expect(item.position[1] + product.size[1]).toBeLessThanOrEqual(1.2 + 1e-9);
      expect(Math.abs(item.position[2])).toBeLessThanOrEqual(0.3);
    }
  });

  test('透明挡条：每层每面一条进玻璃网格，层板下没有价签条；价签插在挡条后面、和挡条一样往后仰，不碰前排的商品', () => {
    const strip = shelfModel(island, sources), rail = shelfModel({ ...island, tagHolder: 'rail' }, sources);
    expect(strip.glass).toBeUndefined();
    // 每层每面：一片两面画的挡条（8 个顶点）进玻璃；价签条换成了挡条顶上不透明的折边（都是盒子，顶点一样多）
    expect(rail.glass!.vertices.length / 8).toBe(island.levels.length * 2 * 8);
    expect(rail.vertices.length).toBe(strip.vertices.length);
    // 价签：法线是挡条的（往上仰 10°、朝外）的四边形；都在层板以上、挡条的范围里
    const { tags, items } = planShelf(island, products);
    const v = rail.vertices, tilted: number[] = [];
    for (let i = 0; i < v.length / 8; i++) if (Math.abs(v[i * 8 + 4]! - Math.sin(Math.PI / 18)) < 1e-4 && Math.abs(v[i * 8 + 3]!) < 1e-6) tilted.push(i);
    expect(tilted.length).toBe(tags.length * 4);
    for (const i of tilted) {
      const y = v[i * 8 + 1]!, level = island.levels.find((l) => y > l && y < l + 0.05);
      expect(level).toBeDefined();
      // 前排的商品最前面在层板前沿往里 1 厘米，价签在它前面
      expect(Math.abs(v[i * 8 + 2]!)).toBeGreaterThan(island.depth + 0.02 - 0.01);
    }
    expect(items.length).toBeGreaterThan(0);
  });

  test('带色块的纸价签：白底深灰字，右边一块 tagAccent 的颜色；没写时有黄底的', () => {
    const plain = shelfModel(island, sources), accent = shelfModel({ ...island, tagAccent: '#1a8fe0' }, sources);
    expect(plain.colorSvg).toContain('#f6d21a');
    expect(accent.colorSvg).not.toContain('#f6d21a');
    expect((accent.colorSvg.match(/fill="#1a8fe0"/g) ?? []).length).toBe(8);
  });

  test('层板颜色：写了 boardColor 时层板用它（哑光），没写同架子', () => {
    const plain = shelfModel({ ...island, frameColor: '#3b3c3f' }, sources);
    const wood = shelfModel({ ...island, frameColor: '#3b3c3f', boardColor: '#cfb48c' }, sources);
    expect(plain.colorSvg).not.toContain('#cfb48c');
    expect(wood.colorSvg).toContain('#cfb48c');
  });

  test('熟食柜：碗盘一排排摆在下沉的托盘里，不出柜子；上方每隔 bay 一盏保温灯，灯罩底发暖光', () => {
    const bowl: ProductFile = { name: 'Bowl', shape: 'bowl', size: [0.2, 0.08, 0], food: { color: '#8a3818' } };
    const deliSources = { products: new Map([['Bowl', bowl]]), font: () => undefined };
    const deli: ShelfFile = { name: 'Deli', type: 'deli', sides: 1, length: 2.4, height: 1.6, depth: 0.9, levels: [0.86], bay: 0.6, stock: { products: ['Bowl'], facings: [1, 1], rows: 3, gaps: 0 } };
    const model = shelfModel(deli, deliSources);
    expect(model.items).toBeGreaterThan(20);
    const { items } = planShelf({ ...deli, type: 'gondola', length: 2.36, depth: 0.9 - 0.28, levels: [0.86] }, deliSources.products);
    expect(items.length).toBe(model.items);
    expect(deliLamps(deli)).toHaveLength(4);
    expect(deliLamps(deli).every(([x, y]) => Math.abs(x) < 1.2 && y === 1.6)).toBe(true);
    expect(model.emissive).toBeGreaterThan(0);
  });

  test('材质：颜色图集加表面图集（G 粗糙度、B 金属度）；有发光的格子时加自发光图集', () => {
    expect(mergedMaterial('Island', 'Shop/Island', 2048).emissiveTexture).toBeUndefined();
    expect(mergedMaterial('Fridge', 'Shop/Fridge', 2048, 6)).toMatchObject({ emissive: [6, 6, 6], emissiveTexture: { texture: 'Shop/Fridge.emissive', encoding: 'svg' } });
    const material = mergedMaterial(island.name, 'Shop/Island', 2048);
    expect(material.baseColorTexture).toMatchObject({ texture: 'Shop/Island', encoding: 'svg', size: [2048, 2048] });
    expect(material.glossinessTexture).toMatchObject({ texture: 'Shop/Island.surface', channel: 'g', invert: true, metalnessChannel: 'b', srgb: false });
  });

  test('透光的油瓶另成一个网格：同样的图集加透射，表面图集里瓶身的 R 是透射、印的地方用滤镜涂成不透', () => {
    const clearProducts = new Map([...products, ['P/Oil', { ...products.get('P/Oil')!, transmission: 0.8, pattern: 'band' as const }]]);
    const all = shelfModel(island, { products: clearProducts, font: () => undefined });
    const opaque = shelfModel(island, sources);
    expect(all.clear).toBeDefined();
    expect(opaque.clear).toBeUndefined();
    // 油瓶的顶点从主网格挪进了透光的网格，总数不变
    expect(all.vertices.length + all.clear!.vertices.length).toBe(opaque.vertices.length);
    expect(all.surfaceSvg).toContain('fill="rgb(204,82,0)"');
    expect(all.surfaceSvg).toMatch(/<defs><filter id="print-82-0"[^>]*><feFlood flood-color="rgb\(0,82,0\)"\/>/);
    expect(all.surfaceSvg).toContain('filter="url(#print-82-0)"');
    expect(opaque.surfaceSvg).not.toContain('filter');
    expect(mergedClearMaterial('Island', 'Shop/Island', 2048)).toMatchObject({
      name: 'Island clear', transmission: { factor: 1 }, glossinessTexture: { texture: 'Shop/Island.surface', transmissionChannel: 'r', metalnessChannel: 'b' },
    });
  });
});
