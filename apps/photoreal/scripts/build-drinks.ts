// 路线图七"超市和街边小店"的照片比对：照用户拍的饮料冷柜（reference/shop/cc342d23…jpg，不进仓库）搭靠墙一排单门的品牌冷柜——
// 白的（矿泉水）、黄的（茶、果汁）、红的（可乐），门框、门下的前脸、顶上的灯箱是柜体色，门边一根把手；机位站在白冷柜的左前方，
// 斜着往右沿这排看（手机主摄竖拍，长边 67°）。只用编辑器的 MCP 服务，资源和场景按这里写的覆盖，重跑就是重搭。地面、墙用
// build-shop.ts 写的（先跑过它），天花板同它。
//   node apps/photoreal/scripts/build-drinks.ts
//   看：http://localhost:5234/?scene=DrinkFridges；比：stride shot drinks.png --photo reference/shop/cc342d2361630995154c09a5d15a921c.jpg
import path from 'node:path';
import type { CeilingFile, ProductFile } from '@stride-ts/engine/content-format';
import { ceilingLights } from '@stride-ts/engine/modeling';
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

// 照片里的饮料：透明瓶的矿泉水（蓝标、蓝盖，瓶身透光），瓶装的茶、果汁（绿、橙、黄），可乐罐；Cola、Juice、Tea 用 build-shop.ts 的
const drinks: (Omit<ProductFile, 'name' | 'font'> & { readonly id: string })[] = [
  { id: 'Spring', shape: 'bottle', size: [0.068, 0.23, 0], text: '天然矿泉水', seed: 101, pattern: 'band', transmission: 0.95, colors: { background: '#d8e8f2', accent: '#1e64c8', cap: '#1e64c8' } },
  { id: 'GreenTea', shape: 'bottle', size: [0.065, 0.22, 0], text: '绿茶', seed: 102, pattern: 'band', transmission: 0.9, colors: { background: '#b9c86a', accent: '#2f9e44', cap: '#2f9e44' } },
  { id: 'OrangeDrink', shape: 'bottle', size: [0.065, 0.22, 0], text: '橙汁', seed: 103, pattern: 'band', transmission: 0.85, colors: { background: '#f09a2a', accent: '#f6c40f', cap: '#f4f2ec' } },
];
for (const { id, ...product } of drinks) await write('product', `Shop/Products/${id}`, { name: id, font: FONT, ...product });
const p = (id: string) => `Shop/Products/${id}`;
// 单门冷柜：一扇门一台，下面 0.32 米是压缩机那一格（柜体色的前脸），五层
const fridge = (name: string, doorColor: string, products: string[], seed: number) => write('shelf', `Shop/Shelves/${name}`, {
  name, type: 'fridge', sides: 1, length: 0.68, height: 1.9, depth: 0.5, levels: [0.32, 0.62, 0.92, 1.22, 1.52], bay: 0.68, font: FONT,
  doorColor, stripColor: doorColor, frameColor: '#e9ebec',
  stock: { products: products.map(p), variants: 3, facings: [3, 6], rows: 5, gaps: 0.04 }, seed,
});
const fridges = [
  { name: 'FridgeWhite', color: '#eef0f2', products: ['Spring'] },
  { name: 'FridgeYellow', color: '#e8a91c', products: ['GreenTea', 'OrangeDrink', 'Tea'] },
  { name: 'FridgeRed1', color: '#b8231c', products: ['Cola', 'Juice', 'OrangeDrink'] },
  { name: 'FridgeRed2', color: '#b8231c', products: ['Cola', 'GreenTea'] },
  { name: 'FridgeRed3', color: '#b8231c', products: ['Juice', 'Cola'] },
];
for (const [i, f] of fridges.entries()) await fridge(f.name, f.color, f.products, 110 + i);

// 冷柜沿大厅的左墙排（正面朝 +X，这一排自己的 +X 是世界的 -Z）；自己坐标里的点 (x, y, z) 在世界的 (z - 5.6, y, -x - 4)
const rowAt: Vec3 = [-5.6, 0, -4];
const world = ([x, y, z]: Vec3): Vec3 => [z + rowAt[0], y, -x + rowAt[2]];
// 机位：白冷柜左前方 1 米、1.4 米高，往右前方看（和这排的方向差 40°）
const eye = world([-1.3, 1.4, 1.6]);
const sid = (n: number) => `0b1e0b1e-0003-4000-8000-${n.toString(16).padStart(12, '0')}`;
const ceiling: CeilingFile = { name: 'Hall', size: [20, 14], height: 3.3, style: 'open', ducts: 2, trays: 2, pipes: 3, lights: { rows: 4, spacing: 2.2, length: 1.4, drop: 0.55 } };
const ceilingAt: Vec3 = [0, 0, -4];
const lights = ceilingLights(ceiling).map((light, i) => entity(sid(0x40 + i), `Light ${i}`, [ceilingAt[0] + light.center[2], light.center[1] - 0.015, ceilingAt[2] - light.center[0]], {
  light: { type: 'rect', color: [1, 0.97, 0.92], intensity: 24, width: 0.12, height: light.length, range: 9 },
}, euler(0, -90)));
await write('scene', 'DrinkFridges', {
  name: 'DrinkFridges',
  // 饱和度照手机的出片（手机默认把颜色提得很鲜，AgX 偏淡）
  compositor: {
    clearColor: [0.85, 0.85, 0.85, 1],
    postEffects: { brightFilter: true, bloom: true, lightStreak: false, lensFlare: false, toneMap: true, antialiasing: true, antialiasingMode: 'temporal', ambientOcclusion: { radius: 0.2 },
      localReflections: { maxRoughness: 0.4, edgeFade: 0.1 }, colorGrading: { operator: 'agx', temperature: 6000, saturation: 1.3 }, exposure: { metering: 'histogram', localShadows: 0.75 } },
    transparent: true,
  },
  entities: [
    entity(sid(1), 'Camera', eye, { camera: { verticalFieldOfView: 67, nearClipPlane: 0.05, farClipPlane: 100 } }, lookAt(eye, world([0.7, 1.0, 0.15]))),
    entity(sid(2), 'Ambient', [0, 3, 0], { light: { type: 'ambient', color: [1, 0.98, 0.95], intensity: 0.3 } }),
    entity(sid(3), 'Hall', [0, 0, 0], { model: { model: 'Shop/Models/Hall', materials: [] } }),
    ...fridges.map((f, i) => entity(sid(0x10 + i), f.name, world([-0.34 + i * 0.7, 0, 0]), { model: { model: `Shop/Shelves/${f.name}`, materials: [] } }, euler(90))),
    entity(sid(5), 'Ceiling', ceilingAt, { model: { model: 'Shop/Ceilings/Hall', materials: [] } }, euler(90)),
    ...lights,
  ],
});
await mcp.stop();
