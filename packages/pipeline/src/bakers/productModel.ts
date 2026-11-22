/**
 * 商品包装的烘焙（引擎 content/formats/productFormat.ts 的 ProductFile）：生成在引擎的 modeling/product.ts，这里写成同名的三个
 * 文件：模型（量化加 meshopt）、标签贴图（.svg）、材质（引用标签贴图）；瓶身透光时还有表面贴图（.surface.svg）。编辑器后端在包装的文件存下、或者在磁盘上改了以后调它；
 * 字体资源从内容目录读，readContent 给。
 */
import { encodeModel, EXTENSIONS, type ProductFile } from '@stride-ts/engine/content-format';
import { labelPixels, productDesign, productLabelSvg, productMaterial, productMesh, productSurfaceSvg, productTransmission } from '@stride-ts/engine/modeling';
import type { StrideTools } from '@stride-ts/native/tools';
import { compressMeshes } from '../mesh.ts';
import { loadTextFont } from './textFont.ts';

/** 烘出的一个文件：内容路径加扩展名、字节。 */
export interface BakedFile {
  readonly path: string;
  readonly bytes: Uint8Array;
}

/** 生成 path（包装的内容路径）同名的模型、标签贴图（透光时加表面贴图）和材质。参数不对、字体读不到时报错。 */
export async function bakeProduct(tools: StrideTools, file: ProductFile, path: string, readContent: (path: string) => Promise<Uint8Array>, where = file.name): Promise<BakedFile[]> {
  const mesh = productMesh(file, where);
  const design = productDesign(file);
  const font = file.font ? await loadTextFont(file.font, design.brand + (design.text ?? ''), readContent, where) : undefined;
  const svg = productLabelSvg(file, mesh.labelSize, font);
  const material = productMaterial(file, path, labelPixels(mesh.labelSize));
  const model = encodeModel({ meshes: compressMeshes([{ name: 'package', material: 0, vertices: mesh.vertices, indices: mesh.indices }], tools), materials: [path] });
  const encoder = new TextEncoder();
  return [
    { path: path + EXTENSIONS.model, bytes: model },
    { path: `${path}.svg`, bytes: encoder.encode(svg) },
    ...(productTransmission(file) > 0 ? [{ path: `${path}.surface.svg`, bytes: encoder.encode(productSurfaceSvg(file, mesh.labelSize, font)) }] : []),
    { path: path + EXTENSIONS.material, bytes: encoder.encode(`${JSON.stringify(material, null, 1)}\n`) },
  ];
}
