/**
 * 货架（`.shelf.json`，Stride 没有）：超市的中岛（双面）、靠墙的单面货架，连同摆在上面的商品。文件存货架的尺寸、每层的高度和
 * 摆货的规则（哪些商品、几个变体、几个排面），编辑器后端照它生成同名的模型、标签图集和材质（modeling/shelf.ts 生成、
 * pipeline 的 bakers/shelfModel.ts 写文件）：架子、价签条、所有商品合成一个模型、一个材质——一排货架几千件商品是一次绘制。
 *
 * 坐标是米，原点在货架底面的中心，沿 X 是长，+Z 是正面（双面的背面朝 -Z），往 +Y 高。商品的变体同 ProductFile：文件里没写的
 * 配色、品牌名按种子换，同一种商品摆出几个牌子。
 *
 * 格式用模式（content/schema）声明：同一份给出文件的类型（ShelfFile：文件里的样子）、解析以后的类型（Shelf：默认值补齐）、
 * 读文件时的检查和编辑器的字段描述（SHELF_FIELDS）。
 */
import { s, type Infer, type InputOf } from '../schema/schema.ts';

/** 摆货的规则：从这些商品里挑（每层只挑放得下的），每种出几个变体，一次摆几个排面，往里摆几排。 */
export const SHELF_STOCK = s.object({
  /** 商品包装的内容路径（`.product.json`）。 */
  products: s.list(s.asset('product')).describe('products to stock; each level only takes those that fit under the next board'),
  /** 每种商品出几个牌子（ProductFile 的变体）。 */
  variants: s.integer(1, 32).default(3).describe('brands of each product (product variants: the colors and brand the product file leaves out)'),
  /** 同一件商品挨着摆几个（排面数）的范围；没写时货架是 [2, 5]、堆头是 [3, 6]。 */
  facings: s.vector(2).optional().describe('how many of one item stand side by side (min, max); [2, 5] on shelves, [3, 6] on stacks when missing'),
  /** 往里最多摆几排；摆满按层深算。 */
  rows: s.integer(1, 16).default(4).describe('at most this many rows deep (fewer when the board is shallower)'),
  /** 架上空着的比例（0..1，卖掉了的空位）。 */
  gaps: s.number({ min: 0, max: 1, step: 0.05 }).default(0.05).describe('share of empty spots (sold out)'),
  /**
   * 摆得有多乱（0..1；0 是出厂一样整整齐齐）：圆的瓶罐被转过（标签朝向不一，最多 ±45°），方的盒子歪一点（挤得紧，只能歪到碰不着
   * 旁边的），一些列被往里推（前面那件被拿走过），左右前后在缝里错开一点。按种子，同一个文件摆出来一样。
   */
  messiness: s.number({ min: 0, max: 1, step: 0.05 }).default(0.5).describe('how messy the stock is: round bottles and jars turned (labels facing different ways), boxes tilted a little, some columns pushed back, small shifts within the gaps; 0 is factory tidy'),
  /** 按层摆（从下往上第 i 个是第 i 层，同 levels）：这一层只从这些商品里挑（超市里一层常是一类货）；没写、null 的层用 products。 */
  levels: s.nullableList(s.list(s.asset('product'))).optional().describe('products per level (from the bottom, like levels): a level only takes these (stores often keep one kind per level); missing or null levels use products'),
});

/** 冷柜门上的广告贴（ShelfFile.doorSticker）。 */
export const SHELF_DOOR_STICKER = s.object({
  color: s.string().describe('sticker color (sRGB #rrggbb)'),
  title: s.string().optional().describe('text on the banner at the top of the sticker ("frozen zone"); needs font'),
  slogan: s.string().optional().describe('text on the strip at the bottom of the sticker; needs font'),
  textColor: s.string().default('#ffffff').describe('color of the sticker text (sRGB #rrggbb)'),
  border: s.number({ min: 0, step: 0.005, unit: 'm' }).default(0.05).describe('width of the side borders'),
});

export const SHELF = s.object({
  name: s.string(),
  /** 单面（靠墙，正面朝 +Z）或双面（中岛）。 */
  sides: s.integer(1, 2).$type<1 | 2>().describe('1: against a wall, front facing +Z; 2: an island with a second face toward -Z'),
  /** 长（米，沿 X）。 */
  length: s.number({ min: 0.1, step: 0.25, unit: 'm' }).describe('length along X'),
  /** 总高（米）。 */
  height: s.number({ min: 0.1, step: 0.1, unit: 'm' }).describe('total height'),
  /** 每一面层板的深（米）。 */
  depth: s.number({ min: 0.05, step: 0.05, unit: 'm' }).describe('depth of the shelf boards on each face'),
  /** 每层层板上表面离地的高（米，从下往上）；第一层是底座。 */
  levels: s.list(s.number({ min: 0, step: 0.05, unit: 'm' })).describe('height of the top of each shelf board from the floor, bottom up; the first is the base'),
  /** 立柱的间距（米）；没写时货架 1、冷柜一扇门 0.75、熟食柜一盏灯 0.6。 */
  bay: s.number({ min: 0.2, step: 0.25, unit: 'm' }).optional().describe('spacing of the uprights (shelves, 1 when missing), the doors (fridges, 0.75) or the heat lamps (deli, 0.6)'),
  /** 架子和价签条的颜色（sRGB 的 #rrggbb）：架子默认浅灰，价签条默认白。 */
  frameColor: s.string().default('#d9dadc').describe('color of the frame and boards (sRGB #rrggbb)'),
  stripColor: s.string().default('#f4f4f2').describe('color of the price strips (sRGB #rrggbb)'),
  /** 层板的厚（米；木层板前沿常有 4 厘米厚）。 */
  boardThickness: s.number({ min: 0.005, max: 0.1, step: 0.005, unit: 'm' }).default(0.02).describe('thickness of the boards (wooden boards often have a 4 cm thick front)'),
  /** 层板的颜色（sRGB 的 #rrggbb，木纹板的浅木色这类）：写了是木纹层板；没写同架子。 */
  boardColor: s.string().optional().describe('color of the boards (sRGB #rrggbb): wood-grain boards of this color; plain boards of the frame color when missing'),
  /** 价签上的数字用的字体；没有时价签只是色块。 */
  font: s.asset('font').optional().describe('font of the prices on the tags; plain tags without one'),
  stock: SHELF_STOCK.optional().describe('what goes on the shelf; empty shelves without it'),
  /**
   * 种类：货架（gondola）；立式冷柜（fridge：单面，玻璃门，门框上竖着灯带，顶上一条灯箱写着 header）；卧式冰柜（freezer：货躺在
   * 槽里，上面两块玻璃推拉盖；depth 是整个柜子的宽，levels 只用第一个——槽底的高，height 是柜沿的高）；挂钩架（pegboard：
   * 洞洞板上一排排挂钩，袋装、卡装的商品挂在钩上，levels 是每排挂钩的高、depth 是钩长）；堆头（stack：地上一个台子，商品一块块
   * 码成往上收的垛，levels 只用第一个——台面的高，depth 是整个垛的深，原点在台子中心）；熟食柜（deli：黑色的柜体，前面一条白
   * 石英台面，中间下沉的黑托盘上成排摆碗、盘（商品的 bowl、plate，摆货的 rows 是往里几排），上面每隔 bay 挂一盏金色的保温灯；
   * levels 只用第一个——托盘面的高，height 是灯罩底的高，depth 是整个柜子的深）。端架就是短的单面货架。
   */
  type: s.oneOf('gondola', 'fridge', 'freezer', 'pegboard', 'stack', 'deli').default('gondola').describe('gondola: open shelves; fridge: one face behind glass doors with light strips and a lit header; freezer: a chest with goods lying in the well under sliding glass lids (depth is the whole width, only the first level is used: the well floor); pegboard: goods hanging on rows of hooks (levels are the hook rows, depth the hook length); stack: a floor display stacked in tapering blocks on a platform (only the first level is used: the platform top; depth is the stack depth; centered); deli: a black counter with a white quartz front ledge and rows of bowls and plates in a sunken black tray, gold heat lamps every bay above (only the first level is used: the tray top; height is the bottom of the lamp shades; depth is the whole counter)'),
  /** 冷柜顶上灯箱的字（"冷藏饮料"），要有 font；没写时灯箱只发光不写字。 */
  header: s.string().optional().describe('text on the lit header of a fridge (needs the font)'),
  /** 冷柜的门框、门下的前脸、顶盖和灯箱的颜色（sRGB 的 #rrggbb；饮料厂家的品牌冷柜，黄的、红的）；没写是深灰门框、架子色的顶、蓝灯箱。 */
  doorColor: s.string().optional().describe('fridge: color of the door frames, the front below the doors, the top and the header box (sRGB #rrggbb; branded drink fridges are yellow, red...); dark frames and a blue header when missing'),
  /**
   * 冷柜门上的广告贴（贴在每扇门的玻璃外面）：门的下面三分之二贴一圈——上面一条横幅写 title（"冰冻专区"），两边各一条边框，
   * 下面一条写 slogan（"天然矿泉水"），中间空着看得见里面的货。color 是贴纸的底色，textColor 是字的颜色，border 是两边边框的宽；
   * 字要有 font。
   */
  doorSticker: SHELF_DOOR_STICKER.optional().describe('fridge: an advertising sticker on the outside of every door glass, around the lower two thirds: a banner with a title, side borders and a strip with a slogan, the middle left clear'),
  /**
   * 价签放在哪：价签条（strip：层板前沿往下的一条，价签贴在正面）或透明挡条（rail：立在层板前沿、略往后仰的一条透明塑料，
   * 纸价签插在它后面，层板下面没有价签条；照片里的木层板货架）。只对货架、冷柜有用。
   */
  tagHolder: s.oneOf('strip', 'rail').default('strip').describe('where the tags sit: on a strip below the board front (strip) or slid behind a clear plastic rail standing on the board front, leaning back a little (rail; no strip under the board)'),
  /** 纸价签右边一块的颜色（sRGB 的 #rrggbb，超市自己的颜色）：写了时价签都是白底深灰字、右边这一块；没写是白底或黄底红字。 */
  tagAccent: s.string().optional().describe('color of a block on the right of paper tags (sRGB #rrggbb, the store color): all tags white with dark grey prices then; white or yellow with red prices when missing'),
  /** 价签：纸的（白底或黄底红字）或电子价签（一个小外壳加一块墨水屏：黑字、角上的二维码，有的带红色的促销条）。 */
  priceTags: s.oneOf('paper', 'electronic').default('paper').describe('paper tags (white or yellow, red price) or electronic shelf labels (a small housing with an e-ink screen, black price and a QR code, some with a red promo bar)'),
  /**
   * 货架顶上的格子柜（照片里油货架上面两排深色的木格子，横躺着放酒）：摞在货架顶上，height 高、depth 深（没写同货架），rows 排，
   * 每个立柱间距里 columns 格（格宽按种子错开一点，每排各分各的，上下的竖板错开）；hex 个六边形格上下贯通所有排（左右在半高处
   * 是尖角，位置按种子挑）；products 里的瓶子瓶口朝外、贴近前沿横躺成一排，fill 是有瓶子的格子的比例。木头带木纹（color 是它的颜色）。只对货架（gondola）有用。
   */
  cubbies: s.object({
    height: s.number({ min: 0.1, step: 0.05, unit: 'm' }).describe('height of the cabinet on top of the shelf'),
    depth: s.number({ min: 0.1, step: 0.05, unit: 'm' }).optional().describe('depth of the cabinet; the shelf depth when missing'),
    rows: s.integer(1, 8).default(2).describe('rows of cells'),
    columns: s.integer(1, 8).default(2).describe('cells per bay (the widths vary a little from the seed, each row on its own)'),
    color: s.string().default('#5f5650').describe('wood color (sRGB #rrggbb)'),
    hex: s.integer(0, 8).default(0).describe('tall hexagonal cells through all rows (pointed at half height on the left and right), placed by the seed'),
    products: s.list(s.asset('product')).default([]).describe('bottles lying in the cells, neck out'),
    fill: s.number({ min: 0, max: 1, step: 0.05 }).default(0.6).describe('share of the cells that have bottles'),
  }).optional().describe('a wooden cubby cabinet on top of a gondola, bottles lying in the cells'),
  seed: s.integer(0, 2 ** 31 - 1).default(1).describe('random seed of the stocking and the prices'),
});

/** 货架文件里的样子（有默认值的可以不写）。 */
export type ShelfFile = InputOf<typeof SHELF>;
/** 解析以后的货架（默认值补齐）。 */
export type Shelf = Infer<typeof SHELF>;
export type ShelfStockFile = InputOf<typeof SHELF_STOCK>;
export type ShelfStock = Infer<typeof SHELF_STOCK>;
export type ShelfDoorSticker = InputOf<typeof SHELF_DOOR_STICKER>;
