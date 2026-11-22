/**
 * 招牌的烘焙（引擎 content/formats/signFormat.ts 的 SignFile）：生成在引擎的 modeling/sign.ts，这里读字体，写成同名的文件
 * （bakers/mergedFiles.ts：模型、图集、材质，灯箱还有自发光图集）；地贴只写一张 SVG。
 */
import type { SignFile } from '@stride-ts/engine/content-format';
import { floorStickerSvg, signModel } from '@stride-ts/engine/modeling';
import type { StrideTools } from '@stride-ts/native/tools';
import type { BakedFile } from './productModel.ts';
import { mergedFiles } from './mergedFiles.ts';
import { loadTextFont } from './textFont.ts';

export async function bakeSign(tools: StrideTools, file: SignFile, path: string, readContent: (path: string) => Promise<Uint8Array>, where = file.name): Promise<BakedFile[]> {
  const font = file.font ? await loadTextFont(file.font, file.text, readContent, where) : undefined;
  // 地贴只出一张 SVG（贴花贴到地上）
  if (file.style === 'floor') return [{ path: `${path}.svg`, bytes: new TextEncoder().encode(floorStickerSvg(file, font, where)) }];
  return mergedFiles(tools, file.name, path, signModel(file, font, where));
}
