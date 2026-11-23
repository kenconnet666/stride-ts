import { describe, expect, test } from 'vitest';
import type { ProductFile } from '../../src/content/formats/productFormat';
import type { ShelfFile } from '../../src/content/formats/shelfFormat';
import { mergedClearMaterial, mergedMaterial } from '../../src/modeling/productBatch';
import { deliLamps, planShelf, shelfModel } from '../../src/modeling/shelf';
import { productFootprint } from '../../src/modeling/product';

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
    // 背面的转半圈（摆得乱：圆的瓶罐再转最多 ±45°×0.5）
    expect(items.some((item) => item.position[2] > 0 && Math.abs(item.yaw) <= Math.PI / 8 + 1e-9)).toBe(true);
    expect(items.some((item) => item.position[2] < 0 && Math.abs(item.yaw - Math.PI) <= Math.PI / 8 + 1e-9)).toBe(true);
    expect(tags.some((tag) => tag.side === -1)).toBe(true);
    const again = planShelf(island, products);
    expect(again.items).toEqual(items);
    expect(again.tags).toEqual(tags);
    expect(planShelf({ ...island, seed: 8 }, products).items).not.toEqual(items);
  });

  test('摆得乱：messiness 0 时整整齐齐；默认时圆的转过、方的只歪一点，同一层相邻的两件不重叠', () => {
    const tidy = planShelf({ ...island, stock: { ...island.stock!, messiness: 0 } }, products);
    expect(tidy.items.every((item) => item.yaw === 0 || item.yaw === Math.PI)).toBe(true);
    const { items } = planShelf(island, products);
    const turned = items.filter((item) => item.yaw !== 0 && item.yaw !== Math.PI);
    expect(turned.length).toBeGreaterThan(items.length / 2);
    for (const item of items) {
      const product = products.get(item.product)!, off = Math.abs(Math.atan2(Math.sin(item.yaw), Math.cos(item.yaw))) % Math.PI;
      const yaw = Math.min(off, Math.PI - off);
      expect(yaw).toBeLessThanOrEqual(product.shape === 'box' || product.shape === 'pouch' ? 0.12 : Math.PI / 8 + 1e-9);
    }
    // 同一层、同一面、同一排（z 差不到半件）里左右挨着的两件：中心距不小于两件的半宽之和（圆的按直径，方的按转过的外接宽）
    const rows = new Map<string, typeof items>();
    for (const item of items) {
      const key = `${item.position[1].toFixed(3)}|${Math.sign(item.position[2])}|${Math.round(item.position[2] * 20)}`;
      rows.set(key, [...(rows.get(key) ?? []), item]);
    }
    const half = (item: (typeof items)[number]) => {
      const [w, , d] = productFootprint(products.get(item.product)!);
      return products.get(item.product)!.shape === 'box' ? (w * Math.abs(Math.cos(item.yaw)) + d * Math.abs(Math.sin(item.yaw))) / 2 : w / 2;
    };
    for (const row of rows.values()) {
      row.sort((a, b) => a.position[0] - b.position[0]);
      for (let i = 1; i < row.length; i++) expect(row[i]!.position[0] - row[i - 1]!.position[0]).toBeGreaterThanOrEqual(half(row[i]!) + half(row[i - 1]!) - 1e-6);
    }
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

  test('冷柜门上的脏：每扇门两片贴在玻璃外面（把手周围、底下的水雾，UV 在贴图里这扇门的那一格里），贴图每扇不同；doorHaze 0 时没有，别的货架没有', () => {
    const fridge: ShelfFile = { ...island, type: 'fridge', sides: 1, length: 2.25, bay: 0.75 };
    const model = shelfModel(fridge, sources);
    expect(model.haze!.indices.length).toBe(3 * 2 * 6);
    expect(model.hazePixels).toEqual([3 * Math.round((0.75 - 0.04) * 600), Math.round((1.6 - 0.15) * 600)]);
    const vertices = model.haze!.vertices;
    for (let i = 0; i < vertices.length; i += 8) {
      expect(vertices[i + 2]!).toBeGreaterThan(0.4);
      // 第几扇门：按 x 算，UV 落在那一格里
      const door = Math.min(2, Math.floor((vertices[i]! + 1.125) / 0.75 + 1e-6));
      expect(vertices[i + 6]! * 3).toBeGreaterThanOrEqual(door - 1e-6);
      expect(vertices[i + 6]! * 3).toBeLessThanOrEqual(door + 1 + 1e-6);
      expect(vertices[i + 7]!).toBeGreaterThanOrEqual(-1e-6);
      expect(vertices[i + 7]!).toBeLessThanOrEqual(1 + 1e-6);
    }
    const doors = model.hazeSvg!.split('<g transform=').slice(1);
    expect(doors).toHaveLength(3);
    expect(new Set(doors.map((door) => door.slice(door.indexOf('>'))))).toHaveProperty('size', 3);
    expect(shelfModel({ ...fridge, doorHaze: 0 }, sources).haze).toBeUndefined();
    expect(shelfModel(island, sources).haze).toBeUndefined();
  });

  test('品牌冷柜：doorColor 是门框、门下前脸、顶和灯箱的颜色；每扇门一个把手，凸在门外', () => {
    const fridge: ShelfFile = { ...island, type: 'fridge', sides: 1, length: 0.7, bay: 0.7 };
    const plain = shelfModel(fridge, sources), branded = shelfModel({ ...fridge, doorColor: '#e8a91c' }, sources);
    expect(plain.colorSvg).not.toContain('#e8a91c');
    expect(branded.colorSvg).toContain('fill="#e8a91c"');
    // 一扇门：把手是三个盒子，最前面那个在门的玻璃外 3 厘米
    const front = Math.max(...Array.from({ length: branded.vertices.length / 8 }, (_, i) => branded.vertices[i * 8 + 2]!));
    expect(front).toBeGreaterThan(island.depth + 0.05 + 0.02);
  });

  test('冷柜门上的广告贴：每扇门多两条横幅（两个四边形）和两条边框（两个盒子），贴在玻璃外面；图集里有贴纸的底色', () => {
    const fridge: ShelfFile = { ...island, type: 'fridge', sides: 1, length: 1.4, bay: 0.7 };
    const plain = shelfModel(fridge, sources), stuck = shelfModel({ ...fridge, doorSticker: { color: '#5a2d91', title: 'A', slogan: 'B' } }, sources);
    // 两扇门，每扇 2 个四边形（4 个顶点）加 2 个盒子（24 个顶点）
    expect(stuck.vertices.length / 8 - plain.vertices.length / 8).toBe(2 * (2 * 4 + 2 * 24));
    expect(stuck.colorSvg).toContain('fill="#5a2d91"');
    expect(plain.colorSvg).not.toContain('#5a2d91');
  });

  test('木纹层板：写了 boardColor 时层板贴木纹的格子（UV 铺满一格，不是纯色的一点），图集里有木纹的线', () => {
    const plain = shelfModel(island, sources), wood = shelfModel({ ...island, boardColor: '#bfb8ac' }, sources);
    const lines = (svg: string) => (svg.match(/fill="none" stroke=/g) ?? []).length;
    expect(lines(wood.colorSvg) - lines(plain.colorSvg)).toBeGreaterThanOrEqual(60);
    // 顶点一样多（还是盒子），但层板的 UV 散开了：不同的 UV 比纯色的多
    expect(wood.vertices.length).toBe(plain.vertices.length);
    const uvs = (vertices: Float32Array) => new Set(Array.from({ length: vertices.length / 8 }, (_, i) => `${vertices[i * 8 + 6]},${vertices[i * 8 + 7]}`)).size;
    expect(uvs(wood.vertices)).toBeGreaterThan(uvs(plain.vertices));
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

  test('码垛：一个托盘一种货，整箱直上直下码在托盘面上、不超过高和托盘的大小，最上面一层少几箱', () => {
    const pallet: ShelfFile = { ...island, type: 'pallet', length: 1.2, height: 1.5, depth: 1.0, levels: [0.144], boardColor: '#b48a5a', stock: { products: ['P/Cereal', 'P/Oil'], variants: 2 } };
    const { items, tags } = planShelf(pallet, products);
    expect(new Set(items.map((item) => item.product)).size).toBe(1);
    expect(tags.length).toBe(1);
    const product = products.get(items[0]!.product)!;
    const [w, h, d] = productFootprint(product);
    const layers = [...new Set(items.map((item) => item.position[1]))].sort((a, b) => a - b);
    expect(layers.length).toBe(Math.floor((1.5 - 0.144) / (h + 0.002)));
    const perLayer = (y: number) => items.filter((item) => item.position[1] === y).length;
    expect(perLayer(layers.at(-1)!)).toBeLessThanOrEqual(perLayer(layers[0]!));
    for (const item of items) {
      expect(item.position[1] + h).toBeLessThanOrEqual(1.5 + 1e-9);
      expect(Math.abs(item.position[0]) + w / 2).toBeLessThanOrEqual(0.6 + 0.01);
      expect(Math.abs(item.position[2]) + d / 2).toBeLessThanOrEqual(0.5 + 0.01);
    }
    expect(shelfModel(pallet, sources).items).toBe(items.length);
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

  test('按层摆：写了 stock.levels 的层只摆那几种，null 的层照 products；层板厚了上一层的净空跟着少', () => {
    const file: ShelfFile = { ...island, sides: 1, stock: { ...island.stock!, levels: [['P/Cereal'], null, ['P/Water']] } };
    const { items } = planShelf(file, products);
    const on = (level: number) => new Set(items.filter((item) => Math.abs(item.position[1] - level) < 1e-6).map((item) => item.product));
    expect([...on(0.15)]).toEqual(['P/Cereal']);
    expect([...on(0.85)]).toEqual(['P/Water']);
    expect(on(0.5).size).toBeGreaterThan(1);
    // 0.35 米一层、麦片盒 0.28 米高：层板 2 厘米时下面几层放得下，8 厘米时只有最上一层放得下
    const below = (thickness: number) => planShelf({ ...island, boardThickness: thickness }, products).items.some((item) => item.product === 'P/Cereal' && item.position[1] < 1.2);
    expect(below(0.02)).toBe(true);
    expect(below(0.08)).toBe(false);
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
  test('价签：商品写了价格的第 0 款印它，别的款在 0.9～1.12 倍、几十块的不用 .99 和 .00；没写的随机', () => {
    const priced = new Map([...products].map(([path, product]): [string, ProductFile] => [path, { ...product, price: 59.9 }]));
    const one = planShelf({ ...island, stock: { ...island.stock!, variants: 1 } }, priced);
    expect(new Set(one.tags.map((tag) => tag.price))).toEqual(new Set(['59.90']));
    const { tags } = planShelf(island, priced);
    expect(new Set(tags.map((tag) => tag.price)).size).toBeGreaterThan(1);
    for (const tag of tags) {
      expect(Number(tag.price)).toBeGreaterThanOrEqual(53);
      expect(Number(tag.price)).toBeLessThanOrEqual(67.1);
      expect(tag.price).toMatch(/\.(90|80|50)$/);
    }
    // 同一种货、同一款的价签一样
    expect(new Set(planShelf({ ...island, seed: 9 }, priced).tags.map((tag) => tag.price)).size).toBeLessThanOrEqual(3);
    expect(planShelf(island, products).tags.every((tag) => /^\d+\.\d\d$/.test(tag.price))).toBe(true);
  });

  test('透光的商品：每一排都进透射的网格（前后排同一种材质），别的进不透明的', () => {
    const oil: ProductFile = { name: 'Oil', shape: 'bottle', size: [0.08, 0.28, 0], transmission: 0.75, seed: 2 };
    const shelf = (rows: number): ShelfFile => ({ ...island, sides: 1, stock: { products: ['P/Oil'], variants: 1, gaps: 0, rows, messiness: 0 } });
    const all = { products: new Map([['P/Oil', oil]]), font: () => undefined };
    const one = shelfModel(shelf(1), all), three = shelfModel(shelf(3), all);
    expect(three.items).toBeGreaterThan(one.items);
    // 多出来的后排都在透射的网格里，不透明的只多了价签之类的零碎
    expect(three.clear!.vertices.length / one.clear!.vertices.length).toBeGreaterThan(1.5);
    expect(three.vertices.length).toBeLessThan(one.vertices.length * 1.2);
  });

  test('格子柜：摞在货架顶上，瓶子横躺在格子里、瓶口朝外贴近前沿；有六边形格；没有瓶子时也能画', () => {
    const wine: ProductFile = { name: 'Wine', shape: 'bottle', size: [0.075, 0.3, 0], seed: 4 };
    const shelf: ShelfFile = {
      name: 'Oil', sides: 1, length: 2, height: 1.6, depth: 0.4, levels: [0.15, 0.5, 0.85, 1.2], seed: 7,
      stock: { products: ['P/Water'], gaps: 0 },
      cubbies: { height: 0.8, rows: 2, columns: 3, hex: 1, products: ['P/Wine'], fill: 1 },
    };
    const all = new Map([...products, ['P/Wine', wine]]);
    const { items } = planShelf(shelf, all);
    const model = shelfModel(shelf, { products: all, font: () => undefined });
    const bottles = model.items - items.length;
    expect(bottles).toBeGreaterThan(6);
    let top = 0;
    for (let i = 1; i < model.vertices.length; i += 8) top = Math.max(top, model.vertices[i]!);
    expect(top).toBeCloseTo(2.4, 5);
    const empty = shelfModel({ ...shelf, cubbies: { ...shelf.cubbies!, products: [] } }, { products: all, font: () => undefined });
    expect(empty.items).toBe(items.length);
    expect(empty.vertices.length).toBeLessThan(model.vertices.length);
  });
});
