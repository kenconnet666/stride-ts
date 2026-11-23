// 路线图七"超市和街边小店"的照片比对：照用户拍的调料过道（reference/shop/0b30352b…jpg，不进仓库）搭一条长的单面货架——灰木纹的
// 厚层板、九层，透明挡条里带蓝色块的价签，摆满小玻璃罐的酱（红盖、金盖、绿盖）和橙色盖的瓶子；机位站在过道里离货架不到 1 米，
// 斜着往右沿过道看（手机主摄竖拍，长边 67°）。只用编辑器的 MCP 服务，资源和场景按这里写的覆盖，重跑就是重搭。地面、墙用
// build-shop.ts 写的（先跑过它），天花板同它。
//   node apps/photoreal/scripts/build-sauce.ts
//   看：http://localhost:5234/?scene=SauceAisle；比：stride shot sauce.png --photo reference/shop/0b30352b8f237a52537e90e15c77f8c2.jpg
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

// 照片里的酱（标签的颜色不写，每个牌子自己挑；罐身是酱的颜色）：小玻璃罐（油辣椒、豆瓣、豆豉、腐乳、芝麻酱），罐身透出来的是酱的红褐色，标签一圈；中间几层有橙色盖的瓶子（蚝油
// 那样的），最下层是大罐的辣椒酱（红盖）
const sauces: (Omit<ProductFile, 'name' | 'font'> & { readonly id: string })[] = [
  { id: 'ChiliOil', shape: 'jar', size: [0.072, 0.11, 0], text: '油辣椒', seed: 91, badge: '280g', pattern: 'band', surface: 'glass', colors: { background: '#4a130b', cap: '#d0261e' } },
  { id: 'BeanPaste', shape: 'jar', size: [0.078, 0.12, 0], text: '豆瓣酱', seed: 92, badge: '300g', pattern: 'band', surface: 'glass', colors: { background: '#3e1a0e', cap: '#d9a520' } },
  { id: 'Douchi', shape: 'jar', size: [0.07, 0.1, 0], text: '风味豆豉', seed: 93, pattern: 'band', surface: 'glass', colors: { background: '#33150c', cap: '#2f8f3a' } },
  { id: 'Sesame', shape: 'jar', size: [0.07, 0.095, 0], text: '芝麻酱', seed: 94, motif: 'sesame', pattern: 'band', surface: 'glass', colors: { background: '#8a5a2a', accent: '#f4f0e2', cap: '#f2c40f' } },
  { id: 'Oyster', shape: 'bottle', size: [0.058, 0.15, 0], text: '蚝油', seed: 95, pattern: 'band', surface: 'plastic', colors: { background: '#7a3410', accent: '#e8731a', cap: '#e8731a' } },
  { id: 'ChiliBig', shape: 'jar', size: [0.095, 0.15, 0], text: '辣椒酱', seed: 96, badge: '1kg', pattern: 'band', surface: 'plastic', colors: { background: '#6a160c', accent: '#f4f0e2', cap: '#e0321e' } },
];
for (const { id, ...product } of sauces) await write('product', `Shop/Products/${id}`, { name: id, font: FONT, ...product });
const p = (id: string) => `Shop/Products/${id}`;
await write('shelf', 'Shop/Shelves/Sauce', {
  name: 'Sauce', sides: 1, length: 16, height: 2.0, depth: 0.32, levels: [0.12, 0.33, 0.54, 0.75, 0.96, 1.17, 1.38, 1.59, 1.8], font: FONT,
  frameColor: '#4a4b4e', boardColor: '#bfb8ac', boardThickness: 0.04, tagHolder: 'rail', tagAccent: '#28a9d7',
  stock: {
    products: ['ChiliOil', 'BeanPaste', 'Douchi', 'Sesame', 'Oyster', 'ChiliBig'].map(p), variants: 4, facings: [3, 7], rows: 3, gaps: 0.02,
    // 照片里一层是一类：最下层大罐的辣椒酱，中间有一层橙盖的瓶子，别的层两三种小罐
    levels: [['ChiliBig'], ['ChiliOil', 'BeanPaste'], ['Douchi', 'ChiliOil'], ['BeanPaste', 'Douchi'], ['Oyster'], ['Sesame', 'Douchi'], ['ChiliOil', 'Sesame'], ['Oyster', 'BeanPaste'], null].map((level) => level?.map(p) ?? null),
  },
  seed: 97,
});

// 货架靠大厅的左墙（x = -5.6），正面朝 +X、顺着过道（货架自己的 +X 是世界的 -Z）；机位在过道里离货架前沿 0.85 米、1.45 米高，
// 往前沿货架看（货架的方向在画面右边 23° 那里消失），稍往下。货架自己坐标里的点 (x, y, z) 在世界的 (z - 5.6, y, -x - 4)
const shelfAt: Vec3 = [-5.6, 0, -4];
const world = ([x, y, z]: Vec3): Vec3 => [z + shelfAt[0], y, -x + shelfAt[2]];
const eye = world([-2.4, 1.45, 1.17]);
const sid = (n: number) => `0b1e0b1e-0002-4000-8000-${n.toString(16).padStart(12, '0')}`;
// 天花板：同 build-shop.ts 的开放式黑顶（照片右上是黑的顶和吊着的灯管），灯在每盏灯管下面
const ceiling: CeilingFile = { name: 'Hall', size: [20, 14], height: 3.3, style: 'open', ducts: 2, trays: 2, pipes: 3, lights: { rows: 4, spacing: 2.2, length: 1.4, drop: 0.55 } };
const ceilingAt: Vec3 = [0, 0, -4];
const lights = ceilingLights(ceiling).map((light, i) => entity(sid(0x40 + i), `Light ${i}`, [ceilingAt[0] + light.center[2], light.center[1] - 0.015, ceilingAt[2] - light.center[0]], {
  light: { type: 'rect', color: [1, 0.97, 0.92], intensity: 24, width: 0.12, height: light.length, range: 9 },
}, euler(0, -90)));
await write('scene', 'SauceAisle', {
  name: 'SauceAisle',
  // 饱和度照手机的出片（手机默认把颜色提得很鲜，AgX 偏淡）
  compositor: {
    clearColor: [0.85, 0.85, 0.85, 1],
    postEffects: { brightFilter: true, bloom: true, lightStreak: false, lensFlare: false, toneMap: true, antialiasing: true, antialiasingMode: 'temporal', ambientOcclusion: { radius: 0.2 },
      localReflections: { maxRoughness: 0.4, edgeFade: 0.1 }, colorGrading: { operator: 'agx', temperature: 6000, saturation: 1.3 }, exposure: { metering: 'histogram', localShadows: 0.75 } },
    transparent: true,
  },
  entities: [
    entity(sid(1), 'Camera', eye, { camera: { verticalFieldOfView: 67, nearClipPlane: 0.05, farClipPlane: 100 } }, lookAt(eye, world([-0.56, 1.15, 0.39]))),
    entity(sid(2), 'Ambient', [0, 3, 0], { light: { type: 'ambient', color: [1, 0.98, 0.95], intensity: 0.3 } }),
    entity(sid(3), 'Hall', [0, 0, 0], { model: { model: 'Shop/Models/Hall', materials: [] } }),
    entity(sid(4), 'Shelf', shelfAt, { model: { model: 'Shop/Shelves/Sauce', materials: [] } }, euler(90)),
    entity(sid(5), 'Ceiling', ceilingAt, { model: { model: 'Shop/Ceilings/Hall', materials: [] } }, euler(90)),
    ...lights,
  ],
});
await mcp.stop();
