// 几何实验 E1（docs/vector-assets.md 的"几何"）：同样的几何误差下，"基础网格加位移微图"比稠密网格小多少。
//   node packages/pipeline/experiments/displacement-storage.ts <模型.glb|.ply> [...]
//   node packages/pipeline/experiments/displacement-storage.ts <模型> --export <文件> [--base 64] [--level 3] [--step 0.0005]
//     不量大小，把这一个配置（基础网格是原来的 1/base，细分 level 级，8 位）导出给 E2 的运行时实验用（apps/bench 的 displacement 页面）。
// 对每个模型：
//   1. 稠密网格逐档简化（meshopt），每档记大小和到原网格的误差，得到"普通网格"的大小—误差曲线；
//   2. 简化出几档基础网格，每个基础三角形按重心坐标细分 k 级，沿插值的法线向原网格打射线量位移，量化成 8 位（步长取几档），
//      按层级预测（新点的预测值是上一级两个相邻点的平均）存残差；记大小和重建出来的网格到原网格的误差；
//   3. 每个位移的配置和曲线上误差相同的普通网格比大小。
// 大小只算几何（位置和连接关系，位移的版本加上位移），都是量化、编码之后再 brotli；法线两边都能在加载时算出来，不计。
// 误差：两边各取样本点量到对方表面的最近距离，报均方根、平均和最大值，除以包围盒的对角线。和普通网格比大小时按均方根、按平均各比一次：
// 均方根被少数差得远的点主导（两种表示在这些地方都差），平均说的是表面大部分地方。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { brotliCompressSync } from 'node:zlib';
import { createStrideTools, type StrideTools } from '@stride-ts/native/tools';
import { TriangleBvh } from '../src/geometry/bvh.ts';

interface Mesh {
  positions: Float32Array;
  indices: Uint32Array;
}

const SAMPLES = 20000;

/** glb/gltf/fbx/obj 用 stride-tools 读（所有网格并成一个）；PLY（文本的、二进制小端的）自己读。 */
async function loadMesh(tools: StrideTools, file: string): Promise<Mesh> {
  const bytes = readFileSync(file);
  if (file.toLowerCase().endsWith('.ply')) return weld(readPly(bytes));
  const scene = await tools.loadScene(bytes);
  const positions: number[] = [], indices: number[] = [];
  for (let m = 0; m < scene.meshCount; m++) {
    const mesh = scene.mesh(m), base = positions.length / 3;
    for (const value of mesh.positions) positions.push(value);
    for (const index of mesh.indices) indices.push(base + index);
  }
  return weld({ positions: Float32Array.from(positions), indices: Uint32Array.from(indices) });
}

function readPly(bytes: Buffer): Mesh {
  const headerEnd = bytes.indexOf('end_header\n') + 'end_header\n'.length;
  const header = bytes.subarray(0, headerEnd).toString('latin1').split('\n').map((line) => line.trim());
  const ascii = header.includes('format ascii 1.0');
  if (!ascii && !header.includes('format binary_little_endian 1.0')) throw new Error('only ASCII and binary little-endian PLY are supported');
  const SIZES: Record<string, number> = { char: 1, uchar: 1, short: 2, ushort: 2, int: 4, uint: 4, float: 4, double: 8 };
  let vertexCount = 0, faceCount = 0, vertexStride = 0, element = '';
  for (const line of header) {
    const words = line.trim().split(/\s+/);
    if (words[0] === 'element') {
      element = words[1]!;
      if (element === 'vertex') vertexCount = Number(words[2]);
      if (element === 'face') faceCount = Number(words[2]);
    } else if (words[0] === 'property' && element === 'vertex') {
      vertexStride += SIZES[words[1]!]!;
    }
  }
  const positions = new Float32Array(vertexCount * 3);
  if (ascii) {
    // 斯坦福扫描库的格式：每个顶点一行（前三个数是 x、y、z），每个面一行（"3 a b c"）
    const lines = bytes.subarray(headerEnd).toString('latin1').split('\n');
    for (let v = 0; v < vertexCount; v++) {
      const words = lines[v]!.trim().split(/\s+/);
      for (let axis = 0; axis < 3; axis++) positions[v * 3 + axis] = Number(words[axis]);
    }
    const faces = new Uint32Array(faceCount * 3);
    for (let f = 0; f < faceCount; f++) {
      const words = lines[vertexCount + f]!.trim().split(/\s+/);
      if (words[0] !== '3') throw new Error('only triangles are supported');
      for (let corner = 0; corner < 3; corner++) faces[f * 3 + corner] = Number(words[corner + 1]);
    }
    return { positions, indices: faces };
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // x、y、z 是每个顶点的前三个 float
  for (let v = 0; v < vertexCount; v++) for (let axis = 0; axis < 3; axis++) positions[v * 3 + axis] = view.getFloat32(headerEnd + v * vertexStride + axis * 4, true);
  const indices = new Uint32Array(faceCount * 3);
  let offset = headerEnd + vertexCount * vertexStride;
  for (let f = 0; f < faceCount; f++) {
    if (view.getUint8(offset) !== 3) throw new Error('only triangles are supported');
    for (let corner = 0; corner < 3; corner++) indices[f * 3 + corner] = view.getUint32(offset + 1 + corner * 4, true);
    offset += 13;
  }
  return { positions, indices };
}

/** 位置相同的顶点并成一个（模型在 UV、法线的接缝处把顶点拆开了，几何上是连着的），去掉退化的三角形。 */
function weld({ positions, indices }: Mesh): Mesh {
  const remap = new Uint32Array(positions.length / 3), unique: number[] = [];
  const seen = new Map<string, number>();
  for (let v = 0; v < remap.length; v++) {
    const key = `${positions[v * 3]},${positions[v * 3 + 1]},${positions[v * 3 + 2]}`;
    let index = seen.get(key);
    if (index === undefined) {
      index = unique.length / 3;
      seen.set(key, index);
      unique.push(positions[v * 3]!, positions[v * 3 + 1]!, positions[v * 3 + 2]!);
    }
    remap[v] = index;
  }
  const welded: number[] = [];
  for (let t = 0; t < indices.length; t += 3) {
    const a = remap[indices[t]!]!, b = remap[indices[t + 1]!]!, c = remap[indices[t + 2]!]!;
    if (a !== b && b !== c && a !== c) welded.push(a, b, c);
  }
  return { positions: Float32Array.from(unique), indices: Uint32Array.from(welded) };
}

function bounds(positions: Float32Array): { min: number[]; extent: number[]; diagonal: number } {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i++) {
    min[i % 3] = Math.min(min[i % 3]!, positions[i]!);
    max[i % 3] = Math.max(max[i % 3]!, positions[i]!);
  }
  const extent = max.map((value, axis) => value - min[axis]!);
  return { min, extent, diagonal: Math.hypot(...extent) };
}

/** 只留用到的顶点，按第一次用到的顺序排（顶点缓存优化之后这样排，编码最小）。 */
function compact({ positions, indices }: Mesh): Mesh {
  const remap = new Int32Array(positions.length / 3).fill(-1), compacted: number[] = [];
  const reindexed = indices.map((index) => {
    if (remap[index] === -1) {
      remap[index] = compacted.length / 3;
      compacted.push(positions[index * 3]!, positions[index * 3 + 1]!, positions[index * 3 + 2]!);
    }
    return remap[index]!;
  });
  return { positions: Float32Array.from(compacted), indices: reindexed };
}

/**
 * 普通网格的编码：位置按原网格的包围盒量化成 16 位，meshopt 编顶点和下标，再 brotli。返回字节数和量化后再还原的网格
 * （之后的计算都用它，和解码出来的一致）。
 */
function encode(tools: StrideTools, mesh: Mesh, frame: { min: number[]; extent: number[] }): { bytes: number; decoded: Mesh } {
  const ordered = compact({ positions: mesh.positions, indices: tools.optimizeMesh(mesh.indices, mesh.positions) });
  const count = ordered.positions.length / 3;
  const quantized = new Uint16Array(count * 4), decoded = new Float32Array(count * 3);
  for (let v = 0; v < count; v++) {
    for (let axis = 0; axis < 3; axis++) {
      const q = Math.round(((ordered.positions[v * 3 + axis]! - frame.min[axis]!) / (frame.extent[axis]! || 1)) * 65535);
      quantized[v * 4 + axis] = q;
      decoded[v * 3 + axis] = frame.min[axis]! + (q / 65535) * frame.extent[axis]!;
    }
  }
  const vertices = tools.encodeVertices(new Uint8Array(quantized.buffer), 8), indexBytes = tools.encodeIndices(ordered.indices, count);
  return { bytes: brotliCompressSync(vertices).length + brotliCompressSync(indexBytes).length, decoded: { positions: decoded, indices: ordered.indices } };
}

/** 均匀地取最多 SAMPLES 个顶点。 */
function samplePoints(positions: Float32Array): [number, number, number][] {
  const count = positions.length / 3, step = Math.max(1, Math.floor(count / SAMPLES));
  const points: [number, number, number][] = [];
  for (let v = 0; v < count; v += step) points.push([positions[v * 3]!, positions[v * 3 + 1]!, positions[v * 3 + 2]!]);
  return points;
}

interface GeometricError {
  /** 均方根：少数差得远的点（薄的部位、洞的边上）占大头。 */
  readonly rms: number;
  /** 平均：表面大部分地方差多少。 */
  readonly mean: number;
  readonly max: number;
}

/** 两个网格之间的误差：各取顶点当样本，量到对方表面的最近距离；都除以包围盒的对角线。 */
function errorBetween(original: { mesh: Mesh; bvh: TriangleBvh }, other: Mesh, diagonal: number): GeometricError {
  const otherBvh = new TriangleBvh(other.positions, other.indices);
  const distances = [...samplePoints(original.mesh.positions).map((p) => otherBvh.distanceTo(p)), ...samplePoints(other.positions).map((p) => original.bvh.distanceTo(p))];
  const sum = (power: number) => distances.reduce((total, d) => total + d ** power, 0) / distances.length;
  return { rms: Math.sqrt(sum(2)) / diagonal, mean: sum(1) / diagonal, max: Math.max(...distances) / diagonal };
}

/** 面积加权的顶点法线。 */
function vertexNormals({ positions, indices }: Mesh): Float32Array {
  const normals = new Float32Array(positions.length);
  for (let t = 0; t < indices.length; t += 3) {
    const [a, b, c] = [indices[t]! * 3, indices[t + 1]! * 3, indices[t + 2]! * 3];
    const e1 = [positions[b]! - positions[a]!, positions[b + 1]! - positions[a + 1]!, positions[b + 2]! - positions[a + 2]!];
    const e2 = [positions[c]! - positions[a]!, positions[c + 1]! - positions[a + 1]!, positions[c + 2]! - positions[a + 2]!];
    const n = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!];
    for (const vertex of [a, b, c]) for (let axis = 0; axis < 3; axis++) normals[vertex + axis] = normals[vertex + axis]! + n[axis]!;
  }
  for (let v = 0; v < normals.length; v += 3) {
    const length = Math.hypot(normals[v]!, normals[v + 1]!, normals[v + 2]!) || 1;
    for (let axis = 0; axis < 3; axis++) normals[v + axis] = normals[v + axis]! / length;
  }
  return normals;
}

/**
 * 基础网格细分 level 级后的采样点。同一个顶点、同一条边上的点在相邻的三角形之间共用（编号一样），所以重建出来的网格没有裂缝，
 * 位移也只存一份。每个基础三角形有 (n + 1)(n + 2) / 2 个格点（n = 2^level），格点 (i, j) 的重心坐标是 (1 - (i + j) / n, i / n, j / n)。
 */
class MicroGrid {
  readonly n: number;
  readonly sampleCount: number;
  readonly #base: Mesh;
  readonly #edgeStart = new Map<number, number>();
  readonly #interiorStart: number;
  readonly #interiorPerTriangle: number;

  constructor(base: Mesh, level: number) {
    this.#base = base;
    this.n = 1 << level;
    const vertexCount = base.positions.length / 3;
    let next = vertexCount;
    for (let t = 0; t < base.indices.length; t += 3) {
      for (let e = 0; e < 3; e++) {
        const key = this.#edgeKey(base.indices[t + e]!, base.indices[t + ((e + 1) % 3)]!);
        if (!this.#edgeStart.has(key)) {
          this.#edgeStart.set(key, next);
          next += this.n - 1;
        }
      }
    }
    this.#interiorStart = next;
    this.#interiorPerTriangle = ((this.n - 1) * (this.n - 2)) / 2;
    this.sampleCount = next + (base.indices.length / 3) * this.#interiorPerTriangle;
  }

  #edgeKey(a: number, b: number): number {
    return Math.min(a, b) * (this.#base.positions.length / 3) + Math.max(a, b);
  }

  /** 边 a → b 上离 a 第 k 格（1..n-1）的点的编号；边按"编号小的顶点到大的"存。 */
  #onEdge(a: number, b: number, k: number): number {
    return this.#edgeStart.get(this.#edgeKey(a, b))! + (a < b ? k : this.n - k) - 1;
  }

  /**
   * 三角形的三条边（ab、ac、bc）上的点从哪个编号开始、内部的点从哪个编号开始，着色器按它算格点的编号。
   * 边的编号最高位是 1 时，这条边在三角形里的方向和存的方向相反（第 k 格是 起点 + n - k - 1）。
   */
  layout(triangle: number): [number, number, number, number] {
    const [a, b, c] = [this.#base.indices[triangle * 3]!, this.#base.indices[triangle * 3 + 1]!, this.#base.indices[triangle * 3 + 2]!];
    const edge = (from: number, to: number) => (this.#edgeStart.get(this.#edgeKey(from, to))! | (from < to ? 0 : 0x80000000)) >>> 0;
    return [edge(a, b), edge(a, c), edge(b, c), this.#interiorStart + triangle * this.#interiorPerTriangle];
  }

  /** 三角形 triangle 的格点 (i, j) 的采样点编号。 */
  sample(triangle: number, i: number, j: number): number {
    const n = this.n, [a, b, c] = [this.#base.indices[triangle * 3]!, this.#base.indices[triangle * 3 + 1]!, this.#base.indices[triangle * 3 + 2]!];
    if (i === 0 && j === 0) return a;
    if (i === n) return b;
    if (j === n) return c;
    if (j === 0) return this.#onEdge(a, b, i);
    if (i === 0) return this.#onEdge(a, c, j);
    if (i + j === n) return this.#onEdge(b, c, j);
    // 内部：按行排（j = 1..n-2，每行 i = 1..n-1-j）
    const before = (j - 1) * (n - 1) - ((j - 1) * j) / 2;
    return this.#interiorStart + triangle * this.#interiorPerTriangle + before + (i - 1);
  }
}

/** 位移量化成 8 位：GPU 上一个采样点一个字节。 */
const TOP = 255;
/** 顶点范围的下界对齐到这么多步的格子上：相邻顶点的下界多半落在同一格，存下来几乎不占地方。 */
const BOUND_GRID = 32;

interface RawDisplacement {
  /** 每个采样点沿法线到原网格的距离（带符号）。 */
  readonly raw: Float32Array;
  readonly misses: number;
}

interface Displaced {
  /** 每个采样点的位移，量化成 0..255：0 是这一点的下界，255 是上界。 */
  readonly quantized: Uint8Array;
  /**
   * 每个基础顶点的位移范围（下界、上界各一个）。三角形里一点的范围按重心坐标从三个顶点插值，所以共用的边上两侧的范围一样
   * （只取决于边的两个端点），量化以后两侧的位置仍然重合。范围跟着局部走，个别位移特别大的地方不会把别处的精度摊薄
   * （NVIDIA 的位移微网格同样按顶点给范围）。
   */
  readonly bounds: Float32Array;
  /** 量化的步长（范围不超过 255 步的地方）。 */
  readonly step: number;
  /** 每个采样点量化再还原以后的位移。 */
  readonly values: Float32Array;
  /** 每个采样点的范围（从顶点的范围插值出来的）。 */
  readonly low: Float32Array;
  readonly high: Float32Array;
  readonly misses: number;
}

/**
 * 每个采样点沿基础网格插值的法线向原网格打射线（两个方向取近的），量出位移。射线最远只找到所在基础三角形最长边那么远：
 * 比这更远的"命中"是打到了别处的表面。
 */
function castDisplacement(base: Mesh, normals: Float32Array, grid: MicroGrid, original: TriangleBvh): RawDisplacement {
  const samples = grid.sampleCount;
  const raw = new Float32Array(samples), done = new Uint8Array(samples);
  const reach = new Float32Array(base.indices.length / 3);
  for (let t = 0; t < reach.length; t++) {
    const corner = (c: number) => base.indices[t * 3 + c]! * 3;
    const edge = (a: number, b: number) => Math.hypot(base.positions[a]! - base.positions[b]!, base.positions[a + 1]! - base.positions[b + 1]!, base.positions[a + 2]! - base.positions[b + 2]!);
    reach[t] = Math.max(edge(corner(0), corner(1)), edge(corner(1), corner(2)), edge(corner(2), corner(0)));
  }
  let misses = 0;
  forEachSample(base, normals, grid, (sample, position, normal, triangle) => {
    if (done[sample]) return;
    done[sample] = 1;
    const out = original.rayCast(position, normal, reach[triangle]!);
    const back = original.rayCast(position, [-normal[0], -normal[1], -normal[2]], reach[triangle]!);
    if (out === undefined && back === undefined) misses++;
    else raw[sample] = back === undefined || (out !== undefined && out <= back) ? out! : -back;
  });
  return { raw, misses };
}

/**
 * 量化。step 是想要的量化步长（世界单位）：误差由它定，不由"范围除以 255"定。顶点的范围先取它周围一圈三角形里所有采样点的
 * 最小、最大位移；下界对齐到 BOUND_GRID 步的格子，范围不到 255 步的放宽到 255 步（步长正好是 step，值只占 0..255 里的一段，
 * 熵编码以后不多占地方），超过 255 步的地方步长跟着变粗。第二轮量过"范围收到最紧"：步长比需要的细得多，存下来的是噪声，
 * 体积是这里的三到四倍。
 */
function quantizeDisplacement(base: Mesh, normals: Float32Array, grid: MicroGrid, { raw, misses }: RawDisplacement, step: number): Displaced {
  const samples = grid.sampleCount, vertices = base.positions.length / 3;
  const bounds = new Float32Array(vertices * 2);
  for (let v = 0; v < vertices; v++) bounds.set([Infinity, -Infinity], v * 2);
  forEachSample(base, normals, grid, (sample, _position, _normal, triangle) => {
    for (let corner = 0; corner < 3; corner++) {
      const v = base.indices[triangle * 3 + corner]! * 2;
      bounds[v] = Math.min(bounds[v]!, raw[sample]!);
      bounds[v + 1] = Math.max(bounds[v + 1]!, raw[sample]!);
    }
  });
  for (let v = 0; v < vertices * 2; v += 2) {
    // 不属于任何三角形的顶点没有采样点
    const min = Number.isFinite(bounds[v]!) ? bounds[v]! : 0, max = Number.isFinite(bounds[v + 1]!) ? bounds[v + 1]! : 0;
    const lo = Math.floor(min / (BOUND_GRID * step)) * BOUND_GRID * step;
    bounds.set([lo, lo + Math.max(TOP, Math.ceil((max - lo) / step)) * step], v);
  }
  const n = grid.n;
  const quantized = new Uint8Array(samples), values = new Float32Array(samples), low = new Float32Array(samples), high = new Float32Array(samples);
  forEachSample(base, normals, grid, (sample, _position, _normal, triangle, i, j) => {
    const weights = [1 - (i + j) / n, i / n, j / n];
    let lo = 0, hi = 0;
    for (let corner = 0; corner < 3; corner++) {
      const v = base.indices[triangle * 3 + corner]! * 2;
      lo += bounds[v]! * weights[corner]!;
      hi += bounds[v + 1]! * weights[corner]!;
    }
    const span = hi - lo || 1;
    quantized[sample] = Math.min(TOP, Math.max(0, Math.round(((raw[sample]! - lo) / span) * TOP)));
    values[sample] = lo + (quantized[sample]! / TOP) * span;
    low[sample] = lo;
    high[sample] = hi;
  });
  return { quantized, bounds, step, values, low, high, misses };
}

/** 逐个基础三角形、逐个格点：采样点编号、基础网格上的位置和插值的单位法线。 */
function forEachSample(base: Mesh, normals: Float32Array, grid: MicroGrid, visit: (sample: number, position: [number, number, number], normal: [number, number, number], triangle: number, i: number, j: number) => void): void {
  const n = grid.n;
  for (let t = 0; t < base.indices.length / 3; t++) {
    const corners = [base.indices[t * 3]! * 3, base.indices[t * 3 + 1]! * 3, base.indices[t * 3 + 2]! * 3];
    for (let j = 0; j <= n; j++) {
      for (let i = 0; i <= n - j; i++) {
        const weights = [1 - (i + j) / n, i / n, j / n];
        const position: [number, number, number] = [0, 0, 0], normal: [number, number, number] = [0, 0, 0];
        for (let corner = 0; corner < 3; corner++) {
          for (let axis = 0; axis < 3; axis++) {
            position[axis] = position[axis]! + base.positions[corners[corner]! + axis]! * weights[corner]!;
            normal[axis] = normal[axis]! + normals[corners[corner]! + axis]! * weights[corner]!;
          }
        }
        const length = Math.hypot(...normal) || 1;
        visit(grid.sample(t, i, j), position, [normal[0] / length, normal[1] / length, normal[2] / length], t, i, j);
      }
    }
  }
}

/**
 * 位移的编码：从粗到细一级一级存。第 0 级是基础顶点的值；之后每一级新出现的点（在上一级两个相邻点的中点上）存它和预测值的差，
 * 预测值是这两个点还原出来的位移的平均、换算到这一点自己的量化范围里；表面光滑的地方差接近 0。差按 256 取模存成一个字节，
 * 再 brotli。顶点的范围另存两条流：下界在第几格、范围有几步（绝大多数是 255），各 16 位。
 */
function encodeDisplacement(base: Mesh, grid: MicroGrid, { quantized, bounds, step, values, low, high }: Displaced): number {
  const stream = new Uint8Array(grid.sampleCount), emitted = new Uint8Array(grid.sampleCount);
  let length = 0;
  const emit = (sample: number, predicted: number) => {
    if (emitted[sample]) return;
    emitted[sample] = 1;
    // 差移到以半程为中心：光滑处的值都挤在中间，熵编码好压
    stream[length++] = (quantized[sample]! - predicted + 256 + 128) & 0xff;
  };
  const n = grid.n, triangles = base.indices.length / 3;
  for (let v = 0; v < base.positions.length / 3; v++) emit(v, 128);
  for (let step = n >> 1; step >= 1; step >>= 1) {
    for (let t = 0; t < triangles; t++) {
      for (let j = 0; j <= n; j += step) {
        for (let i = 0; i <= n - j; i += step) {
          const oddI = (i / step) % 2 === 1, oddJ = (j / step) % 2 === 1;
          if (!oddI && !oddJ) continue;
          // 新点在哪条边的中点上：沿 i、沿 j，或者沿斜边
          const [a, b] = oddI && oddJ ? [grid.sample(t, i - step, j + step), grid.sample(t, i + step, j - step)]
            : oddI ? [grid.sample(t, i - step, j), grid.sample(t, i + step, j)]
            : [grid.sample(t, i, j - step), grid.sample(t, i, j + step)];
          const sample = grid.sample(t, i, j), span = high[sample]! - low[sample]! || 1;
          const predicted = Math.round((((values[a]! + values[b]!) / 2 - low[sample]!) / span) * TOP);
          emit(sample, Math.min(TOP, Math.max(0, predicted)));
        }
      }
    }
  }
  const vertices = bounds.length / 2;
  const lows = Int16Array.from({ length: vertices }, (_, v) => Math.round(bounds[v * 2]! / (BOUND_GRID * step)));
  const spans = Uint16Array.from({ length: vertices }, (_, v) => Math.round((bounds[v * 2 + 1]! - bounds[v * 2]!) / step));
  return brotliCompressSync(stream.subarray(0, length)).length + brotliCompressSync(new Uint8Array(lows.buffer)).length + brotliCompressSync(new Uint8Array(spans.buffer)).length;
}

/** 按量化后的位移重建出细分的网格（顶点就是采样点）。 */
function reconstruct(base: Mesh, normals: Float32Array, grid: MicroGrid, { values }: Displaced): Mesh {
  const positions = new Float32Array(grid.sampleCount * 3), n = grid.n;
  forEachSample(base, normals, grid, (sample, position, normal) => {
    for (let axis = 0; axis < 3; axis++) positions[sample * 3 + axis] = position[axis]! + normal[axis]! * values[sample]!;
  });
  const indices: number[] = [];
  for (let t = 0; t < base.indices.length / 3; t++) {
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n - j; i++) {
        indices.push(grid.sample(t, i, j), grid.sample(t, i + 1, j), grid.sample(t, i, j + 1));
        if (i + j < n - 1) indices.push(grid.sample(t, i + 1, j), grid.sample(t, i + 1, j + 1), grid.sample(t, i, j + 1));
      }
    }
  }
  return { positions, indices: Uint32Array.from(indices) };
}

/** 普通网格的曲线上，误差（按 measure 这一种算）是 error 时的大小（在相邻两档之间按对数插值）；曲线够不到这么小的误差时是 undefined。 */
function plainSizeAt(curve: readonly { bytes: number; error: GeometricError }[], measure: 'rms' | 'mean', error: number): number | undefined {
  const sorted = curve.map((point) => ({ bytes: point.bytes, error: point.error[measure] })).filter((point) => point.error > 0).sort((a, b) => a.error - b.error);
  if (sorted.length === 0 || error < sorted[0]!.error) return undefined;
  for (let i = 1; i < sorted.length; i++) {
    const low = sorted[i - 1]!, high = sorted[i]!;
    if (error <= high.error) {
      const t = (Math.log(error) - Math.log(low.error)) / (Math.log(high.error) - Math.log(low.error));
      return Math.exp(Math.log(low.bytes) + t * (Math.log(high.bytes) - Math.log(low.bytes)));
    }
  }
  return sorted.at(-1)!.bytes;
}

/**
 * 导出给 E2 用的二进制（小端）：
 *   u32 × 8   魔数 'DMSH'、细分级数、基础顶点数、基础三角形数、采样点数、微三角形数、保留 × 2
 *   f32 × 4V  基础顶点的位置（xyz，w 是这个顶点位移范围的下界）；f32 × 4V 基础顶点的法线（w 是上界）
 *   u32 × 8T  每个基础三角形：三个顶点、三条边的起点（MicroGrid.layout）、内部的起点、保留
 *   u8  × S   每个采样点的位移（0..255 对应这一点的下界..上界，范围按重心坐标从三个顶点插值），补到 4 的倍数
 *   f32 × 3S  重建出来的顶点位置；u32 × 3M 重建出来的三角形（对照用的静态网格）
 */
function exportForBench(file: string, base: Mesh, normals: Float32Array, grid: MicroGrid, level: number, displaced: Displaced, reconstructed: Mesh): void {
  const vertices = base.positions.length / 3, triangles = base.indices.length / 3, samples = grid.sampleCount;
  const padded = (samples + 3) & ~3;
  const header = new Uint32Array(8);
  header.set([0x48534d44, level, vertices, triangles, samples, reconstructed.indices.length / 3]);
  // 每个顶点 4 个 float：xyz 加这个顶点的范围里的一个数（位置带下界，法线带上界）
  const wide = (source: Float32Array, bound: number) => Float32Array.from({ length: vertices * 4 }, (_, i) => (i % 4 === 3 ? displaced.bounds[(i >> 2) * 2 + bound]! : source[(i >> 2) * 3 + (i % 4)]!));
  const layout = new Uint32Array(triangles * 8);
  for (let t = 0; t < triangles; t++) layout.set([...base.indices.subarray(t * 3, t * 3 + 3), ...grid.layout(t)], t * 8);
  const displacement = new Uint8Array(padded);
  displacement.set(displaced.quantized);
  const parts = [header, wide(base.positions, 0), wide(normals, 1), layout, displacement, reconstructed.positions, reconstructed.indices];
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, Buffer.concat(parts.map((part) => new Uint8Array(part.buffer, part.byteOffset, part.byteLength))));
  console.log(`exported ${file}: ${triangles} base triangles, level ${level}, ${samples} samples, ${reconstructed.indices.length / 3} micro triangles`);
}

const kb = (bytes: number) => (bytes / 1024).toFixed(1).padStart(8);
const percent = (value: number) => (value * 100).toFixed(4).padStart(8);

const option = (name: string) => {
  const at = process.argv.indexOf(name);
  return at < 0 ? undefined : process.argv[at + 1];
};
const exportFile = option('--export');
const STEPS = [0.0002, 0.0005, 0.001, 0.002];
const files = process.argv.slice(2).filter((arg, i, all) => !arg.startsWith('--') && !all[i - 1]?.startsWith('--'));

const tools = await createStrideTools({ workerThreads: 2 });
for (const file of files) {
  const mesh = await loadMesh(tools, file);
  const frame = bounds(mesh.positions), triangles = mesh.indices.length / 3;
  if (triangles === 0) {
    // 压缩过的 glTF（Draco、meshopt）stride-tools 读不出几何
    console.log(`
== ${path.basename(file)}: no triangles could be read; skipped`);
    continue;
  }
  const original = { mesh, bvh: new TriangleBvh(mesh.positions, mesh.indices) };
  if (exportFile) {
    const level = Number(option('--level') ?? 3);
    const simplified = tools.simplifyMesh(mesh.indices, mesh.positions, Math.floor(triangles / Number(option('--base') ?? 64)) * 3, 1).indices;
    const base = encode(tools, { positions: mesh.positions, indices: simplified }, frame).decoded;
    const normals = vertexNormals(base), grid = new MicroGrid(base, level);
    const displaced = quantizeDisplacement(base, normals, grid, castDisplacement(base, normals, grid, original.bvh), frame.diagonal * Number(option('--step') ?? 0.0005));
    exportForBench(exportFile, base, normals, grid, level, displaced, reconstruct(base, normals, grid, displaced));
    break;
  }
  console.log(`\n== ${path.basename(file)}: ${triangles} triangles, ${mesh.positions.length / 3} vertices`);
  console.log('kind                         triangles       KB    rms %   mean %    max %   bits/orig-tri');

  const curve: { bytes: number; error: GeometricError }[] = [];
  for (const divisor of [1, 2, 4, 8, 16, 32, 64, 128, 256]) {
    const indices = divisor === 1 ? mesh.indices : tools.simplifyMesh(mesh.indices, mesh.positions, Math.floor(triangles / divisor) * 3, 1).indices;
    if (indices.length < 12) continue;
    const { bytes, decoded } = encode(tools, { positions: mesh.positions, indices }, frame);
    const error = errorBetween(original, decoded, frame.diagonal);
    curve.push({ bytes, error });
    console.log(`${`plain 1/${divisor}`.padEnd(28)} ${String(indices.length / 3).padStart(9)} ${kb(bytes)} ${percent(error.rms)} ${percent(error.mean)} ${percent(error.max)} ${((bytes * 8) / triangles).toFixed(2).padStart(10)}`);
  }

  for (const divisor of [16, 64, 256, 1024, 4096]) {
    const simplified = tools.simplifyMesh(mesh.indices, mesh.positions, Math.floor(triangles / divisor) * 3, 1).indices;
    if (simplified.length < 12) continue;
    const base = encode(tools, { positions: mesh.positions, indices: simplified }, frame);
    const normals = vertexNormals(base.decoded);
    for (let level = 1; level <= 6; level++) {
      const micro = (simplified.length / 3) * 4 ** level;
      // 细到和原网格差不多为止：再细只是把原网格的三角形重新采样一遍
      if (micro < triangles / 4 || micro > triangles * 2) continue;
      const grid = new MicroGrid(base.decoded, level);
      const cast = castDisplacement(base.decoded, normals, grid, original.bvh);
      // 量化的步长（占包围盒对角线的比例）：均匀量化的均方根误差是步长的 0.29 倍
      for (const step of STEPS) {
        const displaced = quantizeDisplacement(base.decoded, normals, grid, cast, frame.diagonal * step);
        const bytes = base.bytes + encodeDisplacement(base.decoded, grid, displaced);
        const error = errorBetween(original, reconstruct(base.decoded, normals, grid, displaced), frame.diagonal);
        const versus = (measure: 'rms' | 'mean') => {
          const plain = plainSizeAt(curve, measure, error[measure]);
          return `same ${measure}: ${plain === undefined ? 'n/a (below the curve)' : `${kb(plain).trim()} KB, ${(bytes / plain).toFixed(2)}x`}`;
        };
        const label = `base 1/${divisor} + L${level} step ${(step * 100).toFixed(2)}%`;
        console.log(`${label.padEnd(28)} ${String(micro).padStart(9)} ${kb(bytes)} ${percent(error.rms)} ${percent(error.mean)} ${percent(error.max)} ${((bytes * 8) / triangles).toFixed(2).padStart(10)}`
          + `   plain at ${versus('rms')}; ${versus('mean')}${displaced.misses ? `   ${displaced.misses} rays missed` : ''}`);
      }
    }
  }
}
process.exit(0);
