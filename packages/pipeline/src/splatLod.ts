/**
 * 高斯泼溅的细节层次（导入时建，引擎 content/splatFile.ts 的版本 3）：把泼溅按位置分进一棵八叉树，一个节点的泼溅不超过
 * NODE_SPLATS 个就是叶子（原样的泼溅）；内部节点是它的子节点那一级的泼溅按 GRID³ 的格子合并成的一级（每格一个），从叶子往根
 * 一层层合，所以根是整个场景最粗的样子。格子占得太满（泼溅充满一块体积）时减半，一级不超过下一级的 1/LEVEL_RATIO。画的时候每个视图按节点投到屏幕上的粗细选一刀（引擎 rendering/splats/splatLod.ts）。
 *
 * 合并照 splat-transform 的矩匹配（decimate/moment-match.ts：面积乘不透明度当权重、总方差公式求协方差、不透明度守恒"质量"）：
 * 一格里的高斯按权重 w = α · 面积（三个半轴两两乘积之和）求均值和协方差 Σ = Σw(Σᵢ + μᵢμᵢᵀ)/Σw − μμᵀ，协方差分解出旋转和
 * 半轴；不透明度 = Σ αᵢ·面积ᵢ / 合并后的面积（不超过 1）；颜色、高阶球谐按权重平均。splat-transform 在 kNN 图上一对对地挑代价
 * 最小的合并（细，但 100 万个要几十秒到几分钟）；我们按格子合，一遍是线性的，远处那几级的质量够用。
 *
 * 节点按层（宽度优先）排、泼溅按节点的次序放：粗的在文件前面（以后按需加载时先读前面一段就有整个场景）。合并的泼溅大约多出
 * 原来的 1/7（贴在表面上的扫描），最多 1/3。
 */
import type { SplatNode, SplatSource } from '@stride-ts/engine/splats';
import { shCoefficients } from '@stride-ts/engine/splats';

/** 一个节点最多几个泼溅（叶子不超过它；内部节点合并成 GRID³ 以内）：选的时候一个节点是一起换级的最小单位。 */
export const NODE_SPLATS = 4096;
/** 内部节点合并的格子：每个轴最多 GRID 格（16³ = 4096，和 NODE_SPLATS 一致）。 */
const GRID = 16;
/** 内部节点那一级最多是子节点那一级的几分之一：格子占得太满（泼溅充满体积）时格子减半再合，粗一级的总量收在原来的 1/3 以内。 */
const LEVEL_RATIO = 4;
/** 八叉树最多几层（全挤在一点上的泼溅分不开时停）。 */
const MAX_DEPTH = 21;

/** 一组泼溅（结构同 SplatSource 的数组，个数可变）。 */
interface SplatSet {
  count: number;
  positions: Float32Array;
  scales: Float32Array;
  rotations: Float32Array;
  colors: Float32Array;
  sh: Float32Array;
}

/** 建树时的一个节点：所在的立方体、子节点（叶子没有）、这一级的泼溅和合并用的格子数（每个轴）。 */
interface TreeNode {
  readonly min: readonly [number, number, number];
  readonly size: number;
  readonly children: TreeNode[];
  splats: SplatSet;
  grid: number;
}

/** 泼溅不多于 NODE_SPLATS 个时原样返回（一个根节点，由编码器写）；多了建细节层次，返回按节点排好的泼溅和节点表。 */
export function buildSplatLod(source: SplatSource): SplatSource {
  if (source.count <= NODE_SPLATS) return source;
  const per = source.sh ? shCoefficients(source.shBands ?? 0) * 3 : 0;
  const min: [number, number, number] = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < source.count; i++) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k]!, source.positions[i * 3 + k]!);
      max[k] = Math.max(max[k]!, source.positions[i * 3 + k]!);
    }
  }
  // 立方体（各轴一样长）：格子是正方的，合出来的泼溅不偏扁
  const size = Math.max(max[0]! - min[0], max[1]! - min[1], max[2]! - min[2]) * (1 + 1e-6) || 1;
  const indices = new Uint32Array(source.count).map((_, i) => i);
  const root = split(source, per, indices, min, size, 0);
  merge(root, per);
  return flatten(root, source, per);
}

/** 把 indices 这些泼溅分进立方体 (min, size) 的八叉树：不多于 NODE_SPLATS 个（或者到了最深）是叶子。 */
function split(source: SplatSource, per: number, indices: Uint32Array, min: readonly [number, number, number], size: number, depth: number): TreeNode {
  if (indices.length <= NODE_SPLATS || depth >= MAX_DEPTH) return { min, size, children: [], splats: gather(source, per, indices), grid: 0 };
  const half = size / 2;
  const octant = new Uint8Array(indices.length);
  const counts = new Uint32Array(8);
  indices.forEach((i, n) => {
    let o = 0;
    for (let k = 0; k < 3; k++) if (source.positions[i * 3 + k]! >= min[k]! + half) o |= 1 << k;
    octant[n] = o;
    counts[o]!++;
  });
  const starts = new Uint32Array(8);
  for (let o = 1; o < 8; o++) starts[o] = starts[o - 1]! + counts[o - 1]!;
  const sorted = new Uint32Array(indices.length), cursor = starts.slice();
  indices.forEach((i, n) => (sorted[cursor[octant[n]!]!++] = i));
  const children: TreeNode[] = [];
  for (let o = 0; o < 8; o++) {
    if (counts[o] === 0) continue;
    const childMin: [number, number, number] = [min[0] + (o & 1 ? half : 0), min[1] + (o & 2 ? half : 0), min[2] + (o & 4 ? half : 0)];
    children.push(split(source, per, sorted.subarray(starts[o]!, starts[o]! + counts[o]!), childMin, half, depth + 1));
  }
  return { min, size, children, splats: emptySet(0, per), grid: GRID };
}

/** 从叶子往根：内部节点这一级 = 子节点那一级的泼溅按格子合并。 */
function merge(node: TreeNode, per: number): void {
  if (node.children.length === 0) return;
  for (const child of node.children) merge(child, per);
  const sets = node.children.map((child) => child.splats);
  const target = Math.max(1, Math.floor(sets.reduce((sum, set) => sum + set.count, 0) / LEVEL_RATIO));
  for (node.grid = GRID; node.grid > 2 && occupiedCells(sets, node.min, node.size, node.grid) > target; node.grid /= 2);
  node.splats = mergeIntoGrid(sets, node.min, node.size, per, node.grid);
}

/** 这些泼溅占了 grid³ 的格子里的几格。 */
function occupiedCells(sets: readonly SplatSet[], min: readonly number[], size: number, grid: number): number {
  const cells = new Set<number>();
  for (const set of sets) for (let i = 0; i < set.count; i++) cells.add(cellIndex(set, i, min, size, grid));
  return cells.size;
}

function cellIndex(set: SplatSet, i: number, min: readonly number[], size: number, grid: number): number {
  let cell = 0;
  for (let k = 2; k >= 0; k--) cell = cell * grid + Math.min(grid - 1, Math.max(0, Math.floor(((set.positions[i * 3 + k]! - min[k]!) / size) * grid)));
  return cell;
}

/**
 * 几组泼溅按立方体 (min, size) 里 grid³ 的格子合并（见文件开头）：一格只有一个的原样留着。
 */
export function mergeIntoGrid(sets: readonly SplatSet[], min: readonly number[], size: number, per: number, grid = GRID): SplatSet {
  const cellOf = new Map<number, number>();
  const cells: number[][] = [];
  sets.forEach((set, s) => {
    for (let i = 0; i < set.count; i++) {
      const cell = cellIndex(set, i, min, size, grid);
      let slot = cellOf.get(cell);
      if (slot === undefined) {
        slot = cells.length;
        cellOf.set(cell, slot);
        cells.push([]);
      }
      cells[slot]!.push(s, i);
    }
  });
  const out = emptySet(cells.length, per);
  const rotation = new Float64Array(9);
  cells.forEach((members, c) => {
    if (members.length === 2) {
      copySplat(sets[members[0]!]!, members[1]!, out, c, per);
      return;
    }
    // 权重 w = α · 面积；全是 0（看不见的）时每个一样重
    let total = 0, mass = 0;
    const mean = [0, 0, 0], second = [0, 0, 0, 0, 0, 0], color = [0, 0, 0];
    const sh = new Float64Array(per);
    const weights: number[] = [];
    for (let m = 0; m < members.length; m += 2) {
      const set = sets[members[m]!]!, i = members[m + 1]!;
      const [sx, sy, sz] = [set.scales[i * 3]!, set.scales[i * 3 + 1]!, set.scales[i * 3 + 2]!];
      const area = sx * sy + sy * sz + sx * sz;
      weights.push(set.colors[i * 4 + 3]! * area);
      mass += set.colors[i * 4 + 3]! * area;
    }
    const uniform = weights.every((w) => w <= 0);
    for (let m = 0, n = 0; m < members.length; m += 2, n++) {
      const set = sets[members[m]!]!, i = members[m + 1]!;
      const w = uniform ? 1 : weights[n]!;
      total += w;
      const p = [set.positions[i * 3]!, set.positions[i * 3 + 1]!, set.positions[i * 3 + 2]!];
      // Σᵢ = R diag(s²) Rᵀ，二阶矩 E[xxᵀ] = Σᵢ + μᵢμᵢᵀ（存上三角：xx xy xz yy yz zz）
      quaternionMatrix(set.rotations, i, rotation);
      const s2 = [set.scales[i * 3]! ** 2, set.scales[i * 3 + 1]! ** 2, set.scales[i * 3 + 2]! ** 2];
      const pairs = [[0, 0], [0, 1], [0, 2], [1, 1], [1, 2], [2, 2]] as const;
      pairs.forEach(([a, b], k) => {
        let sigma = 0;
        for (let j = 0; j < 3; j++) sigma += rotation[a * 3 + j]! * rotation[b * 3 + j]! * s2[j]!;
        second[k]! += w * (sigma + p[a]! * p[b]!);
      });
      for (let k = 0; k < 3; k++) {
        mean[k]! += w * p[k]!;
        color[k]! += w * set.colors[i * 4 + k]!;
      }
      for (let k = 0; k < per; k++) sh[k]! += w * set.sh[i * per + k]!;
    }
    for (let k = 0; k < 3; k++) {
      mean[k]! /= total;
      color[k]! /= total;
    }
    const covariance = [
      second[0]! / total - mean[0]! * mean[0]!, second[1]! / total - mean[0]! * mean[1]!, second[2]! / total - mean[0]! * mean[2]!,
      second[3]! / total - mean[1]! * mean[1]!, second[4]! / total - mean[1]! * mean[2]!, second[5]! / total - mean[2]! * mean[2]!,
    ];
    const { axes, values } = symmetricEigen(covariance);
    const scale = values.map((value) => Math.sqrt(Math.max(value, 1e-12)));
    const area = scale[0]! * scale[1]! + scale[1]! * scale[2]! + scale[0]! * scale[2]!;
    out.positions.set(mean, c * 3);
    out.scales.set(scale, c * 3);
    out.rotations.set(matrixQuaternion(axes), c * 4);
    out.colors.set([...color, Math.min(1, area > 0 ? mass / area : 1)], c * 4);
    for (let k = 0; k < per; k++) out.sh[c * per + k] = sh[k]! / total;
  });
  return out;
}

/** 按宽度优先排节点、泼溅按节点的次序连着放，写成 SplatSource。 */
function flatten(root: TreeNode, source: SplatSource, per: number): SplatSource {
  const order: TreeNode[] = [root];
  for (let n = 0; n < order.length; n++) order.push(...order[n]!.children);
  const total = order.reduce((sum, node) => sum + node.splats.count, 0);
  const out = emptySet(total, per);
  const nodes: SplatNode[] = [];
  let first = 0, nextChild = 1;
  for (const node of order) {
    const set = node.splats;
    out.positions.set(set.positions.subarray(0, set.count * 3), first * 3);
    out.scales.set(set.scales.subarray(0, set.count * 3), first * 3);
    out.rotations.set(set.rotations.subarray(0, set.count * 4), first * 4);
    out.colors.set(set.colors.subarray(0, set.count * 4), first * 4);
    if (per > 0) out.sh.set(set.sh.subarray(0, set.count * per), first * per);
    const { min, max } = bounds(set);
    nodes.push({ min, max, first, count: set.count, firstChild: node.children.length > 0 ? nextChild : 0, childCount: node.children.length, detail: node.children.length > 0 ? node.size / node.grid : 0 });
    nextChild += node.children.length;
    first += set.count;
  }
  return {
    count: total, positions: out.positions, scales: out.scales, rotations: out.rotations, colors: out.colors, nodes,
    ...(per > 0 ? { sh: out.sh, shBands: source.shBands ?? 0 } : {}),
  };
}

/** 泼溅的包围盒：中心加 3σ（最长的半轴）。 */
function bounds(set: SplatSet): { min: [number, number, number]; max: [number, number, number] } {
  const min: [number, number, number] = [Infinity, Infinity, Infinity], max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < set.count; i++) {
    const reach = 3 * Math.max(set.scales[i * 3]!, set.scales[i * 3 + 1]!, set.scales[i * 3 + 2]!);
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k]!, set.positions[i * 3 + k]! - reach);
      max[k] = Math.max(max[k]!, set.positions[i * 3 + k]! + reach);
    }
  }
  return { min, max };
}

function emptySet(count: number, per: number): SplatSet {
  return { count, positions: new Float32Array(count * 3), scales: new Float32Array(count * 3), rotations: new Float32Array(count * 4), colors: new Float32Array(count * 4), sh: new Float32Array(count * per) };
}

function gather(source: SplatSource, per: number, indices: Uint32Array): SplatSet {
  const set = emptySet(indices.length, per);
  const from: SplatSet = { count: source.count, positions: source.positions, scales: source.scales, rotations: source.rotations, colors: source.colors, sh: source.sh ?? new Float32Array(0) };
  indices.forEach((i, n) => copySplat(from, i, set, n, per));
  return set;
}

function copySplat(from: SplatSet, i: number, to: SplatSet, n: number, per: number): void {
  to.positions.set(from.positions.subarray(i * 3, i * 3 + 3), n * 3);
  to.scales.set(from.scales.subarray(i * 3, i * 3 + 3), n * 3);
  to.rotations.set(from.rotations.subarray(i * 4, i * 4 + 4), n * 4);
  to.colors.set(from.colors.subarray(i * 4, i * 4 + 4), n * 4);
  if (per > 0) to.sh.set(from.sh.subarray(i * per, i * per + per), n * per);
}

/** 四元数（xyzw，不必单位化）的旋转矩阵，按行存：out[r * 3 + c]；列是泼溅的三个轴（同着色器）。 */
function quaternionMatrix(rotations: Float32Array, i: number, out: Float64Array): void {
  let [x, y, z, w] = [rotations[i * 4]!, rotations[i * 4 + 1]!, rotations[i * 4 + 2]!, rotations[i * 4 + 3]!];
  const length = Math.hypot(x, y, z, w) || 1;
  [x, y, z, w] = [x / length, y / length, z / length, w / length];
  out.set([
    1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
    2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
    2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y),
  ]);
}

/** 旋转矩阵（按行存，列是三个轴）→ 四元数 xyzw。 */
function matrixQuaternion(m: readonly number[]): [number, number, number, number] {
  const trace = m[0]! + m[4]! + m[8]!;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    return [(m[7]! - m[5]!) / s, (m[2]! - m[6]!) / s, (m[3]! - m[1]!) / s, s / 4];
  }
  if (m[0]! > m[4]! && m[0]! > m[8]!) {
    const s = Math.sqrt(1 + m[0]! - m[4]! - m[8]!) * 2;
    return [s / 4, (m[1]! + m[3]!) / s, (m[2]! + m[6]!) / s, (m[7]! - m[5]!) / s];
  }
  if (m[4]! > m[8]!) {
    const s = Math.sqrt(1 + m[4]! - m[0]! - m[8]!) * 2;
    return [(m[1]! + m[3]!) / s, s / 4, (m[5]! + m[7]!) / s, (m[2]! - m[6]!) / s];
  }
  const s = Math.sqrt(1 + m[8]! - m[0]! - m[4]!) * 2;
  return [(m[2]! + m[6]!) / s, (m[5]! + m[7]!) / s, s / 4, (m[3]! - m[1]!) / s];
}

/**
 * 对称 3×3 矩阵（上三角 xx xy xz yy yz zz）的特征分解（Jacobi 旋转）：axes 按行存、列是特征向量（行列式为 +1 的旋转），
 * values 是对应的特征值。
 */
export function symmetricEigen(upper: readonly number[]): { axes: number[]; values: number[] } {
  const a = [[upper[0]!, upper[1]!, upper[2]!], [upper[1]!, upper[3]!, upper[4]!], [upper[2]!, upper[4]!, upper[5]!]];
  const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 32; sweep++) {
    const off = a[0]![1]! ** 2 + a[0]![2]! ** 2 + a[1]![2]! ** 2;
    if (off < 1e-30) break;
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]] as const) {
      if (Math.abs(a[p]![q]!) < 1e-300) continue;
      const theta = (a[q]![q]! - a[p]![p]!) / (2 * a[p]![q]!);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < 3; k++) {
        const akp = a[k]![p]!, akq = a[k]![q]!;
        a[k]![p] = c * akp - s * akq;
        a[k]![q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = a[p]![k]!, aqk = a[q]![k]!;
        a[p]![k] = c * apk - s * aqk;
        a[q]![k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = v[k]![p]!, vkq = v[k]![q]!;
        v[k]![p] = c * vkp - s * vkq;
        v[k]![q] = s * vkp + c * vkq;
      }
    }
  }
  // 行列式是 −1 时把第三个轴反过来（成为旋转）
  const det = v[0]![0]! * (v[1]![1]! * v[2]![2]! - v[1]![2]! * v[2]![1]!) - v[0]![1]! * (v[1]![0]! * v[2]![2]! - v[1]![2]! * v[2]![0]!) + v[0]![2]! * (v[1]![0]! * v[2]![1]! - v[1]![1]! * v[2]![0]!);
  if (det < 0) for (let k = 0; k < 3; k++) v[k]![2] = -v[k]![2]!;
  return { axes: v.flat(), values: [a[0]![0]!, a[1]![1]!, a[2]![2]!] };
}
