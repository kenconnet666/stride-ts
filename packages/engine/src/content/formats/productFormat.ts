/**
 * 商品包装（`.product.json`，Stride 没有）：超市货架上的盒、瓶、罐、桶、袋。文件存外形和标签的设计（矢量的：配色、图案、
 * 品牌名和品类的字），编辑器后端照它生成同名的三样（modeling/product.ts 生成、pipeline 的 bakers/productModel.ts 写文件）：
 * 模型 `.model`、标签贴图 `.svg`（字是字体的轮廓，不依赖系统字体）、材质 `.material.json`（标签贴图加这类包装的粗糙度、金属度）。
 * 这三个是生成的，改包装改 `.product.json`。
 *
 * 没写的配色、品牌名、图案按种子挑：同一个文件换种子（货架摆货的 variants）就是同一类商品的另一个牌子。坐标是米，原点在底面
 * 中心，往 +Y 高，正面朝 +Z。格式用模式（content/schema）声明：ProductFile 是文件的样子，Product 是解析后的（固定的默认值补齐；
 * 按种子挑的配色、图案、品牌名、材料不是默认值，在 modeling/product.ts 的 productDesign 里挑）。
 */
import { s, type Infer, type InputOf } from '../schema/schema.ts';

/**
 * 外形：纸盒、瓶（细颈加盖）、易拉罐、广口瓶（宽盖）、桶（上大下小加盖，酱料、冰淇淋）、袋（枕形的零食袋，上下封口）、
 * 方桶（5 升的油桶：圆角方的桶身，瓶口偏到前面，后面一个提手）；
 * 散装的果蔬干货（没有标签和字，表皮按种子出颜色、纹路）：圆的（番茄、橙子、苹果）、洋葱、蒜头（一瓣瓣的）、核桃（坑坑洼洼）、
 * 土豆（扁长、不规则）、落叶（躺平时宽 × 卷起的高 × 长，叶脉画在贴图上；地上的杂物用）；熟食的器皿（没有字，可以盛一份菜，见 food）：碗（圈足、带壁厚的旋转体）、方盘（圆角的方形浅盘）。
 */
export const PRODUCT_SHAPES = ['box', 'bottle', 'can', 'jar', 'tub', 'pouch', 'jug', 'round', 'onion', 'garlic', 'nut', 'tuber', 'leaf', 'bowl', 'plate'] as const;
export type ProductShape = (typeof PRODUCT_SHAPES)[number];

/** 散装的果蔬干货（没有标签，堆放用）。 */
export const PRODUCE_SHAPES: readonly ProductShape[] = ['round', 'onion', 'garlic', 'nut', 'tuber', 'leaf'];

/** 熟食的器皿（碗、盘：釉面，纹样和盛的菜画在贴图上）。 */
export const WARE_SHAPES: readonly ProductShape[] = ['bowl', 'plate'];

/** 包装的材料：决定粗糙度和金属度；skin 是果蔬的表皮，ceramic 是瓷器的釉面（器皿和里面油亮的菜都光滑）。 */
export const PRODUCT_SURFACES = ['paper', 'plastic', 'metal', 'glass', 'skin', 'ceramic'] as const;
export type ProductSurface = (typeof PRODUCT_SURFACES)[number];

/** 标签的底纹：纯色、横带、斜条纹、上下两截、波浪、圆点；floral 是器皿的青花（口沿、外壁的缠枝花带，碗心一朵）。 */
export const PRODUCT_PATTERNS = ['plain', 'band', 'stripes', 'split', 'wave', 'dots', 'floral'] as const;
export type ProductPattern = (typeof PRODUCT_PATTERNS)[number];

/** 标签上配料的小图（品牌名两边的白圆底上）：叶子、油滴、花生、玉米、向日葵、麦穗、芝麻；none 不画。 */
export const PRODUCT_MOTIFS = ['leaf', 'drop', 'peanut', 'corn', 'sunflower', 'wheat', 'sesame', 'none'] as const;
export type ProductMotif = (typeof PRODUCT_MOTIFS)[number];

/** 颜色写成 sRGB 的 #rrggbb；没写的按种子挑。 */
const seededColor = (description: string) => s.string().optional().describe(`${description} (sRGB #rrggbb; picked from the seed when missing)`);

/**
 * 器皿里盛的一份菜：color 是主料的颜色，accent 是配料（红椒丝、葱花），sauce 是底下汤汁的颜色（没写按主料暗一些）；level 是菜面
 * 边上到内壁多高（0..1，按碗的深度），mound 是中间再鼓起多少（按器皿的高）；pieces 是菜的样子：块（红烧肉、炸鸡块）、丝（土豆丝、
 * 豆芽）、粒（花生、毛豆）、糊（土豆泥、蛋羹）——决定贴图上画什么和菜面起伏多大。
 *
 * dropped 是菜面上再一块块、一根根落下去堆起来的几份（真的几何，编辑器后端烘焙时用物理让它们落在菜面和碗壁上停下）：形状按
 * pieces（块是不规则的小方块、丝是细长条、粒是小椭球；糊不落），pieceSize 是一块的大小（米：块的边长、丝的粗细、粒的长；没写时
 * 0.02、0.004、0.009）。0 时菜只画在菜面的贴图上。
 */
export const PRODUCT_FOOD = s.object({
  color: s.string().describe('main ingredient color (sRGB #rrggbb)'),
  accent: s.string().optional().describe('side ingredient color (red pepper, scallion; sRGB #rrggbb); a darker main color when missing'),
  sauce: s.string().optional().describe('sauce under the food (sRGB #rrggbb); the main color darkened when missing'),
  level: s.number().default(0.7).describe('how high the food reaches the wall (0..1 of the inner depth)'),
  mound: s.number().default(0.15).describe('how much the middle heaps up (fraction of the ware height)'),
  pieces: s.oneOf('chunks', 'strands', 'beans', 'smooth').default('chunks').describe('what the food looks like: chunks (braised pork, fried chicken), strands (shredded potato, bean sprouts), beans (peanuts, soybeans), smooth (mashed, custard)'),
  dropped: s.number().default(0).describe('how many real pieces (by pieces: chunks, strands, beans; not smooth) are dropped on top and settled with physics when baking; 0 draws the food only on the surface texture'),
  pieceSize: s.number().optional().describe('size of one dropped piece in meters: chunk edge, strand thickness (strands are 10..16 times as long), bean length; 0.02, 0.004, 0.009 when missing'),
});

/** 标签的配色（sRGB 的 #rrggbb）：底色、图案的强调色、字的颜色、盖子的颜色、镶边（色带的金边、徽标）的颜色；没写的按种子挑。 */
export const PRODUCT_COLORS = s.object({
  background: seededColor('label background'),
  accent: seededColor('pattern color'),
  text: seededColor('text color (black or white by contrast when missing)'),
  cap: seededColor('cap or lid color'),
  trim: seededColor('trim lines and emblem color (gold, white or off-white)'),
});

export const PRODUCT = s.object({
  name: s.string(),
  shape: s.oneOf(...PRODUCT_SHAPES).describe('box: carton; bottle: narrow neck and cap; can; jar: wide lid; tub: wider at the top, with a lid; pouch: pillow-shaped bag sealed at both ends; jug: 5 l oil jug (rounded square body, spout moved to the front, a handle at the back); produce without a label (round: tomato, orange; onion; garlic; nut: walnut; tuber: potato; leaf: a fallen leaf lying flat, width × curl height × length); ware for cooked food: bowl (foot ring, wall thickness), plate (shallow rounded square)'),
  /** 外形尺寸（米）：宽（瓶、罐、桶是直径）、高、深（纸盒、袋、方桶的厚度，方桶没写是宽的 0.62；瓶罐不用；果蔬写了就是扁的、长的，没写同宽）。 */
  size: s.vector(3, 'm').describe('width (diameter for bottles, cans, jars, tubs and bowls), height, depth (cartons, pouches and plates; produce: elongated when given)'),
  /** 标签上的字用的字体资源；没有时标签只画色块和图案。 */
  font: s.asset('font').optional().describe('font of the label text (Shared/Fonts/ZCOOLQingKeHuangYou from @stride-ts/assets has Chinese); no text without one'),
  /** 品牌名（大字）；没写时按种子从常见的字里拼两三个字。 */
  brand: s.string().optional().describe('brand name in big letters; two or three common characters picked from the seed when missing'),
  /** 品类（品牌名下面的小字："生抽""矿泉水"）；没写时不画。 */
  text: s.string().optional().describe('product kind under the brand (e.g. 生抽, 矿泉水); none when missing'),
  colors: PRODUCT_COLORS.default({}).describe('label colors; the missing ones come from the seed, so variants of one file differ in them'),
  pattern: s.oneOf(...PRODUCT_PATTERNS).optional().describe('label pattern (floral: blue-and-white porcelain bands for ware); picked from the seed when missing, ware: bowls floral, plates plain'),
  /** 没写时按外形：纸盒是纸，罐是金属，广口瓶是玻璃，器皿是瓷，别的是塑料。 */
  surface: s.oneOf(...PRODUCT_SURFACES).optional().describe('material (roughness, metalness); by shape when missing: cartons paper, cans metal, jars glass, produce skin, ware ceramic, others plastic'),
  /** 器皿（碗、盘）里盛的菜；没写是空的。 */
  food: PRODUCT_FOOD.optional().describe('a dish of food in a bowl or plate; empty ware when missing'),
  /** 配料的小图；没写时按种子从叶子、油滴、麦穗、向日葵和不画里挑。 */
  motif: s.oneOf(...PRODUCT_MOTIFS).optional().describe('small picture of the ingredient on both sides of the brand (on a white disc); picked from the seed when missing (leaf, drop, wheat, sunflower or none)'),
  /** 角上的标（"5L""非转基因"）；没写时不画。 */
  badge: s.string().optional().describe('text of the starburst in the lower right corner ("5L", "non-GMO"); none when missing'),
  /** 卖点：印得细的标签上药丸下面的一行小字（"非转基因""物理压榨"）；没写时按种子挑两句。有角标时下面再印一行"净含量"加角标的字。 */
  claims: s.list(s.string()).optional().describe('selling points printed small under the product name ("non-GMO", "cold pressed"); two picked by the seed when missing; with a badge a net-content line follows'),
  /** 标签印得细不细：徽标、配料的小图、细字、角标、色带的镶边和明暗；false 只画色块、底纹和字（卡通的风格）。果蔬、器皿不看它。 */
  detail: s.bool().default(true).describe('print details: emblem, ingredient pictures, fine print, badge, trim lines and shading of the band; false draws only the color blocks, pattern and text (a cartoon look)'),
  /**
   * 瓶身透多少光（0..1）：装油、饮料的塑料瓶、玻璃瓶看得见里面的颜色。透的是标签的底色那片（瓶身，底色当里面装的东西的颜色），
   * 印上去的（盖子、图案、字）不透；果蔬、器皿不看它。
   */
  transmission: s.number({ min: 0, max: 1, step: 0.05 }).default(0).describe('how much light passes through the body (0..1: oil and drink bottles show what is inside); the label background is the body, printed parts (cap, pattern, text) stay opaque; produce and ware ignore it'),
  /** 旧了多少（0..1；0 是刚出厂）：每个变体按种子褪一点色、沾几块手印似的灰、边上几道擦痕（只画在颜色上，不挡透光）。果蔬、器皿不看它。 */
  wear: s.number({ min: 0, max: 1, step: 0.05 }).default(0.5).describe('how handled the package looks (0..1): each variant fades a little and gets a few grimy smudges and scuffs near the edges, from the seed; 0 is fresh from the factory; produce and ware ignore it'),
  /** 零售价（元）：货架上的价签印它，别的款式（别的牌子）在它上下一成左右；没写时价签上是随机的价格。 */
  price: s.number({ min: 0, step: 0.1 }).optional().describe('retail price in yuan printed on the shelf tags; other variants (brands) are within about 10% of it; a random price when missing'),
  seed: s.integer(0, 2 ** 31 - 1).default(1).describe('random seed of everything not written: another number is another brand of the same product'),
});

/** 商品文件的样子（有默认值的可以不写）。 */
export type ProductFile = InputOf<typeof PRODUCT>;
/** 解析以后的商品（固定的默认值补齐）。 */
export type Product = Infer<typeof PRODUCT>;
export type ProductFoodFile = InputOf<typeof PRODUCT_FOOD>;
export type ProductFood = Infer<typeof PRODUCT_FOOD>;
export type ProductColors = InputOf<typeof PRODUCT_COLORS>;
