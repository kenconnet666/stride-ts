/**
 * 招牌（`.sign.json`，Stride 没有）：店门口、超市里的灯箱和挂牌（"上蔬永辉""沙县小吃""收银""1 号门"）。文件存尺寸、字和配色，
 * 编辑器后端生成同名的模型、图集和材质（modeling/sign.ts，同货架走 ProductBatch）：一个框，正面（两面的话背面也有）是字面；
 * 灯箱的字面整块发光（背光从里面透出来），挂牌不发光。立体的发光字用 3D 文字（`.text.json`）。
 *
 * 地贴（style 是 floor：地上的导视箭头、"请排队""1 米线"的圆标）不出模型，只出同名的一张透明底的 SVG（modeling/sign.ts 的
 * floorStickerSvg），场景里用贴花（Decal 组件的 albedo 引用它）投到地面上——跟着地面起伏、不和地面打架。
 * 吊旗（banner：超市顶上吊下来的促销旗，两面都印、不发光，顶上一根横杆、两根吊绳）和地堆的价牌（stand：圆底座、立杆，顶上一块
 * 两面印的卡片，"特价 9.9"）也是招牌。
 *
 * 坐标是米，原点在招牌的中心，字面朝 +Z；价牌的原点在底座的地面上。格式用模式（content/schema）声明：SignFile 是文件的样子，
 * Sign 是解析后的（默认值补齐）。配色没写时按样式不同（灯箱绿底白字、印的红底黄字、地贴黄底白边……），在 modeling/sign.ts 里定。
 */
import { s, type Infer, type InputOf } from '../schema/schema.ts';

export const SIGN = s.object({
  name: s.string(),
  /** 字，`\n` 换行。 */
  text: s.string().describe('the text on the face; line breaks start new lines'),
  /** 字体资源（要有中文就用资源包的 Shared/Fonts/ZCOOLQingKeHuangYou）。 */
  font: s.asset('font').describe('font of the text (Shared/Fonts/ZCOOLQingKeHuangYou from @stride-ts/assets has Chinese)'),
  /** 宽、高、厚（米）；地贴是宽、长（贴图的上方是长的方向），厚不用。 */
  size: s.vector(3, 'm').describe('width, height, depth (floor stickers: width and length, the length along the top of the texture)'),
  /** 灯箱（字面发光）、挂牌（不发光）、地贴（只出 SVG，用贴花贴到地上）、吊旗、地堆的价牌（见开头）。 */
  style: s.oneOf('lightbox', 'panel', 'floor', 'banner', 'stand').default('lightbox').describe('lightbox: the face glows (lit from inside); panel: it does not; floor: a floor sticker, only a transparent SVG of the same name, put on the floor with a decal; banner: a promo flag hanging from the ceiling (printed on both sides, a rod and two cords on top); stand: a price card on a pole with a round base by a floor stack (origin on the floor)'),
  /** 吊旗的吊绳多长（米）。 */
  hang: s.number({ min: 0, step: 0.1 }).default(0.5).describe('length of the cords of a banner (m)'),
  /** 价牌从地面到卡片顶多高（米）。 */
  standHeight: s.number({ min: 0.2, step: 0.1 }).default(1.2).describe('height from the floor to the top of a stand card (m)'),
  /** 地贴的外形：圆角方块、圆标、箭头（指向贴图的上方，转实体来定方向）。 */
  shape: s.oneOf('rect', 'round', 'arrow').default('rect').describe('floor sticker shape: rounded rectangle, round badge, arrow (pointing to the top of the texture; turn the entity to aim it)'),
  /** 用旧了多少（0..1，按种子）：地贴擦掉几道、几片；别的招牌字面上的手印、擦痕，外框边角的划伤、靠底发脏。 */
  wear: s.number({ min: 0, max: 1, step: 0.05 }).default(0.3).describe('how worn it is (0..1, from the seed): a floor sticker gets scratches and scuffed patches; other signs smudges and scuffs on the face, scratched edges and grime on the frame'),
  seed: s.integer(0, 2 ** 31 - 1).default(1).describe('random seed of the wear'),
  /** 两面都有字面（挂在通道上方的）。 */
  doubleSided: s.bool().default(false).describe('a face on the back too (signs hanging over an aisle)'),
  /** 配色（sRGB 的 #rrggbb）：字面的底、字、外框（地贴是描边）；没写的按样式。 */
  colors: s.object({
    background: s.string().optional().describe('face color (sRGB #rrggbb, green when missing)'),
    text: s.string().optional().describe('text color (sRGB #rrggbb, white when missing)'),
    frame: s.string().optional().describe('frame color (sRGB #rrggbb, brushed grey when missing; the outline of a floor sticker, white when missing)'),
  }).default({}).describe('colors of the face, the text and the frame'),
  /** 灯箱的亮度（自发光的强度）。 */
  brightness: s.number({ min: 0, step: 0.5 }).default(3).describe('emissive strength of a lightbox face'),
});

/** 招牌文件的样子（有默认值的可以不写）。 */
export type SignFile = InputOf<typeof SIGN>;
/** 解析以后的招牌（默认值补齐）。 */
export type Sign = Infer<typeof SIGN>;
