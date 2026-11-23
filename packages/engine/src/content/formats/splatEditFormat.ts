/**
 * 扫描场景的编辑（`.splatedit.json`，Stride 没有；照 PlayCanvas 的 SuperSplat、splat-transform 的过滤）：手机扫的高斯泼溅拿来当
 * 远景、真实地点时，几段扫描对齐合并，裁掉不要的部分、刷掉飘着的噪点。文件只存源泼溅和一条条编辑（矢量的、可比较的文本），编辑器后端照它从源泼溅
 * 生成同名的泼溅（`.splat`：content/splatEdit.ts 改、pipeline 的 bakers/splatEditModel.ts 重建细节层次、写文件）；源泼溅不动，
 * 编辑随时能改、撤。
 *
 * 坐标是源泼溅自己的坐标（实体变换之前；3DGS 的 .ply 是 y 朝下的，场景里的实体一般绕 X 转了 180°）。
 */

/** 一个盒子：中心、边长（米），可选地转一下（四元数 xyzw）。 */
export interface SplatEditBox {
  readonly center: readonly [number, number, number];
  readonly size: readonly [number, number, number];
  readonly rotation?: readonly [number, number, number, number];
}

/** 刷掉的一笔：球心、半径（米）。 */
export interface SplatEditSphere {
  readonly center: readonly [number, number, number];
  readonly radius: number;
}

/**
 * 合并进来的另一段扫描：泼溅资源，和把它放进源泼溅坐标里的变换（先统一缩放、再转、再挪；手机扫的几段比例常常不一样）。编辑器里
 * 用操纵器摆个大概，"自动对齐"（content/splatAlign.ts 的 ICP）再把它对准。
 */
export interface SplatEditPart {
  readonly source: string;
  readonly position?: readonly [number, number, number];
  readonly rotation?: readonly [number, number, number, number];
  readonly scale?: number;
}

export interface SplatEditFile {
  readonly name: string;
  /** 源泼溅（splats 资源的内容路径），从它生成。 */
  readonly source: string;
  /** 合并进来的几段扫描（先合并，再按下面的裁剪、刷掉、删飞点）。 */
  readonly merge?: readonly SplatEditPart[];
  /** 裁剪框：只留这些盒子（的并集）里面的；没写不裁。 */
  readonly keep?: readonly SplatEditBox[];
  /** 删掉这些盒子里面的。 */
  readonly remove?: readonly SplatEditBox[];
  /** 刷选删掉的：中心落在这些球里的泼溅去掉（编辑器里拖着刷，一笔是一串球）。 */
  readonly erase?: readonly SplatEditSphere[];
  /**
   * 删飞点：按 cell 米的格子数泼溅，自己和周围 26 格加起来不到 neighbors 个的（孤零零飘在空中的）去掉；不透明度低于 minOpacity
   * 的也去掉（几乎看不见的；默认不按它删——很多淡的叠在一起是地面、墙上柔和的那层光，删了发暗）。默认 cell 0.25、neighbors 4。
   */
  readonly floaters?: { readonly cell?: number; readonly neighbors?: number; readonly minOpacity?: number };
}
