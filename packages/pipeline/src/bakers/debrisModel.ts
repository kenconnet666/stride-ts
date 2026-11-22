/**
 * 地上的碎石杂物的烘焙（引擎 content/formats/debrisFormat.ts 的 DebrisFile）：东西在地面上方一点摆好（引擎 modeling/debris.ts 的
 * debrisSpawn），原生的 Jolt 让它们落下、躺稳（settle.ts，地面和四周的矮墙是板），读回停下的位姿合成一个模型（debrisModel），
 * 写成同名的四个文件：模型、颜色图集、表面图集、材质（同物理堆放）。
 */
import type { DebrisFile } from '@stride-ts/engine/content-format';
import { debrisBoards, debrisModel, debrisSpawn } from '@stride-ts/engine/modeling';
import type { StrideTools } from '@stride-ts/native/tools';
import type { BakedFile } from './productModel.ts';
import { mergedFiles } from './mergedFiles.ts';
import { loadFonts, productFontTexts, readProducts, settleProducts } from './settle.ts';

/** 生成 path（杂物的内容路径）同名的模型、两张图集和材质。商品读不到、范围不对时报错。 */
export async function bakeDebris(tools: StrideTools, file: DebrisFile, path: string, readContent: (path: string) => Promise<Uint8Array>, where = file.name): Promise<BakedFile[]> {
  const products = await readProducts(file.items.map((item) => item.product), readContent, where);
  const fonts = await loadFonts(productFontTexts(file.items.map((item) => [products.get(item.product)!, item.variants ?? 3] as const)), readContent, where);
  const settled = await settleProducts(debrisBoards(file), products, debrisSpawn(file, products, where));
  return mergedFiles(tools, file.name, path, debrisModel(file, { products, font: (font) => fonts.get(font) }, settled, where));
}
