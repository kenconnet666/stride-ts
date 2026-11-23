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
  { id: 'SoySauce', shape: 'bottle', size: [0.07, 0.25, 0], text: '生抽', price: 12.9, seed: 11 },
  { id: 'Water', shape: 'bottle', size: [0.065, 0.21, 0], text: '矿泉水', price: 1.5, seed: 12, colors: { background: '#e8f1f8', cap: '#d7262b' } },
  { id: 'PeanutOil', shape: 'bottle', size: [0.13, 0.32, 0], text: '花生油', price: 45.9, seed: 13, colors: { background: '#f2c230' } },
  { id: 'Cola', shape: 'can', size: [0.066, 0.122, 0], text: '可乐', price: 3, seed: 14, colors: { background: '#d7262b', cap: '#c8c8c8' } },
  { id: 'Tea', shape: 'can', size: [0.058, 0.16, 0], text: '凉茶', price: 3.5, seed: 15, colors: { cap: '#c8c8c8' } },
  { id: 'ChiliSauce', shape: 'jar', size: [0.08, 0.1, 0], text: '辣酱', price: 9.5, seed: 16 },
  { id: 'Yogurt', shape: 'tub', size: [0.09, 0.07, 0], text: '酸奶', price: 6.5, seed: 17 },
  { id: 'Biscuits', shape: 'box', size: [0.2, 0.06, 0.09], text: '饼干', price: 8.9, seed: 18 },
  { id: 'Milk', shape: 'box', size: [0.095, 0.2, 0.065], text: '纯牛奶', price: 12.9, seed: 19 },
  { id: 'Cereal', shape: 'box', size: [0.19, 0.28, 0.07], text: '麦片', price: 25.9, seed: 20 },
  { id: 'Chips', shape: 'pouch', size: [0.18, 0.25, 0.06], text: '薯片', price: 7.5, seed: 21 },
  { id: 'Konjac', shape: 'pouch', size: [0.13, 0.18, 0.03], text: '魔芋爽', price: 9.9, seed: 22 },
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
  { id: 'Juice', shape: 'bottle', size: [0.075, 0.26, 0], text: '果汁', price: 6.9, seed: 31 },
  { id: 'Vinegar', shape: 'bottle', size: [0.068, 0.24, 0], text: '香醋', price: 8.5, seed: 32 },
  { id: 'Detergent', shape: 'bottle', size: [0.12, 0.3, 0], text: '洗衣液', price: 39.9, seed: 33, surface: 'plastic' },
  { id: 'Beer', shape: 'can', size: [0.066, 0.165, 0], text: '啤酒', price: 4.5, seed: 34 },
  { id: 'Sauce', shape: 'jar', size: [0.075, 0.12, 0], text: '酱', price: 9.8, seed: 35 },
  { id: 'Noodles', shape: 'pouch', size: [0.2, 0.13, 0.07], text: '方便面', price: 4.5, seed: 36 },
  { id: 'Crackers', shape: 'box', size: [0.14, 0.2, 0.05], text: '苏打饼干', price: 9.9, seed: 37 },
  { id: 'Tissue', shape: 'box', size: [0.2, 0.09, 0.11], text: '抽纸', price: 4.9, seed: 38 },
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
  { id: 'Dumplings', shape: 'pouch', size: [0.2, 0.26, 0.05], text: '水饺', price: 24.9, seed: 39 },
  { id: 'IceCream', shape: 'tub', size: [0.1, 0.08, 0], text: '冰淇淋', price: 15.9, seed: 40 },
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
  { id: 'Jerky', shape: 'pouch', size: [0.12, 0.18, 0.02], text: '牛肉干', price: 29.9, seed: 71 },
  { id: 'Candy', shape: 'pouch', size: [0.1, 0.14, 0.015], text: '软糖', price: 6.9, seed: 72 },
] as const) await write('product', `Shop/Products/${id}`, { name: id, font: FONT, ...product });
shelves['EndCap'] = { ...gondola, sides: 1, length: 0.9, priceTags: 'electronic', stock: { products: ['Cereal', 'Crackers', 'Biscuits', 'Milk'].map(p), variants: 3, facings: [2, 3] }, seed: 48 };
shelves['Hooks'] = {
  type: 'pegboard', sides: 1, length: 0.9, height: 1.95, depth: 0.22, levels: [0.62, 0.92, 1.22, 1.52, 1.82], font: FONT, frameColor: '#c9ccd0',
  stock: { products: ['Jerky', 'Candy', 'Konjac', 'Noodles'].map(p), variants: 4, facings: [2, 3], rows: 6 }, seed: 49,
};
shelves['Stack'] = { type: 'stack', sides: 1, length: 1.1, height: 0.85, depth: 0.6, levels: [0.12], font: FONT, stock: { products: ['Tissue', 'Cereal', 'Biscuits'].map(p), variants: 2, facings: [3, 4] }, seed: 50 };
// 整个超市要的更多品类（照片里：米面粮油、酒、洗护、日化、罐头、桶面，入口那片码在托盘上的整箱牛奶、水、方便面、啤酒）
for (const { id, ...product } of [
  { id: 'Rice', shape: 'pouch', size: [0.3, 0.45, 0.1], text: '东北大米', price: 39.9, seed: 151, badge: '5kg' },
  { id: 'Flour', shape: 'pouch', size: [0.28, 0.4, 0.09], text: '小麦面粉', price: 25.9, seed: 152, badge: '5kg' },
  { id: 'Liquor', shape: 'box', size: [0.1, 0.27, 0.1], text: '白酒', price: 168, seed: 153, colors: { background: '#b3121b', accent: '#e8c25a' } },
  { id: 'Wine', shape: 'bottle', size: [0.075, 0.31, 0], text: '干红', price: 89, seed: 154, surface: 'glass' },
  { id: 'Shampoo', shape: 'bottle', size: [0.08, 0.24, 0], text: '洗发水', price: 39.9, seed: 155, surface: 'plastic' },
  { id: 'Toothpaste', shape: 'box', size: [0.2, 0.045, 0.045], text: '牙膏', price: 12.9, seed: 156 },
  { id: 'Wipes', shape: 'pouch', size: [0.2, 0.12, 0.06], text: '湿巾', price: 9.9, seed: 157 },
  { id: 'Porridge', shape: 'can', size: [0.066, 0.11, 0], text: '八宝粥', price: 4.5, seed: 158 },
  { id: 'CupNoodle', shape: 'tub', size: [0.11, 0.11, 0], text: '桶面', price: 5.5, seed: 159 },
  { id: 'MilkCase', shape: 'box', size: [0.34, 0.25, 0.22], text: '纯牛奶', price: 59.9, seed: 160, badge: '24盒', colors: { background: '#f4f6f2', accent: '#2f8f3a' } },
  { id: 'WaterCase', shape: 'box', size: [0.38, 0.26, 0.25], text: '饮用水', price: 29.9, seed: 161, badge: '24瓶', colors: { background: '#e8f2fb', accent: '#1e64c8' } },
  { id: 'NoodleCase', shape: 'box', size: [0.42, 0.24, 0.3], text: '方便面', price: 69, seed: 162, badge: '整箱', colors: { background: '#c8281e', accent: '#f2c40f' } },
  { id: 'BeerCase', shape: 'box', size: [0.4, 0.25, 0.27], text: '啤酒', price: 79, seed: 163, badge: '24罐', colors: { background: '#1a5a2e', accent: '#e8c25a' } },
] as const) await write('product', `Shop/Products/${id}`, { name: id, font: FONT, ...product });
// 靠墙的单面货架（三面墙铺满：左墙、右墙一节节 4 米，后墙两头各一节短的，中间是冷柜）
const wall = { ...gondola, priceTags: 'electronic', sides: 1, height: 2.1, levels: [0.15, 0.52, 0.89, 1.26, 1.63] };
Object.assign(shelves, {
  WallGrain: { ...wall, stock: { products: ['Rice', 'Flour', 'PeanutOil', 'SoySauce'].map(p), variants: 4, facings: [3, 6] }, seed: 171 },
  WallLiquor: { ...wall, stock: { products: ['Liquor', 'Wine', 'Beer'].map(p), variants: 5, facings: [3, 6] }, seed: 172 },
  WallCare: { ...wall, stock: { products: ['Shampoo', 'Toothpaste', 'Wipes', 'Detergent'].map(p), variants: 5 }, seed: 173 },
  WallHome: { ...wall, stock: { products: ['Tissue', 'Wipes', 'Detergent'].map(p), variants: 4, facings: [3, 6] }, seed: 174 },
  WallCanned: { ...wall, stock: { products: ['Porridge', 'Sauce', 'Vinegar', 'ChiliSauce'].map(p), variants: 4, facings: [3, 7] }, seed: 175 },
  WallSnack: { ...wall, stock: { products: ['Chips', 'Biscuits', 'Jerky', 'Candy'].map(p), variants: 5 }, seed: 180 },
  WallDrinks: { ...wall, stock: { products: ['Water', 'Juice', 'Cola', 'Tea'].map(p), variants: 4, facings: [4, 8] }, seed: 186 },
  WallEnd: { ...wall, length: 1.75, stock: { products: ['Water', 'Juice', 'Tea'].map(p), variants: 3 }, seed: 176 },
  WallCorner: { ...wall, length: 2.45, stock: { products: ['Milk', 'Yogurt', 'Cereal'].map(p), variants: 4 }, seed: 177 },
  // 中间三排货架多出来的两种
  Instant: { ...gondola, priceTags: 'electronic', stock: { products: ['CupNoodle', 'Noodles', 'Porridge', 'Konjac'].map(p), variants: 5 }, seed: 178 },
  Breakfast: { ...gondola, stock: { products: ['Cereal', 'Milk', 'Crackers', 'Biscuits'].map(p), variants: 4 }, seed: 179 },
  // 码垛区：一个托盘一种整箱的货（货垛最大 1.2 × 1.0 米、1.2 米高，木托盘跟着货垛的大小）
  ...Object.fromEntries(['MilkCase', 'WaterCase', 'NoodleCase', 'BeerCase'].map((product, i) => [`Pallet${product.replace('Case', '')}`, {
    type: 'pallet', sides: 1, length: 1.2, height: 1.2, depth: 1.0, levels: [0.144], font: FONT, boardColor: '#b48a5a',
    stock: { products: [p(product)], variants: 2 }, seed: 181 + i,
  }])),
});
for (const [name, shelf] of Object.entries(shelves)) await write('shelf', `Shop/Shelves/${name}`, { name, ...shelf });
// 收银台、自助收银机、寄存柜、购物车、篮子、闸机
const fixtures: Record<string, object> = {
  Checkout1: { type: 'checkout', number: '1', font: FONT }, Checkout2: { type: 'checkout', number: '2', font: FONT },
  ...Object.fromEntries([3, 4, 5].map((n) => [`Self${n}`, { type: 'selfCheckout', number: String(n), font: FONT }])),
  Locker: { type: 'locker', columns: 6, rows: 4 }, Cart: { type: 'cart' }, Basket: { type: 'basket', color: '#2f9e44' }, Gate: { type: 'gate' },
};
for (const [name, fixture] of Object.entries(fixtures)) await write('fixture', `Shop/Fixtures/${name}`, { name, ...fixture });
// 通道上方挂的双面招牌
const signs: Record<string, object> = {
  AisleDrinks: { text: '饮料 · 零食', size: [1.5, 0.36, 0.08], doubleSided: true, colors: { background: '#2f9e44' } },
  AisleFrozen: { text: '冷冻食品', size: [1.5, 0.36, 0.08], doubleSided: true, colors: { background: '#1e64c8' } },
  AisleGrain: { text: '粮油 · 酒水', size: [1.5, 0.36, 0.08], doubleSided: true, colors: { background: '#c8281e' } },
  AislePantry: { text: '调味 · 速食', size: [1.5, 0.36, 0.08], doubleSided: true, colors: { background: '#e07a1a' } },
  AisleHome: { text: '日化 · 洗护', size: [1.5, 0.36, 0.08], doubleSided: true, colors: { background: '#7a3fa0' } },
  // 靠墙货架上方墙上的分类灯箱（照片里墙上一排发光的字）
  ...Object.fromEntries(([
    ['WallSignGrain', '粮油', '#c8281e'], ['WallSignLiquor', '酒水', '#8a1a20'], ['WallSignCanned', '调味 · 罐头', '#e07a1a'], ['WallSignSnack', '休闲零食', '#e0a01a'],
    ['WallSignCare', '个人洗护', '#2f7fd0'], ['WallSignHome', '家庭日化', '#7a3fa0'], ['WallSignDrinks', '饮料 · 水', '#1e9e8a'],
  ] as const).map(([name, text, background]) => [name, { text, size: [1.8, 0.42, 0.1], colors: { background }, brightness: 2.5 }])),
  // 入口、出口上方的挂牌
  Entrance: { text: '入口', size: [1.4, 0.4, 0.06], style: 'panel', doubleSided: true, colors: { background: '#2f9e44' } },
  Exit: { text: '出口 · 收银', size: [1.8, 0.4, 0.06], style: 'panel', doubleSided: true, colors: { background: '#c8281e' } },
  // 过道上方吊下来的促销旗（两面印）
  ...Object.fromEntries(([['BannerSale', '特价', '#d7262b'], ['BannerDeal', '满99减20', '#e07a1a'], ['BannerNew', '新品上市', '#2f9e44'], ['BannerMember', '会员日', '#7a3fa0']] as const)
    .map(([name, text, background], i) => [name, { text, size: [0.55, 0.8, 0.01], style: 'banner', hang: 0.45, colors: { background, text: '#fff3b0' }, seed: 120 + i }])),
  // 码垛旁的地堆价牌
  ...Object.fromEntries(([['StandMilk', '整箱特价\n59.9'], ['StandWater', '整箱\n29.9'], ['StandNoodle', '整箱特价\n69'], ['StandBeer', '整箱\n79']] as const)
    .map(([name, text], i) => [name, { text, size: [0.34, 0.26, 0.01], style: 'stand', standHeight: 1.25, colors: { background: '#f6d21a', text: '#d7262b' }, seed: 130 + i }])),
  // 地贴：入口进来的箭头、出口的箭头、收银台前的排队圆标
  FloorEnter: { text: '入口', size: [0.6, 1.0, 0], style: 'floor', shape: 'arrow', colors: { background: '#2f9e44' }, wear: 0.4, seed: 140 },
  FloorExit: { text: '出口', size: [0.6, 1.0, 0], style: 'floor', shape: 'arrow', colors: { background: '#c8281e' }, wear: 0.4, seed: 141 },
  FloorQueue: { text: '请排队', size: [0.5, 0.5, 0], style: 'floor', shape: 'round', colors: { background: '#f6d21a', text: '#3a3a3a' }, wear: 0.5, seed: 142 },
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
      node('clean', 'mix', {}, { a: 'joint', b: 'surface', t: ['tiles', 'mask'] }),
      // 脏：一米多一块的灰印（低频噪声），货架脚下、墙角这些被遮住的地方更脏（屏幕空间遮蔽）
      node('dirtUv', 'worldUv', { scale: 0.35 }),
      node('blotch', 'noise', { scale: 3, octaves: 5, seed: 7 }, { uv: 'dirtUv' }),
      node('blotches', 'levels', { inMin: 0.45, inMax: 0.68, outMax: 0.45 }, { in: 'blotch' }),
      node('corners', 'occlusionMask', { from: 0.15, to: 0.6 }),
      node('dirt', 'add', {}, { a: 'blotches', b: 'corners' }),
      node('grime', 'color', { color: [0.5, 0.48, 0.44] }),
      node('dirty', 'mix', {}, { a: 'clean', b: 'grime', t: 'dirt' }),
      // 划痕：顺着过道拉长的细线（拉长的噪声取很窄的一段），稍亮、糙
      node('scratchUv', 'uvTransform', { scale: [40, 1.2], rotation: 8 }, { uv: 'uv' }),
      node('scratchNoise', 'noise', { scale: 4, octaves: 2, seed: 3 }, { uv: 'scratchUv' }),
      node('scratch', 'levels', { inMin: 0.67, inMax: 0.69 }, { in: 'scratchNoise' }),
      node('bright', 'color', { color: [0.82, 0.81, 0.79] }),
      node('color', 'mix', {}, { a: 'dirty', b: 'bright', t: ['scratch', 'out'] }),
      // 光滑：瓷砖 0.1～0.2（每块不同，磨痕处糙一点），缝 0.6
      node('gloss', 'levels', { inMin: 0, inMax: 1, outMin: 0.1, outMax: 0.2 }, { in: ['tiles', 'brick'] }),
      node('scuff', 'levels', { inMin: 0.4, inMax: 0.9, outMin: 0, outMax: 0.08 }, { in: 'wear' }),
      node('worn', 'add', {}, { a: 'gloss', b: 'scuff' }),
      node('dirtRough', 'levels', { outMax: 0.18 }, { in: 'dirt' }),
      node('scratchRough', 'levels', { outMax: 0.15 }, { in: 'scratch' }),
      node('roughExtra', 'add', {}, { a: 'dirtRough', b: 'scratchRough' }),
      node('tileRough', 'add', {}, { a: 'worn', b: 'roughExtra' }),
      node('jointRough', 'value', { value: 0.6 }),
      node('rough', 'mix', {}, { a: 'jointRough', b: 'tileRough', t: ['tiles', 'mask'] }),
      node('normal', 'normalFromHeight', { strength: 0.6 }, { height: ['tiles', 'mask'], uv: 'uv' }),
    ],
    outputs: { baseColor: { node: 'color' }, roughness: { node: 'rough' }, normal: { node: 'normal' } },
  },
});
// 墙：大片淡淡的水渍，墙根一截脏，推车、拖把碰到的高度（0.15～0.9 米）横着几道黑色的擦痕；UV 是白盒的自动 UV（一米一个周期）
await write('material', 'Shop/Materials/Wall', {
  name: 'Wall', baseColor: [1, 1, 1, 1], metalness: 0, roughness: 0.7,
  graph: {
    nodes: [
      node('uv', 'uv'),
      node('paint', 'color', { color: [0.62, 0.6, 0.56] }),
      node('stainNoise', 'noise', { scale: 1.2, octaves: 5, seed: 11 }, { uv: 'uv' }),
      node('stain', 'levels', { inMin: 0.5, inMax: 0.9, outMax: 0.35 }, { in: 'stainNoise' }),
      node('stainColor', 'color', { color: [0.54, 0.52, 0.48] }),
      node('stained', 'mix', {}, { a: 'paint', b: 'stainColor', t: 'stain' }),
      node('base', 'heightMask', { minHeight: -1, maxHeight: 0.12, blend: 0.14 }),
      node('baseNoise', 'noise', { scale: 6, octaves: 3, seed: 5 }, { uv: 'uv' }),
      node('baseGrime', 'multiply', {}, { a: 'base', b: 'baseNoise' }),
      node('grimeColor', 'color', { color: [0.42, 0.4, 0.37] }),
      node('grimy', 'mix', {}, { a: 'stained', b: 'grimeColor', t: 'baseGrime' }),
      node('scuffUv', 'uvTransform', { scale: [0.25, 10] }, { uv: 'uv' }),
      node('scuffNoise', 'noise', { scale: 5, octaves: 2, seed: 9 }, { uv: 'scuffUv' }),
      node('scuffLine', 'levels', { inMin: 0.76, inMax: 0.8, outMax: 0.55 }, { in: 'scuffNoise' }),
      node('bumpHeight', 'heightMask', { minHeight: 0.15, maxHeight: 0.9, blend: 0.1 }),
      node('scuff', 'multiply', {}, { a: 'scuffLine', b: 'bumpHeight' }),
      node('rubber', 'color', { color: [0.2, 0.2, 0.2] }),
      node('color', 'mix', {}, { a: 'grimy', b: 'rubber', t: 'scuff' }),
      node('roughBase', 'value', { value: 0.7 }),
      node('roughGrime', 'levels', { outMin: 0, outMax: 0.15 }, { in: 'baseGrime' }),
      node('rough', 'add', {}, { a: 'roughBase', b: 'roughGrime' }),
    ],
    outputs: { baseColor: { node: 'color' }, roughness: { node: 'rough' } },
  },
});
await write('brush', 'Shop/Models/Hall', {
  name: 'Hall', materials: ['Shop/Materials/Floor', 'Shop/Materials/Wall'], uvScale: 1,
  brushes: [
    { kind: 'box', operation: 'add', position: [0, -0.05, -4], size: [14, 0.1, 20] },
    { kind: 'box', operation: 'add', position: [-6.1, 1.65, -4], size: [0.2, 3.3, 20], material: 1 },
    { kind: 'box', operation: 'add', position: [6.1, 1.65, -4], size: [0.2, 3.3, 20], material: 1 },
    { kind: 'box', operation: 'add', position: [0, 1.65, -14.1], size: [14, 3.3, 0.2], material: 1 },
  ],
});
// 整个超市（用户 11-23 画的布局）：大厅 12 × 20 米，入口在 +Z 那头。靠墙三面铺满单面货架（左墙、右墙一节节，后墙两头各一节、中间
// 两节立式冷柜）；中间三排双面货架（x = -3、0、3，顺着 -Z，两节 8 米，两头是端架和挂钩架），后面一片放卧式冰柜；门口左边是入口
// （门外的门厅里贴墙的寄存柜，两道单向闸机和两段围栏，闸机里面的购物车和篮子），右边是结账出口（两个收银台、靠右墙三台自助收银机），中间一片码垛（四个托盘的整箱货）。
// 货架的原点：单面的在背板上、正面朝它自己的 +Z；双面的、冰柜、码垛在中心。yaw 90 正面朝 +X，-90 朝 -X，0 朝 +Z，180 朝 -Z。
const entranceEye: Vec3 = [0.2, 1.75, 5.8];
const sid = (k: number) => `5e0b5e0b-0002-4000-8000-${k.toString(16).padStart(12, '0')}`;
const fixtureAt = (k: number, name: string, position: Vec3, yaw: number) => entity(sid(0x80 + k), `${name} ${k}`, position, { model: { model: `Shop/Fixtures/${name}`, materials: [] } }, euler(yaw));
let shelfCount = 0;
const shelfAt = (name: string, position: Vec3, yaw: number) => entity(sid(0x10 + shelfCount), `${name} ${shelfCount++}`, position, { model: { model: `Shop/Shelves/${name}`, materials: [] } }, euler(yaw));
const WALL_X = 5.95, BACK_Z = -13.95, ROWS = [-3, 0, 3] as const;
// 入口的围栏（用户 11-23 在截图上画的）：沿着闸机那条线（z = 4.8）横着拦，左墙到第一道闸机一段，第二道闸机到收银台那头一段，
// 进店只能走闸机，出店走收银台外面；颜色、质感同闸机（灰色的漆面金属，fixture.ts 的闸机主色）
await write('material', 'Shop/Materials/Railing', { name: 'Railing', baseColor: [0.48, 0.5, 0.53, 1], metalness: 0.8, roughness: 0.45 });
const fence = (name: string, from: number, to: number) => write('spline', `Shop/Splines/${name}`, {
  name, materials: ['Shop/Materials/Railing', 'Shop/Materials/Railing'],
  profile: { type: 'fence', height: 0.97, postSpacing: 1.1, rails: 2 },
  points: [{ position: [from, 0, 4.8] }, { position: [to, 0, 4.8] }],
});
await fence('EntranceFence', -5.98, -4.74);
await fence('CheckoutFence', -3.06, 2.0);
// 门外的门厅（储物柜放在入口外面，用户 11-23）：地面、两边的墙、顶往外接 3.5 米，顶上两盏灯
await write('brush', 'Shop/Models/Vestibule', {
  name: 'Vestibule', materials: ['Shop/Materials/Floor', 'Shop/Materials/Wall'], uvScale: 1,
  brushes: [
    { kind: 'box', operation: 'add', position: [0, -0.05, 7.75], size: [14, 0.1, 3.5] },
    { kind: 'box', operation: 'add', position: [-6.1, 1.65, 7.75], size: [0.2, 3.3, 3.5], material: 1 },
    { kind: 'box', operation: 'add', position: [6.1, 1.65, 7.75], size: [0.2, 3.3, 3.5], material: 1 },
    { kind: 'box', operation: 'add', position: [0, 3.35, 7.75], size: [12.4, 0.1, 3.5], material: 1 },
  ],
});
const shelfEntities = [
  // 左墙：粮油、酒、罐头调味、零食，从入口那头（z = 2.05）铺到后墙
  ...['WallGrain', 'WallLiquor', 'WallCanned', 'WallSnack'].map((name, i) => shelfAt(name, [-WALL_X, 0, 0.05 - 4 * i], 90)),
  // 右墙：饮料（紧挨着收银，用户 11-23 定）、日化、洗护，前面留给自助收银机（z = -0.2 起），最后一节短的接到后墙
  ...['WallDrinks', 'WallHome', 'WallCare'].map((name, i) => shelfAt(name, [WALL_X, 0, -2.2 - 4 * i], -90)),
  shelfAt('WallEnd', [WALL_X, 0, -13.075], -90),
  // 后墙：中间两节立式冷柜，两头各一节短货架
  shelfAt('Fridge', [-1.55, 0, BACK_Z], 0), shelfAt('Fridge', [1.55, 0, BACK_Z], 0),
  shelfAt('WallCorner', [-4.275, 0, BACK_Z], 0), shelfAt('WallCorner', [4.275, 0, BACK_Z], 0),
  // 中间三排：每排两节 4 米（z 从 0.4 到 -7.6），朝入口那头一个端架，后头一个挂钩架；再往后一台卧式冰柜
  ...ROWS.flatMap((x, i) => {
    const [front, back] = ([['Snacks', 'Breakfast'], ['Drinks', 'Pantry'], ['Instant', 'Household']] as const)[i]!;
    return [
      shelfAt(front, [x, 0, -1.6], 90), shelfAt(back, [x, 0, -5.6], 90),
      shelfAt('EndCap', [x, 0, 0.43], 0), shelfAt('Hooks', [x, 0, -7.63], 180),
      shelfAt('Freezer', [x, 0, -10.2], 90),
    ];
  }),
  // 码垛区：入口和出口之间四个托盘
  ...(['PalletMilk', 'PalletWater', 'PalletNoodle', 'PalletBeer'] as const).map((name, i) => shelfAt(name, [i % 2 === 0 ? -0.75 : 0.75, 0, i < 2 ? 1.75 : 3.0], 0)),
  // 入口（左）：门厅左墙的寄存柜（在入口外面），两道单向闸机，闸机里面的购物车、一摞篮子
  fixtureAt(2, 'Locker', [-5.75, 0, 7.6], 90),
  fixtureAt(10, 'Gate', [-4.3, 0, 4.8], 0), fixtureAt(11, 'Gate', [-3.5, 0, 4.8], 0),
  // 购物车顺着车身套成一串（车头朝店里，后一辆的车头插进前一辆的车尾）
  ...[0, 1, 2].map((i) => fixtureAt(3 + i, 'Cart', [-2.6, 0, 3.4 + i * 0.26], 180)),
  ...[0, 1, 2, 3].map((i) => fixtureAt(6 + i, 'Basket', [-1.7, i * 0.09, 3.6], 10 * i)),
  // 结账出口（右）：两个收银台（顾客从 -Z 走过来），右墙前三台自助收银机朝过道
  fixtureAt(0, 'Checkout1', [2.9, 0, 3.6], -90), fixtureAt(1, 'Checkout2', [4.4, 0, 3.6], -90),
  entity(sid(0x35), 'Checkout fence', [0, 0, 0], { model: { model: 'Shop/Splines/CheckoutFence', materials: [] } }),
  entity(sid(0x36), 'Entrance fence', [0, 0, 0], { model: { model: 'Shop/Splines/EntranceFence', materials: [] } }),
  entity(sid(0x37), 'Vestibule', [0, 0, 0], { model: { model: 'Shop/Models/Vestibule', materials: [] } }),
  ...[-3, 3].map((x, i) => entity(sid(0x38 + i), `Vestibule light ${i}`, [x, 3.28, 7.75], {
    light: { type: 'rect', color: [1, 0.97, 0.92], intensity: 18, width: 0.12, height: 1.4, range: 7 },
  }, euler(0, -90))),
  ...[3, 4, 5].map((n, i) => fixtureAt(12 + i, `Self${n}`, [5.7, 0, 0.6 + i * 1.15], -90)),
  // 四条过道上方的招牌
  ...([['AisleGrain', -4.5], ['AisleDrinks', -1.5], ['AislePantry', 1.5], ['AisleHome', 4.5]] as const).map(([name, x], i) => entity(sid(0x30 + i), `Sign ${name}`, [x, 2.55, -3.6], { model: { model: `Shop/Signs/${name}`, materials: [] } }, euler(0))),
  entity(sid(0x34), 'Sign frozen', [0, 2.55, -9.0], { model: { model: 'Shop/Signs/AisleFrozen', materials: [] } }),
  ...detailEntities(),
];

/** 细节：墙上的分类灯箱、入口出口的挂牌、过道上的吊旗、码垛旁的价牌、地贴、过道里的购物车和篮子。 */
function detailEntities() {
  let count = 0;
  const did = () => `5e0b5e0b-0004-4000-8000-${(count++).toString(16).padStart(12, '0')}`;
  const sign = (name: string, position: Vec3, yaw: number) => entity(did(), name, position, { model: { model: `Shop/Signs/${name}`, materials: [] } }, euler(yaw));
  // 地贴：贴花从上往下投到地面，盒子 0.3 米高、中心在地面上（离中心远的上下两截按 upperFade、lowerFade 渐隐）
  const sticker = (name: string, position: Vec3, size: readonly [number, number], yaw: number) =>
    entity(did(), name, position, { decal: { size: [size[0], 0.3, size[1]], albedo: { texture: `Shop/Signs/${name}`, encoding: 'svg' } } }, euler(yaw));
  return [
    // 墙上的灯箱：在每节靠墙货架的正上方，贴着墙
    ...(['WallSignGrain', 'WallSignLiquor', 'WallSignCanned', 'WallSignSnack'] as const).map((name, i) => sign(name, [-WALL_X, 2.55, 0.05 - 4 * i], 90)),
    ...(['WallSignDrinks', 'WallSignHome', 'WallSignCare'] as const).map((name, i) => sign(name, [WALL_X, 2.55, -2.2 - 4 * i], -90)),
    sign('Entrance', [-3.9, 2.5, 4.8], 0), sign('Exit', [3.65, 2.6, 5.3], 0),
    // 吊旗：中间两条过道上错开挂
    sign('BannerSale', [-1.5, 2.3, -1.5], 0), sign('BannerDeal', [1.5, 2.3, -2.2], 0),
    sign('BannerNew', [-1.5, 2.3, -5.6], 0), sign('BannerMember', [1.5, 2.3, -6.6], 0),
    // 价牌：每个托盘外侧前角（托盘的顺序同码垛：牛奶、水在里排，方便面、啤酒在外排）
    sign('StandMilk', [-1.55, 0, 2.15], 15), sign('StandWater', [1.55, 0, 2.15], -15),
    sign('StandNoodle', [-1.55, 0, 3.4], 15), sign('StandBeer', [1.55, 0, 3.4], -15),
    sticker('FloorEnter', [-3.9, 0, 3.6], [0.6, 1.0], 0), sticker('FloorExit', [3.65, 0, 5.0], [0.6, 1.0], 180),
    sticker('FloorQueue', [3.65, 0, 2.1], [0.5, 0.5], 0), sticker('FloorQueue', [3.65, 0, 1.3], [0.5, 0.5], 0),
    // 过道里推着的购物车、放在地上的篮子
    fixtureAt(16, 'Cart', [-1.45, 0, -3.3], 165), fixtureAt(17, 'Basket', [1.6, 0, -2.6], 30),
  ];
}
// 天花板：照片里开放式的黑顶（风管、桥架、喷淋管、吊杆上的灯管）。管线沿天花板的 X，转 90° 以后顺着过道（-Z）；
// 面光源放在 ceilingLights 算出的每盏灯管下面，灯具和光对得上。调料过道用的 Hall（14 米宽）照旧；超市的 Market 和大厅一样
// 12 米宽，四排灯正好在四条过道（x = ±1.5、±4.5）的上面
const hallCeiling: CeilingFile = { name: 'Hall', size: [20, 14], height: 3.3, style: 'open', ducts: 2, trays: 2, pipes: 3, lights: { rows: 4, spacing: 2.2, length: 1.4, drop: 0.55 } };
await write('ceiling', 'Shop/Ceilings/Hall', hallCeiling);
const ceiling: CeilingFile = { ...hallCeiling, name: 'Market', size: [20, 12] };
await write('ceiling', 'Shop/Ceilings/Market', ceiling);
const ceilingAt: Vec3 = [0, 0, -4];
const ceilingEntity = (id: string) => entity(id, 'Ceiling', ceilingAt, { model: { model: 'Shop/Ceilings/Market', materials: [] } }, euler(90));
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
    entity(sid(1), 'Camera', entranceEye, { camera: { verticalFieldOfView: 67, nearClipPlane: 0.05, farClipPlane: 200 } }, lookAt(entranceEye, [0, 1.0, -6])),
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
