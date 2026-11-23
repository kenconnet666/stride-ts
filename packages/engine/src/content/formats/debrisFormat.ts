/**
 * 地上的碎石杂物（`.debris.json`，Stride 没有）：一块地面上散落的小东西——石子、落叶、烟头、纸片，墙根、栏杆脚下攒得多。文件存
 * 范围和撒什么（矢量的规则），编辑器后端把东西放在地面上方一点、用物理（原生的 Jolt）让它们落下、躺稳，再把停下的位置合成一个
 * 模型（modeling/debris.ts 摆、合成，pipeline 的 bakers/debrisModel.ts 跑物理、写文件）：同物理堆放，一个模型、一张图集、一个材质，
 * 几百件一次绘制。同一个文件、同一个种子撒出来一样。
 *
 * 坐标是米，原点在这块地面的中心，地面是 y = 0。
 */

import { s, type Infer, type InputOf } from '../schema/schema.ts';

/** 撒的一种东西：商品（`.product.json`：石子用果蔬的 nut、tuber 外形配灰色，落叶是 leaf，烟头是小的 can）、几个、几个变体。 */
export const DEBRIS_ITEM = s.object({
  product: s.asset('product').describe('what lies around (pebbles: nut or tuber in grey, leaves, cigarette butts: small cans)'),
  count: s.integer(0, 5000).describe('how many'),
  variants: s.integer(1, 32).default(3).describe('color or brand variants of it'),
});

/** 范围的一条边：后（−Z）、前（+Z）、左（−X）、右（+X）。 */
export type DebrisSide = 'back' | 'front' | 'left' | 'right';

export const DEBRIS = s.object({
  name: s.string(),
  /** 撒的范围：宽（X）、深（Z），米。 */
  area: s.vector(2, 'm').describe('width (X) and depth (Z) of the patch of ground, centered on the origin'),
  items: s.list(DEBRIS_ITEM).describe('items dropped on the ground; physics lays them down and the result is baked into one model'),
  /**
   * 靠边攒：share（0..1）的东西落在 sides 这几条边往里 width 米以内，越靠边越多（风吹、扫地扫过去的）；其余的在整块里均匀撒。
   * 没写时都均匀撒。
   */
  edges: s.object({
    sides: s.list(s.oneOf('back', 'front', 'left', 'right')).describe('edges where debris gathers (back is -Z, left is -X)'),
    width: s.number({ min: 0, step: 0.05, unit: 'm' }).default(0.4).describe('how far in from those edges it gathers'),
    share: s.number({ min: 0, max: 1, step: 0.05 }).default(0.7).describe('share of the items that gather by the edges (denser closer in); the rest is spread over the whole patch'),
  }).optional().describe('debris piles up along walls and railings; spread evenly when missing'),
  seed: s.integer(0, 2 ** 31 - 1).default(1).describe('random seed of the layout'),
});

/** 杂物文件的样子（有默认值的可以不写）。 */
export type DebrisFile = InputOf<typeof DEBRIS>;
/** 解析以后的杂物（默认值补齐）。 */
export type Debris = Infer<typeof DEBRIS>;
export type DebrisItemFile = InputOf<typeof DEBRIS_ITEM>;
