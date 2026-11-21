/**
 * 视口里编辑样条（.spline.json）控制点的纯函数部分：点选控制点、双击路径加点、删点、操纵器拖的结果落到选中的点上。
 * EditorViewport 的样条编辑模式调这些，画路径和控制点、处理鼠标；编辑器存文件，后端重新烘模型，贴着它的地形跟着重算。
 *
 * 坐标同多边形编辑（PolyEditTool）：控制点是实体的本地坐标，画和点选用世界坐标，操纵器的结果换回本地再写进文件。
 */
import type { SplineFile, SplinePointFile } from '../content/splineFormat';
import type { MatrixSource } from '../data/Matrix';
import { splinePoint } from '../modeling/spline';
import { closestOnSegment, POLY_PICK_PIXELS, transformPoints } from './PolyEditTool';
import type { GizmoChange } from './TransformGizmo';

/** 正在编辑的样条：哪个实体（场景文件的 id）上的模型、它的 .spline.json，样条（拖的时候每帧换）和选中的控制点。 */
export interface SplineEditSession {
  readonly entity: string;
  /** 样条的内容路径（烘成同名的模型）。 */
  readonly path: string;
  spline: SplineFile;
  selection: readonly number[];
}

/** 路径上离 pixel 最近、在 radius 像素以内的地方：第几段（控制点 segment 到下一个之间）和段内的参数 u。 */
export function pickSplineCurve(
  projected: readonly (readonly (readonly [number, number] | undefined)[])[], pixel: readonly [number, number], radius = POLY_PICK_PIXELS,
): { readonly segment: number; readonly u: number } | undefined {
  let best: { segment: number; u: number; distance: number } | undefined;
  projected.forEach((points, segment) => {
    const parts = points.length - 1;
    for (let k = 0; k < parts; k++) {
      const a = points[k], b = points[k + 1];
      if (!a || !b) continue;
      const { distance, t } = closestOnSegment(pixel, a, b);
      if (distance <= radius && (!best || distance < best.distance)) best = { segment, u: (k + t) / parts, distance };
    }
  });
  return best && { segment: best.segment, u: best.u };
}

/** 在第 segment 段的 u 处加一个控制点（位置在路径上，路形不变；侧倾、宽度按两头插值）；返回新的样条和新点的下标。 */
export function insertSplinePoint(file: SplineFile, segment: number, u: number, digits = 3): { readonly spline: SplineFile; readonly index: number } {
  const n = file.points.length, a = file.points[segment]!, b = file.points[(segment + 1) % n]!;
  const round = (value: number) => Math.round(value * 10 ** digits) / 10 ** digits;
  const point: { -readonly [K in keyof SplinePointFile]: SplinePointFile[K] } = { position: splinePoint(file.points, file.closed === true, segment, u).map(round) as [number, number, number] };
  if (a.tilt !== undefined || b.tilt !== undefined) point.tilt = round((a.tilt ?? 0) + ((b.tilt ?? 0) - (a.tilt ?? 0)) * u);
  if (a.width !== undefined || b.width !== undefined) point.width = round((a.width ?? 1) + ((b.width ?? 1) - (a.width ?? 1)) * u);
  const index = segment + 1;
  return { spline: { ...file, points: [...file.points.slice(0, index), point, ...file.points.slice(index)] }, index };
}

/** 删掉这些控制点；剩下不到两个时抛错（样条至少两个点）。 */
export function deleteSplinePoints(file: SplineFile, indices: readonly number[]): SplineFile {
  const removing = new Set(indices);
  const points = file.points.filter((_, i) => !removing.has(i));
  if (points.length < 2) throw new Error('a spline needs at least 2 points');
  return { ...file, points };
}

/** 操纵器拖的结果落到选中的控制点上（从拖之前的样条算，见 transformPoints）；没选中的点原样。 */
export function moveSplinePoints(
  start: SplineFile, indices: readonly number[], change: GizmoChange,
  pivot: Readonly<{ x: number; y: number; z: number }>, orientation: Readonly<{ x: number; y: number; z: number; w: number }>, world: MatrixSource,
): SplineFile {
  const moved = transformPoints(start.points.map((point) => point.position), indices, change, pivot, orientation, world, 3);
  return { ...start, points: start.points.map((point, i) => (moved[i] === point.position ? point : { ...point, position: moved[i]! })) };
}
