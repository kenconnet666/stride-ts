/**
 * 商品包装（`.product.json`，Stride 没有）：超市货架上的盒、瓶、罐、桶、袋。文件存外形和标签的设计（矢量的：配色、图案、
 * 品牌名和品类的字），编辑器后端照它生成同名的三样（modeling/product.ts 生成、pipeline 的 bakers/productModel.ts 写文件）：
 * 模型 `.model`、标签贴图 `.svg`（字是字体的轮廓，不依赖系统字体）、材质 `.material.json`（标签贴图加这类包装的粗糙度、金属度）。
 * 这三个是生成的，改包装改 `.product.json`。
 *
 * 没写的配色、品牌名、图案按种子挑：同一个文件换种子（货架摆货的 variants）就是同一类商品的另一个牌子。坐标是米，原点在底面
 * 中心，往 +Y 高，正面朝 +Z。
 */

/** 外形：纸盒、瓶（细颈加盖）、易拉罐、广口瓶（宽盖）、桶（上大下小加盖，酱料、冰淇淋）、袋（枕形的零食袋，上下封口）。 */
export type ProductShape = 'box' | 'bottle' | 'can' | 'jar' | 'tub' | 'pouch';

/** 包装的材料：决定粗糙度和金属度。 */
export type ProductSurface = 'paper' | 'plastic' | 'metal' | 'glass';

/** 标签的底纹：纯色、横带、斜条纹、上下两截、波浪、圆点。 */
export type ProductPattern = 'plain' | 'band' | 'stripes' | 'split' | 'wave' | 'dots';

/** 标签的配色（sRGB 的 #rrggbb）：底色、图案的强调色、字的颜色、盖子的颜色。 */
export interface ProductColors {
  readonly background?: string;
  readonly accent?: string;
  readonly text?: string;
  readonly cap?: string;
}

export interface ProductFile {
  readonly name: string;
  readonly shape: ProductShape;
  /** 外形尺寸（米）：宽（瓶、罐、桶是直径）、高、深（纸盒、袋的厚度；瓶罐不用）。 */
  readonly size: readonly [number, number, number];
  /** 标签上的字用的字体资源；没有时标签只画色块和图案。 */
  readonly font?: string;
  /** 品牌名（大字）；没写时按种子从常见的字里拼两三个字。 */
  readonly brand?: string;
  /** 品类（品牌名下面的小字："生抽""矿泉水"）；没写时不画。 */
  readonly text?: string;
  readonly colors?: ProductColors;
  readonly pattern?: ProductPattern;
  /** 没写时按外形：纸盒是纸，罐是金属，广口瓶是玻璃，别的是塑料。 */
  readonly surface?: ProductSurface;
  readonly seed?: number;
}
