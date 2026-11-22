// 路线图七"超市和街边小店"（用户 2026-11-22 的第二批照片，reference/shop/，不进仓库）的试验场：先是商品包装生成器的展示台——
// 各种外形、按种子出的牌子排在一张台子上。只用编辑器的 MCP 服务（agent 那条路），资源和场景按这里写的覆盖，重跑就是重搭。
//   node apps/photoreal/scripts/build-shop.ts
//   看：http://localhost:5234/?scene=Shop（包装的展示台）、?scene=Supermarket（货架的过道）、?scene=Produce（散装区的物理堆放）
// 标签的中文字用资源包 @stride-ts/assets 里的站酷庆科黄油体（Shared/Fonts，开发服务器、编辑器后端打开工程时同步进来）。
import path from 'node:path';
import type { CeilingFile, ProductFile } from '@stride-ts/engine/content-format';
import { ceilingLights } from '@stride-ts/engine/modeling';
import { McpProcess } from '@stride-ts/editor/mcp-client';

const project = path.resolve(import.meta.dirname, '..');
const mcp = new McpProcess(project);
await mcp.start();

const call = async (tool: string, args: object) => {
  const start = performance.now();
  const { error, value } = await mcp.call(tool, args);
  if (error) throw new Error(`${tool}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
  console.log(`${tool} ${'path' in args ? String(args.path) : ''} (${Math.round(performance.now() - start)} ms)`);
  return value;
};
const write = (kind: string, path: string, content: object) => call('write_asset', { kind, path, content });

type Vec3 = [number, number, number];
type Quat = [number, number, number, number];
function euler(yaw: number, pitch = 0): Quat {
  const [y, x] = [yaw, pitch].map((degrees) => (degrees * Math.PI) / 360);
  const [cy, sy, cx, sx] = [Math.cos(y!), Math.sin(y!), Math.cos(x!), Math.sin(x!)];
  return [cy * sx, sy * cx, -sy * sx, cy * cx];
}
function lookAt(eye: Vec3, target: Vec3): Quat {
  const d = target.map((v, i) => v - eye[i]!) as Vec3;
  return euler((Math.atan2(-d[0], -d[2]) * 180) / Math.PI, (Math.asin(d[1] / Math.hypot(...d)) * 180) / Math.PI);
}
const entity = (id: string, name: string, position: Vec3, components: object, rotation: Quat = [0, 0, 0, 1]) => ({ id, name, parent: null, position, rotation, scale: [1, 1, 1], components });

const FONT = 'Shared/Fonts/ZCOOLQingKeHuangYou';
// 照片里常见的几类：瓶装的酱油、油、水，罐装饮料，广口瓶的酱，桶装的酸奶，纸盒的饼干、牛奶，袋装的零食
const products: (Omit<ProductFile, 'name' | 'font'> & { readonly id: string })[] = [
  { id: 'SoySauce', shape: 'bottle', size: [0.07, 0.25, 0], text: '生抽', seed: 11 },
  { id: 'Water', shape: 'bottle', size: [0.065, 0.21, 0], text: '矿泉水', seed: 12, colors: { background: '#e8f1f8', cap: '#d7262b' } },
  { id: 'PeanutOil', shape: 'bottle', size: [0.13, 0.32, 0], text: '花生油', seed: 13, colors: { background: '#f2c230' } },
  { id: 'Cola', shape: 'can', size: [0.066, 0.122, 0], text: '可乐', seed: 14, colors: { background: '#d7262b', cap: '#c8c8c8' } },
  { id: 'Tea', shape: 'can', size: [0.058, 0.16, 0], text: '凉茶', seed: 15, colors: { cap: '#c8c8c8' } },
  { id: 'ChiliSauce', shape: 'jar', size: [0.08, 0.1, 0], text: '辣酱', seed: 16 },
  { id: 'Yogurt', shape: 'tub', size: [0.09, 0.07, 0], text: '酸奶', seed: 17 },
  { id: 'Biscuits', shape: 'box', size: [0.2, 0.06, 0.09], text: '饼干', seed: 18 },
  { id: 'Milk', shape: 'box', size: [0.095, 0.2, 0.065], text: '纯牛奶', seed: 19 },
  { id: 'Cereal', shape: 'box', size: [0.19, 0.28, 0.07], text: '麦片', seed: 20 },
  { id: 'Chips', shape: 'pouch', size: [0.18, 0.25, 0.06], text: '薯片', seed: 21 },
  { id: 'Konjac', shape: 'pouch', size: [0.13, 0.18, 0.03], text: '魔芋爽', seed: 22 },
];
for (const { id, ...product } of products) await write('product', `Shop/Products/${id}`, { name: id, font: FONT, ...product });

await write('material', 'Shop/Materials/Table', { name: 'Table', baseColor: [0.62, 0.6, 0.57, 1], metalness: 0, roughness: 0.45 });
await write('brush', 'Shop/Models/Table', {
  name: 'Table', materials: ['Shop/Materials/Table'], uvScale: 1,
  brushes: [{ kind: 'box', operation: 'add', position: [0, 0.4, 0], size: [2.4, 0.8, 0.9] }, { kind: 'box', operation: 'add', position: [0, -0.05, 0], size: [20, 0.1, 20] }],
});

const eye: Vec3 = [0.15, 1.35, 1.35];
const sunAt: Vec3 = [-6, 10, 8];
const id = (n: number) => `5e0b5e0b-0001-4000-8000-${n.toString(16).padStart(12, '0')}`;
// 台面 y = 0.8：两排，每排六件，间隔按宽度排开
const placed = products.map((product, i) => {
  const row = Math.floor(i / 6), column = i % 6;
  const x = -0.95 + column * 0.38, z = row === 0 ? -0.18 : 0.18;
  return entity(id(0x10 + i), product.id, [x, 0.8, z], { model: { model: `Shop/Products/${product.id}`, materials: [] } }, euler(row === 0 ? 0 : -15));
});
await write('scene', 'Shop', {
  name: 'Shop',
  compositor: {
    clearColor: [0.1, 0.1, 0.12, 1],
    postEffects: { brightFilter: true, bloom: true, lightStreak: false, lensFlare: false, toneMap: true, antialiasing: true, antialiasingMode: 'temporal', ambientOcclusion: { radius: 0.1 },
      colorGrading: { operator: 'agx' }, exposure: { metering: 'histogram' } },
    transparent: true,
  },
  entities: [
    entity(id(1), 'Camera', eye, { camera: { verticalFieldOfView: 50, nearClipPlane: 0.02, farClipPlane: 500 } }, lookAt(eye, [0, 0.88, 0])),
    entity(id(2), 'Sun', sunAt, {
      light: {
        type: 'directional', color: [1, 0.97, 0.92], intensity: 8,
        shadow: { size: 'large', filter: 'pcf5x5', cascadeCount: 'four', depthBias: 0.0015, normalOffsetScale: 10, stabilization: 'projectionSnapping', pssmFactor: 0.5, depthRange: 'automatic', minDistance: 0, maxDistance: 20, blendCascades: true },
      },
    }, lookAt(sunAt, [0, 0, 0])),
    entity(id(3), 'Sky', [0, 0, 0], { skyAtmosphere: { sun: id(2) } }),
    entity(id(4), 'Table', [0, 0, 0], { model: { model: 'Shop/Models/Table', materials: [] } }),
    ...placed,
  ],
});

// ---- 超市的过道（照片 reference/shop/ 里的货架过道）：两边各两节中岛货架，靠墙一排，顶上一排排灯管 ----
// 几类没写配色、品牌名的商品：货架的变体按种子换成不同的牌子
const families: (Omit<ProductFile, 'name' | 'font'> & { readonly id: string })[] = [
  { id: 'Juice', shape: 'bottle', size: [0.075, 0.26, 0], text: '果汁', seed: 31 },
  { id: 'Vinegar', shape: 'bottle', size: [0.068, 0.24, 0], text: '香醋', seed: 32 },
  { id: 'Detergent', shape: 'bottle', size: [0.12, 0.3, 0], text: '洗衣液', seed: 33, surface: 'plastic' },
  { id: 'Beer', shape: 'can', size: [0.066, 0.165, 0], text: '啤酒', seed: 34 },
  { id: 'Sauce', shape: 'jar', size: [0.075, 0.12, 0], text: '酱', seed: 35 },
  { id: 'Noodles', shape: 'pouch', size: [0.2, 0.13, 0.07], text: '方便面', seed: 36 },
  { id: 'Crackers', shape: 'box', size: [0.14, 0.2, 0.05], text: '苏打饼干', seed: 37 },
  { id: 'Tissue', shape: 'box', size: [0.2, 0.09, 0.11], text: '抽纸', seed: 38 },
];
for (const { id, ...product } of families) await write('product', `Shop/Products/${id}`, { name: id, font: FONT, ...product });
const p = (id: string) => `Shop/Products/${id}`;
const gondola = { sides: 2, length: 4, height: 1.95, depth: 0.42, levels: [0.15, 0.55, 0.92, 1.29, 1.66], font: FONT };
const shelves: Record<string, object> = {
  Drinks: { ...gondola, priceTags: 'electronic', stock: { products: ['Water', 'Juice', 'Cola', 'Tea', 'Beer', 'PeanutOil'].map(p), variants: 4, facings: [3, 6] }, seed: 41 },
  Pantry: { ...gondola, priceTags: 'electronic', stock: { products: ['SoySauce', 'Vinegar', 'ChiliSauce', 'Sauce', 'PeanutOil', 'Yogurt'].map(p), variants: 4 }, seed: 42 },
  Snacks: { ...gondola, stock: { products: ['Chips', 'Konjac', 'Noodles', 'Biscuits', 'Crackers', 'Cereal', 'Milk'].map(p), variants: 5 }, seed: 43 },
  Household: { ...gondola, stock: { products: ['Detergent', 'Tissue', 'Cereal', 'Crackers'].map(p), variants: 3 }, seed: 44 },
  Wall: { ...gondola, priceTags: 'electronic', sides: 1, length: 8, height: 2.1, levels: [0.15, 0.52, 0.89, 1.26, 1.63, 2.0].slice(0, 5), stock: { products: ['Water', 'Juice', 'Beer', 'Cola', 'Milk', 'Yogurt'].map(p), variants: 5, facings: [4, 8] }, seed: 45 },
};
// 冷冻的货（冰柜里躺着的）、冷柜和冰柜
for (const { id, ...product } of [
  { id: 'Dumplings', shape: 'pouch', size: [0.2, 0.26, 0.05], text: '水饺', seed: 39 },
  { id: 'IceCream', shape: 'tub', size: [0.1, 0.08, 0], text: '冰淇淋', seed: 40 },
] as const) await write('product', `Shop/Products/${id}`, { name: id, font: FONT, ...product });
shelves['Fridge'] = {
  type: 'fridge', sides: 1, length: 3, height: 1.95, depth: 0.55, levels: [0.12, 0.5, 0.88, 1.26, 1.64], bay: 0.75, font: FONT, header: '冷藏饮料',
  stock: { products: ['Water', 'Juice', 'Cola', 'Beer', 'Tea', 'Milk', 'Yogurt'].map(p), variants: 4, facings: [3, 6] }, seed: 46,
};
shelves['Freezer'] = {
  type: 'freezer', sides: 1, length: 1.8, height: 0.85, depth: 0.9, levels: [0.45], font: FONT, frameColor: '#e8eaec',
  stock: { products: ['Dumplings', 'IceCream', 'Noodles'].map(p), variants: 4, facings: [2, 5], rows: 10, gaps: 0.1 }, seed: 47,
};
// 货架头上的端架（短的单面货架）、挂钩架，过道口的堆头
for (const { id, ...product } of [
  { id: 'Jerky', shape: 'pouch', size: [0.12, 0.18, 0.02], text: '牛肉干', seed: 71 },
  { id: 'Candy', shape: 'pouch', size: [0.1, 0.14, 0.015], text: '软糖', seed: 72 },
] as const) await write('product', `Shop/Products/${id}`, { name: id, font: FONT, ...product });
shelves['EndCap'] = { ...gondola, sides: 1, length: 0.9, priceTags: 'electronic', stock: { products: ['Cereal', 'Crackers', 'Biscuits', 'Milk'].map(p), variants: 3, facings: [2, 3] }, seed: 48 };
shelves['Hooks'] = {
  type: 'pegboard', sides: 1, length: 0.9, height: 1.95, depth: 0.22, levels: [0.62, 0.92, 1.22, 1.52, 1.82], font: FONT, frameColor: '#c9ccd0',
  stock: { products: ['Jerky', 'Candy', 'Konjac', 'Noodles'].map(p), variants: 4, facings: [2, 3], rows: 6 }, seed: 49,
};
shelves['Stack'] = { type: 'stack', sides: 1, length: 1.1, height: 0.85, depth: 0.6, levels: [0.12], font: FONT, stock: { products: ['Tissue', 'Cereal', 'Biscuits'].map(p), variants: 2, facings: [3, 4] }, seed: 50 };
for (const [name, shelf] of Object.entries(shelves)) await write('shelf', `Shop/Shelves/${name}`, { name, ...shelf });
// 收银台、寄存柜、购物车、篮子、闸机
const fixtures: Record<string, object> = {
  Checkout1: { type: 'checkout', number: '1', font: FONT }, Checkout2: { type: 'checkout', number: '2', font: FONT },
  Locker: { type: 'locker', columns: 6, rows: 4 }, Cart: { type: 'cart' }, Basket: { type: 'basket', color: '#2f9e44' }, Gate: { type: 'gate' },
};
for (const [name, fixture] of Object.entries(fixtures)) await write('fixture', `Shop/Fixtures/${name}`, { name, ...fixture });
// 通道上方挂的双面招牌
const signs: Record<string, object> = {
  AisleDrinks: { text: '饮料 · 零食', size: [1.5, 0.36, 0.08], doubleSided: true, colors: { background: '#2f9e44' } },
  AisleFrozen: { text: '冷冻食品', size: [1.5, 0.36, 0.08], doubleSided: true, colors: { background: '#1e64c8' } },
};
for (const [name, sign] of Object.entries(signs)) await write('sign', `Shop/Signs/${name}`, { name, font: FONT, ...sign });

// 地面：照片里超市的大块浅色瓷砖（60 厘米），按世界坐标铺；每块深浅、光滑程度略有不同，缝是浅灰的，表面有细的磨痕
type GraphNode = { id: string; type: string; params?: object; inputs?: Record<string, { node: string; output?: string }> };
const node = (id: string, type: string, params: object = {}, inputs: Record<string, string | readonly [string, string]> = {}): GraphNode => ({
  id, type, params,
  inputs: Object.fromEntries(Object.entries(inputs).map(([port, from]) => [port, typeof from === 'string' ? { node: from } : { node: from[0], output: from[1] }])),
});
await write('material', 'Shop/Materials/Floor', {
  name: 'Floor', baseColor: [1, 1, 1, 1], metalness: 0, roughness: 0.18,
  graph: {
    nodes: [
      node('uv', 'worldUv', { scale: 1 / 0.6 }),
      node('tiles', 'bricks', { columns: 1, rows: 1, mortar: 0.004, shift: 0 }, { uv: 'uv' }),
      node('tone', 'colorRamp', { from: [0.66, 0.65, 0.63], to: [0.76, 0.75, 0.73] }, { t: ['tiles', 'brick'] }),
      node('wear', 'noise', { scale: 30, octaves: 4 }, { uv: 'uv' }),
      node('speckle', 'colorRamp', { from: [0.96, 0.96, 0.96], to: [1.03, 1.03, 1.03] }, { t: 'wear' }),
      node('surface', 'multiply', {}, { a: 'tone', b: 'speckle' }),
      node('joint', 'color', { color: [0.5, 0.5, 0.49] }),
      node('color', 'mix', {}, { a: 'joint', b: 'surface', t: ['tiles', 'mask'] }),
      // 光滑：瓷砖 0.1～0.2（每块不同，磨痕处糙一点），缝 0.6
      node('gloss', 'levels', { inMin: 0, inMax: 1, outMin: 0.1, outMax: 0.2 }, { in: ['tiles', 'brick'] }),
      node('scuff', 'levels', { inMin: 0.4, inMax: 0.9, outMin: 0, outMax: 0.08 }, { in: 'wear' }),
      node('tileRough', 'add', {}, { a: 'gloss', b: 'scuff' }),
      node('jointRough', 'value', { value: 0.6 }),
      node('rough', 'mix', {}, { a: 'jointRough', b: 'tileRough', t: ['tiles', 'mask'] }),
      node('normal', 'normalFromHeight', { strength: 0.6 }, { height: ['tiles', 'mask'], uv: 'uv' }),
    ],
    outputs: { baseColor: { node: 'color' }, roughness: { node: 'rough' }, normal: { node: 'normal' } },
  },
});
await write('material', 'Shop/Materials/Wall', { name: 'Wall', baseColor: [0.62, 0.6, 0.56, 1], metalness: 0, roughness: 0.7 });
await write('brush', 'Shop/Models/Hall', {
  name: 'Hall', materials: ['Shop/Materials/Floor', 'Shop/Materials/Wall'], uvScale: 1,
  brushes: [
    { kind: 'box', operation: 'add', position: [0, -0.05, -4], size: [14, 0.1, 20] },
    { kind: 'box', operation: 'add', position: [-6.1, 1.65, -4], size: [0.2, 3.3, 20], material: 1 },
    { kind: 'box', operation: 'add', position: [6.1, 1.65, -4], size: [0.2, 3.3, 20], material: 1 },
    { kind: 'box', operation: 'add', position: [0, 1.65, -14.1], size: [14, 3.3, 0.2], material: 1 },
  ],
});
const aisleEye: Vec3 = [0.25, 1.5, 3.2];
const sid = (k: number) => `5e0b5e0b-0002-4000-8000-${k.toString(16).padStart(12, '0')}`;
const fixtureAt = (k: number, name: string, position: Vec3, yaw: number) => entity(sid(0x80 + k), `${name} ${k}`, position, { model: { model: `Shop/Fixtures/${name}`, materials: [] } }, euler(yaw));
const shelfAt = (k: number, name: string, position: Vec3, yaw: number) => entity(sid(0x10 + k), `${name} ${k}`, position, { model: { model: `Shop/Shelves/${name}`, materials: [] } }, euler(yaw));
// 过道沿 -Z：左边一排的正面朝 +X，右边一排朝 -X；靠墙那排在右边的墙上
const shelfEntities = [
  shelfAt(0, 'Drinks', [-1.3, 0, -1], 90), shelfAt(1, 'Pantry', [-1.3, 0, -5.1], 90),
  shelfAt(2, 'Snacks', [1.3, 0, -1], -90), shelfAt(3, 'Household', [1.3, 0, -5.1], -90),
  shelfAt(4, 'Snacks', [-4.2, 0, -3], 90), shelfAt(5, 'Wall', [5.95, 0, -3], -90),
  // 过道尽头：一台卧式冰柜，后墙前一排两节立式冷柜
  shelfAt(6, 'Freezer', [0, 0, -8.4], 0), shelfAt(7, 'Fridge', [-1.55, 0, -11.6], 0), shelfAt(8, 'Fridge', [1.55, 0, -11.6], 0),
  // 两排货架朝着入口的那一头：左边端架、右边挂钩架；过道口一个低的堆头
  shelfAt(9, 'EndCap', [-1.3, 0, 1.03], 0), shelfAt(10, 'Hooks', [1.3, 0, 1.03], 0), shelfAt(11, 'Stack', [0, 0, 1.85], 0),
  // 入口那片：左边两个收银台（顾客从 -Z 走过），右墙一排寄存柜，几辆购物车、一摞篮子，中间两道闸机
  fixtureAt(0, 'Checkout1', [-4.4, 0, 3.6], 90), fixtureAt(1, 'Checkout2', [-2.9, 0, 3.6], 90),
  fixtureAt(2, 'Locker', [5.75, 0, 3.8], -90),
  ...[0, 1, 2].map((i) => fixtureAt(3 + i, 'Cart', [3.2 + i * 0.12, 0, 4.4 - i * 0.28], 180)),
  ...[0, 1, 2, 3].map((i) => fixtureAt(6 + i, 'Basket', [4.4, i * 0.09, 2.6], 10 * i)),
  fixtureAt(10, 'Gate', [1.2, 0, 4.6], 0), fixtureAt(11, 'Gate', [2.0, 0, 4.6], 0),
  // 挂在过道上方的招牌
  entity(sid(0x30), 'Sign drinks', [0, 2.55, -2.6], { model: { model: 'Shop/Signs/AisleDrinks', materials: [] } }),
  entity(sid(0x31), 'Sign frozen', [0, 2.55, -7.4], { model: { model: 'Shop/Signs/AisleFrozen', materials: [] } }),
];
// 天花板：照片里开放式的黑顶（风管、桥架、喷淋管、吊杆上的灯管）。管线沿天花板的 X，转 90° 以后顺着过道（-Z）；
// 面光源放在 ceilingLights 算出的每盏灯管下面，灯具和光对得上
const ceiling: CeilingFile = { name: 'Hall', size: [20, 14], height: 3.3, style: 'open', ducts: 2, trays: 2, pipes: 3, lights: { rows: 4, spacing: 2.2, length: 1.4, drop: 0.55 } };
await write('ceiling', 'Shop/Ceilings/Hall', ceiling);
const ceilingAt: Vec3 = [0, 0, -4];
const ceilingEntity = (id: string) => entity(id, 'Ceiling', ceilingAt, { model: { model: 'Shop/Ceilings/Hall', materials: [] } }, euler(90));
// 转 90°：天花板本地的 (x, z) 到世界是 (z, -x)
const lights = ceilingLights(ceiling).map((light, i) => entity(sid(0x40 + i), `Light ${i}`, [ceilingAt[0] + light.center[2], light.center[1] - 0.015, ceilingAt[2] - light.center[0]], {
  light: { type: 'rect', color: [1, 0.97, 0.92], intensity: 24, width: 0.12, height: light.length, range: 9 },
}, euler(0, -90)));
await write('scene', 'Supermarket', {
  name: 'Supermarket',
  compositor: {
    clearColor: [0.05, 0.05, 0.06, 1],
    postEffects: { brightFilter: true, bloom: true, lightStreak: false, lensFlare: false, toneMap: true, antialiasing: true, antialiasingMode: 'temporal', ambientOcclusion: { radius: 0.2 },
      localReflections: { maxRoughness: 0.4, edgeFade: 0.1 }, colorGrading: { operator: 'agx', temperature: 6000 }, exposure: { metering: 'histogram', localShadows: 0.3 } },
    transparent: true,
  },
  entities: [
    entity(sid(1), 'Camera', aisleEye, { camera: { verticalFieldOfView: 67, nearClipPlane: 0.05, farClipPlane: 200 } }, lookAt(aisleEye, [0, 1.2, -6])),
    entity(sid(2), 'Ambient', [0, 3, 0], { light: { type: 'ambient', color: [1, 0.98, 0.95], intensity: 0.35 } }),
    entity(sid(3), 'Hall', [0, 0, 0], { model: { model: 'Shop/Models/Hall', materials: [] } }),
    ceilingEntity(sid(4)),
    ...shelfEntities,
    ...lights,
  ],
});
// ---- 散装区（照片里的蒜、洋葱、核桃、番茄、土豆）：几个筐里物理堆放，放在一张蔬果台上 ----
const produce: (Omit<ProductFile, 'name' | 'font'> & { readonly id: string })[] = [
  { id: 'Garlic', shape: 'garlic', size: [0.055, 0.048, 0], seed: 51 },
  { id: 'RedOnion', shape: 'onion', size: [0.08, 0.085, 0], seed: 52 },
  { id: 'Walnut', shape: 'nut', size: [0.034, 0.036, 0], seed: 53 },
  { id: 'Tomato', shape: 'round', size: [0.075, 0.062, 0], seed: 54 },
  { id: 'Potato', shape: 'tuber', size: [0.11, 0.055, 0.07], seed: 55 },
];
for (const { id, ...product } of produce) await write('product', `Shop/Products/${id}`, { name: id, ...product });
const piles: Record<string, object> = {
  GarlicBin: { container: { size: [0.6, 0.12, 0.4], color: '#2b2d30' }, items: [{ product: p('Garlic'), count: 220, variants: 4 }], seed: 61 },
  OnionBin: { container: { size: [0.6, 0.12, 0.4], color: '#2b2d30' }, items: [{ product: p('RedOnion'), count: 90, variants: 4 }], seed: 62 },
  WalnutBin: { container: { size: [0.4, 0.1, 0.3], color: '#6b4a2e' }, items: [{ product: p('Walnut'), count: 420, variants: 3 }], seed: 63 },
  TomatoBin: { container: { size: [0.6, 0.12, 0.4], color: '#2b2d30' }, items: [{ product: p('Tomato'), count: 110, variants: 5 }], seed: 64 },
  PotatoBin: { container: { size: [0.6, 0.12, 0.4], color: '#2b2d30' }, items: [{ product: p('Potato'), count: 70, variants: 3 }], seed: 65 },
};
// 散装柜（照片里一格格带透明盖的）：两格干货跑物理，六格米、豆、瓜子画成一堆
for (const { id, ...product } of [
  { id: 'Peanut', shape: 'tuber', size: [0.032, 0.014, 0.016], seed: 56, colors: { background: '#c9a374', accent: '#9a7448' } },
  { id: 'Shiitake', shape: 'round', size: [0.045, 0.018, 0], seed: 57, colors: { background: '#6a4a30', accent: '#3e2a1a', cap: '#8a6a48' } },
] as const) await write('product', `Shop/Products/${id}`, { name: id, ...product });
piles['BulkBin'] = {
  container: { size: [1.6, 0.16, 0.56], color: '#cdb994', cells: [4, 2], lids: true },
  items: [{ product: p('Peanut'), count: 160, variants: 2, cell: 0 }, { product: p('Shiitake'), count: 70, variants: 3, cell: 5 }],
  heaps: [
    { cell: 1, color: '#f1ece0', grain: 0.005, speckle: '#c9c0aa' },
    { cell: 2, color: '#8e2a2a', grain: 0.008, speckle: '#4a1212' },
    { cell: 3, color: '#4e7a2a', grain: 0.006, speckle: '#23401a' },
    { cell: 4, color: '#2a2526', grain: 0.009, speckle: '#000000' },
    { cell: 6, color: '#3c3734', grain: 0.014, speckle: '#d8d0c0', level: 0.9 },
    { cell: 7, color: '#e0b63a', grain: 0.008, speckle: '#a77a18' },
  ],
  seed: 66,
};
for (const [name, pile] of Object.entries(piles)) await write('pile', `Shop/Piles/${name}`, { name, ...pile });
await write('material', 'Shop/Materials/Stand', { name: 'Stand', baseColor: [0.32, 0.24, 0.17, 1], metalness: 0, roughness: 0.6 });
await write('brush', 'Shop/Models/Stand', {
  name: 'Stand', materials: ['Shop/Materials/Stand'], uvScale: 1,
  brushes: [{ kind: 'box', operation: 'add', position: [0, 0.4, 0], size: [2.1, 0.8, 0.95] }],
});
const standEye: Vec3 = [0.1, 1.55, 1.25];
const pid = (k: number) => `5e0b5e0b-0003-4000-8000-${k.toString(16).padStart(12, '0')}`;
const binAt = (k: number, name: string, x: number, z: number) => entity(pid(0x10 + k), name, [x, 0.8, z], { model: { model: `Shop/Piles/${name}`, materials: [] } });
await write('scene', 'Produce', {
  name: 'Produce',
  compositor: {
    clearColor: [0.05, 0.05, 0.06, 1],
    postEffects: { brightFilter: true, bloom: true, lightStreak: false, lensFlare: false, toneMap: true, antialiasing: true, antialiasingMode: 'temporal', ambientOcclusion: { radius: 0.1 },
      colorGrading: { operator: 'agx', temperature: 6000 }, exposure: { metering: 'histogram', localShadows: 0.3 } },
    transparent: true,
  },
  entities: [
    entity(pid(1), 'Camera', standEye, { camera: { verticalFieldOfView: 60, nearClipPlane: 0.02, farClipPlane: 100 } }, lookAt(standEye, [0, 0.82, -0.05])),
    entity(pid(2), 'Ambient', [0, 3, 0], { light: { type: 'ambient', color: [1, 0.98, 0.95], intensity: 0.35 } }),
    entity(pid(3), 'Hall', [0, 0, 0], { model: { model: 'Shop/Models/Hall', materials: [] } }),
    ceilingEntity(pid(7)),
    entity(pid(4), 'Stand', [0, 0, 0], { model: { model: 'Shop/Models/Stand', materials: [] } }),
    binAt(0, 'GarlicBin', -0.66, -0.23), binAt(1, 'OnionBin', 0, -0.23), binAt(2, 'TomatoBin', 0.66, -0.23),
    binAt(3, 'PotatoBin', -0.5, 0.23), binAt(4, 'WalnutBin', 0.25, 0.23),
    // 后面一张台子上是散装柜
    entity(pid(6), 'Stand back', [0, 0, -1.15], { model: { model: 'Shop/Models/Stand', materials: [] } }),
    entity(pid(0x20), 'BulkBin', [0, 0.8, -1.15], { model: { model: 'Shop/Piles/BulkBin', materials: [] } }),
    entity(pid(5), 'Light', [0, 3.0, 0], { light: { type: 'rect', color: [1, 0.96, 0.9], intensity: 30, width: 1.6, height: 0.3, range: 6 } }, euler(0, -90)),
  ],
});
await mcp.stop();
