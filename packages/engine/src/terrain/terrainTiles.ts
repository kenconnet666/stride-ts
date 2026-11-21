/**
 * 地形的分块和细节层次（纯函数，TerrainSystem 用）：地形的范围是一棵四叉树，近处的节点细分、远处的整块画；每个节点是一块
 * TILE_QUADS × TILE_QUADS 个格的网格，所以每一层的顶点间距是上一层的一半，画出来的三角形数和视野里的范围无关、和距离的对数有关。
 *
 * - 细分只在四个子块的网格都准备好了才换上（之前一直画父块），不会出现空洞；
 * - 相邻的块细节层次不同时接缝处会有小缝：每块的四边垂下一圈裙边挡住（同 Unity、Godot 的地形插件的常见做法）；
 * - 网格的顶点相对块的原点（数都小），块的位置放在实体的变换里（双精度）。
 */
import { FLOAT_LAYOUT, type VertexLayout } from '../content/format';

/** 每块每边几个格（顶点多一个）。 */
export const TILE_QUADS = 32;
/** 一块要的高度页每边几个点：顶点数加上两边各一圈（算法线用）。 */
export const TILE_SAMPLES = TILE_QUADS + 3;
/** 带切线（法线贴图要用）的顶点布局。 */
export const TILE_LAYOUT: VertexLayout = { ...FLOAT_LAYOUT, tangent: 'float32x4' };
const TILE_FLOATS = 12;

/** 四叉树的一个节点：level 0 是根，那一层的块边长是 size / 2^level，x、z 是这一层里的第几块（从 0 起）。 */
export interface TileKey {
  readonly level: number;
  readonly x: number;
  readonly z: number;
}

export const tileId = ({ level, x, z }: TileKey): string => `${level}/${x}_${z}`;

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
  const maxLevel = Math.max(0, Math.ceil(Math.log2(size / leafEdge)));
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
 * 一块的网格：heights 是 TILE_SAMPLES² 个高度（按行 z 排，从块的原点外一格起），顶点位置相对块的原点。uvOrigin 是块的原点在
 * UV 里的位置（调用方按贴图的周期取过模，数小），uvScale 米重复一次。裙边从四边垂下 skirt 米。
 */
export function buildTileMesh(heights: Float32Array, edge: number, uvOrigin: readonly [number, number], uvScale: number, skirt: number): { vertices: Float32Array; indices: Uint16Array } {
  const n = TILE_QUADS, side = n + 1, spacing = edge / n;
  if (heights.length !== TILE_SAMPLES * TILE_SAMPLES) throw new RangeError(`terrain tile needs ${TILE_SAMPLES}² heights, got ${heights.length}`);
  const sample = (i: number, j: number) => heights[(j + 1) * TILE_SAMPLES + i + 1]!;
  const vertices = new Float32Array((side * side + 4 * side) * TILE_FLOATS);
  const put = (v: number, i: number, j: number, y: number) => {
    // 中心差分的法线；切线沿 +x（贴图的 u），bitangent 沿 +z（v 也沿 +z）
    const dx = (sample(i + 1, j) - sample(i - 1, j)) / (2 * spacing), dz = (sample(i, j + 1) - sample(i, j - 1)) / (2 * spacing);
    const inv = 1 / Math.hypot(dx, 1, dz), tInv = 1 / Math.hypot(1, dx);
    const at = v * TILE_FLOATS;
    vertices[at] = i * spacing;
    vertices[at + 1] = y;
    vertices[at + 2] = j * spacing;
    vertices[at + 3] = -dx * inv;
    vertices[at + 4] = inv;
    vertices[at + 5] = -dz * inv;
    vertices[at + 6] = uvOrigin[0] + (i * spacing) / uvScale;
    vertices[at + 7] = uvOrigin[1] + (j * spacing) / uvScale;
    vertices[at + 8] = tInv;
    vertices[at + 9] = dx * tInv;
    vertices[at + 10] = 0;
    vertices[at + 11] = -1;
  };
  for (let j = 0; j < side; j++) for (let i = 0; i < side; i++) put(j * side + i, i, j, sample(i, j));
  // 裙边：四条边各一排垂下去的顶点（顺序同 tileIndices）
  let next = side * side;
  for (const [i, j] of edgeVertices()) put(next++, i, j, sample(i, j) - skirt);
  return { vertices, indices: tileIndices() };
}

/** 四条边上的顶点（格坐标），依次是 z = 0、z = n、x = 0、x = n 的边。 */
function edgeVertices(): [number, number][] {
  const n = TILE_QUADS, line = Array.from({ length: n + 1 }, (_, k) => k);
  return [...line.map((i): [number, number] => [i, 0]), ...line.map((i): [number, number] => [i, n]), ...line.map((j): [number, number] => [0, j]), ...line.map((j): [number, number] => [n, j])];
}

let indices: Uint16Array | undefined;

/** 每块都一样的索引（只建一次，各块的网格共用这个数组）。 */
function tileIndices(): Uint16Array {
  if (indices) return indices;
  const n = TILE_QUADS, side = n + 1, out: number[] = [];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const a = j * side + i, b = a + 1, c = a + side, d = c + 1;
      // 从上往下看逆时针（法线朝 +Y）
      out.push(a, c, b, b, c, d);
    }
  }
  // 裙边和边上的顶点连成竖着的带；两面都画（不用管每条边的绕向），三角形很少
  const edges = edgeVertices();
  for (let e = 0; e < 4; e++) {
    const first = side * side + e * side;
    for (let k = 0; k < n; k++) {
      const [i0, j0] = edges[e * side + k]!, [i1, j1] = edges[e * side + k + 1]!;
      const top0 = j0 * side + i0, top1 = j1 * side + i1, bottom0 = first + k, bottom1 = first + k + 1;
      out.push(top0, bottom0, top1, top1, bottom0, bottom1, top0, top1, bottom0, top1, bottom1, bottom0);
    }
  }
  return (indices = Uint16Array.from(out));
}
