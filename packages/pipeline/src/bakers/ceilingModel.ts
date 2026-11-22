/**
 * 天花板的烘焙（引擎 content/formats/ceilingFormat.ts 的 CeilingFile）：生成在引擎的 modeling/ceiling.ts，写成同名的文件
 * （bakers/mergedFiles.ts：模型、图集、自发光图集、材质）。
 */
import type { CeilingFile } from '@stride-ts/engine/content-format';
import { ceilingModel } from '@stride-ts/engine/modeling';
import type { StrideTools } from '@stride-ts/native/tools';
import type { BakedFile } from './productModel.ts';
import { mergedFiles } from './mergedFiles.ts';

export function bakeCeiling(tools: StrideTools, file: CeilingFile, path: string, where = file.name): BakedFile[] {
  return mergedFiles(tools, file.name, path, ceilingModel(file, where));
}
