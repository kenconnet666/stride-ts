// 几何实验 E4（docs/vector-assets.md 的"几何"）：规则生成的几何，现生成和下载哪个快。
//   node packages/pipeline/experiments/sweep-generator.ts [--length 1000] [--spacing 0.5]
// 一条路：中心线是过一串控制点的 Catmull-Rom 样条，路面和两侧的护栏是沿它扫掠的横截面，护栏的立柱隔几米一根。
// "矢量"的描述只有控制点、横截面和几个参数；对照是把生成出来的网格照管线的做法压缩（50 米一段，位置 16 位、法线 8 位、UV 16 位，
// meshopt 再 brotli）以后下载。量：生成的时间（这里是 JavaScript，放进 wasm 只会更快）、两边的字节数、按 10 Mbps 下载要多久。
import { brotliCompressSync } from 'node:zlib';
import { createStrideTools } from '@stride-ts/native/tools';

type Vec3 = [number, number, number];

/** 横截面上的一点：x 向右、y 向上（米）。 */
type Profile = readonly (readonly [number, number])[];

interface RoadDescription {
  /** 中心线的控制点。 */
  readonly controlPoints: readonly Vec3[];
  /** 沿中心线隔多远取一圈（米）。 */
  readonly spacing: number;
  readonly road: Profile;
  /** 护栏的横截面（相对路的中心线，右侧的；左侧镜像）。 */
  readonly rail: Profile;
  readonly post: { readonly every: number; readonly offset: number; readonly width: number; readonly height: number };
}

interface Geometry {
  /** 每个顶点 8 个 float：位置、法线、UV。 */
  readonly vertices: number[];
  readonly indices: number[];
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalize = (a: Vec3): Vec3 => {
  const length = Math.hypot(...a) || 1;
  return [a[0] / length, a[1] / length, a[2] / length];
};

/** 均匀的 Catmull-Rom：第 segment 段上 t（0..1）处的点。 */
function spline(points: readonly Vec3[], segment: number, t: number): Vec3 {
  const at = (i: number) => points[Math.min(points.length - 1, Math.max(0, i))]!;
  const [p0, p1, p2, p3] = [at(segment - 1), at(segment), at(segment + 1), at(segment + 2)];
  const out: Vec3 = [0, 0, 0];
  for (let axis = 0; axis < 3; axis++) {
    const a = 2 * p1[axis]!, b = p2[axis]! - p0[axis]!, c = 2 * p0[axis]! - 5 * p1[axis]! + 4 * p2[axis]! - p3[axis]!, d = -p0[axis]! + 3 * p1[axis]! - 3 * p2[axis]! + p3[axis]!;
    out[axis] = 0.5 * (a + b * t + c * t * t + d * t * t * t);
  }
  return out;
}

/** 中心线上隔 spacing 米一个的标架：位置、朝右、朝上。样条按弦长近似均匀地取。 */
function frames(description: RoadDescription): { position: Vec3; right: Vec3; up: Vec3; distance: number }[] {
  const { controlPoints, spacing } = description;
  const out: { position: Vec3; right: Vec3; up: Vec3; distance: number }[] = [];
  let distance = 0;
  for (let segment = 0; segment < controlPoints.length - 1; segment++) {
    const chord = Math.hypot(...sub(controlPoints[segment + 1]!, controlPoints[segment]!));
    const steps = Math.max(1, Math.round(chord / spacing));
    for (let step = 0; step < steps + (segment === controlPoints.length - 2 ? 1 : 0); step++) {
      const t = step / steps, position = spline(controlPoints, segment, t);
      const tangent = normalize(sub(spline(controlPoints, segment, t + 0.01), spline(controlPoints, segment, t - 0.01)));
      const right = normalize(cross(tangent, [0, 1, 0]));
      if (out.length > 0) distance += Math.hypot(...sub(position, out.at(-1)!.position));
      out.push({ position, right, up: cross(right, tangent), distance });
    }
  }
  return out;
}

/** 沿标架扫掠一个横截面（mirror：左右镜像，三角形的绕向跟着反过来）。 */
function sweep(geometry: Geometry, rings: ReturnType<typeof frames>, profile: Profile, mirror: boolean): void {
  const first = geometry.vertices.length / 8, side = mirror ? -1 : 1;
  // 横截面上每个点的法线：相邻两段的法线取平均
  const normals = profile.map((_, i) => {
    const before = profile[Math.max(0, i - 1)]!, after = profile[Math.min(profile.length - 1, i + 1)]!;
    const length = Math.hypot(after[0] - before[0], after[1] - before[1]) || 1;
    return [-(after[1] - before[1]) / length, (after[0] - before[0]) / length] as const;
  });
  const lengths = profile.map((point, i) => (i === 0 ? 0 : Math.hypot(point[0] - profile[i - 1]![0], point[1] - profile[i - 1]![1])));
  for (let i = 1; i < lengths.length; i++) lengths[i] = lengths[i]! + lengths[i - 1]!;
  for (const { position, right, up, distance } of rings) {
    profile.forEach(([x, y], i) => {
      const [nx, ny] = normals[i]!;
      for (let axis = 0; axis < 3; axis++) geometry.vertices.push(position[axis]! + right[axis]! * x * side + up[axis]! * y);
      for (let axis = 0; axis < 3; axis++) geometry.vertices.push(right[axis]! * nx * side + up[axis]! * ny);
      geometry.vertices.push(lengths[i]! / lengths.at(-1)!, distance / 4);
    });
  }
  const n = profile.length;
  for (let ring = 0; ring < rings.length - 1; ring++) {
    for (let i = 0; i < n - 1; i++) {
      const a = first + ring * n + i, b = a + n;
      if (mirror) geometry.indices.push(a, a + 1, b, a + 1, b + 1, b);
      else geometry.indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
}

/** 一根立柱：四个侧面（每个面自己的四个顶点，法线朝外）。 */
function post(geometry: Geometry, frame: ReturnType<typeof frames>[number], offset: number, width: number, height: number): void {
  const tangent = cross(frame.up, frame.right), half = width / 2;
  const sides: readonly (readonly [Vec3, Vec3])[] = [[frame.right, tangent], [tangent, frame.right.map((v) => -v) as Vec3], [frame.right.map((v) => -v) as Vec3, tangent.map((v) => -v) as Vec3], [tangent.map((v) => -v) as Vec3, frame.right]];
  for (const [normal, along] of sides) {
    const first = geometry.vertices.length / 8;
    for (const [u, v] of [[-1, 0], [1, 0], [1, 1], [-1, 1]] as const) {
      for (let axis = 0; axis < 3; axis++) geometry.vertices.push(frame.position[axis]! + frame.right[axis]! * offset + normal[axis]! * half + along[axis]! * half * u + frame.up[axis]! * height * v);
      geometry.vertices.push(...normal, (u + 1) / 2, v);
    }
    geometry.indices.push(first, first + 1, first + 2, first, first + 2, first + 3);
  }
}

function generate(description: RoadDescription): Geometry {
  const geometry: Geometry = { vertices: [], indices: [] }, rings = frames(description);
  sweep(geometry, rings, description.road, false);
  sweep(geometry, rings, description.rail, false);
  sweep(geometry, rings, description.rail, true);
  const every = Math.max(1, Math.round(description.post.every / description.spacing));
  for (let ring = 0; ring < rings.length; ring += every) {
    for (const side of [1, -1]) post(geometry, rings[ring]!, description.post.offset * side, description.post.width, description.post.height);
  }
  return geometry;
}

const option = (name: string, fallback: number) => {
  const at = process.argv.indexOf(name);
  return at < 0 ? fallback : Number(process.argv[at + 1]);
};
const length = option('--length', 1000), spacing = option('--spacing', 0.5);

// 控制点 50 米一个，左右、高低随机摆一点（固定的种子）
let seed = 12345;
const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;
const description: RoadDescription = {
  controlPoints: Array.from({ length: Math.round(length / 50) + 1 }, (_, i) => [random() * 12, random() * 2, -i * 50] as Vec3),
  spacing,
  road: [[-5, -0.3], [-4.2, 0], [-3.6, 0.02], [-1.8, 0.06], [0, 0.09], [1.8, 0.06], [3.6, 0.02], [4.2, 0], [5, -0.3]],
  // W 形的护栏板
  rail: [[4.62, 0.45], [4.6, 0.48], [4.56, 0.52], [4.6, 0.56], [4.62, 0.6], [4.6, 0.64], [4.56, 0.68], [4.6, 0.72], [4.62, 0.75]],
  post: { every: 4, offset: 4.68, width: 0.1, height: 0.75 },
};
const descriptionBytes = brotliCompressSync(Buffer.from(JSON.stringify(description))).length;

// 生成：先跑几遍让 JIT 热起来，再量
for (let i = 0; i < 3; i++) generate(description);
const times: number[] = [];
let geometry = generate(description);
for (let i = 0; i < 9; i++) {
  const started = performance.now();
  geometry = generate(description);
  times.push(performance.now() - started);
}
const generateMs = times.sort((a, b) => a - b)[times.length >> 1]!;
const vertexCount = geometry.vertices.length / 8, triangles = geometry.indices.length / 3;

// 对照：照管线的做法压缩。位置的 16 位量化只够几十米的范围，所以按沿路的距离 50 米一段分开压
const tools = await createStrideTools({ workerThreads: 1 });
const CHUNK = 50;
const chunks = new Map<number, number[]>();
for (let t = 0; t < geometry.indices.length; t += 3) {
  const key = Math.floor(-geometry.vertices[geometry.indices[t]! * 8 + 2]! / CHUNK);
  let list = chunks.get(key);
  if (!list) chunks.set(key, (list = []));
  list.push(geometry.indices[t]!, geometry.indices[t + 1]!, geometry.indices[t + 2]!);
}
let encodedBytes = 0, rawBytes = 0;
const encodeStarted = performance.now();
for (const chunkIndices of chunks.values()) {
  // 这一段用到的顶点重新编号
  const remap = new Map<number, number>(), sources: number[] = [];
  const local = Uint32Array.from(chunkIndices, (index) => {
    let found = remap.get(index);
    if (found === undefined) {
      remap.set(index, (found = sources.length));
      sources.push(index);
    }
    return found;
  });
  const positions = new Float32Array(sources.length * 3);
  sources.forEach((source, v) => positions.set(geometry.vertices.slice(source * 8, source * 8 + 3), v * 3));
  const ordered = tools.optimizeMesh(local, positions);
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity], uvMax = [0, 0], uvMin = [Infinity, Infinity];
  for (const source of sources) {
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis]!, geometry.vertices[source * 8 + axis]!);
      max[axis] = Math.max(max[axis]!, geometry.vertices[source * 8 + axis]!);
    }
    for (let axis = 0; axis < 2; axis++) {
      uvMin[axis] = Math.min(uvMin[axis]!, geometry.vertices[source * 8 + 6 + axis]!);
      uvMax[axis] = Math.max(uvMax[axis]!, geometry.vertices[source * 8 + 6 + axis]!);
    }
  }
  // 16 字节一个顶点：位置 u16×3（第四个不用）、法线 snorm8×3（第四个不用）、UV u16×2
  const packed = new DataView(new ArrayBuffer(sources.length * 16));
  sources.forEach((source, v) => {
    const o = source * 8;
    for (let axis = 0; axis < 3; axis++) packed.setUint16(v * 16 + axis * 2, Math.round(((geometry.vertices[o + axis]! - min[axis]!) / (max[axis]! - min[axis]! || 1)) * 65535), true);
    for (let axis = 0; axis < 3; axis++) packed.setInt8(v * 16 + 8 + axis, Math.round(geometry.vertices[o + 3 + axis]! * 127));
    for (let axis = 0; axis < 2; axis++) packed.setUint16(v * 16 + 12 + axis * 2, Math.round(((geometry.vertices[o + 6 + axis]! - uvMin[axis]!) / (uvMax[axis]! - uvMin[axis]! || 1)) * 65535), true);
  });
  encodedBytes += brotliCompressSync(tools.encodeVertices(new Uint8Array(packed.buffer), 16)).length + brotliCompressSync(tools.encodeIndices(ordered, sources.length)).length;
  rawBytes += sources.length * 16 + ordered.length * (sources.length > 65535 ? 4 : 2);
}
const encodeMs = performance.now() - encodeStarted;

const downloadMs = (bytes: number) => (bytes * 8) / 10e6 * 1000;
console.log(`road: ${length} m, a ring every ${spacing} m: ${vertexCount} vertices, ${triangles} triangles`);
console.log(`description: ${descriptionBytes} bytes (brotli of the JSON), download at 10 Mbps ${downloadMs(descriptionBytes).toFixed(2)} ms`);
console.log(`generate: ${generateMs.toFixed(1)} ms (JavaScript, median of 9)`);
console.log(`mesh: ${(rawBytes / 1024).toFixed(0)} KB in GPU memory, ${(encodedBytes / 1024).toFixed(1)} KB encoded in ${chunks.size} chunks (the encoding took ${encodeMs.toFixed(0)} ms), download at 10 Mbps ${downloadMs(encodedBytes).toFixed(0)} ms`);
console.log(`ratio: the mesh download is ${(encodedBytes / descriptionBytes).toFixed(0)}x the description; generating is ${(downloadMs(encodedBytes) / generateMs).toFixed(1)}x faster than downloading at 10 Mbps`);
process.exit(0);
