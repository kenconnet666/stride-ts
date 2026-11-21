// 地形的山影图：用原生的求值器在 Node 里求一块地形文件（.terrain.json）的高度，画成 PNG（光从西北上方来）。调噪声、冲沟的参数时
// 不用开浏览器、发版：
//   node tools/terrain-hillshade.ts <地形文件> <out.png> [--x0 -1500] [--z0 -1500] [--size 3000] [--pixels 600] [--local]
// 坐标是地形本地的米；--local 用 fork 里刚编的原生模块（C:\code\JoltPhysics\StrideNative\JS\dist，改了原生代码还没发版时）。
// 打印求值的耗时（工作线程池，和游戏里算块的方式一样）。
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';

const args = process.argv.slice(2);
// 带值的选项（--x0 -1500）和开关（--local），剩下的是两个位置参数
const options = new Map<string, string>(), positional: string[] = [];
for (let i = 0; i < args.length; i++) {
  const arg = args[i]!;
  if (arg === '--local') options.set('local', '');
  else if (arg.startsWith('--')) options.set(arg.slice(2), args[++i] ?? '');
  else positional.push(arg);
}
const option = (name: string, fallback: number) => (options.has(name) ? Number(options.get(name)) : fallback);
const [file, out] = positional;
if (!file || !out) throw new Error('usage: node tools/terrain-hillshade.ts <terrain.json> <out.png> [--x0 m] [--z0 m] [--size m] [--pixels n] [--local]');
const x0 = option('x0', -1500), z0 = option('z0', -1500), size = option('size', 3000), n = option('pixels', 600);

// 仓库根不依赖原生包：用引擎装的那份
const dist = options.has('local') ? 'C:/code/JoltPhysics/StrideNative/JS/dist' : path.resolve(import.meta.dirname, '../packages/engine/node_modules/@stride-ts/native/dist');
const module = await import(pathToFileURL(path.join(dist, 'stride-native.js')).href);
const native = await module.createStrideNative({});
const terrain = JSON.parse(readFileSync(file, 'utf8')) as { noise: object; features?: object[]; strokes?: object[] };
using evaluator = native.createTerrain({ noise: terrain.noise, features: terrain.features ?? [], strokes: terrain.strokes ?? [] });
const step = size / n;
const start = performance.now();
const h: Float32Array = await evaluator.heights(x0, z0, step, n + 1, n + 1);
const ms = performance.now() - start;

const rgb = Buffer.alloc(n * n * 3);
const light = [-0.5, 0.7, -0.5], lightLength = Math.hypot(...light);
for (let j = 0; j < n; j++) {
  for (let i = 0; i < n; i++) {
    const dx = (h[j * (n + 1) + i + 1]! - h[j * (n + 1) + i]!) / step, dz = (h[(j + 1) * (n + 1) + i]! - h[j * (n + 1) + i]!) / step;
    // 法线 (-dx, 1, -dz) 和光的夹角
    const shade = Math.max(0, (dx * -light[0]! + light[1]! + dz * -light[2]!) / Math.hypot(dx, 1, dz) / lightLength);
    rgb.fill(Math.round(255 * Math.min(1, shade)), (j * n + i) * 3, (j * n + i) * 3 + 3);
  }
}
const raw = Buffer.alloc(n * (n * 3 + 1));
for (let j = 0; j < n; j++) rgb.copy(raw, j * (n * 3 + 1) + 1, j * n * 3, (j + 1) * n * 3);
const chunk = (type: string, data: Buffer) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([length, body, crc]);
};
const header = Buffer.alloc(13);
header.writeUInt32BE(n, 0);
header.writeUInt32BE(n, 4);
header[8] = 8;
header[9] = 2;
writeFileSync(out, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
console.log(`${out}: ${n} × ${n} px, ${size} m wide, ${(n + 1) ** 2} points in ${ms.toFixed(0)} ms`);
process.exit(0);
