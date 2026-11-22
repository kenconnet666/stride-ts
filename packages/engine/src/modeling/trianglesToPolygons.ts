/**
 * 三角网格转成多边形网格（白盒导出成可编辑的多边形网格用：`.brush.json` 烘出的三角形 → `.poly.json`）：位置相同的顶点焊在一起，
 * 同一平面、同一组（材质槽）、靠共用的边连在一起的三角形合成一个面。合成的那组只有一圈边界时是一个 n 边形（边界上和前后两点
 * 共线的点去掉）；有洞的（地板上立着东西，多边形网格的面不能带洞）切成几块不带洞的简单多边形（diskPieces），切不成的才留成三角形。
 */
import type { PolyFaceFile } from '../content/formats/assetFormat.ts';

export interface PolygonMesh {
  readonly vertices: [number, number, number][];
  readonly faces: PolyFaceFile[];
}

/**
 * positions 是 xyz，indices 每三个一个三角形（从外面看逆时针），group(t) 是第 t 个三角形属于哪一组（材质槽）。tolerance 是
 * 焊接、判断共面的容差（米）。
 */
export function trianglesToPolygons(positions: ArrayLike<number>, indices: ArrayLike<number>, group: (triangle: number) => number, tolerance = 1e-5): PolygonMesh {
  // 焊接顶点
  const vertices: [number, number, number][] = [];
  const weld = new Map<string, number>();
  const remap: number[] = [];
  for (let i = 0; i < positions.length / 3; i++) {
    const p: [number, number, number] = [positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!];
    const key = p.map((v) => Math.round(v / tolerance)).join(',');
    let index = weld.get(key);
    if (index === undefined) {
      index = vertices.length;
      weld.set(key, index);
      vertices.push(p);
    }
    remap.push(index);
  }
  // 每个三角形的焊接后的顶点、法线、平面（法线加到原点的距离）；退化的扔掉
  type Triangle = { v: [number, number, number]; normal: [number, number, number]; d: number; group: number };
  const triangles: (Triangle | undefined)[] = [];
  for (let t = 0; t < indices.length / 3; t++) {
    const v = [remap[indices[t * 3]!]!, remap[indices[t * 3 + 1]!]!, remap[indices[t * 3 + 2]!]!] as [number, number, number];
    if (v[0] === v[1] || v[1] === v[2] || v[0] === v[2]) {
      triangles.push(undefined);
      continue;
    }
    const a = vertices[v[0]]!, b = vertices[v[1]]!, c = vertices[v[2]]!;
    const u = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!], w = [c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!];
    const n = [u[1]! * w[2]! - u[2]! * w[1]!, u[2]! * w[0]! - u[0]! * w[2]!, u[0]! * w[1]! - u[1]! * w[0]!];
    const l = Math.hypot(n[0]!, n[1]!, n[2]!);
    if (l < 1e-12) {
      triangles.push(undefined);
      continue;
    }
    const normal = [n[0]! / l, n[1]! / l, n[2]! / l] as [number, number, number];
    triangles.push({ v, normal, d: normal[0] * a[0]! + normal[1] * a[1]! + normal[2] * a[2]!, group: group(t) });
  }
  // 边 → 用它的三角形（有向边 a→b 存在三角形里；相邻的三角形用的是 b→a）
  const edgeOwner = new Map<string, number>();
  triangles.forEach((tri, t) => {
    if (!tri) return;
    for (let k = 0; k < 3; k++) edgeOwner.set(`${tri.v[k]}>${tri.v[(k + 1) % 3]}`, t);
  });
  const coplanar = (a: Triangle, b: Triangle) => a.group === b.group && a.normal[0] * b.normal[0] + a.normal[1] * b.normal[1] + a.normal[2] * b.normal[2] > 1 - 1e-6 && Math.abs(a.d - b.d) < tolerance * 10;
  // 按共用的边、共面连成一块块
  const region = new Array<number>(triangles.length).fill(-1);
  const regions: number[][] = [];
  triangles.forEach((tri, start) => {
    if (!tri || region[start]! >= 0) return;
    const members: number[] = [];
    const stack = [start];
    region[start] = regions.length;
    while (stack.length > 0) {
      const t = stack.pop()!, current = triangles[t]!;
      members.push(t);
      for (let k = 0; k < 3; k++) {
        const neighbor = edgeOwner.get(`${current.v[(k + 1) % 3]}>${current.v[k]}`);
        if (neighbor === undefined || region[neighbor]! >= 0) continue;
        const other = triangles[neighbor]!;
        if (!coplanar(current, other)) continue;
        region[neighbor] = regions.length;
        stack.push(neighbor);
      }
    }
    regions.push(members);
  });
  const faces: PolyFaceFile[] = [];
  for (const members of regions) {
    const first = triangles[members[0]!]!;
    const material = first.group === 0 ? {} : { material: first.group };
    const corners = members.map((t) => triangles[t]!.v);
    // 一圈边界的整块是一个面；有洞的切成几块不带洞的，每块一个面
    const pieces = boundaryLoop(corners) ? [corners] : diskPieces(corners);
    for (const piece of pieces) {
      const loop = boundaryLoop(piece);
      const cleaned = loop ? dropCollinear(loop, vertices) : [];
      if (cleaned.length >= 3) faces.push({ vertices: cleaned, ...material });
      else for (const v of piece) faces.push({ vertices: [...v], ...material });
    }
  }
  // 没用到的顶点（被合并掉的边界中间点）去掉、重新编号
  const used = new Map<number, number>();
  const compact: [number, number, number][] = [];
  const renumbered = faces.map((face) => ({
    ...face,
    vertices: face.vertices.map((v) => {
      let index = used.get(v);
      if (index === undefined) {
        index = compact.length;
        used.set(v, index);
        compact.push(vertices[v]!);
      }
      return index;
    }),
  }));
  return { vertices: compact, faces: renumbered };
}

/** 一组三角形的边界：只出现一次的有向边连成的圈；正好一圈时按方向返回顶点，否则（有洞、几圈、不是流形）undefined。 */
function boundaryLoop(triangles: readonly (readonly [number, number, number])[]): number[] | undefined {
  const edges = new Set<string>();
  for (const v of triangles) for (let k = 0; k < 3; k++) edges.add(`${v[k]}>${v[(k + 1) % 3]}`);
  const next = new Map<number, number>();
  for (const v of triangles) {
    for (let k = 0; k < 3; k++) {
      const a = v[k]!, b = v[(k + 1) % 3]!;
      if (edges.has(`${b}>${a}`)) continue;
      if (next.has(a)) return undefined;
      next.set(a, b);
    }
  }
  if (next.size < 3) return undefined;
  const start = next.keys().next().value!;
  const loop = [start];
  for (let v = next.get(start)!; v !== start; v = next.get(v)!) {
    if (v === undefined || loop.length > next.size) return undefined;
    loop.push(v);
  }
  return loop.length === next.size ? loop : undefined;
}

/**
 * 把一块（有洞的）三角形分成几块不带洞的：每块从一个三角形按广度优先长起，只接受贴着它的边、又不会让边界碰到自己的三角形
 * （新三角形不贴着的那个顶点不能已经在这块上：不然会围出洞或者在一个点上掐住），长不动了另起一块。每块的边界是一圈，是简单多边形。
 * 一个洞通常多切出一块（绕洞一圈长到快合上时停下，剩下的是另一块）。
 */
function diskPieces(triangles: readonly (readonly [number, number, number])[]): (readonly [number, number, number])[][] {
  const owner = new Map<string, number>();
  triangles.forEach((v, t) => {
    for (let k = 0; k < 3; k++) owner.set(`${v[k]}>${v[(k + 1) % 3]}`, t);
  });
  const piece = new Array<number>(triangles.length).fill(-1);
  const pieces: (readonly [number, number, number])[][] = [];
  triangles.forEach((_, start) => {
    if (piece[start]! >= 0) return;
    const id = pieces.length;
    const members = [triangles[start]!];
    const inPiece = new Set<number>(triangles[start]);
    piece[start] = id;
    const queue = [start];
    while (queue.length > 0) {
      const t = queue.shift()!, v = triangles[t]!;
      for (let k = 0; k < 3; k++) {
        const n = owner.get(`${v[(k + 1) % 3]}>${v[k]}`);
        if (n === undefined || piece[n]! >= 0) continue;
        const w = triangles[n]!;
        // n 和这块共用的边上的顶点
        const onShared = new Set<number>();
        for (let j = 0; j < 3; j++) {
          const a = w[j]!, b = w[(j + 1) % 3]!, other = owner.get(`${b}>${a}`);
          if (other !== undefined && piece[other] === id) onShared.add(a).add(b);
        }
        if (w.some((x) => !onShared.has(x) && inPiece.has(x))) continue;
        piece[n] = id;
        members.push(w);
        for (const x of w) inPiece.add(x);
        queue.push(n);
      }
    }
    pieces.push(members);
  });
  return pieces;
}

/** 去掉和前后两点共线的点（布尔运算在边上留下的点）。 */
function dropCollinear(loop: readonly number[], vertices: readonly (readonly number[])[]): number[] {
  return loop.filter((v, i) => {
    const a = vertices[loop[(i + loop.length - 1) % loop.length]!]!, b = vertices[v]!, c = vertices[loop[(i + 1) % loop.length]!]!;
    const u = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!], w = [c[0]! - b[0]!, c[1]! - b[1]!, c[2]! - b[2]!];
    const cross = Math.hypot(u[1]! * w[2]! - u[2]! * w[1]!, u[2]! * w[0]! - u[0]! * w[2]!, u[0]! * w[1]! - u[1]! * w[0]!);
    return cross > 1e-9 * Math.hypot(...u) * Math.hypot(...w) + 1e-12;
  });
}
