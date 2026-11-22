/**
 * 货架的烘焙（引擎 content/formats/shelfFormat.ts 的 ShelfFile）：生成在引擎的 modeling/shelf.ts，这里读摆货要的商品文件和字体，
 * 写成同名的四个文件：模型、颜色图集（.svg）、表面图集（.surface.svg：G 粗糙度、B 金属度）、材质。编辑器后端在货架的文件存下、
 * 在磁盘上改了、或者它摆着的商品改了以后调它。
 */
import { encodeModel, EXTENSIONS, type ProductFile, type ShelfFile } from '@stride-ts/engine/content-format';
import { productDesign, shelfMaterial, shelfModel, type TextFont } from '@stride-ts/engine/modeling';
import type { StrideTools } from '@stride-ts/native/tools';
import { compressMeshes } from '../mesh.ts';
import type { BakedFile } from './productModel.ts';
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
      want(product.font, design.brand + (design.text ?? ''));
    }
  }
  want(file.font, '0123456789.');
  const fonts = new Map<string, TextFont>();
  for (const [font, text] of texts) fonts.set(font, await loadTextFont(font, text, readContent, where));

  const model = shelfModel(file, { products, font: (font) => fonts.get(font) }, where);
  const encoder = new TextEncoder();
  const meshes = model.indices.length === 0 ? [] : compressMeshes([{ name: 'shelf', material: 0, vertices: model.vertices, indices: model.indices }], tools);
  return [
    { path: path + EXTENSIONS.model, bytes: encodeModel({ meshes, materials: [path] }) },
    { path: `${path}.svg`, bytes: encoder.encode(model.colorSvg) },
    { path: `${path}.surface.svg`, bytes: encoder.encode(model.surfaceSvg) },
    { path: path + EXTENSIONS.material, bytes: encoder.encode(`${JSON.stringify(shelfMaterial(file, path, model.atlasPixels), null, 1)}\n`) },
  ];
}
