/**
 * 天花板（`.ceiling.json`，Stride 没有）：超市、商场、地下车库的顶。文件存范围、高度和样式，编辑器后端生成同名的模型、图集和
 * 材质（modeling/ceiling.ts，走 ProductBatch）：
 * - open：开放式的顶（照片里的超市）：刷深色的楼板，下面露着一排排风管、桥架、喷淋管，灯管吊在杆上；
 * - grid：矿棉板的格栅吊顶，一格格的板、T 形龙骨，嵌着方形的灯盘。
 * 灯只是发光的灯具，照亮场景的光源（面光源）另外放，位置照 `lights` 排出来的（见 ceilingLights）。
 *
 * 坐标是米，原点在这片顶下面地面的中心；风管、灯管沿 X 排。
 */
import { s, type Infer, type InputOf } from '../schema/schema.ts';

export const CEILING = s.object({
  name: s.string(),
  /** 范围：宽（沿 X）、深（沿 Z）。 */
  size: s.vector(2, 'm').describe('width along X and depth along Z'),
  /** 楼板底（开放式）或吊顶（格栅）离地的高（米）。 */
  height: s.number({ min: 0.5, step: 0.1, unit: 'm' }).describe('height of the slab underside (open) or of the suspended ceiling (grid)'),
  style: s.oneOf('open', 'grid').default('open').describe('open: a dark slab with exposed ducts, cable trays, sprinkler pipes and hanging tube lights; grid: a suspended tile ceiling with recessed light panels'),
  /** 楼板、吊顶的颜色（sRGB 的 #rrggbb）：没写时开放式深灰、格栅白。 */
  color: s.string().optional().describe('slab or tile color (sRGB #rrggbb; dark grey for open, white for grid when missing)'),
  /** 开放式的管线：几根风管、几条桥架、几根喷淋管（沿 X，均匀地分在深度上）。 */
  ducts: s.integer(0, 20).default(2).describe('air ducts running along X (open)'),
  trays: s.integer(0, 20).default(2).describe('cable trays running along X (open)'),
  pipes: s.integer(0, 20).default(3).describe('sprinkler pipes running along X (open)'),
  /** 灯：沿 Z 排几排（rows），每排沿 X 每隔 spacing 米一盏，一盏长 length 米；开放式的吊在楼板下 drop 米。格栅的灯盘按同样的排布嵌在板里。 */
  lights: s.object({
    rows: s.integer(0, 50).default(2).describe('rows of lights across the depth'),
    spacing: s.number({ min: 0.5, step: 0.1, unit: 'm' }).default(2.2).describe('spacing of lights along X'),
    length: s.number({ min: 0.1, step: 0.1, unit: 'm' }).default(1.4).describe('length of one tube light (open)'),
    drop: s.number({ min: 0, step: 0.05, unit: 'm' }).default(0.6).describe('how far the lights hang below the slab (open)'),
  }).default({}).describe('light fixtures (they glow; place area lights at the same spots to light the scene)'),
  seed: s.integer(0, 2 ** 31 - 1).default(1).describe('random seed'),
});

/** 天花板文件的样子（有默认值的可以不写）。 */
export type CeilingFile = InputOf<typeof CEILING>;
/** 解析以后的天花板（默认值补齐）。 */
export type Ceiling = Infer<typeof CEILING>;
