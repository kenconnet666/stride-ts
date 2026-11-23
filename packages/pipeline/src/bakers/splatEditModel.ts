/**
 * 扫描场景的编辑的烘焙（引擎 content/formats/splatEditFormat.ts 的 SplatEditFile）：读源泼溅和合并的几段，解回原样的泼溅（引擎
 * content/splatEdit.ts 的 decodeSplatSource），合并的几段按各自的变换放进源泼溅的坐标、连在后面（content/splatAlign.ts），按
 * 裁剪框、刷掉的球、删飞点挑出留下的（applySplatEdit），重建细节层次（splatLod.ts），写成同名的 .splat。泼溅读不到、不是泼溅
 * 时报错。
 */
import { EXTENSIONS, type SplatEditFile } from '@stride-ts/engine/content-format';
import { encodeSplats } from '@stride-ts/engine/splats';
import { applySplatEdit, concatSplats, decodeSplatSource, partTransform, transformSplats, type SplatEditStats } from '@stride-ts/engine/splat-edit';
import { buildSplatLod } from '../splatLod.ts';
import type { BakedFile } from './productModel.ts';

/** 生成 path（编辑的内容路径）同名的 .splat；stats 是每一步去掉了几个。 */
export async function bakeSplatEdit(file: SplatEditFile, path: string, readContent: (path: string) => Promise<Uint8Array>, where = file.name): Promise<{ readonly files: BakedFile[]; readonly stats: SplatEditStats }> {
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
  return { files: [{ path: path + EXTENSIONS.splats, bytes: encodeSplats(buildSplatLod(edited)) }], stats };
}
