/**
 * 多边形网格（.poly.json）的环选和软选择（照 Blender 的 Select Loop、Proportional Editing）：纯函数，视口工具 PolyEditTool 用，
 * agent 也能直接调。
 *
 * - 边环（edgeLoop）：从一条边出发往两头走；走到一个顶点时，如果它连着正好四条边，下一条是不和来的那条边同在一个面上的那条
 *   （四边形网格上"一直往前"的那条）；顶点不是四条边、走到网格边上、或者绕回起点时停。
 * - 面环（faceLoop）：从一个四边形和它的一条边出发，穿过对边走到隔壁的四边形，一格一格往两头走；遇到不是四边形的面、网格边上、
 *   绕回起点时停。
 * - 软选择（softWeights）：没选中的顶点离最近的选中顶点 d 在半径 r 以内时跟着动一部分，权重 w = 3x² − 2x³、x = 1 − d/r
 *   （Blender 的 Smooth 衰减），选中的是 1。距离按直线量（Blender 默认的那种，不沿着表面）。
 */
import type { PolyMeshFile, Vec3Tuple } from '../content/formats/assetFormat.ts';
import type { PolyEdge } from './polyEdit.ts';

const key = (a: number, b: number) => (a < b ? `${a},${b}` : `${b},${a}`);

/** 边 → 用到它的面（面的下标）；顶点 → 连着的边。 */
function topology(mesh: Pick<PolyMeshFile, 'faces'>) {
  const facesOfEdge = new Map<string, number[]>();
  const edgesOfVertex = new Map<number, Set<string>>();
  const ends = new Map<string, PolyEdge>();
  mesh.faces.forEach(({ vertices }, face) => {
    for (let i = 0; i < vertices.length; i++) {
      const a = vertices[i]!, b = vertices[(i + 1) % vertices.length]!;
      const k = key(a, b);
      const list = facesOfEdge.get(k) ?? [];
      list.push(face);
      facesOfEdge.set(k, list);
      ends.set(k, a < b ? [a, b] : [b, a]);
      for (const v of [a, b]) {
        const set = edgesOfVertex.get(v) ?? new Set<string>();
        set.add(k);
        edgesOfVertex.set(v, set);
      }
    }
  });
  return { facesOfEdge, edgesOfVertex, ends };
}

/** 从 edge 出发的边环（含它自己），按走的顺序：先往 edge[1] 那头，再往 edge[0] 那头接在前面。 */
export function edgeLoop(mesh: Pick<PolyMeshFile, 'faces'>, edge: PolyEdge): PolyEdge[] {
  const { facesOfEdge, edgesOfVertex, ends } = topology(mesh);
  const start = key(edge[0], edge[1]);
  if (!facesOfEdge.has(start)) return [];
  const loop = new Set<string>([start]);
  const walk = (from: string, through: number): string[] => {
    const path: string[] = [];
    let current = from, vertex = through;
    for (;;) {
      const around = edgesOfVertex.get(vertex);
      if (!around || around.size !== 4) break;
      const faces = new Set(facesOfEdge.get(current));
      // 和来的边不共面的那条（四条里只有一条）
      const next = [...around].filter((k) => k !== current && !facesOfEdge.get(k)!.some((f) => faces.has(f)));
      if (next.length !== 1 || loop.has(next[0]!)) break;
      current = next[0]!;
      loop.add(current);
      path.push(current);
      const [a, b] = ends.get(current)!;
      vertex = a === vertex ? b : a;
    }
    return path;
  };
  const forward = walk(start, edge[1]);
  const backward = walk(start, edge[0]);
  return [...backward.reverse(), start, ...forward].map((k) => ends.get(k)!);
}

/** 从四边形 face 出发、穿过它的边 edge 的面环（含它自己），按走的顺序；face 不是四边形或者不含这条边时只有它自己。 */
export function faceLoop(mesh: Pick<PolyMeshFile, 'faces'>, face: number, edge: PolyEdge): number[] {
  const { facesOfEdge } = topology(mesh);
  const quad = (f: number) => mesh.faces[f]?.vertices.length === 4;
  const opposite = (f: number, a: number, b: number): PolyEdge | undefined => {
    const v = mesh.faces[f]!.vertices;
    const i = v.findIndex((x, k) => key(x, v[(k + 1) % 4]!) === key(a, b));
    return i < 0 ? undefined : [v[(i + 2) % 4]!, v[(i + 3) % 4]!];
  };
  if (!quad(face) || !opposite(face, edge[0], edge[1])) return [face];
  const loop = new Set<number>([face]);
  // 从 face 穿过边 [a, b] 走到隔壁，一直走
  const walk = (a: number, b: number): number[] => {
    const path: number[] = [];
    let current = face, through: PolyEdge = [a, b];
    for (;;) {
      const next = facesOfEdge.get(key(through[0], through[1]))?.find((f) => f !== current);
      if (next === undefined || loop.has(next) || !quad(next)) break;
      loop.add(next);
      path.push(next);
      const across = opposite(next, through[0], through[1]);
      if (!across) break;
      current = next;
      through = across;
    }
    return path;
  };
  const other = opposite(face, edge[0], edge[1])!;
  const forward = walk(edge[0], edge[1]);
  const backward = walk(other[0], other[1]);
  return [...backward.reverse(), face, ...forward];
}

/** 软选择的权重（见文件开头）：顶点下标 → 0..1，只含权重大于 0 的。positions 是顶点的位置（同一个坐标系，世界或本地都行）。 */
export function softWeights(positions: readonly Vec3Tuple[], selected: readonly number[], radius: number): Map<number, number> {
  const weights = new Map<number, number>();
  const chosen = new Set(selected);
  for (const v of chosen) weights.set(v, 1);
  if (!(radius > 0) || chosen.size === 0) return weights;
  positions.forEach((p, v) => {
    if (chosen.has(v)) return;
    let nearest = Infinity;
    for (const s of chosen) {
      const q = positions[s]!;
      nearest = Math.min(nearest, Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]));
    }
    if (nearest >= radius) return;
    const x = 1 - nearest / radius;
    weights.set(v, x * x * (3 - 2 * x));
  });
  return weights;
}
