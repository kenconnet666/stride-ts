/**
 * 样条（`.spline.json`，W3，Stride 没有，新加的）：道路、管子、轨道、围栏、电线这类"沿着一条路径"的东西。文件存控制点和横截面
 * （矢量的参数），编辑器后端把它烘成同名的模型（modeling/spline.ts 拉伸、pipeline 的 splineModel.ts 写模型），场景照常引用；
 * 改了控制点、横截面马上重新烘、视口热重载。
 *
 * 坐标是实体的本地坐标（米）。路径经过每一个控制点（向心 Catmull-Rom，不打圈、不过冲），按弧长每 resolution 米取一个截面；
 * 截面的朝向跟着世界的上方（路面不随路径侧翻），tilt 让它绕路径转（弯道的超高）。
 *
 * 路网：branches 是更多的路径（同一个横截面）。各条路径上位置相同（差不到 1 厘米）的控制点焊在一起：编辑器里一起拖；道路在
 * 三条以上的路交汇的点上自动生成路口（各条路停在相邻两条路的边线交点再往回倒一个转角半径的地方，路口按转角的圆弧补齐）。
 */

/** 一个控制点：位置，可选的侧倾（度，绕路径转，正的向右倾）和截面宽度的倍数（路变宽、变窄）。 */
export interface SplinePointFile {
  readonly position: readonly [number, number, number];
  readonly tilt?: number;
  readonly width?: number;
}

/**
 * 横截面。材质槽按种类固定（文件的 materials 按这个顺序）：
 * - road：路面（顶面、两侧斜坡、底面一个槽）；width 是路面宽，thickness 是厚度，shoulder 是两侧斜坡往外伸出的宽度，
 *   cornerRadius 是路口转角的半径（默认半个路宽），lanes 是每个方向几条车道（默认按 3.5 米一条、至少一条），oneWay 时全部
 *   顺着路径的方向（车道图见 modeling/spline.ts 的 roadLanes，靠右行驶）；
 * - tube：圆管（管子、缆线、扶手），radius、sides；
 * - custom：任意截面（shape 是 [右, 上] 的折线，米；closed 时首尾相连），一个槽；
 * - rail：铁轨（钢轨、轨枕两个槽），gauge 是两根钢轨内侧的距离（标准轨 1.435 米）；
 * - fence：围栏（立柱、横杆两个槽），立柱每 postSpacing 米一根，rails 根横杆；
 * - wire：架空线（电杆、导线两个槽），电杆每 poleSpacing 米一根、高 poleHeight，wires 根导线在杆顶的横担上，两杆之间下垂 sag 米。
 */
export type SplineProfileFile =
  | { readonly type: 'road'; readonly width: number; readonly thickness?: number; readonly shoulder?: number; readonly cornerRadius?: number; readonly lanes?: number; readonly oneWay?: boolean }
  | { readonly type: 'tube'; readonly radius: number; readonly sides?: number }
  | { readonly type: 'custom'; readonly shape: readonly (readonly [number, number])[]; readonly closed?: boolean }
  | { readonly type: 'rail'; readonly gauge?: number; readonly sleeperSpacing?: number }
  | { readonly type: 'fence'; readonly height?: number; readonly postSpacing?: number; readonly rails?: number }
  | { readonly type: 'wire'; readonly poleHeight?: number; readonly poleSpacing?: number; readonly sag?: number; readonly wires?: number };

export interface SplineFile {
  readonly name: string;
  /** 至少两个点。 */
  readonly points: readonly SplinePointFile[];
  /** 首尾相连（环路、围一圈的围栏）。 */
  readonly closed?: boolean;
  /** 路网里更多的路径（见文件开头的"路网"）。 */
  readonly branches?: readonly SplineBranchFile[];
  readonly profile: SplineProfileFile;
  /** 沿路径取截面的间距（米），默认 2：越小弯道越圆，三角形越多。 */
  readonly resolution?: number;
  /** 材质槽（内容路径；null 是默认材质），顺序见 SplineProfileFile。 */
  readonly materials: readonly (string | null)[];
}

/** 路网里的一条路径：至少两个点。 */
export interface SplineBranchFile {
  readonly points: readonly SplinePointFile[];
  readonly closed?: boolean;
}

/** 每种横截面的材质槽个数。 */
export const SPLINE_SLOTS: Readonly<Record<SplineProfileFile['type'], number>> = { road: 1, tube: 1, custom: 1, rail: 2, fence: 2, wire: 2 };
