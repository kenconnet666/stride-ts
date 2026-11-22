/**
 * 物理堆放（`.pile.json`，Stride 没有）：超市散装区的一筐蒜、一箱洋葱、一槽核桃、一摞桶装水。文件存容器和往里倒什么，编辑器
 * 后端把东西放在容器上面、用物理（原生的 Jolt）让它们落下去、等都静止，再把停下的位置合成一个模型（modeling/pile.ts 摆、合成，
 * pipeline 的 bakers/pileModel.ts 跑物理、写文件）：同货架，一个模型、一张标签图集、一个材质。同一个文件、同一个种子倒出来一样。
 *
 * 坐标是米，原点在容器底面的中心，往 +Y 高。
 */

/** 倒进去的一种东西：商品（`.product.json`，果蔬或者包装）、几个、几个变体（颜色、牌子）。 */
export interface PileItemFile {
  readonly product: string;
  readonly count: number;
  readonly variants?: number;
}

export interface PileFile {
  readonly name: string;
  /** 容器：里面的宽、高（壁高）、深（米），壁厚（默认 0.015），颜色（sRGB 的 #rrggbb，默认深灰的塑料筐）。 */
  readonly container: {
    readonly size: readonly [number, number, number];
    readonly wall?: number;
    readonly color?: string;
  };
  readonly items: readonly PileItemFile[];
  readonly seed?: number;
}
