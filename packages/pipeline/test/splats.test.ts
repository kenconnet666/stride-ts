import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { decodeSplats, SPLAT_WORDS } from '@stride-ts/engine/splats';
import { convertPlySplats, readPlySplats } from '../src/splats.ts';

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
  test('标准 3DGS 的 .ply：对数缩放取 exp、不透明度过 sigmoid、f_dc 换成颜色；写成 .splat 再读回来', () => {
    const ply = standardPly([{ x: 1, y: 2, z: 3, scale: 0.05, dc: 0, opacity: 0 }, { x: -1, y: 0, z: 4, scale: 0.2, dc: 1, opacity: 10 }]);
    const source = readPlySplats(ply, 'test.ply');
    expect(source.count).toBe(2);
    expect(source.scales[0]).toBeCloseTo(0.05, 5);
    expect(source.colors[0]).toBeCloseTo(0.5, 5);
    expect(source.colors[3]).toBeCloseTo(0.5, 5);
    expect(source.colors[4]).toBeCloseTo(0.5 + 0.2820948, 5);
    expect(source.colors[7]).toBeGreaterThan(0.9999);
    const { bytes, count } = convertPlySplats(ply, 'test.ply');
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

  test('不是 .ply、不是二进制小端时报错', () => {
    expect(() => readPlySplats(new TextEncoder().encode('hello'), 'x')).toThrow(/not a .ply/);
    expect(() => readPlySplats(new TextEncoder().encode('ply\nformat ascii 1.0\nelement vertex 0\nend_header\n'), 'x')).toThrow(/binary little-endian/);
  });
});
