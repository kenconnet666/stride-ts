/**
 * 扫描场景的编辑的烘焙（引擎 content/formats/splatEditFormat.ts 的 SplatEditFile）：读源泼溅和合并的几段，解回原样的泼溅（引擎
 * content/splatEdit.ts 的 decodeSplatSource），合并的几段按各自的变换放进源泼溅的坐标、连在后面（content/splatAlign.ts），按
 * 裁剪框、刷掉的球、删飞点挑出留下的（applySplatEdit），重建细节层次（splatLod.ts），写成同名的 .splat。写了 proxy 时再生成
 * 同名加 .proxy 的代理网格（体素化、抽面，content/splatProxy.ts；按格子一半的误差简化）。泼溅读不到、不是泼溅时报错。
 */
import { encodeModel, EXTENSIONS, VERTEX_FLOATS, type SplatEditFile } from '@stride-ts/engine/content-format';
import { encodeSplats } from '@stride-ts/engine/splats';
import { applySplatEdit, concatSplats, decodeSplatSource, partTransform, splatProxyMesh, transformSplats, type SplatEditStats } from '@stride-ts/engine/splat-edit';
import type { StrideTools } from '@stride-ts/native/tools';
import { compressMeshes } from '../mesh.ts';
import { buildSplatLod } from '../splatLod.ts';
import type { BakedFile } from './productModel.ts';

/** 代理网格的后缀：编辑 Foo 生成 Foo.splat 和 Foo.proxy.model。 */
export const SPLAT_PROXY_SUFFIX = '.proxy';

/** 生成 path（编辑的内容路径）同名的 .splat；stats 是每一步去掉了几个。 */
export async function bakeSplatEdit(file: SplatEditFile, path: string, readContent: (path: string) => Promise<Uint8Array>, tools: StrideTools, where = file.name): Promise<{ readonly files: BakedFile[]; readonly stats: SplatEditStats }> {
  if (!file.source) throw new Error(`${where}: source needs a splats asset`);
  const read = async (splats: string, what: string) => {
    if (splats === path) throw new Error(`${where}: ${what} cannot be the edit's own output`);
    let bytes: Uint8Array;
    try {
      bytes = await readContent(splats + EXTENSIONS.splats);
    } catch (error) {
      throw new Error(`${where}: cannot read the ${what} splats ${splats}: ${(error as Error).message}`, { cause: error });
    }
    return decodeSplatSource(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, `${where}: ${splats}`);
  };
  const source = await read(file.source, 'source');
  const parts = await Promise.all((file.merge ?? []).map(async (part, i) => transformSplats(await read(part.source, `merged #${i}`), partTransform(part))));
  const { source: edited, stats } = applySplatEdit(parts.length > 0 ? concatSplats([source, ...parts]) : source, file);
  const files: BakedFile[] = [{ path: path + EXTENSIONS.splats, bytes: encodeSplats(buildSplatLod(edited)) }];
  if (file.proxy) {
    const proxy = splatProxyModel(edited, file.proxy, tools);
    if (proxy) files.push({ path: path + SPLAT_PROXY_SUFFIX + EXTENSIONS.model, bytes: proxy });
  }
  return { files, stats };
}

/** 代理网格烘成模型（一个网格、默认材质）：按格子一半的误差简化，光滑的法线，没有面时 undefined。 */
function splatProxyModel(source: Parameters<typeof splatProxyMesh>[0], options: NonNullable<SplatEditFile['proxy']>, tools: StrideTools): Uint8Array | undefined {
  const { positions, indices, cell } = splatProxyMesh(source, options);
  if (indices.length === 0) return undefined;
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i++) {
    min[i % 3] = Math.min(min[i % 3]!, positions[i]!);
    max[i % 3] = Math.max(max[i % 3]!, positions[i]!);
  }
  // meshoptimizer 的误差是相对网格大小的
  const extent = Math.max(max[0]! - min[0]!, max[1]! - min[1]!, max[2]! - min[2]!, 1e-6);
  const simplified = tools.simplifyMesh(indices, positions, 0, (cell * 0.5) / extent).indices;
  const remap = new Int32Array(positions.length / 3).fill(-1), kept: number[] = [];
  const out = Uint32Array.from(simplified, (index) => {
    if (remap[index] === -1) {
      remap[index] = kept.length;
      kept.push(index);
    }
    return remap[index]!;
  });
  const vertices = new Float32Array(kept.length * VERTEX_FLOATS);
  kept.forEach((source, v) => vertices.set(positions.subarray(source * 3, source * 3 + 3), v * VERTEX_FLOATS));
  // 法线：相邻三角形的面法线（按面积）加起来
  for (let t = 0; t < out.length; t += 3) {
    const [a, b, c] = [out[t]! * VERTEX_FLOATS, out[t + 1]! * VERTEX_FLOATS, out[t + 2]! * VERTEX_FLOATS];
    const e1 = [0, 1, 2].map((k) => vertices[b + k]! - vertices[a + k]!), e2 = [0, 1, 2].map((k) => vertices[c + k]! - vertices[a + k]!);
    const n = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!];
    for (const v of [a, b, c]) for (let k = 0; k < 3; k++) vertices[v + 3 + k]! += n[k]!;
  }
  for (let v = 0; v < vertices.length; v += VERTEX_FLOATS) {
    const length = Math.hypot(vertices[v + 3]!, vertices[v + 4]!, vertices[v + 5]!) || 1;
    for (let k = 3; k < 6; k++) vertices[v + k]! /= length;
  }
  return encodeModel({ meshes: compressMeshes([{ name: 'proxy', material: 0, vertices, indices: out }], tools), materials: [null] });
}
