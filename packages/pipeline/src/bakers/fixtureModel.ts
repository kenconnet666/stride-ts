/**
 * 店里器具的烘焙（引擎 content/formats/fixtureFormat.ts 的 FixtureFile）：生成在引擎的 modeling/fixture.ts，这里读字体（器具上
 * 要写的字由 fixtureText 给：收银台的号码、自助收银机屏上的界面和号码），写成同名的文件（bakers/mergedFiles.ts）。
 */
import type { FixtureFile } from '@stride-ts/engine/content-format';
import { fixtureModel, fixtureText } from '@stride-ts/engine/modeling';
import type { StrideTools } from '@stride-ts/native/tools';
import type { BakedFile } from './productModel.ts';
import { mergedFiles } from './mergedFiles.ts';
import { loadTextFont } from './textFont.ts';

export async function bakeFixture(tools: StrideTools, file: FixtureFile, path: string, readContent: (path: string) => Promise<Uint8Array>, where = file.name): Promise<BakedFile[]> {
  const text = fixtureText(file);
  const font = file.font && text ? await loadTextFont(file.font, text, readContent, where) : undefined;
  return mergedFiles(tools, file.name, path, fixtureModel(file, font, where));
}
