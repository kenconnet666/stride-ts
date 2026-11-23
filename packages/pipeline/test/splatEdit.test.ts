import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createStrideTools, type StrideTools } from '@stride-ts/native/tools';
import { decodeModel } from '@stride-ts/engine/content-format';
import { encodeSplats, type SplatSource } from '@stride-ts/engine/splats';
import { applySplatEdit, decodeSplatSource, insideBox } from '@stride-ts/engine/splat-edit';
import { buildSplatLod } from '../src/splatLod.ts';
import { bakeSplatEdit } from '../src/bakers/splatEditModel.ts';

/** 一块 4 × 1 × 4 米的地面上 n 个泼溅（确定的伪随机），加几个飘在 3 米高的孤点。 */
function scene(n: number, loners: number): SplatSource {
  let seed = 11;
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const count = n + loners;
  const positions = new Float32Array(count * 3), colors = new Float32Array(count * 4), scales = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const loner = i >= n;
    positions.set(loner ? [-2 + (i - n) * 1.3, 3, 0.5] : [random() * 4 - 2, random(), random() * 4 - 2], i * 3);
    colors.set([random(), random(), random(), loner ? 0.9 : 0.2 + 0.8 * random()], i * 4);
    scales.set([0.01 + random() * 0.02, 0.01, 0.015], i * 3);
  }
  const rotations = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    const [x, y, z] = [random() - 0.5, random() - 0.5, random() - 0.5], w = 1, l = Math.hypot(x, y, z, w);
    rotations.set([x / l, y / l, z / l, w / l], i * 4);
  }
  return { count, positions, scales, rotations, colors };
}

describe('扫描场景的编辑', () => {
  let tools: StrideTools;
  beforeAll(async () => {
    tools = await createStrideTools({ workerThreads: 2 });
  });
  afterAll(() => tools.shutdown());

  test('从 .splat 读回原样的泼溅：只要叶子，合并出来的粗级不要；值和量化前差在量化的精度里', () => {
    const original = scene(3000, 0);
    const bytes = encodeSplats(buildSplatLod(original));
    const back = decodeSplatSource(bytes.buffer as ArrayBuffer);
    expect(back.count).toBe(original.count);
    // 叶子按八叉树重排过：按位置配对比较
    const byPosition = new Map<string, number>();
    for (let i = 0; i < original.count; i++) byPosition.set([0, 1, 2].map((k) => original.positions[i * 3 + k]!.toFixed(5)).join(','), i);
    let worstScale = 0, worstColor = 0;
    for (let i = 0; i < back.count; i++) {
      const j = byPosition.get([0, 1, 2].map((k) => back.positions[i * 3 + k]!.toFixed(5)).join(','));
      expect(j).toBeDefined();
      for (let k = 0; k < 3; k++) worstScale = Math.max(worstScale, Math.abs(back.scales[i * 3 + k]! / original.scales[j! * 3 + k]! - 1));
      for (let k = 0; k < 4; k++) worstColor = Math.max(worstColor, Math.abs(back.colors[i * 4 + k]! - original.colors[j! * 4 + k]!));
    }
    expect(worstScale).toBeLessThan(1e-3);
    expect(worstColor).toBeLessThanOrEqual(0.5 / 255 + 1e-6);
  });

  test('裁剪框只留里面的、删掉的框和刷掉的球去掉里面的；转了的盒子按自己的坐标算', () => {
    const source = scene(2000, 0);
    const { source: kept, stats } = applySplatEdit(source, { name: 'Crop', source: 'S', keep: [{ center: [0, 0.5, 0], size: [2, 2, 2] }], remove: [{ center: [0.5, 0.5, 0.5], size: [0.5, 2, 0.5] }], erase: [{ center: [-0.5, 0.5, -0.5], radius: 0.3 }] });
    expect(stats.kept + stats.cropped + stats.erased + stats.floaters).toBe(2000);
    expect(kept.count).toBe(stats.kept);
    for (let i = 0; i < kept.count; i++) {
      const p = [kept.positions[i * 3]!, kept.positions[i * 3 + 1]!, kept.positions[i * 3 + 2]!];
      expect(Math.abs(p[0]!)).toBeLessThanOrEqual(1);
      expect(Math.abs(p[2]!)).toBeLessThanOrEqual(1);
      expect(Math.abs(p[0]! - 0.5) <= 0.25 && Math.abs(p[2]! - 0.5) <= 0.25).toBe(false);
      expect(Math.hypot(p[0]! + 0.5, p[1]! - 0.5, p[2]! + 0.5)).toBeGreaterThan(0.3);
    }
    expect(stats.cropped).toBeGreaterThan(1000);
    expect(stats.erased).toBeGreaterThan(0);
    // 绕 Y 转 45° 的细长盒子：(0.7, 0, 0.7) 在里面、(1, 0, 0) 不在
    const turned = { center: [0, 0, 0] as const, size: [2.2, 0.2, 0.2] as const, rotation: [0, Math.sin(Math.PI / 8), 0, Math.cos(Math.PI / 8)] as const };
    expect(insideBox(turned, [0.7, 0, -0.7])).toBe(true);
    expect(insideBox(turned, [1, 0, 0])).toBe(false);
  });

  test('删飞点：孤零零飘着的和几乎透明的去掉，成片的留着；不写就不删', () => {
    const source = scene(4000, 4);
    source.colors[3] = 0.005;
    const { source: cleaned, stats } = applySplatEdit(source, { name: 'Clean', source: 'S', floaters: { cell: 0.25, neighbors: 4, minOpacity: 0.01 } });
    expect(stats.floaters).toBe(5);
    for (let i = 0; i < cleaned.count; i++) expect(cleaned.positions[i * 3 + 1]!).toBeLessThan(2);
    expect(applySplatEdit(source, { name: 'None', source: 'S' }).stats).toEqual({ kept: 4004, cropped: 0, erased: 0, floaters: 0 });
  });

  test('烘焙：读源泼溅、按编辑挑、重建细节层次写同名的 .splat；源读不到、源是自己时报错', async () => {
    const bytes = encodeSplats(buildSplatLod(scene(3000, 2)));
    const read = async (path: string) => {
      if (path === 'Scans/Room.splat') return bytes;
      throw new Error('missing');
    };
    const { files, stats } = await bakeSplatEdit({ name: 'RoomClean', source: 'Scans/Room', floaters: {} }, 'Scans/RoomClean', read, tools);
    expect(files.map((file) => file.path)).toEqual(['Scans/RoomClean.splat']);
    expect(stats.floaters).toBeGreaterThanOrEqual(2);
    expect(decodeSplatSource(files[0]!.bytes.buffer as ArrayBuffer).count).toBe(stats.kept);
    // 代理网格：同名加 .proxy 的模型，地面那一层
    const { files: withProxy } = await bakeSplatEdit({ name: 'RoomClean', source: 'Scans/Room', proxy: { cell: 0.2, minOpacity: 0, density: 0.5 } }, 'Scans/RoomClean', read, tools);
    expect(withProxy.map((file) => file.path)).toEqual(['Scans/RoomClean.splat', 'Scans/RoomClean.proxy.model']);
    const model = decodeModel(withProxy[1]!.bytes.buffer.slice(withProxy[1]!.bytes.byteOffset, withProxy[1]!.bytes.byteOffset + withProxy[1]!.bytes.byteLength) as ArrayBuffer);
    expect(model.meshes.length).toBe(1);
    await expect(bakeSplatEdit({ name: 'X', source: 'Scans/Nope' }, 'Scans/X', read, tools)).rejects.toThrow(/cannot read the source splats/);
    await expect(bakeSplatEdit({ name: 'X', source: 'Scans/X' }, 'Scans/X', read, tools)).rejects.toThrow(/own output/);
  });
});
