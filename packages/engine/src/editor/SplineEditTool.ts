/**
 * 视口里编辑样条（.spline.json）控制点的纯函数部分：点选控制点、双击路径加点、删点、从一个点拉出分支、操纵器拖的结果落到选中的
 * 点上。EditorViewport 的样条编辑模式调这些，画路径和控制点、处理鼠标；编辑器存文件，后端重新烘模型，贴着它的地形跟着重算。
 *
 * 控制点按"扁平的下标"说：先是文件的 points，再是各个分支的点（splinePointList）。位置相同的点焊在一起（路网的路口、分支的
 * 起点，见 splineFormat.ts），拖、删的时候一起动。坐标同多边形编辑（PolyEditTool）：控制点是实体的本地坐标，画和点选用世界
 * 坐标，操纵器的结果换回本地再写进文件。
 */
import type { SplineBranchFile, SplineFile, SplinePointFile } from '../content/splineFormat';
import type { MatrixSource } from '../data/Matrix';
import { sampleSpline, splinePaths, splinePoint, splineWeldKey } from '../modeling/spline';
import { closestOnSegment, POLY_PICK_PIXELS, transformPoints } from './PolyEditTool';
import type { GizmoChange } from './TransformGizmo';

/** 正在编辑的样条：哪个实体（场景文件的 id）上的模型、它的 .spline.json，样条（拖的时候每帧换）和选中的控制点（扁平的下标）。 */
export interface SplineEditSession {
  readonly entity: string;
  /** 样条的内容路径（烘成同名的模型）。 */
  readonly path: string;
  spline: SplineFile;
  selection: readonly number[];
}

/** 全部控制点，按扁平的下标排：第几条路径（0 是文件的 points，1 起是分支）、路径里的第几个、点本身。 */
export function splinePointList(file: SplineFile): { readonly path: number; readonly index: number; readonly point: SplinePointFile }[] {
  return splinePaths(file).flatMap((path, p) => path.points.map((point, index) => ({ path: p, index, point })));
}

/** 和这些点焊在一起的全部点（扁平的下标，含它们自己）。 */
export function weldedPoints(file: SplineFile, indices: readonly number[]): number[] {
  const list = splinePointList(file);
  const keys = new Set(indices.map((i) => splineWeldKey(list[i]!.point.position)));
  return list.flatMap((entry, i) => (keys.has(splineWeldKey(entry.point.position)) ? [i] : []));
}

/** 路径上离 pixel 最近、在 radius 像素以内的地方：第几条路径、第几段（控制点 segment 到下一个之间）和段内的参数 u。 */
export function pickSplineCurve(
  projected: readonly (readonly (readonly (readonly [number, number] | undefined)[])[])[], pixel: readonly [number, number], radius = POLY_PICK_PIXELS,
): { readonly path: number; readonly segment: number; readonly u: number } | undefined {
  let best: { path: number; segment: number; u: number; distance: number } | undefined;
  projected.forEach((segments, path) => segments.forEach((points, segment) => {
    const parts = points.length - 1;
    for (let k = 0; k < parts; k++) {
      const a = points[k], b = points[k + 1];
      if (!a || !b) continue;
      const { distance, t } = closestOnSegment(pixel, a, b);
      if (distance <= radius && (!best || distance < best.distance)) best = { path, segment, u: (k + t) / parts, distance };
    }
  }));
  return best && { path: best.path, segment: best.segment, u: best.u };
}

/**
 * 在第 path 条路径第 segment 段的 u 处加一个控制点（位置在路径上，路形不变；侧倾、宽度按两头插值）；返回新的样条和新点的
 * 扁平下标。
 */
export function insertSplinePoint(file: SplineFile, path: number, segment: number, u: number, digits = 3): { readonly spline: SplineFile; readonly index: number } {
  const paths = splinePaths(file), target = paths[path]!, n = target.points.length;
  const a = target.points[segment]!, b = target.points[(segment + 1) % n]!;
  const round = (value: number) => Math.round(value * 10 ** digits) / 10 ** digits;
  const point: { -readonly [K in keyof SplinePointFile]: SplinePointFile[K] } = {
    position: splinePoint(target.points, target.closed === true, segment, u).map(round) as [number, number, number],
  };
  if (a.tilt !== undefined || b.tilt !== undefined) point.tilt = round((a.tilt ?? 0) + ((b.tilt ?? 0) - (a.tilt ?? 0)) * u);
  if (a.width !== undefined || b.width !== undefined) point.width = round((a.width ?? 1) + ((b.width ?? 1) - (a.width ?? 1)) * u);
  const at = segment + 1;
  paths[path] = { ...target, points: [...target.points.slice(0, at), point, ...target.points.slice(at)] };
  return { spline: withPaths(file, paths), index: paths.slice(0, path).reduce((sum, p) => sum + p.points.length, 0) + at };
}

/** 删掉这些控制点（连同焊在一起的）；分支剩不到两个点时整条去掉，文件的 points 剩不到两个时抛错（样条至少两个点）。 */
export function deleteSplinePoints(file: SplineFile, indices: readonly number[]): SplineFile {
  const removing = new Set(weldedPoints(file, indices));
  let flat = 0;
  const paths = splinePaths(file).map((path) => ({ ...path, points: path.points.filter(() => !removing.has(flat++)) }));
  if (paths[0]!.points.length < 2) throw new Error('a spline needs at least 2 points');
  return withPaths(file, [paths[0]!, ...paths.slice(1).filter((path) => path.points.length >= 2)]);
}

/**
 * 从第 index 个控制点拉出一条分支：新分支从这个点（焊在一起）水平地往路径的右边（right 为负时左边）伸出 length 米；返回新的
 * 样条和分支末端的扁平下标（编辑器选中它，接着拖）。
 */
export function branchFromPoint(file: SplineFile, index: number, length = 20, side: 1 | -1 = 1): { readonly spline: SplineFile; readonly index: number } {
  const list = splinePointList(file), entry = list[index]!;
  const path = splinePaths(file)[entry.path]!;
  // 这个点处路径的水平切线：按这一条路径采样，找离它最近的截面
  const frames = sampleSpline(path.points, path.closed === true, 1);
  const [x, y, z] = entry.point.position;
  const nearest = frames.reduce((best, frame) => (Math.hypot(frame.position[0] - x, frame.position[2] - z) < Math.hypot(best.position[0] - x, best.position[2] - z) ? frame : best));
  const right = [nearest.right[0], nearest.right[2]], l = Math.hypot(right[0]!, right[1]!) || 1;
  const end: [number, number, number] = [x + (right[0]! / l) * length * side, y, z + (right[1]! / l) * length * side];
  const branch: SplineBranchFile = { points: [{ position: [x, y, z] }, { position: end.map((c) => Math.round(c * 1000) / 1000) as [number, number, number] }] };
  return { spline: { ...file, branches: [...(file.branches ?? []), branch] }, index: list.length + 1 };
}

/** 操纵器拖的结果落到选中的控制点（和焊在一起的）上（从拖之前的样条算，见 transformPoints）；没动的点原样。 */
export function moveSplinePoints(
  start: SplineFile, indices: readonly number[], change: GizmoChange,
  pivot: Readonly<{ x: number; y: number; z: number }>, orientation: Readonly<{ x: number; y: number; z: number; w: number }>, world: MatrixSource,
): SplineFile {
  const list = splinePointList(start);
  const moved = transformPoints(list.map((entry) => entry.point.position), weldedPoints(start, indices), change, pivot, orientation, world, 3);
  let flat = 0;
  return withPaths(start, splinePaths(start).map((path) => ({
    ...path,
    points: path.points.map((point) => {
      const position = moved[flat++]!;
      return position === point.position ? point : { ...point, position };
    }),
  })));
}

/** 换掉全部路径（第一条回到 points、closed，后面的是 branches；没有分支时不写 branches）。 */
function withPaths(file: SplineFile, paths: readonly SplineBranchFile[]): SplineFile {
  const [main, ...branches] = paths;
  const { branches: _, ...rest } = file;
  return { ...rest, points: main!.points, ...(branches.length > 0 ? { branches } : {}) };
}
