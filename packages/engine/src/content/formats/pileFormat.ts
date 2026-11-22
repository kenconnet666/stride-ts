/**
 * 物理堆放（`.pile.json`，Stride 没有）：超市散装区的一筐蒜、一箱洋葱、一槽核桃、一摞桶装水。文件存容器和往里倒什么，编辑器
 * 后端把东西放在容器上面、用物理（原生的 Jolt）让它们落下去、等都静止，再把停下的位置合成一个模型（modeling/pile.ts 摆、合成，
 * pipeline 的 bakers/pileModel.ts 跑物理、写文件）：同货架，一个模型、一张标签图集、一个材质。同一个文件、同一个种子倒出来一样。
 *
 * 坐标是米，原点在容器底面的中心，往 +Y 高。
 */

/** 倒进去的一种东西：商品（`.product.json`，果蔬或者包装）、几个、几个变体（颜色、牌子），倒进哪一格（分格时；没写是整个容器）。 */
export interface PileItemFile {
  readonly product: string;
  readonly count: number;
  readonly variants?: number;
  readonly cell?: number;
}

/**
 * 一格里的细粒（米、豆子、瓜子、干香菇碎）：太小太多、不一个个跑物理，画成一堆——中间鼓、边上低、带颗粒的表面。level 是堆到
 * 壁高的多少（0..1，中间再鼓一点），color 是颗粒的颜色（sRGB 的 #rrggbb），grain 是颗粒的大小（米，默认 0.006），speckle 是
 * 颗粒之间深一点的颜色（默认按 color 暗一些）。
 */
export interface PileHeapFile {
  readonly cell: number;
  readonly color: string;
  readonly level?: number;
  readonly grain?: number;
  readonly speckle?: string;
}

export interface PileFile {
  readonly name: string;
  /**
   * 容器：里面的宽、高（壁高）、深（米），壁厚（默认 0.015），颜色（sRGB 的 #rrggbb，默认深灰的塑料筐）；cells 是分几格
   * （列、行：散装柜，格子从左后往右前编号），lids 是每格一块往后掀开的透明盖（亚克力，开 35°）。
   */
  readonly container: {
    readonly size: readonly [number, number, number];
    readonly wall?: number;
    readonly color?: string;
    readonly cells?: readonly [number, number];
    readonly lids?: boolean;
  };
  readonly items: readonly PileItemFile[];
  /** 格子里的细粒（不跑物理，画成一堆）。 */
  readonly heaps?: readonly PileHeapFile[];
  readonly seed?: number;
}
