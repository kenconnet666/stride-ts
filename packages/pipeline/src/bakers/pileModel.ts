/**
 * 物理堆放的烘焙（引擎 content/formats/pileFormat.ts 的 PileFile）：东西在容器上方摆好（引擎 modeling/pile.ts 的 pileSpawn），
 * 原生的 Jolt 让它们落下去、等都睡着（或者到时间，settle.ts），读回停下的位姿合成一个模型（pileModel），写成同名的四个文件：
 * 模型、颜色图集、表面图集、材质（同货架）。
 */
import type { PileFile } from '@stride-ts/engine/content-format';
import { pileContainer, pileModel, pileSpawn } from '@stride-ts/engine/modeling';
import type { StrideTools } from '@stride-ts/native/tools';
import type { BakedFile } from './productModel.ts';
import { mergedFiles } from './mergedFiles.ts';
import { loadFonts, productFontTexts, readProducts, settleProducts } from './settle.ts';

/** 生成 path（堆放的内容路径）同名的模型、两张图集和材质。商品读不到、容器不对时报错。 */
export async function bakePile(tools: StrideTools, file: PileFile, path: string, readContent: (path: string) => Promise<Uint8Array>, where = file.name): Promise<BakedFile[]> {
  const products = await readProducts(file.items.map((item) => item.product), readContent, where);
  // 包装上的字（果蔬没有）
  const fonts = await loadFonts(productFontTexts(file.items.map((item) => [products.get(item.product)!, item.variants ?? 3] as const)), readContent, where);
  const settled = await settleProducts(pileContainer(file), products, pileSpawn(file, products, where));
  return mergedFiles(tools, file.name, path, pileModel(file, { products, font: (font) => fonts.get(font) }, settled, where));
}
