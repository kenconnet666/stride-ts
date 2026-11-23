// 路线图七"超市和街边小店"的熟食柜：照用户拍的熟食柜（青花碗成排、方盘、黑托盘、保温灯）搭一条 2.6 米的熟食柜，六样菜——块的
// 红烧肉、炸鸡块、豆腐，丝的土豆丝、炒青菜，粒的花生——菜面上再落下去一块块、一根根真的几何（ProductFood.dropped，烘焙时物理
// 落定）。机位站在柜前斜着往下看。只用编辑器的 MCP 服务，资源和场景按这里写的覆盖，重跑就是重搭。地面、墙用 build-shop.ts 写的
// （先跑过它），天花板同它。
//   node apps/photoreal/scripts/build-deli.ts
//   看：http://localhost:5234/?scene=Deli
import path from 'node:path';
import type { CeilingFile, ProductFile, ShelfFile } from '@stride-ts/engine/content-format';
import { ceilingLights, deliLamps } from '@stride-ts/engine/modeling';
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

// 六样菜：青花碗（口径 18 厘米）盛块和粒，白方盘盛丝；菜面上落下去的块数按碗的大小——一层多一点，堆出尖
const bowl = { shape: 'bowl', size: [0.18, 0.075, 0], pattern: 'floral', surface: 'ceramic' } as const;
const plate = { shape: 'plate', size: [0.24, 0.035, 0.18], pattern: 'plain', surface: 'ceramic' } as const;
const dishes: (Omit<ProductFile, 'name'> & { readonly id: string })[] = [
  { id: 'Pork', ...bowl, seed: 11, food: { color: '#7a2c12', accent: '#2f8a2f', sauce: '#4a1608', level: 0.55, mound: 0.15, pieces: 'chunks', dropped: 36 } },
  { id: 'Chicken', ...bowl, seed: 12, food: { color: '#c47a2a', accent: '#d8b040', sauce: '#8a4a14', level: 0.55, mound: 0.15, pieces: 'chunks', dropped: 40, pieceSize: 0.024 } },
  { id: 'Tofu', ...bowl, seed: 13, food: { color: '#e8d9a8', accent: '#c0281c', sauce: '#a0401a', level: 0.6, mound: 0.1, pieces: 'chunks', dropped: 30, pieceSize: 0.022 } },
  { id: 'Potato', ...plate, seed: 14, food: { color: '#e8c860', accent: '#d0301c', level: 0.5, mound: 0.6, pieces: 'strands', dropped: 70 } },
  { id: 'Greens', ...plate, seed: 15, food: { color: '#3a7a28', accent: '#e0d8b0', level: 0.5, mound: 0.5, pieces: 'strands', dropped: 50, pieceSize: 0.006 } },
  { id: 'Peanut', ...bowl, seed: 16, food: { color: '#b0602a', accent: '#e8c8a0', sauce: '#6a2a10', level: 0.6, mound: 0.12, pieces: 'beans', dropped: 140 } },
];
for (const { id, ...dish } of dishes) await write('product', `Shop/Products/Deli${id}`, { name: `Deli${id}`, ...dish });

const deli: ShelfFile = {
  name: 'Deli', type: 'deli', sides: 1, length: 2.6, height: 1.55, depth: 0.85, levels: [0.88], bay: 0.65,
  stock: { products: dishes.map(({ id }) => `Shop/Products/Deli${id}`), variants: 1, facings: [1, 1], rows: 2, gaps: 0.03 },
  seed: 21,
};
await write('shelf', 'Shop/Shelves/Deli', deli);

// 熟食柜靠后墙（z = -6.5），正面朝 +Z；机位站在柜前、1.5 米高（人站着往下看），斜着看中间那几碗
const deliAt: Vec3 = [0, 0, -6.2];
const eye: Vec3 = [0.45, 1.5, -5.35];
const sid = (n: number) => `0b1e0b1e-0004-4000-8000-${n.toString(16).padStart(12, '0')}`;
const ceiling: CeilingFile = { name: 'Hall', size: [20, 14], height: 3.3, style: 'open', ducts: 2, trays: 2, pipes: 3, lights: { rows: 4, spacing: 2.2, length: 1.4, drop: 0.55 } };
const ceilingAt: Vec3 = [0, 0, -4];
const lights = ceilingLights(ceiling).map((light, i) => entity(sid(0x40 + i), `Light ${i}`, [ceilingAt[0] + light.center[2], light.center[1] - 0.015, ceilingAt[2] - light.center[0]], {
  light: { type: 'rect', color: [1, 0.97, 0.92], intensity: 24, width: 0.12, height: light.length, range: 9 },
}, euler(0, -90)));
// 保温灯：每个灯罩底下一盏往下照的暖色聚光灯
const lamps = deliLamps(deli).map(([x, y, z], i) => entity(sid(0x80 + i), `Lamp ${i}`, [deliAt[0] + x, deliAt[1] + y - 0.02, deliAt[2] + z], {
  light: { type: 'spot', color: [1, 0.78, 0.52], intensity: 60, range: 3, angleInner: 50, angleOuter: 95 },
}, euler(0, -90)));
await write('scene', 'Deli', {
  name: 'Deli',
  compositor: {
    clearColor: [0.85, 0.85, 0.85, 1],
    postEffects: { brightFilter: true, bloom: true, lightStreak: false, lensFlare: false, toneMap: true, antialiasing: true, antialiasingMode: 'temporal', ambientOcclusion: { radius: 0.2 },
      localReflections: { maxRoughness: 0.4, edgeFade: 0.1 }, colorGrading: { operator: 'agx', temperature: 6000, saturation: 1.3 }, exposure: { metering: 'histogram', localShadows: 0.75 } },
    transparent: true,
  },
  entities: [
    entity(sid(1), 'Camera', eye, { camera: { verticalFieldOfView: 45, nearClipPlane: 0.05, farClipPlane: 100 } }, lookAt(eye, [deliAt[0] - 0.05, 0.95, deliAt[2] - 0.05])),
    entity(sid(2), 'Ambient', [0, 3, 0], { light: { type: 'ambient', color: [1, 0.98, 0.95], intensity: 0.3 } }),
    entity(sid(3), 'Hall', [0, 0, 0], { model: { model: 'Shop/Models/Hall', materials: [] } }),
    entity(sid(4), 'Deli', deliAt, { model: { model: 'Shop/Shelves/Deli', materials: [] } }),
    entity(sid(5), 'Ceiling', ceilingAt, { model: { model: 'Shop/Ceilings/Hall', materials: [] } }, euler(90)),
    ...lights,
    ...lamps,
  ],
});
await mcp.stop();
