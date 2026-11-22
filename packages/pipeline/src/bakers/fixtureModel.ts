/**
 * 店里器具的烘焙（引擎 content/formats/fixtureFormat.ts 的 FixtureFile）：生成在引擎的 modeling/fixture.ts，这里读字体（收银台的
 * 号码），写成同名的文件（bakers/mergedFiles.ts）。
 */
import type { FixtureFile } from '@stride-ts/engine/content-format';
import { fixtureModel } from '@stride-ts/engine/modeling';
import type { StrideTools } from '@stride-ts/native/tools';
import type { BakedFile } from './productModel.ts';
import { mergedFiles } from './mergedFiles.ts';
import { loadTextFont } from './textFont.ts';

export async function bakeFixture(tools: StrideTools, file: FixtureFile, path: string, readContent: (path: string) => Promise<Uint8Array>, where = file.name): Promise<BakedFile[]> {
  const font = file.font && file.type === 'checkout' ? await loadTextFont(file.font, `收银 ${file.number ?? '1'}`, readContent, where) : undefined;
  return mergedFiles(tools, file.name, path, fixtureModel(file, font, where));
}
