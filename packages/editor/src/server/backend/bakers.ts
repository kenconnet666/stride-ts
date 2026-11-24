/**
 * 生成模型的资源（源头是 JSON 的参数：白盒、SDF、多边形网格、3D 文字、样条、树、建筑、商品包装、货架、堆放、招牌、天花板、
 * 店里的器具、可破碎物体的碎块）：每种怎么烘（pipeline 的 bake*），烘出哪些同名的资源（跟着源文件挪、删）。编辑器后端存下、磁盘上改了、打开工程时
 * 补烘都查这张表（generatorFor）；内置的加一种在这里加一行，工程自己的种类由编辑器扩展登记（shared/extension.ts 的 bake）。
 */
import { EXTENSIONS, type BrushFile, type BuildingFile, type CeilingFile, type FixtureFile, type PileFile, type DebrisFile, type FractureFile, type SplatEditFile, type PolyMeshFile, type ProductFile, type SdfFile, type ShelfFile, type SignFile, type SplineFile, type TextModelFile, type TreeFile } from '@stride-ts/engine/content-format';
import type { StrideTools } from '@stride-ts/native/tools';
import { bakeBrushModel, bakeBuildingModel, bakeCeiling, bakeDebris, bakeFixture, bakeFracture, bakePile, bakeSplatEdit, SPLAT_PROXY_SUFFIX, bakePolyModel, bakeProduct, bakeSdfModel, bakeShelf, bakeSign, bakeSplineModel, bakeTextModel, bakeTreeModel } from '@stride-ts/pipeline';
import type { AssetKind } from '../../shared/protocol.ts';
import { extensionAssetKinds, extensionAssetKind } from '../../shared/extension.ts';

/** 烘的时候能用的：原生工具、读内容目录里的文件（字体、商品）。 */
export interface BakeContext {
  readonly tools: StrideTools;
  readonly read: (file: string) => Promise<Uint8Array>;
}

/** 烘出的一个文件：相对内容目录的路径和内容。 */
export interface BakedFile {
  readonly path: string;
  readonly bytes: string | Uint8Array;
}

/** 一种生成的资源。 */
interface Generator {
  /** 烘：写到哪些文件（还没写）；参数不对时报错，消息以 where 开头。 */
  bake(context: BakeContext, content: unknown, assetPath: string, where: string): Promise<readonly BakedFile[]>;
  /** 烘出的同名资源：种类和路径的后缀（`''` 是同名，`.surface` 是 `<路径>.surface`）。 */
  readonly outputs: readonly (readonly [AssetKind, string])[];
}

/** 只烘出一个同名模型的（没有几何时 bytes 是 undefined，不写）。 */
function modelOnly<F>(bake: (context: BakeContext, file: F, where: string) => Uint8Array | undefined | Promise<Uint8Array | undefined>): Generator {
  return {
    async bake(context, content, assetPath, where) {
      const bytes = await bake(context, content as F, where);
      return bytes ? [{ path: assetPath + EXTENSIONS.model, bytes }] : [];
    },
    outputs: [['model', '']],
  };
}

/** 合成一个模型加图集、材质的（货架这一类）：模型、颜色和表面、自发光的图集，图集的材质、玻璃的材质和透光的商品的材质。 */
const MERGED_OUTPUTS: Generator['outputs'] = [['model', ''], ['material', ''], ['image', ''], ['image', '.surface'], ['image', '.emissive'], ['material', '.glass'], ['material', '.clear'], ['material', '.wire']];

function merged<F>(bake: (context: BakeContext, file: F, assetPath: string, where: string) => readonly BakedFile[] | Promise<readonly BakedFile[]>, outputs = MERGED_OUTPUTS): Generator {
  return { bake: async (context, content, assetPath, where) => bake(context, content as F, assetPath, where), outputs };
}

export const GENERATORS = {
  brush: modelOnly<BrushFile>(({ tools }, file, where) => bakeBrushModel(tools, file, where)),
  sdf: modelOnly<SdfFile>(({ tools }, file, where) => bakeSdfModel(tools, file, where)),
  poly: modelOnly<PolyMeshFile>(({ tools }, file, where) => bakePolyModel(tools, file, where)),
  text: modelOnly<TextModelFile>(({ tools, read }, file, where) => bakeTextModel(tools, file, read, where)),
  spline: modelOnly<SplineFile>(({ tools }, file, where) => bakeSplineModel(tools, file, where)),
  tree: modelOnly<TreeFile>(({ tools }, file, where) => bakeTreeModel(tools, file, where)),
  building: modelOnly<BuildingFile>(({ tools }, file, where) => bakeBuildingModel(tools, file, where)),
  // 可破碎物体的碎块：读完整的模型切开
  fracture: modelOnly<FractureFile>(({ tools, read }, file, where) => bakeFracture(tools, file, read, where)),
  // 包装还生成了同名的标签贴图和材质（瓶身透光时还有表面贴图）
  product: merged<ProductFile>(({ tools, read }, file, assetPath, where) => bakeProduct(tools, file, assetPath, read, where), [['model', ''], ['material', ''], ['image', ''], ['image', '.surface']]),
  shelf: merged<ShelfFile>(({ tools, read }, file, assetPath, where) => bakeShelf(tools, file, assetPath, read, where)),
  pile: merged<PileFile>(({ tools, read }, file, assetPath, where) => bakePile(tools, file, assetPath, read, where)),
  debris: merged<DebrisFile>(({ tools, read }, file, assetPath, where) => bakeDebris(tools, file, assetPath, read, where)),
  // 扫描场景的编辑：从源泼溅生成同名的泼溅，写了 proxy 时还有代理网格的模型
  splatEdit: { bake: async ({ read, tools }, content, assetPath, where) => (await bakeSplatEdit(content as SplatEditFile, assetPath, read, tools, where)).files, outputs: [['splats', ''], ['model', SPLAT_PROXY_SUFFIX]] },
  sign: merged<SignFile>(({ tools, read }, file, assetPath, where) => bakeSign(tools, file, assetPath, read, where)),
  ceiling: merged<CeilingFile>(({ tools }, file, assetPath, where) => bakeCeiling(tools, file, assetPath, where)),
  fixture: merged<FixtureFile>(({ tools, read }, file, assetPath, where) => bakeFixture(tools, file, assetPath, read, where)),
} satisfies Record<string, Generator>;

/** 一种资源的烘法：内置的，或者装上的编辑器扩展登记的（有 bake 的）；不生成文件的种类是 undefined。 */
export function generatorFor(kind: string): Generator | undefined {
  if (Object.hasOwn(GENERATORS, kind)) return GENERATORS[kind as keyof typeof GENERATORS];
  const extension = extensionAssetKind(kind);
  const bake = extension?.bake;
  if (!bake) return undefined;
  return { bake: async ({ tools, read }, content, assetPath, where) => bake(content, { tools, read, assetPath, where }), outputs: extension.outputs ?? [['model', '']] };
}

/** 生成文件的资源种类：内置的和扩展登记的。 */
export function generatedKinds(): AssetKind[] {
  return [...Object.keys(GENERATORS), ...extensionAssetKinds().filter((kind) => kind.bake).map((kind) => kind.kind)] as AssetKind[];
}

export const isGenerated = (kind: string): boolean => generatorFor(kind) !== undefined;

/** 生成的资源用着别的资源、那些变了要跟着重烘的：货架、堆放用着商品（标签、尺寸在它们的图集和网格里），碎块用着完整的模型。 */
export const REBAKE_WITH: Readonly<Partial<Record<AssetKind, readonly AssetKind[]>>> = { product: ['shelf', 'pile', 'debris'], splats: ['splatEdit'], model: ['fracture'] };
