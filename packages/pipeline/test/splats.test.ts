import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createStrideTools, type StrideTools } from '@stride-ts/native/tools';
import { decodeSplats, SPLAT_WORDS } from '@stride-ts/engine/splats';
import { convertSplats, readPlySplats, readSogSplats, readSpzSplats } from '../src/splats.ts';

/** 写一个标准 3DGS 的 .ply（binary little endian）。 */
function standardPly(splats: readonly { x: number; y: number; z: number; scale: number; dc: number; opacity: number }[]): Uint8Array {
  const properties = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];
  const header = `ply\nformat binary_little_endian 1.0\nelement vertex ${splats.length}\n${properties.map((p) => `property float ${p}`).join('\n')}\nend_header\n`;
  const head = new TextEncoder().encode(header);
  const body = new Float32Array(splats.length * properties.length);
  splats.forEach((s, i) => body.set([s.x, s.y, s.z, s.dc, s.dc, s.dc, s.opacity, Math.log(s.scale), Math.log(s.scale), Math.log(s.scale), 1, 0, 0, 0], i * properties.length));
  const bytes = new Uint8Array(head.length + body.byteLength);
  bytes.set(head);
  bytes.set(new Uint8Array(body.buffer), head.length);
  return bytes;
}

describe('高斯泼溅的导入', () => {
  let tools: StrideTools;
  beforeAll(async () => {
    tools = await createStrideTools({ workerThreads: 2 });
  });
  afterAll(() => tools.shutdown());

  test('标准 3DGS 的 .ply：对数缩放取 exp、不透明度过 sigmoid、f_dc 换成颜色；写成 .splat 再读回来', async () => {
    const ply = standardPly([{ x: 1, y: 2, z: 3, scale: 0.05, dc: 0, opacity: 0 }, { x: -1, y: 0, z: 4, scale: 0.2, dc: 1, opacity: 10 }]);
    const source = readPlySplats(ply, 'test.ply');
    expect(source.count).toBe(2);
    expect(source.scales[0]).toBeCloseTo(0.05, 5);
    expect(source.colors[0]).toBeCloseTo(0.5, 5);
    expect(source.colors[3]).toBeCloseTo(0.5, 5);
    expect(source.colors[4]).toBeCloseTo(0.5 + 0.2820948, 5);
    expect(source.colors[7]).toBeGreaterThan(0.9999);
    const { bytes, count } = await convertSplats(tools, ply, 'test.ply');
    const decoded = decodeSplats(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, 'test.splat');
    expect(count).toBe(2);
    expect(decoded.words.length).toBe(2 * SPLAT_WORDS);
    expect(decoded.min).toEqual([-1, 0, 3]);
    expect(decoded.max).toEqual([1, 2, 4]);
    expect(new Float32Array(decoded.words.buffer, decoded.words.byteOffset, 3)[0]).toBe(1);
  });

  // PlayCanvas 的示例里带的压缩 .ply（参考仓库有的时候才跑）
  const sample = 'C:/code/refs/playcanvas-engine/examples/assets/splats/guitar.compressed.ply';
  test.skipIf(!existsSync(sample))('SuperSplat 的压缩 .ply：块里的位置在块的包围盒里，旋转是单位四元数', async () => {
    const source = readPlySplats(new Uint8Array(await readFile(sample)), 'guitar');
    expect(source.count).toBeGreaterThan(10000);
    for (let i = 0; i < source.count; i += 997) {
      const q = source.rotations.subarray(i * 4, i * 4 + 4);
      expect(Math.hypot(...q)).toBeCloseTo(1, 2);
      expect(source.colors[i * 4 + 3]).toBeGreaterThanOrEqual(0);
    }
  });

  // 带 3 阶球谐的压缩 .ply（参考仓库有的时候才跑）
  const withSh = 'C:/code/refs/playcanvas-engine/examples/assets/splats/skull.compressed.ply';
  test.skipIf(!existsSync(withSh))('压缩 .ply 的 element sh：3 阶球谐（每个通道 15 个），写进 .splat 的球谐段再读回来', async () => {
    const source = readPlySplats(new Uint8Array(await readFile(withSh)), 'skull');
    expect(source.shBands).toBe(3);
    expect(source.sh!.length).toBe(source.count * 45);
    // 8 位解出来在 -4..4 之间
    expect(Math.max(...source.sh!.subarray(0, 4500).map(Math.abs))).toBeLessThanOrEqual(4);
    const { bytes } = await convertSplats(tools, new Uint8Array(await readFile(withSh)), 'skull');
    const decoded = decodeSplats(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, 'skull.splat');
    expect(decoded.shBands).toBe(3);
    expect(decoded.sh.length).toBe(source.count * 12);
    expect(decoded.shRange).toBeGreaterThan(0);
  });

  test('SPZ 版本 3（整个 gzip）：定点位置、最小三分量的旋转、1 阶球谐，RUB 换成 .ply 的 RDF', () => {
    const header = new Uint8Array(16);
    const view = new DataView(header.buffer);
    view.setUint32(0, 0x5053474e, true);
    view.setUint32(4, 3, true);
    view.setUint32(8, 1, true);
    view.setUint8(12, 1);
    view.setUint8(13, 12);
    // 位置 (1, 2, -0.5)，24 位定点、12 位小数
    const position = new Uint8Array(9);
    [1, 2, -0.5].forEach((v, k) => {
      const fixed = Math.round(v * 4096) & 0xffffff;
      position.set([fixed & 0xff, (fixed >> 8) & 0xff, fixed >> 16], k * 3);
    });
    // 旋转绕 Y 转 90°：xyzw = (0, √½, 0, √½)，最大的是 w（下标 3），其余三个各 10 位
    const magnitude = Math.round(Math.SQRT1_2 / (Math.SQRT1_2 / 511));
    const rotation = new Uint8Array(new Uint32Array([((3 << 30) | (0 << 20) | (magnitude << 10) | 0) >>> 0]).buffer);
    // 1 阶球谐 3 个系数、RGB 交错：第一个系数（y 的基函数）R 通道是 +0.5
    const sh = new Uint8Array(9).fill(128);
    sh[0] = 192;
    const body = [position, new Uint8Array([255]), new Uint8Array([128, 128, 128]), new Uint8Array([160, 160, 160]), rotation, sh];
    const raw = new Uint8Array(16 + body.reduce((n, b) => n + b.length, 0));
    raw.set(header);
    let offset = 16;
    for (const b of body) {
      raw.set(b, offset);
      offset += b.length;
    }
    const source = readSpzSplats(new Uint8Array(gzipSync(raw)), 'test.spz');
    expect([...source.positions]).toEqual([1, -2, 0.5]);
    expect(source.scales[0]).toBeCloseTo(Math.exp(0), 5);
    expect(source.colors[3]).toBe(1);
    expect(source.colors[0]).toBeCloseTo(0.5 + (128 / 255 - 0.5) * (0.2820948 / 0.15), 5);
    // 绕 X 转半圈：(x, y, z, w) → (x, −y, −z, w)
    expect(source.rotations[1]).toBeCloseTo(-Math.SQRT1_2, 3);
    expect(source.rotations[3]).toBeCloseTo(Math.SQRT1_2, 3);
    // y 的基函数变号；按通道排：R 通道的第一个
    expect(source.shBands).toBe(1);
    expect(source.sh![0]).toBeCloseTo(-0.5, 5);
    expect(source.sh![3]).toBeCloseTo(0, 5);
  });

  // PlayCanvas 的示例里同一个场景的 .spz（版本 4，每段 zstd）和压缩 .ply：导入后逐点一样
  const spz = 'C:/code/refs/playcanvas-engine/examples/assets/splats/biker.spz';
  test.skipIf(!existsSync(spz))('SPZ 版本 4 和同一场景的 .ply 逐点一致', async () => {
    const a = readSpzSplats(new Uint8Array(await readFile(spz)), 'biker.spz');
    const b = readPlySplats(new Uint8Array(await readFile(spz.replace('.spz', '.compressed.ply'))), 'biker.ply');
    expect(a.count).toBe(b.count);
    for (let i = 0; i < a.count; i += 977) {
      for (let k = 0; k < 3; k++) expect(Math.abs(a.positions[i * 3 + k]! - b.positions[i * 3 + k]!)).toBeLessThan(0.002);
      expect(Math.abs(a.colors[i * 4 + 3]! - b.colors[i * 4 + 3]!)).toBeLessThan(0.01);
      const dot = [0, 1, 2, 3].reduce((n, k) => n + a.rotations[i * 4 + k]! * b.rotations[i * 4 + k]!, 0);
      expect(Math.abs(dot)).toBeGreaterThan(0.99);
    }
  });

  // PlayCanvas 示例里的 SOG（版本 2，100 万个、3 阶球谐；参考仓库有的时候才跑）：zip 里的 WebP 用原生工具模块解
  const sog = 'C:/code/refs/playcanvas-engine/examples/assets/splats/bicycle.sog';
  test.skipIf(!existsSync(sog))('SOG：码本的缩放和颜色、最小三分量的旋转、调色板的球谐', async () => {
    const source = await readSogSplats(tools, new Uint8Array(await readFile(sog)), 'bicycle.sog');
    expect(source.count).toBe(1_000_000);
    expect(source.shBands).toBe(3);
    for (let i = 0; i < source.count; i += 9973) {
      expect(Math.hypot(...source.rotations.subarray(i * 4, i * 4 + 4))).toBeCloseTo(1, 2);
      expect(source.colors[i * 4 + 3]).toBeGreaterThanOrEqual(0);
      expect(source.scales[i * 3]).toBeGreaterThan(0);
    }
  }, 60_000);

  test('不是 .ply、不是二进制小端时报错', () => {
    expect(() => readPlySplats(new TextEncoder().encode('hello'), 'x')).toThrow(/not a .ply/);
    expect(() => readPlySplats(new TextEncoder().encode('ply\nformat ascii 1.0\nelement vertex 0\nend_header\n'), 'x')).toThrow(/binary little-endian/);
  });
});
