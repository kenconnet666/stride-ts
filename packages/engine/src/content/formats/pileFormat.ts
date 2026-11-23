/**
 * 物理堆放（`.pile.json`，Stride 没有）：超市散装区的一筐蒜、一箱洋葱、一槽核桃、一摞桶装水。文件存容器和往里倒什么，编辑器
 * 后端把东西放在容器上面、用物理（原生的 Jolt）让它们落下去、等都静止，再把停下的位置合成一个模型（modeling/pile.ts 摆、合成，
 * pipeline 的 bakers/pileModel.ts 跑物理、写文件）：同货架，一个模型、一张标签图集、一个材质。同一个文件、同一个种子倒出来一样。
 *
 * 坐标是米，原点在容器底面的中心，往 +Y 高。格式用模式（content/schema）声明：PileFile 是文件的样子，Pile 是解析后的（默认值补齐）。
 */
import { s, type Infer, type InputOf } from '../schema/schema.ts';

/** 倒进去的一种东西：商品（`.product.json`，果蔬或者包装）、几个、几个变体（颜色、牌子），倒进哪一格（分格时；没写是整个容器）。 */
export const PILE_ITEM = s.object({
  product: s.asset('product').describe('what to pour in (produce or packaged goods)'),
  count: s.integer(0, 5000).describe('how many'),
  variants: s.integer(1, 32).default(3).describe('color or brand variants of it'),
  cell: s.integer(0, 255).optional().describe('compartment to pour into; the whole container when missing'),
});

/**
 * 一格里的细粒（米、豆子、瓜子、干香菇碎）：太小太多、不一个个跑物理，画成一堆——中间鼓、边上低、带颗粒的表面。level 是堆到
 * 壁高的多少（中间再鼓一点），color 是颗粒的颜色，grain 是颗粒的大小（米），speckle 是颗粒之间深一点的颜色。
 */
export const PILE_HEAP = s.object({
  cell: s.integer(0, 255).describe('compartment of the heap'),
  color: s.string().describe('grain color (sRGB #rrggbb)'),
  level: s.number({ min: 0, max: 1, step: 0.05 }).default(0.8).describe('fill height as a share of the wall (the middle rises a bit more)'),
  grain: s.number({ min: 0.001, step: 0.001, unit: 'm' }).default(0.006).describe('grain size'),
  speckle: s.string().default('#000000').describe('darker color between the grains (sRGB #rrggbb)'),
});

export const PILE = s.object({
  name: s.string(),
  /**
   * 容器：里面的宽、高（壁高）、深（米），壁厚，颜色（sRGB 的 #rrggbb，深灰的塑料筐）；cells 是分几格（列、行：散装柜，格子从左后往
   * 右前编号），lids 是每格一块往后掀开的透明盖（亚克力，开 35°）。
   */
  container: s.object({
    size: s.vector(3, 'm').describe('inside width, wall height and depth'),
    wall: s.number({ min: 0.001, step: 0.005, unit: 'm' }).default(0.015).describe('wall thickness'),
    color: s.string().default('#3d4044').describe('color of the container (sRGB #rrggbb)'),
    cells: s.vector(2).default([1, 1]).describe('split into compartments (columns, rows), numbered from back left to front right'),
    lids: s.bool().default(false).describe('a clear lid on each compartment, hinged at the back and lifted open'),
  }).describe('the bin the items are poured into'),
  items: s.list(PILE_ITEM).describe('items dropped into the container; physics settles them and the result is baked into one model'),
  /** 格子里的细粒（不跑物理，画成一堆）。 */
  heaps: s.list(PILE_HEAP).default([]).describe('fine grains (rice, beans, seeds) drawn as a heap instead of single bodies'),
  seed: s.integer(0, 2 ** 31 - 1).default(1).describe('random seed of the drop positions and variants'),
});

/** 堆放文件的样子（有默认值的可以不写）。 */
export type PileFile = InputOf<typeof PILE>;
/** 解析以后的堆放（默认值补齐）。 */
export type Pile = Infer<typeof PILE>;
export type PileItemFile = InputOf<typeof PILE_ITEM>;
export type PileHeapFile = InputOf<typeof PILE_HEAP>;
export type PileHeap = Infer<typeof PILE_HEAP>;
