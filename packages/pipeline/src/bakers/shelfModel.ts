/**
 * 货架的烘焙（引擎 content/formats/shelfFormat.ts 的 ShelfFile）：生成在引擎的 modeling/shelf.ts，这里读摆货要的商品文件和字体，
 * 写成同名的文件（bakers/mergedFiles.ts：模型、图集、材质，冷柜、冰柜还有自发光图集和玻璃的材质）。编辑器后端在货架的文件存下、
 * 在磁盘上改了、或者它摆着的商品改了以后调它。
 */
import type { ShelfFile } from '@stride-ts/engine/content-format';
import { shelfModel } from '@stride-ts/engine/modeling';
import type { StrideTools } from '@stride-ts/native/tools';
import type { BakedFile } from './productModel.ts';
import { mergedFiles } from './mergedFiles.ts';
import { loadFonts, productFontTexts, readProducts, settleFood } from './settle.ts';

/** 生成 path（货架的内容路径）同名的模型、两张图集和材质。商品读不到、规则不对时报错。 */
export async function bakeShelf(tools: StrideTools, file: ShelfFile, path: string, readContent: (path: string) => Promise<Uint8Array>, where = file.name): Promise<BakedFile[]> {
  // 摆货的商品，加上顶上格子柜里躺着的瓶子
  const products = await readProducts([...(file.stock?.products ?? []), ...(file.cubbies?.products ?? [])], readContent, where);
  // 每个字体要排的字：商品各个变体的品牌名、品类、角标，价签的数字
  const variants = file.stock?.variants ?? 3;
  const texts = productFontTexts([...products.values()].map((product) => [product, variants] as const), [[file.font, `0123456789.${file.header ?? ''}${file.doorSticker?.title ?? ''}${file.doorSticker?.slogan ?? ''}`]]);
  const fonts = await loadFonts(texts, readContent, where);
  return mergedFiles(tools, file.name, path, shelfModel(file, { products, font: (font) => fonts.get(font), food: await settleFood(products) }, where));
}
