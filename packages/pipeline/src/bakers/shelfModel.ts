/**
 * 货架的烘焙（引擎 content/formats/shelfFormat.ts 的 ShelfFile）：生成在引擎的 modeling/shelf.ts，这里读摆货要的商品文件和字体，
 * 写成同名的文件（bakers/mergedFiles.ts：模型、图集、材质，冷柜、冰柜还有自发光图集和玻璃的材质）。编辑器后端在货架的文件存下、
 * 在磁盘上改了、或者它摆着的商品改了以后调它。
 */
import { EXTENSIONS, type ProductFile, type ShelfFile } from '@stride-ts/engine/content-format';
import { productDesign, productText, shelfModel, type TextFont } from '@stride-ts/engine/modeling';
import type { StrideTools } from '@stride-ts/native/tools';
import type { BakedFile } from './productModel.ts';
import { mergedFiles } from './mergedFiles.ts';
import { loadTextFont } from './textFont.ts';

/** 生成 path（货架的内容路径）同名的模型、两张图集和材质。商品读不到、规则不对时报错。 */
export async function bakeShelf(tools: StrideTools, file: ShelfFile, path: string, readContent: (path: string) => Promise<Uint8Array>, where = file.name): Promise<BakedFile[]> {
  const products = new Map<string, ProductFile>();
  for (const product of file.stock?.products ?? []) {
    try {
      products.set(product, JSON.parse(new TextDecoder().decode(await readContent(product + EXTENSIONS.product))) as ProductFile);
    } catch (error) {
      throw new Error(`${where}: cannot read the product ${product}: ${(error as Error).message}`, { cause: error });
    }
  }
  // 每个字体要排的字：商品各个变体的品牌名、品类，价签的数字
  const texts = new Map<string, string>();
  const want = (font: string | undefined, text: string) => font && texts.set(font, (texts.get(font) ?? '') + text);
  const variants = Math.max(1, Math.round(file.stock?.variants ?? 3));
  for (const product of products.values()) {
    for (let k = 0; k < variants; k++) {
      const design = productDesign(product, k);
      want(product.font, productText(design));
    }
  }
  want(file.font, `0123456789.${file.header ?? ''}`);
  const fonts = new Map<string, TextFont>();
  for (const [font, text] of texts) fonts.set(font, await loadTextFont(font, text, readContent, where));

  return mergedFiles(tools, file.name, path, shelfModel(file, { products, font: (font) => fonts.get(font) }, where));
}
