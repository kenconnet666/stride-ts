/**
 * 货架（`.shelf.json`，Stride 没有）：超市的中岛（双面）、靠墙的单面货架，连同摆在上面的商品。文件存货架的尺寸、每层的高度和
 * 摆货的规则（哪些商品、几个变体、几个排面），编辑器后端照它生成同名的模型、标签图集和材质（modeling/shelf.ts 生成、
 * pipeline 的 bakers/shelfModel.ts 写文件）：架子、价签条、所有商品合成一个模型、一个材质——一排货架几千件商品是一次绘制。
 *
 * 坐标是米，原点在货架底面的中心，沿 X 是长，+Z 是正面（双面的背面朝 -Z），往 +Y 高。商品的变体同 ProductFile：文件里没写的
 * 配色、品牌名按种子换，同一种商品摆出几个牌子。
 */

/** 摆货的规则：从这些商品里挑（每层只挑放得下的），每种出几个变体，一次摆几个排面，往里摆几排。 */
export interface ShelfStockFile {
  /** 商品包装的内容路径（`.product.json`）。 */
  readonly products: readonly string[];
  /** 每种商品出几个牌子（ProductFile 的变体），默认 3。 */
  readonly variants?: number;
  /** 同一件商品挨着摆几个（排面数）的范围，默认 [2, 5]。 */
  readonly facings?: readonly [number, number];
  /** 往里最多摆几排，默认 4；摆满按层深算。 */
  readonly rows?: number;
  /** 架上空着的比例（0..1，卖掉了的空位），默认 0.05。 */
  readonly gaps?: number;
}

export interface ShelfFile {
  readonly name: string;
  /** 单面（靠墙，正面朝 +Z）或双面（中岛）。 */
  readonly sides: 1 | 2;
  /** 长（米，沿 X）。 */
  readonly length: number;
  /** 总高（米）。 */
  readonly height: number;
  /** 每一面层板的深（米）。 */
  readonly depth: number;
  /** 每层层板上表面离地的高（米，从下往上）；第一层是底座。 */
  readonly levels: readonly number[];
  /** 立柱的间距（米），默认 1。 */
  readonly bay?: number;
  /** 架子和价签条的颜色（sRGB 的 #rrggbb）：架子默认浅灰，价签条默认白。 */
  readonly frameColor?: string;
  readonly stripColor?: string;
  /** 价签上的数字用的字体；没有时价签只是色块。 */
  readonly font?: string;
  readonly stock?: ShelfStockFile;
  readonly seed?: number;
}
