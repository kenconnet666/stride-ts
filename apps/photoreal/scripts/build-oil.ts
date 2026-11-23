// 路线图七"超市和街边小店"的照片比对：照用户拍的油货架（reference/shop/051c92b8…jpg，不进仓库）搭同样的一排靠墙货架——浅木色的
// 层板、插在透明挡条里带蓝色块的价签、深灰的架子，摆满大桶小桶的食用油，上面一排深色木格子；机位照手机主摄（约 26 毫米等效，竖拍时长边 67°）。
// 只用编辑器的 MCP 服务，资源和场景按这里写的覆盖，重跑就是重搭。地面、墙用 build-shop.ts 写的（先跑过它）。
//   node apps/photoreal/scripts/build-oil.ts
//   看：http://localhost:5234/?scene=OilShelf；比：stride shot oil.png --photo reference/shop/051c92b832461cf0f6ad9de50d851329.jpg
import path from 'node:path';
import type { ProductFile } from '@stride-ts/engine/content-format';
import { McpProcess } from '@stride-ts/editor/mcp-client';

const project = path.resolve(import.meta.dirname, '..');
const mcp = new McpProcess(project);
await mcp.start();
const call = async (tool: string, args: object) => {
  const { error, value } = await mcp.call(tool, args);
  if (error) throw new Error(`${tool}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
  console.log(`${tool} ${'path' in args ? String(args.path) : ''}`);
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

// 照片里的油：5 升的大桶（下面几层）、1.8 升（中间）、900 毫升（最上层）。瓶身是透出来的油色（琥珀、金黄），标签只是中间一圈
// （band），红、绿、蓝居多（金龙鱼、鲁花、福临门那样）
const oils: (Omit<ProductFile, 'name' | 'font'> & { readonly id: string })[] = [
  { id: 'Oil5L', claims: ['非转基因', '一级'], shape: 'jug', size: [0.17, 0.32, 0.105], text: '食用油', price: 69.9, seed: 81, motif: 'sunflower', badge: '5L', pattern: 'band', transmission: 0.75, colors: { background: '#e8a52c', accent: '#d7262b', cap: '#d7262b' } },
  { id: 'Peanut5L', claims: ['物理压榨', '一级'], shape: 'jug', size: [0.17, 0.32, 0.105], text: '花生油', price: 129.9, seed: 82, motif: 'peanut', badge: '5L', pattern: 'band', transmission: 0.75, colors: { background: '#d98a22', accent: '#2f9e44', cap: '#d7262b' } },
  { id: 'Corn5L', claims: ['非转基因', '压榨'], shape: 'jug', size: [0.16, 0.31, 0.1], text: '玉米油', price: 79.9, seed: 83, motif: 'corn', badge: '5L', pattern: 'band', transmission: 0.75, colors: { background: '#f0b830', accent: '#1e64c8', cap: '#f6c40f' } },
  { id: 'Oil18', claims: ['营养均衡', '一级'], shape: 'bottle', size: [0.1, 0.3, 0], text: '调和油', price: 29.9, seed: 84, motif: 'drop', badge: '1.8L', pattern: 'band', transmission: 0.75, colors: { background: '#e6a82e', accent: '#d7262b', cap: '#d7262b' } },
  { id: 'Oil900', claims: ['小磨香油', '纯正'], shape: 'bottle', size: [0.075, 0.26, 0], text: '芝麻油', price: 32.8, seed: 85, motif: 'sesame', badge: '900ml', pattern: 'band', transmission: 0.75, colors: { background: '#8a3c10', accent: '#2f9e44', cap: '#f4f2ec' } },
];
for (const { id, ...product } of oils) await write('product', `Shop/Products/${id}`, { name: id, font: FONT, ...product });
// 上面格子柜里横躺的红酒：深色的玻璃瓶、红、黄、绿的瓶盖朝外（照片里一格一排）
const wines: (Omit<ProductFile, 'name' | 'font'> & { readonly id: string })[] = [
  { id: 'WineRed', shape: 'bottle', size: [0.075, 0.3, 0], text: '干红', price: 68, seed: 87, pattern: 'band', surface: 'glass', colors: { background: '#1c0d0b', accent: '#e8dcc8', cap: '#c8281e' } },
  { id: 'WineGold', shape: 'bottle', size: [0.075, 0.3, 0], text: '干红', price: 88, seed: 88, pattern: 'band', surface: 'glass', colors: { background: '#1a110a', accent: '#efe3c4', cap: '#d9a520' } },
  { id: 'WineGreen', shape: 'bottle', size: [0.075, 0.3, 0], text: '白葡萄酒', price: 59, seed: 89, pattern: 'band', surface: 'glass', colors: { background: '#13210f', accent: '#f0ead8', cap: '#2f8f3a' } },
];
for (const { id, ...product } of wines) await write('product', `Shop/Products/${id}`, { name: id, font: FONT, ...product });
await write('shelf', 'Shop/Shelves/Oil', {
  name: 'Oil', sides: 1, length: 3.2, height: 1.95, depth: 0.42, levels: [0.3, 0.72, 1.08, 1.43, 1.78], font: FONT,
  frameColor: '#3b3c3f', boardColor: '#cfb48c', tagHolder: 'rail', tagAccent: '#28a9d7',
  stock: { products: oils.map((oil) => `Shop/Products/${oil.id}`), variants: 3, facings: [2, 5], rows: 3, gaps: 0.03 }, seed: 86,
  // 照片里货架顶上两排灰褐色的木格子，横躺着放红酒，中间偏右有一个上下贯通的六边形格
  cubbies: { height: 0.55, depth: 0.4, rows: 2, columns: 3, color: '#4a433d', hex: 1, products: wines.map((wine) => `Shop/Products/${wine.id}`), fill: 0.75 },
});

// 机位：离货架 2.7 米、1.5 米高，往右前方看（货架往右退远），稍往下
const eye: Vec3 = [-0.4, 1.5, 2.7];
const sid = (n: number) => `0b1e0b1e-0001-4000-8000-${n.toString(16).padStart(12, '0')}`;
// 灯在过道上方（离货架 1.8 米、3.2 米高）：照片里的木格子是暗的，灯离货架太近时它的正面被照得发白
const panels = [-1.2, 0, 1.2].map((x, i) => entity(sid(0x20 + i), `Panel ${i}`, [x, 3.2, 1.8], {
  light: { type: 'rect', color: [1, 0.97, 0.92], intensity: 26, width: 1, height: 0.2, range: 9 },
}, euler(0, -90)));
await write('scene', 'OilShelf', {
  name: 'OilShelf',
  compositor: {
    clearColor: [0.85, 0.85, 0.85, 1],
    postEffects: { brightFilter: true, bloom: true, lightStreak: false, lensFlare: false, toneMap: true, antialiasing: true, antialiasingMode: 'temporal', ambientOcclusion: { radius: 0.2 },
      localReflections: { maxRoughness: 0.4, edgeFade: 0.1 }, colorGrading: { operator: 'agx', temperature: 6000 }, exposure: { metering: 'histogram', localShadows: 0.75 } },
    transparent: true,
  },
  entities: [
    entity(sid(1), 'Camera', eye, { camera: { verticalFieldOfView: 67, nearClipPlane: 0.05, farClipPlane: 100 } }, lookAt(eye, [0.25, 1.15, 0])),
    entity(sid(2), 'Ambient', [0, 3, 0], { light: { type: 'ambient', color: [1, 0.98, 0.95], intensity: 0.12 } }),
    entity(sid(3), 'Hall', [0, 0, 0], { model: { model: 'Shop/Models/Hall', materials: [] } }),
    entity(sid(4), 'Shelf', [0, 0, 0], { model: { model: 'Shop/Shelves/Oil', materials: [] } }),
    ...panels,
  ],
});
await mcp.stop();
