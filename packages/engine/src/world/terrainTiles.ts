/**
 * 地形的分块和细节层次（纯函数，TerrainSystem 用）：地形的范围是一棵四叉树，近处的节点细分、远处的整块画；每个节点是一块
 * TILE_QUADS × TILE_QUADS 个格的网格，所以每一层的顶点间距是上一层的一半，画出来的三角形数和视野里的范围无关、和距离的对数有关。
 *
 * - 细分只在四个子块的网格都准备好了才换上（之前一直画父块），不会出现空洞；
 * - 相邻的块细节层次不同时接缝处会有小缝：每块的四边垂下一圈裙边挡住（同 Unity、Godot 的地形插件的常见做法）；
 * - 所有块共用一个网格（heightfieldGrid），高度在高度页里，整片地形一次实例化绘制；块的位置、缩放放在实体的变换里（双精度）。
 */
import { VERTEX_FLOATS } from '../content/formats/format';
import { HEIGHT_PAGE_SAMPLES } from '../rendering/mesh/HeightPages';

/** 每块每边几个格（顶点多一个）。 */
export const TILE_QUADS = 32;
/** 一块要的高度页每边几个点：顶点数加上两边各一圈（算法线用）。 */
export const TILE_SAMPLES = HEIGHT_PAGE_SAMPLES;

/** 四叉树的一个节点：level 0 是根，那一层的块边长是 size / 2^level，x、z 是这一层里的第几块（从 0 起）。 */
export interface TileKey {
  readonly level: number;
  readonly x: number;
  readonly z: number;
}

export const tileId = ({ level, x, z }: TileKey): string => `${level}/${x}_${z}`;

/** 最细的一层：块边长不大于 detail（米）的第一层。 */
export const leafLevel = ({ size, detail }: { readonly size: number; readonly detail: number }): number => Math.max(0, Math.ceil(Math.log2(size / detail)));

/** 节点在地形本地坐标里的范围：最小角和边长（地形以实体为中心，边长 size）。 */
export function tileRect(size: number, { level, x, z }: TileKey): { x0: number; z0: number; edge: number } {
  const edge = size / 2 ** level;
  return { x0: -size / 2 + x * edge, z0: -size / 2 + z * edge, edge };
}

export interface TileSelection {
  /** 地形的边长（米）。 */
  readonly size: number;
  /** 最细的一层的块边长（米）：到这么细就不再分。 */
  readonly leafEdge: number;
  /** 观察点到块的距离小于块边长的这么多倍就细分。 */
  readonly lodFactor: number;
  /** 观察点（地形本地坐标）和它下面地面的高度。 */
  readonly eye: readonly [number, number, number];
  readonly ground: number;
  /** 这块的网格好了没有。 */
  readonly ready: (key: TileKey) => boolean;
}

/**
 * 选这一帧要画的块：返回要画的（都准备好了的）和要准备的（还没好的，近的在前）。观察点在地形外面也行。
 */
export function selectTiles(selection: TileSelection): { draw: TileKey[]; want: TileKey[] } {
  const { size, leafEdge, lodFactor, eye, ground, ready } = selection;
  const maxLevel = leafLevel({ size, detail: leafEdge });
  const draw: TileKey[] = [];
  const want: { key: TileKey; distance: number }[] = [];
  const height = Math.abs(eye[1] - ground);
  const distanceTo = (key: TileKey): number => {
    const { x0, z0, edge } = tileRect(size, key);
    const dx = Math.max(x0 - eye[0], 0, eye[0] - (x0 + edge));
    const dz = Math.max(z0 - eye[2], 0, eye[2] - (z0 + edge));
    return Math.hypot(dx, dz, height);
  };
  const childrenOf = ({ level, x, z }: TileKey): TileKey[] =>
    [[0, 0], [1, 0], [0, 1], [1, 1]].map(([i, j]) => ({ level: level + 1, x: x * 2 + i!, z: z * 2 + j! }));
  const visit = (key: TileKey): void => {
    const distance = distanceTo(key);
    const split = key.level < maxLevel && distance < tileRect(size, key).edge * lodFactor;
    if (split) {
      const children = childrenOf(key);
      if (children.every(ready)) {
        for (const child of children) visit(child);
        return;
      }
      for (const child of children) if (!ready(child)) want.push({ key: child, distance: distanceTo(child) });
    }
    if (ready(key)) draw.push(key);
    else want.push({ key, distance });
  };
  visit({ level: 0, x: 0, z: 0 });
  want.sort((a, b) => a.key.level - b.key.level || a.distance - b.distance);
  return { draw, want: want.map((entry) => entry.key) };
}

/**
 * 所有块共用的高度场网格（Mesh 的 heightfield，见 rendering/mesh/HeightPages.ts）：顶点的 x、z 是格坐标 0..TILE_QUADS，y 是 0（地面）
 * 或 1（裙边：着色器里往下垂页头给的深度）。高度、法线、UV 在顶点着色器里按块的高度页算，实体的缩放把一格放大成米。
 * 裙边是四条边各一排垂下去的顶点，和边上的顶点连成竖着的带，两面都画（不用管每条边的绕向，三角形很少）。
 */
export function heightfieldGrid(): { vertices: Float32Array; indices: Uint16Array } {
  const n = TILE_QUADS, side = n + 1;
  const edges = edgeVertices();
  const vertices = new Float32Array((side * side + edges.length) * VERTEX_FLOATS);
  const put = (v: number, i: number, j: number, skirt: number) => vertices.set([i, skirt, j, 0, 1, 0, i / n, j / n], v * VERTEX_FLOATS);
  for (let j = 0; j < side; j++) for (let i = 0; i < side; i++) put(j * side + i, i, j, 0);
  edges.forEach(([i, j], k) => put(side * side + k, i, j, 1));
  const indices: number[] = [];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const a = j * side + i, b = a + 1, c = a + side, d = c + 1;
      // 从上往下看逆时针（法线朝 +Y）
      indices.push(a, c, b, b, c, d);
    }
  }
  for (let e = 0; e < 4; e++) {
    const first = side * side + e * side;
    for (let k = 0; k < n; k++) {
      const [i0, j0] = edges[e * side + k]!, [i1, j1] = edges[e * side + k + 1]!;
      const top0 = j0 * side + i0, top1 = j1 * side + i1, bottom0 = first + k, bottom1 = first + k + 1;
      indices.push(top0, bottom0, top1, top1, bottom0, bottom1, top0, top1, bottom0, top1, bottom1, bottom0);
    }
  }
  return { vertices, indices: Uint16Array.from(indices) };
}

/** 四条边上的顶点（格坐标），依次是 z = 0、z = n、x = 0、x = n 的边。 */
function edgeVertices(): [number, number][] {
  const n = TILE_QUADS, line = Array.from({ length: n + 1 }, (_, k) => k);
  return [...line.map((i): [number, number] => [i, 0]), ...line.map((i): [number, number] => [i, n]), ...line.map((j): [number, number] => [0, j]), ...line.map((j): [number, number] => [n, j])];
}

/**
 * 块的高度页的页头：UV 的原点（块的原点按 period 米取过模再除以 uvScale，大世界里 UV 的数也小）、每格的 UV 步长、裙边的深度
 * （垂下几个格那么深：相邻的块最多差一层，接缝的高度差在一个格的坡度以内）。
 */
export function tilePageHeader(x0: number, z0: number, edge: number, uvScale: number, period: number): [number, number, number, number] {
  const spacing = edge / TILE_QUADS;
  const wrap = (value: number) => value - Math.floor(value / period) * period;
  return [wrap(x0) / uvScale, wrap(z0) / uvScale, spacing / uvScale, Math.max(spacing * 4, 1)];
}
