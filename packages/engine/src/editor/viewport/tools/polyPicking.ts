/**
 * 视口里编辑多边形网格（.poly.json）的纯函数部分（照 Blender 的编辑模式、ProBuilder）：点、边、面三种选择模式，点到哪个顶点、
 * 哪条边、哪个面，选择的增减，操纵器拖的结果落到选中的顶点上。视口工具 PolyEditTool 调这些，画线框、处理鼠标；
 * 编辑操作（挤出、倒角……）在 modeling/polyEdit.ts。
 *
 * 坐标：网格的顶点是模型的本地坐标，画和点选用世界坐标（乘实体的世界矩阵），操纵器的结果是世界里的变化，换回本地再写进网格。
 */
import type { PolyMeshFile, Vec3Tuple } from '../../../content/formats/assetFormat';
import { Matrix, type MatrixSource } from '../../../data/Matrix';
import { Quaternion, Vector3 } from '../../../data/vectors';
import type { PolyEdge } from '../../../modeling/polyEdit';
import { triangulateFace } from '../../../modeling/polyMesh';
import type { GizmoChange, Ray } from '../TransformGizmo';

/** 选择模式：点、边、面（键盘的 1、2、3）。 */
export type PolySelectMode = 'vertex' | 'edge' | 'face';

/** 选中的东西：只有当前模式的那一种有内容。 */
export interface PolySelection {
  readonly vertices: readonly number[];
  readonly edges: readonly PolyEdge[];
  readonly faces: readonly number[];
}

export const EMPTY_POLY_SELECTION: PolySelection = { vertices: [], edges: [], faces: [] };

/** 点在顶点、边上多少像素以内算点到。 */
export const POLY_PICK_PIXELS = 8;

/** 网格的边（每条一次，小的顶点在前），按第一次出现的顺序。 */
export function meshEdges(mesh: Pick<PolyMeshFile, 'faces'>): PolyEdge[] {
  const seen = new Set<string>();
  const edges: PolyEdge[] = [];
  for (const { vertices } of mesh.faces) {
    for (let i = 0; i < vertices.length; i++) {
      const a = vertices[i]!, b = vertices[(i + 1) % vertices.length]!;
      const edge: PolyEdge = a < b ? [a, b] : [b, a];
      const key = `${edge[0]},${edge[1]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push(edge);
    }
  }
  return edges;
}

/** 顶点在世界里的位置。 */
export function worldVertices(mesh: Pick<PolyMeshFile, 'vertices'>, world: MatrixSource): Vec3Tuple[] {
  return mesh.vertices.map(([x, y, z]) => Matrix.transformPoint(world, x, y, z) as Vec3Tuple);
}

type Pixel = readonly [number, number];

/** 离 pixel 最近、在 radius 像素以内的顶点；projected 是每个顶点在画面上的位置（看不见的是 undefined）。 */
export function pickVertex(projected: readonly (Pixel | undefined)[], pixel: Pixel, radius = POLY_PICK_PIXELS): number | undefined {
  let best: { index: number; distance: number } | undefined;
  projected.forEach((point, index) => {
    if (!point) return;
    const distance = Math.hypot(point[0] - pixel[0], point[1] - pixel[1]);
    if (distance <= radius && (!best || distance < best.distance)) best = { index, distance };
  });
  return best?.index;
}

/** 离 pixel 最近、在 radius 像素以内的边。 */
export function pickEdge(edges: readonly PolyEdge[], projected: readonly (Pixel | undefined)[], pixel: Pixel, radius = POLY_PICK_PIXELS): PolyEdge | undefined {
  let best: { edge: PolyEdge; distance: number } | undefined;
  for (const edge of edges) {
    const a = projected[edge[0]], b = projected[edge[1]];
    if (!a || !b) continue;
    const { distance } = closestOnSegment(pixel, a, b);
    if (distance <= radius && (!best || distance < best.distance)) best = { edge, distance };
  }
  return best?.edge;
}

/** 射线最先碰到的面（世界坐标的顶点；面按耳切三角化，两面都算）。 */
export function pickFace(mesh: Pick<PolyMeshFile, 'faces'>, world: readonly Vec3Tuple[], ray: Ray): number | undefined {
  let best: { face: number; distance: number } | undefined;
  mesh.faces.forEach(({ vertices }, face) => {
    // 三角化给的是面里的下标，换成顶点的下标
    const corner = (k: number) => world[vertices[k]!]!;
    const triangles = triangulateFace(world, vertices);
    for (let i = 0; i < triangles.length; i += 3) {
      const distance = rayTriangle(ray, corner(triangles[i]!), corner(triangles[i + 1]!), corner(triangles[i + 2]!));
      if (distance !== undefined && (!best || distance < best.distance)) best = { face, distance };
    }
  });
  return best?.face;
}

const sameEdge = (a: PolyEdge, b: PolyEdge) => (a[0] === b[0] && a[1] === b[1]) || (a[0] === b[1] && a[1] === b[0]);

/**
 * 点了一下之后的选择：additive（按着 Shift、Ctrl）时点到的加进来、已经选中的去掉；不按时只选它。点空处：additive 时不变，
 * 不然清空。只留当前模式的那一种。
 */
export function clickSelection(selection: PolySelection, mode: PolySelectMode, hit: number | PolyEdge | undefined, additive: boolean): PolySelection {
  if (hit === undefined) return additive ? selection : EMPTY_POLY_SELECTION;
  if (mode === 'edge') {
    const edge = hit as PolyEdge;
    const current = additive ? selection.edges : [];
    const edges = current.some((other) => sameEdge(other, edge)) ? current.filter((other) => !sameEdge(other, edge)) : [...current, edge];
    return { vertices: [], faces: [], edges };
  }
  const index = hit as number;
  const current = additive ? (mode === 'vertex' ? selection.vertices : selection.faces) : [];
  const next = current.includes(index) ? current.filter((other) => other !== index) : [...current, index];
  return mode === 'vertex' ? { vertices: next, edges: [], faces: [] } : { vertices: [], edges: [], faces: next };
}

/** 选中的顶点在世界里的中心（操纵器放在这里）；什么都没选时是 undefined。 */
export function selectionCenter(world: readonly Vec3Tuple[], vertices: readonly number[]): Vec3Tuple | undefined {
  if (vertices.length === 0) return undefined;
  const sum = [0, 0, 0];
  for (const v of vertices) for (let k = 0; k < 3; k++) sum[k]! += world[v]![k]!;
  return [sum[0]! / vertices.length, sum[1]! / vertices.length, sum[2]! / vertices.length];
}

/**
 * 操纵器拖的结果落到点上（多边形的顶点、样条的控制点；从拖之前的位置算，不累积误差）：移动是加上世界里的位移，旋转绕枢轴转，缩放沿操纵器的轴
 * （orientation）相对枢轴缩放；再换回本地坐标。返回全部的点（没选中的原样）；digits 是存进文件留几位小数。
 */
export function transformPoints(
  start: readonly Vec3Tuple[], indices: readonly number[], change: GizmoChange,
  pivot: Readonly<{ x: number; y: number; z: number }>, orientation: Readonly<{ x: number; y: number; z: number; w: number }>,
  world: MatrixSource, digits = 5,
): Vec3Tuple[] {
  // 双精度：大世界里远处的模型，世界矩阵的逆也要准
  const inverse = new Float64Array(16);
  if (!Matrix.invert(inverse, world)) throw new Error('the model has a singular world matrix; its points cannot be edited');
  const round = (value: number) => Math.round(value * 10 ** digits) / 10 ** digits;
  const axes = new Quaternion(orientation.x, orientation.y, orientation.z, orientation.w);
  const unrotate = axes.clone().invert();
  const moved = start.slice();
  for (const v of new Set(indices)) {
    const [x, y, z] = start[v]!;
    const point = new Vector3(...Matrix.transformPoint(world, x, y, z));
    if (change.type === 'translate') point.add(change.delta);
    else if (change.type === 'rotate') point.subtract(pivot).rotate(change.rotation).add(pivot);
    else {
      const local = point.subtract(pivot).rotate(unrotate);
      local.set(local.x * change.factor.x, local.y * change.factor.y, local.z * change.factor.z);
      point.copy(local.rotate(axes).add(pivot));
    }
    moved[v] = Matrix.transformPoint(inverse, point.x, point.y, point.z).map(round) as unknown as Vec3Tuple;
  }
  return moved;
}

/** 画面上点到线段最近的地方：距离（像素）和在线段上的位置 t（0..1）。 */
export function closestOnSegment(point: Pixel, a: Pixel, b: Pixel): { readonly distance: number; readonly t: number } {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const length = dx * dx + dy * dy;
  const t = length > 0 ? Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / length)) : 0;
  return { distance: Math.hypot(point[0] - (a[0] + dx * t), point[1] - (a[1] + dy * t)), t };
}

/** 射线和三角形（Möller–Trumbore，两面都算）：碰到时是射线上的距离。 */
function rayTriangle(ray: Ray, a: Vec3Tuple, b: Vec3Tuple, c: Vec3Tuple): number | undefined {
  const { origin: o, direction: d } = ray;
  const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const p = [d.y * e2[2]! - d.z * e2[1]!, d.z * e2[0]! - d.x * e2[2]!, d.x * e2[1]! - d.y * e2[0]!];
  const det = e1[0]! * p[0]! + e1[1]! * p[1]! + e1[2]! * p[2]!;
  if (Math.abs(det) < 1e-12) return undefined;
  const inv = 1 / det;
  const t = [o.x - a[0], o.y - a[1], o.z - a[2]];
  const u = (t[0]! * p[0]! + t[1]! * p[1]! + t[2]! * p[2]!) * inv;
  if (u < 0 || u > 1) return undefined;
  const q = [t[1]! * e1[2]! - t[2]! * e1[1]!, t[2]! * e1[0]! - t[0]! * e1[2]!, t[0]! * e1[1]! - t[1]! * e1[0]!];
  const v = (d.x * q[0]! + d.y * q[1]! + d.z * q[2]!) * inv;
  if (v < 0 || u + v > 1) return undefined;
  const distance = (e2[0]! * q[0]! + e2[1]! * q[1]! + e2[2]! * q[2]!) * inv;
  return distance > 0 ? distance : undefined;
}
