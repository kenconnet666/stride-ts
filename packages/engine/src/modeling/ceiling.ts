/**
 * 天花板的生成（`.ceiling.json`，格式见 content/formats/ceilingFormat.ts）：开放式的顶（楼板、风管、桥架、喷淋管、吊杆上的灯管）
 * 或格栅吊顶（一格格的板、龙骨、灯盘），走 ProductBatch 出一个模型、图集和材质；灯具发光。ceilingLights 给出每盏灯的中心和
 * 大小，搭场景时照它放面光源，灯具和光对得上。
 */
import type { CeilingFile } from '../content/formats/ceilingFormat.ts';
import { ProductBatch, type MergedProducts } from './productBatch.ts';

/** 纯色：楼板或吊顶、镀锌的风管、桥架、喷淋管（红）、吊杆和龙骨、灯。 */
const SLAB = 0, DUCT = 1, TRAY = 2, PIPE = 3, ROD = 4, LAMP = 5;

/** 一盏灯：中心（米）、沿 X 的长、沿 Z 的宽。 */
export interface CeilingLight {
  readonly center: readonly [number, number, number];
  readonly length: number;
  readonly width: number;
}

/** 每盏灯的位置（开放式吊在楼板下 drop，格栅嵌在吊顶里）。 */
export function ceilingLights(file: CeilingFile): CeilingLight[] {
  const [w, d] = file.size, grid = file.style === 'grid';
  const rows = Math.max(0, Math.round(file.lights?.rows ?? 2)), spacing = Math.max(0.5, file.lights?.spacing ?? 2.2);
  const length = grid ? 0.6 : Math.min(spacing, file.lights?.length ?? 1.4), y = grid ? file.height - 0.01 : file.height - (file.lights?.drop ?? 0.6);
  const count = Math.max(0, Math.floor(w / spacing));
  const lights: CeilingLight[] = [];
  for (let r = 0; r < rows; r++) {
    const z = -d / 2 + ((r + 0.5) * d) / rows;
    for (let i = 0; i < count; i++) lights.push({ center: [-w / 2 + (i + 0.5) * (w / count), y, z], length, width: grid ? 0.6 : 0.08 });
  }
  return lights;
}

export function ceilingModel(file: CeilingFile, where = file.name): MergedProducts {
  const [w, d] = file.size, H = file.height;
  if (!(w > 0 && d > 0 && H > 0)) throw new Error(`${where}: size and height must be greater than 0`);
  const grid = file.style === 'grid';
  const batch = new ProductBatch({ products: new Map(), font: () => undefined }, where, [], {
    solids: [
      { color: file.color ?? (grid ? '#e9e8e3' : '#1f2124'), roughness: 0.85, metalness: 0 },
      { color: '#a4a8ac', roughness: 0.35, metalness: 0.9 },
      { color: '#8a8e92', roughness: 0.45, metalness: 0.8 },
      { color: '#a8322b', roughness: 0.4, metalness: 0.2 },
      { color: grid ? '#d4d3ce' : '#191a1c', roughness: 0.5, metalness: 0.5 },
      { color: '#ffffff', roughness: 0.5, metalness: 0, emissive: 8 },
    ],
  });
  const lights = ceilingLights(file);
  if (grid) {
    // 吊顶的板，板下面一条条 T 形龙骨（每 0.6 米），灯盘嵌在板里
    batch.box([-w / 2, H, -d / 2], [w / 2, H + 0.015, d / 2], SLAB);
    for (let x = -w / 2; x <= w / 2 + 1e-6; x += 0.6) batch.box([x - 0.012, H - 0.012, -d / 2], [x + 0.012, H, d / 2], ROD);
    for (let z = -d / 2; z <= d / 2 + 1e-6; z += 0.6) batch.box([-w / 2, H - 0.012, z - 0.012], [w / 2, H, z + 0.012], ROD);
    for (const light of lights) {
      const [x, , z] = light.center;
      batch.box([x - light.length / 2 + 0.02, H - 0.006, z - light.width / 2 + 0.02], [x + light.length / 2 - 0.02, H - 0.001, z + light.width / 2 - 0.02], LAMP);
    }
    return batch.finish();
  }
  // 开放式：楼板，下面的管线沿 X 通长，每 2.5 米一个吊架
  batch.box([-w / 2, H, -d / 2], [w / 2, H + 0.25, d / 2], SLAB);
  const lanes = (count: number, offset: number) => Array.from({ length: Math.max(0, Math.round(count)) }, (_, i) => -d / 2 + ((i + offset) * d) / Math.max(1, Math.round(count)));
  const hangers = (z: number, top: number, bottom: number) => {
    for (let x = -w / 2 + 1.25; x < w / 2; x += 2.5) batch.tube([x, top, z], [x, bottom, z], 0.006, ROD, 6);
  };
  for (const z of lanes(file.ducts ?? 2, 0.3)) {
    batch.box([-w / 2, H - 0.45, z - 0.3], [w / 2, H - 0.12, z + 0.3], DUCT);
    hangers(z - 0.32, H, H - 0.45);
  }
  for (const z of lanes(file.trays ?? 2, 0.75)) {
    // 梯形桥架：两条边框、每 0.3 米一根横档
    const y = H - 0.38;
    batch.box([-w / 2, y, z - 0.16], [w / 2, y + 0.06, z - 0.14], TRAY);
    batch.box([-w / 2, y, z + 0.14], [w / 2, y + 0.06, z + 0.16], TRAY);
    for (let x = -w / 2; x < w / 2; x += 0.3) batch.box([x, y, z - 0.14], [x + 0.03, y + 0.012, z + 0.14], TRAY);
    hangers(z - 0.17, H, y);
  }
  for (const z of lanes(file.pipes ?? 3, 0.5)) {
    const y = H - 0.2;
    batch.tube([-w / 2, y, z], [w / 2, y, z], 0.025, PIPE, 10);
    // 每 3 米一个往下的喷头
    for (let x = -w / 2 + 1.5; x < w / 2; x += 3) batch.tube([x, y, z], [x, y - 0.25, z], 0.01, PIPE, 6);
  }
  // 灯管：一盏两根吊杆
  for (const light of lights) {
    const [x, y, z] = light.center, half = light.length / 2;
    batch.box([x - half, y, z - 0.04], [x + half, y + 0.05, z + 0.04], ROD);
    batch.box([x - half + 0.01, y - 0.012, z - 0.03], [x + half - 0.01, y, z + 0.03], LAMP);
    for (const end of [x - half + 0.1, x + half - 0.1]) batch.tube([end, y + 0.05, z], [end, H, z], 0.004, ROD, 6);
  }
  return batch.finish();
}
