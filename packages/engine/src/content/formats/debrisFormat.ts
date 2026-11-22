/**
 * 地上的碎石杂物（`.debris.json`，Stride 没有）：一块地面上散落的小东西——石子、落叶、烟头、纸片，墙根、栏杆脚下攒得多。文件存
 * 范围和撒什么（矢量的规则），编辑器后端把东西放在地面上方一点、用物理（原生的 Jolt）让它们落下、躺稳，再把停下的位置合成一个
 * 模型（modeling/debris.ts 摆、合成，pipeline 的 bakers/debrisModel.ts 跑物理、写文件）：同物理堆放，一个模型、一张图集、一个材质，
 * 几百件一次绘制。同一个文件、同一个种子撒出来一样。
 *
 * 坐标是米，原点在这块地面的中心，地面是 y = 0。
 */

/** 撒的一种东西：商品（`.product.json`：石子用果蔬的 nut、tuber 外形配灰色，落叶是 leaf，烟头是小的 can）、几个、几个变体。 */
export interface DebrisItemFile {
  readonly product: string;
  readonly count: number;
  readonly variants?: number;
}

/** 范围的一条边：后（−Z）、前（+Z）、左（−X）、右（+X）。 */
export type DebrisSide = 'back' | 'front' | 'left' | 'right';

export interface DebrisFile {
  readonly name: string;
  /** 撒的范围：宽（X）、深（Z），米。 */
  readonly area: readonly [number, number];
  readonly items: readonly DebrisItemFile[];
  /**
   * 靠边攒：share（0..1，默认 0.7）的东西落在 sides 这几条边往里 width 米（默认 0.4）以内，越靠边越多（风吹、扫地扫过去的）；
   * 其余的在整块里均匀撒。没写时都均匀撒。
   */
  readonly edges?: { readonly sides: readonly DebrisSide[]; readonly width?: number; readonly share?: number };
  readonly seed?: number;
}
