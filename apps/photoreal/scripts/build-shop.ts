// 路线图七"超市和街边小店"（用户 2026-11-22 的第二批照片，reference/shop/，不进仓库）的试验场：先是商品包装生成器的展示台——
// 各种外形、按种子出的牌子排在一张台子上。只用编辑器的 MCP 服务（agent 那条路），资源和场景按这里写的覆盖，重跑就是重搭。
//   node apps/photoreal/scripts/build-shop.ts
//   看：http://localhost:5234/?scene=Shop
// 标签的中文字用资源包 @stride-ts/assets 里的站酷庆科黄油体（Shared/Fonts，开发服务器、编辑器后端打开工程时同步进来）。
import path from 'node:path';
import type { ProductFile } from '../../../packages/engine/src/content/formats/productFormat.ts';
import { McpProcess } from '../../../packages/editor/src/server/mcpClient.ts';

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
await mcp.stop();
