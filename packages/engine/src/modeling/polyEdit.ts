/**
 * 多边形网格的编辑操作（照 ProBuilder、Blender 的网格编辑）：挤出、内插、倒角、合并、切割（边上加点、面里连两个点、环切）、移动、删面、
 * 翻面。都是纯函数：输入网格和选中的东西，返回新网格和操作之后选中的东西（挤出后选中挤出的面，切割后选中新的边……），没有
 * 副作用；编辑器的视口工具（人）和 MCP 的 edit_poly（agent）都调这些。参数不对时报错，消息说清楚是哪个面、哪条边。
 *
 * 元素的叫法：顶点是下标，面是下标，边是两个顶点 [a, b]（不分方向）。网格不要求封闭（开口的边只属于一个面）。
 */
import type { PolyFaceFile, PolyMeshFile, Vec3Tuple } from '../content/formats/assetFormat.ts';
import { faceCenter, faceNormalRaw } from './polyMesh.ts';
import { faceLoop } from './polyLoops.ts';
import { projectFacesUv, resetFacesUv, transformFacesUv } from './polyUv.ts';

export type PolyEdge = readonly [number, number];

/** 操作的结果：新网格，和操作后该选中的面、边、顶点（没有的是空数组）。 */
export interface PolyEditResult {
  readonly mesh: PolyMeshFile;
  readonly faces: readonly number[];
  readonly edges: readonly PolyEdge[];
  readonly vertices: readonly number[];
}

const result = (mesh: PolyMeshFile, selection: Partial<Omit<PolyEditResult, 'mesh'>> = {}): PolyEditResult => ({ faces: [], edges: [], vertices: [], ...selection, mesh });

/** 一个立方体（边长 size，中心在原点）：新建多边形网格时的起点。 */
export function polyCube(name: string, size = 1): PolyMeshFile {
  const h = size / 2;
  const vertices: Vec3Tuple[] = [[-h, -h, -h], [h, -h, -h], [h, h, -h], [-h, h, -h], [-h, -h, h], [h, -h, h], [h, h, h], [-h, h, h]];
  const faces = [[4, 5, 6, 7], [1, 0, 3, 2], [3, 7, 6, 2], [0, 1, 5, 4], [1, 2, 6, 5], [0, 4, 7, 3]].map((v) => ({ vertices: v }));
  return { name, materials: [null], vertices, faces };
}

/** 两个顶点之间的边的键（不分方向）。 */
const edgeKey = (a: number, b: number) => (a < b ? `${a},${b}` : `${b},${a}`);

/** 每条边属于哪些面（面的下标和边在面里从第几个角开始）。 */
function edgeFaces(faces: readonly PolyFaceFile[]): Map<string, { face: number; corner: number }[]> {
  const map = new Map<string, { face: number; corner: number }[]>();
  faces.forEach((face, f) => face.vertices.forEach((a, k) => {
    const b = face.vertices[(k + 1) % face.vertices.length]!;
    const key = edgeKey(a, b);
    let list = map.get(key);
    if (!list) map.set(key, (list = []));
    list.push({ face: f, corner: k });
  }));
  return map;
}

function checkFaces(mesh: PolyMeshFile, faces: readonly number[], what: string): void {
  if (faces.length === 0) throw new Error(`${what}: select at least one face`);
  for (const f of faces) if (!Number.isInteger(f) || f < 0 || f >= mesh.faces.length) throw new Error(`${what}: there is no face ${f} (the mesh has ${mesh.faces.length})`);
}

function checkVertices(mesh: PolyMeshFile, vertices: readonly number[], what: string): void {
  for (const v of vertices) if (!Number.isInteger(v) || v < 0 || v >= mesh.vertices.length) throw new Error(`${what}: there is no vertex ${v} (the mesh has ${mesh.vertices.length})`);
}

/**
 * 去掉没有面用到的顶点、少于 3 个顶点的面和面里连着重复的顶点，重新编号；返回新网格和旧下标到新下标的表（去掉的是 -1）。
 */
export function compact(mesh: PolyMeshFile): { mesh: PolyMeshFile; vertexMap: Int32Array; faceMap: Int32Array } {
  const faceMap = new Int32Array(mesh.faces.length).fill(-1);
  const kept: PolyFaceFile[] = [];
  mesh.faces.forEach((face, f) => {
    const loop = face.vertices.filter((v, k) => v !== face.vertices[(k + 1) % face.vertices.length]);
    if (new Set(loop).size < 3) return;
    faceMap[f] = kept.length;
    kept.push(loop.length === face.vertices.length ? face : { ...face, vertices: loop });
  });
  // 顶点按原来的顺序编号（没用到的去掉），文件的差别小
  const used = new Uint8Array(mesh.vertices.length);
  for (const face of kept) for (const v of face.vertices) used[v] = 1;
  const order = [...used.keys()].filter((v) => used[v]);
  const vertexMap = new Int32Array(mesh.vertices.length).fill(-1);
  order.forEach((v, i) => (vertexMap[v] = i));
  return {
    mesh: { ...mesh, vertices: order.map((v) => mesh.vertices[v]!), faces: kept.map((face) => ({ ...face, vertices: face.vertices.map((v) => vertexMap[v]!) })) },
    vertexMap,
    faceMap,
  };
}

/** 顶点挪 delta（人拖操纵器、agent 改位置）。 */
export function moveVertices(mesh: PolyMeshFile, vertices: readonly number[], delta: Vec3Tuple): PolyEditResult {
  checkVertices(mesh, vertices, 'move');
  const moving = new Set(vertices);
  return result({ ...mesh, vertices: mesh.vertices.map((p, i) => (moving.has(i) ? [p[0] + delta[0], p[1] + delta[1], p[2] + delta[2]] as const : p)) }, { vertices });
}

/** 选中的面、边用到的所有顶点（拖面、拖边时挪的就是它们）。 */
export function selectionVertices(mesh: PolyMeshFile, selection: { faces?: readonly number[]; edges?: readonly PolyEdge[]; vertices?: readonly number[] }): number[] {
  const set = new Set(selection.vertices ?? []);
  for (const f of selection.faces ?? []) for (const v of mesh.faces[f]?.vertices ?? []) set.add(v);
  for (const [a, b] of selection.edges ?? []) set.add(a).add(b);
  return [...set];
}

/**
 * 挤出面：选中的面连成的区域整体沿法线挪 distance（每个顶点按它周围选中的面的法线平均），区域的边界上补一圈侧面。
 * 结果选中挤出去的面。distance 是负的往里压。
 */
export function extrudeFaces(mesh: PolyMeshFile, faces: readonly number[], distance: number): PolyEditResult {
  checkFaces(mesh, faces, 'extrude');
  const region = new Set(faces);
  const vertices = [...mesh.vertices] as Vec3Tuple[];
  // 每个区域里的顶点的新位置：周围选中的面的法线（按面积）平均，沿它挪
  const normalSum = new Map<number, [number, number, number]>();
  for (const f of region) {
    const n = faceNormalRaw(mesh.vertices, mesh.faces[f]!.vertices);
    for (const v of mesh.faces[f]!.vertices) {
      const sum = normalSum.get(v) ?? [0, 0, 0];
      for (let k = 0; k < 3; k++) sum[k]! += n[k]!;
      normalSum.set(v, sum);
    }
  }
  const moved = new Map<number, number>();
  for (const [v, sum] of normalSum) {
    const length = Math.hypot(...sum) || 1;
    const p = mesh.vertices[v]!;
    moved.set(v, vertices.push([p[0] + (sum[0] / length) * distance, p[1] + (sum[1] / length) * distance, p[2] + (sum[2] / length) * distance]) - 1);
  }
  const edges = edgeFaces(mesh.faces);
  const newFaces: PolyFaceFile[] = mesh.faces.map((face, f) => (region.has(f) ? { ...face, vertices: face.vertices.map((v) => moved.get(v)!) } : face));
  // 区域的边界：区域里的面的边，另一边的面不在区域里（或者没有面）
  for (const f of region) {
    const face = mesh.faces[f]!;
    face.vertices.forEach((a, k) => {
      const b = face.vertices[(k + 1) % face.vertices.length]!;
      const inside = edges.get(edgeKey(a, b))!.some((e) => e.face !== f && region.has(e.face));
      if (!inside) newFaces.push({ vertices: [a, b, moved.get(b)!, moved.get(a)!], ...(face.material !== undefined ? { material: face.material } : {}) });
    });
  }
  const { mesh: out, faceMap } = compact({ ...mesh, vertices, faces: newFaces });
  return result(out, { faces: faces.map((f) => faceMap[f]!) });
}

/**
 * 内插面：每个选中的面往里缩出一个小面（每个角往面中心挪 amount，0 到 1 是到中心的比例），原来的地方补一圈四边形。
 * 结果选中缩进去的小面（接着挤出就是常见的"内插再挤出"）。
 */
export function insetFaces(mesh: PolyMeshFile, faces: readonly number[], amount: number): PolyEditResult {
  checkFaces(mesh, faces, 'inset');
  if (!(amount > 0 && amount < 1)) throw new Error(`inset: amount is a fraction of the way to the face center, between 0 and 1 (got ${amount})`);
  const vertices = [...mesh.vertices] as Vec3Tuple[];
  const newFaces = [...mesh.faces];
  for (const f of faces) {
    const face = mesh.faces[f]!;
    const center = faceCenter(mesh.vertices, face.vertices);
    const inner = face.vertices.map((v) => {
      const p = mesh.vertices[v]!;
      return vertices.push([p[0] + (center[0] - p[0]) * amount, p[1] + (center[1] - p[1]) * amount, p[2] + (center[2] - p[2]) * amount]) - 1;
    });
    const material = face.material !== undefined ? { material: face.material } : {};
    newFaces[f] = { ...face, vertices: inner };
    face.vertices.forEach((a, k) => {
      const next = (k + 1) % face.vertices.length;
      newFaces.push({ vertices: [a, face.vertices[next]!, inner[next]!, inner[k]!], ...material });
    });
  }
  return result({ ...mesh, vertices, faces: newFaces }, { faces });
}

/**
 * 倒角一条边：两边的面各往里让出 distance，中间补一条斜面。第一版只做两头都是三个面相交的角（方块、白盒的棱）——这样角上的
 * 第三个面多一个顶点就接上了；别的情况报错。多条边一条一条倒（共用一个角的边不能一起倒）。结果选中新的斜面。
 */
export function bevelEdges(mesh: PolyMeshFile, edges: readonly PolyEdge[], distance: number): PolyEditResult {
  if (edges.length === 0) throw new Error('bevel: select at least one edge');
  if (!(distance > 0)) throw new Error(`bevel: distance must be positive (got ${distance})`);
  const corners = edges.flat();
  if (new Set(corners).size !== corners.length) throw new Error('bevel: edges that share a corner bevel one at a time');
  let current = mesh;
  const bevels: number[] = [];
  for (const [a, b] of edges) {
    const step = bevelEdge(current, a, b, distance);
    current = step.mesh;
    bevels.push(step.face);
  }
  return result(current, { faces: bevels });
}

function bevelEdge(mesh: PolyMeshFile, a: number, b: number, distance: number): { mesh: PolyMeshFile; face: number } {
  checkVertices(mesh, [a, b], 'bevel');
  const owners = edgeFaces(mesh.faces).get(edgeKey(a, b));
  if (!owners || owners.length !== 2) throw new Error(`bevel: edge ${a}-${b} needs a face on each side (it has ${owners?.length ?? 0})`);
  // f1 里是 a → b，f2 里是 b → a
  const [first, second] = owners;
  const f1 = mesh.faces[first!.face]!.vertices[first!.corner] === a ? first!.face : second!.face;
  const f2 = f1 === first!.face ? second!.face : first!.face;
  const vertices = [...mesh.vertices] as Vec3Tuple[];
  const faces = mesh.faces.map((face) => ({ ...face, vertices: [...face.vertices] }));
  const along = (from: number, to: number) => {
    const p = mesh.vertices[from]!, q = mesh.vertices[to]!;
    const d = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
    const length = Math.hypot(d[0]!, d[1]!, d[2]!);
    if (distance >= length) throw new Error(`bevel: distance ${distance} is longer than the edge ${from}-${to} next to it (${length.toFixed(3)})`);
    return vertices.push([p[0] + (d[0]! / length) * distance, p[1] + (d[1]! / length) * distance, p[2] + (d[2]! / length) * distance]) - 1;
  };
  // 一个角 v（另一头是 w）拆成两个：f1 上沿 f1 的另一条边让出去，f2 上沿 f2 的另一条边让出去；第三个面里 v 换成这两个
  const split = (v: number, w: number): [number, number] => {
    const around = mesh.faces.flatMap((face, f) => (face.vertices.includes(v) ? [f] : []));
    if (around.length !== 3) throw new Error(`bevel: corner ${v} has ${around.length} faces; only corners where three faces meet can be beveled`);
    const other = (f: number) => {
      const loop = mesh.faces[f]!.vertices, k = loop.indexOf(v);
      const prev = loop[(k + loop.length - 1) % loop.length]!, next = loop[(k + 1) % loop.length]!;
      return prev === w ? next : prev;
    };
    const p1 = other(f1), p2 = other(f2);
    const v1 = along(v, p1), v2 = along(v, p2);
    faces[f1]!.vertices[faces[f1]!.vertices.indexOf(v)] = v1;
    faces[f2]!.vertices[faces[f2]!.vertices.indexOf(v)] = v2;
    const third = around.find((f) => f !== f1 && f !== f2)!;
    const loop = faces[third]!.vertices, k = loop.indexOf(v);
    // 第三个面里 v 的前一个是 p1 时，接着是 v1 再 v2（顺着面的方向）
    loop.splice(k, 1, ...(loop[(k + loop.length - 1) % loop.length] === p1 ? [v1, v2] : [v2, v1]));
    return [v1, v2];
  };
  const [a1, a2] = split(a, b);
  const [b1, b2] = split(b, a);
  const material = mesh.faces[f1]!.material !== undefined ? { material: mesh.faces[f1]!.material } : {};
  faces.push({ vertices: [b1, a1, a2, b2], ...material });
  const { mesh: out, faceMap } = compact({ ...mesh, vertices, faces });
  return { mesh: out, face: faceMap[faces.length - 1]! };
}

/** 合并顶点：都挪到它们的中心、合成一个；挤扁了的面（少于 3 个不同的顶点）去掉。结果选中合成的那个顶点。 */
export function mergeVertices(mesh: PolyMeshFile, vertices: readonly number[]): PolyEditResult {
  checkVertices(mesh, vertices, 'merge');
  if (new Set(vertices).size < 2) throw new Error('merge: select at least two vertices');
  const [keep] = vertices;
  const center = [0, 1, 2].map((k) => vertices.reduce((sum, v) => sum + mesh.vertices[v]![k]!, 0) / vertices.length) as unknown as Vec3Tuple;
  const merged = new Set(vertices);
  const moved = mesh.vertices.map((p, i) => (i === keep ? center : p));
  const faces = mesh.faces.map((face) => ({ ...face, vertices: face.vertices.map((v) => (merged.has(v) ? keep! : v)) }));
  const { mesh: out, vertexMap } = compact({ ...mesh, vertices: moved, faces });
  return result(out, { vertices: vertexMap[keep!]! >= 0 ? [vertexMap[keep!]!] : [] });
}

/** 切割 1：在边上 t（0 到 1，从 a 量）处加一个顶点，两边的面都插上它。结果选中新顶点。 */
export function splitEdge(mesh: PolyMeshFile, [a, b]: PolyEdge, t = 0.5): PolyEditResult {
  checkVertices(mesh, [a, b], 'split');
  if (!(t > 0 && t < 1)) throw new Error(`split: t is where on the edge, between 0 and 1 (got ${t})`);
  const owners = edgeFaces(mesh.faces).get(edgeKey(a, b));
  if (!owners) throw new Error(`split: ${a}-${b} is not an edge`);
  const p = mesh.vertices[a]!, q = mesh.vertices[b]!;
  const vertices = [...mesh.vertices, [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t] as const];
  const m = vertices.length - 1;
  const faces = mesh.faces.map((face, f) => {
    const at = owners.find((o) => o.face === f);
    if (!at) return face;
    const loop = [...face.vertices];
    loop.splice(at.corner + 1, 0, m);
    return { ...face, vertices: loop };
  });
  return result({ ...mesh, vertices, faces }, { vertices: [m] });
}

/** 切割 2：在一个面里连两个顶点（不相邻），把面分成两个。结果选中新的边。 */
export function connectVertices(mesh: PolyMeshFile, face: number, a: number, b: number): PolyEditResult {
  checkFaces(mesh, [face], 'connect');
  const loop = mesh.faces[face]!.vertices;
  const i = loop.indexOf(a), j = loop.indexOf(b);
  if (i < 0 || j < 0) throw new Error(`connect: vertices ${a} and ${b} must both be on face ${face}`);
  const n = loop.length;
  if (i === j || (i + 1) % n === j || (j + 1) % n === i) throw new Error(`connect: vertices ${a} and ${b} are already joined by an edge`);
  const walk = (from: number, to: number) => {
    const out: number[] = [];
    for (let k = from; ; k = (k + 1) % n) {
      out.push(loop[k]!);
      if (k === to) return out;
    }
  };
  const base = mesh.faces[face]!;
  const faces = [...mesh.faces];
  faces[face] = { ...base, vertices: walk(i, j) };
  faces.push({ ...base, vertices: walk(j, i) });
  return result({ ...mesh, faces }, { edges: [[a, b]] });
}

/**
 * 环切（Blender 的 Loop Cut）：沿穿过 edge 的那一圈四边形（modeling/polyLoops.ts 的面环，两边都走）从中间切一刀——每条被穿过的边
 * （"横档"）按同一个方向在 t 处加一个顶点（splitEdge，隔壁的面也插上，没有 T 形接缝），每个四边形里把两头的新顶点连起来
 * （connectVertices）。edge 两边都不是四边形时报错。结果选中新的那圈边。
 */
export function loopCut(mesh: PolyMeshFile, edge: PolyEdge, t = 0.5): PolyEditResult {
  checkVertices(mesh, edge, 'loopCut');
  if (!(t > 0 && t < 1)) throw new Error(`loopCut: t is where across the faces, between 0 and 1 (got ${t})`);
  const owners = edgeFaces(mesh.faces).get(edgeKey(edge[0], edge[1]));
  if (!owners) throw new Error(`loopCut: ${edge[0]}-${edge[1]} is not an edge`);
  const quad = owners.map((o) => o.face).find((f) => mesh.faces[f]!.vertices.length === 4);
  if (quad === undefined) throw new Error(`loopCut: edge ${edge[0]}-${edge[1]} has no four-sided face to cut across`);
  const ring = faceLoop(mesh, quad, edge);
  // 每个面的两条横档，方向一致：在面里从横档的起点沿侧边走到的那个点是对边横档的起点
  const across = (face: number, start: number, end: number): readonly [number, number] => {
    const v = mesh.faces[face]!.vertices, k = v.indexOf(start);
    // 横档顺着面的顶点顺序是 (start, end) 时，start 的另一个邻居是 v[k + 3]，对边是 (v[k + 3], v[k + 2])；反过来时是 (v[k + 1], v[k + 2])
    return v[(k + 1) % 4] === end ? [v[(k + 3) % 4]!, v[(k + 2) % 4]!] : [v[(k + 1) % 4]!, v[(k + 2) % 4]!];
  };
  const shared = (f: number, g: number): readonly [number, number] => {
    const v = mesh.faces[f]!.vertices, other = new Set(mesh.faces[g]!.vertices);
    for (let k = 0; k < 4; k++) if (other.has(v[k]!) && other.has(v[(k + 1) % 4]!)) return [v[k]!, v[(k + 1) % 4]!];
    throw new Error(`loopCut: faces ${f} and ${g} of the ring share no edge`);
  };
  // 从环的第一个面进去的那条横档（不和第二个面共的那条）
  let entry: readonly [number, number] = ring.length > 1 ? across(ring[0]!, ...shared(ring[0]!, ring[1]!)) : edge;
  const rungs: (readonly [number, number])[] = [];
  const perFace: (readonly [string, string])[] = [];
  const seen = new Set<string>();
  for (const face of ring) {
    const exit = across(face, entry[0], entry[1]);
    for (const rung of [entry, exit]) {
      const key = edgeKey(rung[0], rung[1]);
      if (!seen.has(key)) {
        seen.add(key);
        rungs.push(rung);
      }
    }
    perFace.push([edgeKey(entry[0], entry[1]), edgeKey(exit[0], exit[1])]);
    entry = exit;
  }
  let current = mesh;
  const cut = new Map<string, number>();
  for (const [start, end] of rungs) {
    const split = splitEdge(current, [start, end], t);
    current = split.mesh;
    cut.set(edgeKey(start, end), split.vertices[0]!);
  }
  const edges: PolyEdge[] = [];
  ring.forEach((face, i) => {
    const a = cut.get(perFace[i]![0])!, b = cut.get(perFace[i]![1])!;
    current = connectVertices(current, face, a, b).mesh;
    edges.push([a, b]);
  });
  return result(current, { edges });
}

/** 删面（用不到的顶点一起去掉）。 */
export function deleteFaces(mesh: PolyMeshFile, faces: readonly number[]): PolyEditResult {
  checkFaces(mesh, faces, 'delete');
  const removed = new Set(faces);
  return result(compact({ ...mesh, faces: mesh.faces.filter((_, f) => !removed.has(f)) }).mesh);
}

/** 翻面：顶点顺序倒过来，法线朝另一边。 */
export function flipFaces(mesh: PolyMeshFile, faces: readonly number[]): PolyEditResult {
  checkFaces(mesh, faces, 'flip');
  const flipped = new Set(faces);
  return result({ ...mesh, faces: mesh.faces.map((face, f) => (flipped.has(f) ? { ...face, vertices: [...face.vertices].reverse(), ...(face.uvs ? { uvs: [...face.uvs].reverse() } : {}) } : face)) }, { faces });
}

/** 给选中的面换材质槽。 */
export function setFaceMaterial(mesh: PolyMeshFile, faces: readonly number[], material: number): PolyEditResult {
  checkFaces(mesh, faces, 'material');
  const slots = Math.max(1, mesh.materials.length);
  if (!Number.isInteger(material) || material < 0 || material >= slots) throw new Error(`material: slot ${material} does not exist (there ${slots === 1 ? 'is 1 slot' : `are ${slots} slots`})`);
  const chosen = new Set(faces);
  return result({ ...mesh, faces: mesh.faces.map((face, f) => (chosen.has(f) ? { ...face, material } : face)) }, { faces });
}

/** 按名字调的操作（MCP 的 edit_poly、编辑器视口的工具条都用这个形状）。 */
export type PolyOperation =
  | { readonly op: 'extrude'; readonly faces: readonly number[]; readonly distance: number }
  | { readonly op: 'inset'; readonly faces: readonly number[]; readonly amount: number }
  | { readonly op: 'bevel'; readonly edges: readonly PolyEdge[]; readonly distance: number }
  | { readonly op: 'merge'; readonly vertices: readonly number[] }
  | { readonly op: 'split'; readonly edge: PolyEdge; readonly t?: number }
  | { readonly op: 'connect'; readonly face: number; readonly a: number; readonly b: number }
  | { readonly op: 'loopCut'; readonly edge: PolyEdge; readonly t?: number }
  | { readonly op: 'uvProject'; readonly faces: readonly number[]; readonly uvScale?: number }
  | { readonly op: 'uvTransform'; readonly faces: readonly number[]; readonly offset?: readonly [number, number]; readonly scale?: number | readonly [number, number]; readonly rotation?: number }
  | { readonly op: 'uvReset'; readonly faces: readonly number[] }
  | { readonly op: 'move'; readonly delta: Vec3Tuple; readonly vertices?: readonly number[]; readonly faces?: readonly number[]; readonly edges?: readonly PolyEdge[] }
  | { readonly op: 'delete'; readonly faces: readonly number[] }
  | { readonly op: 'flip'; readonly faces: readonly number[] }
  | { readonly op: 'material'; readonly faces: readonly number[]; readonly material: number };

export const POLY_OPERATIONS = ['extrude', 'inset', 'bevel', 'merge', 'split', 'connect', 'loopCut', 'move', 'delete', 'flip', 'material', 'uvProject', 'uvTransform', 'uvReset'] as const;

export function applyPolyOperation(mesh: PolyMeshFile, operation: PolyOperation): PolyEditResult {
  switch (operation.op) {
    case 'extrude': return extrudeFaces(mesh, operation.faces, operation.distance);
    case 'inset': return insetFaces(mesh, operation.faces, operation.amount);
    case 'bevel': return bevelEdges(mesh, operation.edges, operation.distance);
    case 'merge': return mergeVertices(mesh, operation.vertices);
    case 'split': return splitEdge(mesh, operation.edge, operation.t);
    case 'connect': return connectVertices(mesh, operation.face, operation.a, operation.b);
    case 'loopCut': return loopCut(mesh, operation.edge, operation.t);
    case 'uvProject': return result(projectFacesUv(mesh, operation.faces, operation.uvScale), { faces: operation.faces });
    case 'uvTransform': return result(transformFacesUv(mesh, operation.faces, operation), { faces: operation.faces });
    case 'uvReset': return result(resetFacesUv(mesh, operation.faces), { faces: operation.faces });
    case 'move': {
      const vertices = selectionVertices(mesh, operation);
      const moved = moveVertices(mesh, vertices, operation.delta);
      return { ...moved, faces: operation.faces ?? [], edges: operation.edges ?? [], vertices: operation.vertices ?? [] };
    }
    case 'delete': return deleteFaces(mesh, operation.faces);
    case 'flip': return flipFaces(mesh, operation.faces);
    case 'material': return setFaceMaterial(mesh, operation.faces, operation.material);
  }
}
