/**
 * 商品包装（`.product.json`，Stride 没有）：超市货架上的盒、瓶、罐、桶、袋。文件存外形和标签的设计（矢量的：配色、图案、
 * 品牌名和品类的字），编辑器后端照它生成同名的三样（modeling/product.ts 生成、pipeline 的 bakers/productModel.ts 写文件）：
 * 模型 `.model`、标签贴图 `.svg`（字是字体的轮廓，不依赖系统字体）、材质 `.material.json`（标签贴图加这类包装的粗糙度、金属度）。
 * 这三个是生成的，改包装改 `.product.json`。
 *
 * 没写的配色、品牌名、图案按种子挑：同一个文件换种子（货架摆货的 variants）就是同一类商品的另一个牌子。坐标是米，原点在底面
 * 中心，往 +Y 高，正面朝 +Z。
 */

/**
 * 外形：纸盒、瓶（细颈加盖）、易拉罐、广口瓶（宽盖）、桶（上大下小加盖，酱料、冰淇淋）、袋（枕形的零食袋，上下封口）、
 * 方桶（5 升的油桶：圆角方的桶身，瓶口偏到前面，后面一个提手）；
 * 散装的果蔬干货（没有标签和字，表皮按种子出颜色、纹路）：圆的（番茄、橙子、苹果）、洋葱、蒜头（一瓣瓣的）、核桃（坑坑洼洼）、
 * 土豆（扁长、不规则）；熟食的器皿（没有字，可以盛一份菜，见 food）：碗（圈足、带壁厚的旋转体）、方盘（圆角的方形浅盘）。
 */
export type ProductShape = 'box' | 'bottle' | 'can' | 'jar' | 'tub' | 'pouch' | 'jug' | 'round' | 'onion' | 'garlic' | 'nut' | 'tuber' | 'bowl' | 'plate';

/** 散装的果蔬干货（没有标签，堆放用）。 */
export const PRODUCE_SHAPES: readonly ProductShape[] = ['round', 'onion', 'garlic', 'nut', 'tuber'];

/** 熟食的器皿（碗、盘：釉面，纹样和盛的菜画在贴图上）。 */
export const WARE_SHAPES: readonly ProductShape[] = ['bowl', 'plate'];

/** 包装的材料：决定粗糙度和金属度；skin 是果蔬的表皮，ceramic 是瓷器的釉面（器皿和里面油亮的菜都光滑）。 */
export type ProductSurface = 'paper' | 'plastic' | 'metal' | 'glass' | 'skin' | 'ceramic';

/** 标签的底纹：纯色、横带、斜条纹、上下两截、波浪、圆点；floral 是器皿的青花（口沿、外壁的缠枝花带，碗心一朵）。 */
export type ProductPattern = 'plain' | 'band' | 'stripes' | 'split' | 'wave' | 'dots' | 'floral';

/**
 * 器皿里盛的一份菜：color 是主料的颜色，accent 是配料（红椒丝、葱花），sauce 是底下汤汁的颜色（没写按主料暗一些）；level 是菜面
 * 边上到内壁多高（0..1，按碗的深度），mound 是中间再鼓起多少（按器皿的高）；pieces 是菜的样子：块（红烧肉、炸鸡块）、丝（土豆丝、
 * 豆芽）、粒（花生、毛豆）、糊（土豆泥、蛋羹）——决定贴图上画什么和菜面起伏多大。
 */
export interface ProductFood {
  readonly color: string;
  readonly accent?: string;
  readonly sauce?: string;
  readonly level?: number;
  readonly mound?: number;
  readonly pieces?: 'chunks' | 'strands' | 'beans' | 'smooth';
}

/** 标签的配色（sRGB 的 #rrggbb）：底色、图案的强调色、字的颜色、盖子的颜色、镶边（色带的金边、徽标）的颜色。 */
export interface ProductColors {
  readonly background?: string;
  readonly accent?: string;
  readonly text?: string;
  readonly cap?: string;
  readonly trim?: string;
}

/** 标签上配料的小图（品牌名两边的白圆底上）：叶子、油滴、花生、玉米、向日葵、麦穗、芝麻；none 不画。 */
export type ProductMotif = 'leaf' | 'drop' | 'peanut' | 'corn' | 'sunflower' | 'wheat' | 'sesame' | 'none';

export interface ProductFile {
  readonly name: string;
  readonly shape: ProductShape;
  /** 外形尺寸（米）：宽（瓶、罐、桶是直径）、高、深（纸盒、袋、方桶的厚度，方桶没写是宽的 0.62；瓶罐不用；果蔬写了就是扁的、长的，没写同宽）。 */
  readonly size: readonly [number, number, number];
  /** 标签上的字用的字体资源；没有时标签只画色块和图案。 */
  readonly font?: string;
  /** 品牌名（大字）；没写时按种子从常见的字里拼两三个字。 */
  readonly brand?: string;
  /** 品类（品牌名下面的小字："生抽""矿泉水"）；没写时不画。 */
  readonly text?: string;
  readonly colors?: ProductColors;
  readonly pattern?: ProductPattern;
  /** 没写时按外形：纸盒是纸，罐是金属，广口瓶是玻璃，器皿是瓷，别的是塑料。 */
  readonly surface?: ProductSurface;
  /** 配料的小图；没写时按种子从叶子、油滴、麦穗、向日葵和不画里挑。 */
  readonly motif?: ProductMotif;
  /** 角上的标（"5L""非转基因"）；没写时不画。 */
  readonly badge?: string;
  /**
   * 标签印得细不细（默认 true）：徽标、配料的小图、细字、角标、色带的镶边和明暗；false 只画色块、底纹和字（卡通的风格）。
   * 果蔬、器皿不看它。
   */
  readonly detail?: boolean;
  /** 器皿（碗、盘）里盛的菜；没写是空的。 */
  readonly food?: ProductFood;
  /**
   * 瓶身透多少光（0..1，默认 0）：装油、饮料的塑料瓶、玻璃瓶看得见里面的颜色。透的是标签的底色那片（瓶身，底色当里面装的东西的
   * 颜色），印上去的（盖子、图案、字）不透；果蔬、器皿不看它。
   */
  readonly transmission?: number;
  readonly seed?: number;
}
