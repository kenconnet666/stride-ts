/**
 * GPU 上的光追场景（路线图 R2，WebGPU 没有硬件光追，在计算着色器里遍历）：两层的 BVH——
 * - 底层（BLAS）：每个网格一棵，原生在工作线程上按 SAH 建（StrideNative.buildTriangleBvh），节点和三角形接在两个大缓冲里；
 * - 顶层（TLAS）：所有画出来的不透明实例的世界包围盒建一棵（buildBoxBvh），实例按叶子的顺序排；实例或变换变了才重建，新的
 *   建好以前接着用上一棵（晚一两帧，给全局光照用看不出来）。
 * 每个实例存世界矩阵的逆（射线变到网格自己的坐标里：方向不归一，所以 t 和世界里的一样）、BLAS 的起点、材质的颜色和自发光。
 * 着色器里用 RAY_TRACING_WGSL 的 rtTrace（最近的交点）和 rtNormal（世界的法线）。没算进去的：带蒙皮和形变的网格、地形的高度页
 * 网格、透明的材质、贴图（只用材质的颜色）。
 */
import type { Game } from '../../engine/Game';
import type { Mesh } from '../mesh/Mesh';
import type { MeshBatch } from '../mesh/MeshRenderFeature';

/** 一个实例几个 32 位：世界矩阵的逆（3 行 × 4）、BLAS 的节点和三角形起点、2 个空、颜色（rgba）、自发光（rgb、0）。 */
export const RT_INSTANCE_WORDS = 24;
const NODE_WORDS = 8;
const TRIANGLE_WORDS = 12;

/**
 * 光追的着色器代码（group 是绑定组号）：rtTrace(原点, 方向, 最远) 返回最近的交点（instance 是 0xffffffff 时没打到），
 * rtNormal 是交点的世界法线（朝着射线来的方向），rtAlbedo、rtEmissive 是实例材质的颜色和自发光。
 */
export function rayTracingWgsl(group: number): string {
  return /* wgsl */ `
@group(${group}) @binding(0) var<storage, read> rtTlas: array<vec4u>;
@group(${group}) @binding(1) var<storage, read> rtInstances: array<vec4f>;
@group(${group}) @binding(2) var<storage, read> rtBlas: array<vec4u>;
@group(${group}) @binding(3) var<storage, read> rtTriangles: array<vec4f>;

struct RtHit {
  t: f32,
  instance: u32,
  triangle: u32,
  uv: vec2f,
};

/** 射线和节点（两个 vec4u：最小角 + 第一个、最大角 + 个数）的盒子相交：进入的距离，没交上是 1e30。 */
fn rtBox(node0: vec4u, node1: vec4u, origin: vec3f, inverse: vec3f, tMax: f32) -> f32 {
  let t0 = (bitcast<vec3f>(node0.xyz) - origin) * inverse;
  let t1 = (bitcast<vec3f>(node1.xyz) - origin) * inverse;
  let near = max(max(min(t0.x, t1.x), min(t0.y, t1.y)), max(min(t0.z, t1.z), 0.0));
  let far = min(min(max(t0.x, t1.x), max(t0.y, t1.y)), min(max(t0.z, t1.z), tMax));
  return select(1e30, near, near <= far);
}

/** 一个实例的 BLAS 里最近的三角形（局部的射线，t 和世界里的一样），比 hit.t 近才改。 */
fn rtTraceBlas(instance: u32, origin: vec3f, dir: vec3f, hit: ptr<function, RtHit>) {
  let header = bitcast<vec4u>(rtInstances[instance * 6u + 3u]);
  let nodeBase = header.x;
  let triangleBase = header.y;
  let inverse = 1.0 / select(dir, vec3f(1e-20), abs(dir) < vec3f(1e-20));
  var stack: array<u32, 48>;
  var sp = 0u;
  var node = 0u;
  loop {
    let node0 = rtBlas[(nodeBase + node) * 2u];
    let node1 = rtBlas[(nodeBase + node) * 2u + 1u];
    if (node1.w == 0u) {
      // 内部节点：两个孩子挨着，先走近的
      let a = node0.w;
      let da = rtBox(rtBlas[(nodeBase + a) * 2u], rtBlas[(nodeBase + a) * 2u + 1u], origin, inverse, (*hit).t);
      let db = rtBox(rtBlas[(nodeBase + a + 1u) * 2u], rtBlas[(nodeBase + a + 1u) * 2u + 1u], origin, inverse, (*hit).t);
      if (da < 1e30 && db < 1e30) {
        node = select(a + 1u, a, da <= db);
        stack[sp] = select(a, a + 1u, da <= db);
        sp++;
        continue;
      }
      if (da < 1e30) { node = a; continue; }
      if (db < 1e30) { node = a + 1u; continue; }
    } else {
      for (var i = node0.w; i < node0.w + node1.w; i++) {
        let base = (triangleBase + i) * 3u;
        let v0 = rtTriangles[base];
        let e1 = rtTriangles[base + 1u].xyz;
        let e2 = rtTriangles[base + 2u].xyz;
        // Möller–Trumbore，两面都算
        let p = cross(dir, e2);
        let det = dot(e1, p);
        if (abs(det) < 1e-12) { continue; }
        let invDet = 1.0 / det;
        let s = origin - v0.xyz;
        let u = dot(s, p) * invDet;
        let q = cross(s, e1);
        let v = dot(dir, q) * invDet;
        let t = dot(e2, q) * invDet;
        if (u >= 0.0 && v >= 0.0 && u + v <= 1.0 && t > 1e-4 && t < (*hit).t) {
          *hit = RtHit(t, instance, triangleBase + i, vec2f(u, v));
        }
      }
    }
    if (sp == 0u) { break; }
    sp--;
    node = stack[sp];
  }
}

/** 最近的交点（世界的射线，dir 可以不归一；没打到时 instance 是 0xffffffff，t 是 tMax）。 */
fn rtTrace(origin: vec3f, dir: vec3f, tMax: f32) -> RtHit {
  var hit = RtHit(tMax, 0xffffffffu, 0u, vec2f(0.0));
  if (arrayLength(&rtTlas) < 2u) { return hit; }
  let inverse = 1.0 / select(dir, vec3f(1e-20), abs(dir) < vec3f(1e-20));
  var stack: array<u32, 48>;
  var sp = 0u;
  var node = 0u;
  if (rtBox(rtTlas[0], rtTlas[1], origin, inverse, tMax) >= 1e30) { return hit; }
  loop {
    let node0 = rtTlas[node * 2u];
    let node1 = rtTlas[node * 2u + 1u];
    if (node1.w == 0u) {
      let a = node0.w;
      let da = rtBox(rtTlas[a * 2u], rtTlas[a * 2u + 1u], origin, inverse, hit.t);
      let db = rtBox(rtTlas[(a + 1u) * 2u], rtTlas[(a + 1u) * 2u + 1u], origin, inverse, hit.t);
      if (da < 1e30 && db < 1e30) {
        node = select(a + 1u, a, da <= db);
        stack[sp] = select(a, a + 1u, da <= db);
        sp++;
        continue;
      }
      if (da < 1e30) { node = a; continue; }
      if (db < 1e30) { node = a + 1u; continue; }
    } else {
      for (var i = node0.w; i < node0.w + node1.w; i++) {
        // 世界的射线变到网格的坐标：乘世界矩阵的逆（3 行）
        let r0 = rtInstances[i * 6u];
        let r1 = rtInstances[i * 6u + 1u];
        let r2 = rtInstances[i * 6u + 2u];
        let o = vec3f(dot(r0, vec4f(origin, 1.0)), dot(r1, vec4f(origin, 1.0)), dot(r2, vec4f(origin, 1.0)));
        let d = vec3f(dot(r0.xyz, dir), dot(r1.xyz, dir), dot(r2.xyz, dir));
        rtTraceBlas(i, o, d, &hit);
      }
    }
    if (sp == 0u) { break; }
    sp--;
    node = stack[sp];
  }
  return hit;
}

/** 交点的世界法线（几何的，朝着射线来的那面）。 */
fn rtNormal(hit: RtHit, dir: vec3f) -> vec3f {
  let e1 = rtTriangles[hit.triangle * 3u + 1u].xyz;
  let e2 = rtTriangles[hit.triangle * 3u + 2u].xyz;
  let local = cross(e1, e2);
  // 法线按逆矩阵的转置变到世界
  let r0 = rtInstances[hit.instance * 6u].xyz;
  let r1 = rtInstances[hit.instance * 6u + 1u].xyz;
  let r2 = rtInstances[hit.instance * 6u + 2u].xyz;
  let n = normalize(r0 * local.x + r1 * local.y + r2 * local.z);
  return select(n, -n, dot(n, dir) > 0.0);
}

fn rtAlbedo(hit: RtHit) -> vec3f {
  return rtInstances[hit.instance * 6u + 4u].rgb;
}

fn rtEmissive(hit: RtHit) -> vec3f {
  return rtInstances[hit.instance * 6u + 5u].rgb;
}
`;
}

/** 一个网格的 BLAS 在大缓冲里的位置。 */
interface Blas {
  readonly nodeOffset: number;
  readonly triangleOffset: number;
}

/** 光追场景（RenderSystem.rayTracing）：用到它的特性（全局光照、调试视图）每帧先 update，再按 bindGroupLayout 绑它的缓冲。 */
export class RayTracingScene {
  readonly #device: GPUDevice;
  readonly #blas = new Map<Mesh, Blas | 'building'>();
  #nodes: Uint32Array = new Uint32Array(1 << 12);
  #nodeWords = 0;
  #triangles: Float32Array = new Float32Array(1 << 12);
  #triangleWords = 0;
  #blasVersion = 0;
  #uploadedBlas = -1;
  #tlas: { nodes: Uint32Array; instances: Float32Array } | undefined;
  #tlasBuilding = false;
  #tlasDirty = true;
  #uploadedTlas: object | undefined;
  #instanceKey = '';
  readonly #buffers: { tlas: GPUBuffer | undefined; instances: GPUBuffer | undefined; blas: GPUBuffer | undefined; triangles: GPUBuffer | undefined } = { tlas: undefined, instances: undefined, blas: undefined, triangles: undefined };
  #layout: GPUBindGroupLayout | undefined;
  #group: GPUBindGroup | undefined;
  /** 顶层里有几个实例（统计）。 */
  instanceCount = 0;

  constructor(device: GPUDevice) {
    this.#device = device;
  }

  /** 四个只读的存储缓冲（TLAS、实例、BLAS、三角形），计算着色器用。 */
  get bindGroupLayout(): GPUBindGroupLayout {
    return (this.#layout ??= this.#device.createBindGroupLayout({
      label: 'RayTracingScene',
      entries: [0, 1, 2, 3].map((binding) => ({ binding, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' as const } })),
    }));
  }

  /** 这一帧的绑定组（update 以后）；还没有能遍历的场景时 undefined。 */
  get bindGroup(): GPUBindGroup | undefined {
    return this.#group;
  }

  /** 网格的 BLAS 都建好了、顶层也建好了。 */
  get ready(): boolean {
    return this.#tlas !== undefined && ![...this.#blas.values()].includes('building') && !this.#tlasBuilding;
  }

  /** 每帧（用到光追的那帧）：给新网格建 BLAS，实例或变换变了重建 TLAS，建好的传上去。 */
  update(game: Game): void {
    const batches = game.meshes.batches.filter((batch) => traceable(batch));
    for (const batch of batches) if (!this.#blas.has(batch.mesh)) this.#buildBlas(game, batch.mesh);
    // 实例变了（批里的个数、槽位）或者有东西动了：重建 TLAS
    const key = batches.map((batch) => `${batch.mesh.id}:${batch.material.id}:${batch.material.version}:${batch.count}`).join(',');
    if (key !== this.#instanceKey || game.transforms.changedSlots().length > 0) this.#tlasDirty = true;
    this.#instanceKey = key;
    if (this.#tlasDirty && !this.#tlasBuilding && batches.every((batch) => this.#blas.get(batch.mesh) !== 'building')) this.#buildTlas(game, batches);
    this.#upload();
  }

  #buildBlas(game: Game, mesh: Mesh): void {
    this.#blas.set(mesh, 'building');
    const indices = Uint32Array.from(mesh.data.indices);
    void game.native.buildTriangleBvh(mesh.positions(), indices).then(({ nodes, triangles }) => {
      const blas = { nodeOffset: this.#nodeWords / NODE_WORDS, triangleOffset: this.#triangleWords / TRIANGLE_WORDS };
      this.#nodes = append(this.#nodes, this.#nodeWords, nodes) as Uint32Array;
      this.#nodeWords += nodes.length;
      this.#triangles = append(this.#triangles, this.#triangleWords, triangles) as Float32Array;
      this.#triangleWords += triangles.length;
      this.#blas.set(mesh, blas);
      this.#blasVersion++;
      this.#tlasDirty = true;
    }, (error: unknown) => console.error(`ray tracing: building the BVH of ${mesh.name} failed`, error));
  }

  #buildTlas(game: Game, batches: readonly MeshBatch[]): void {
    this.#tlasDirty = false;
    const world = game.transforms.renderWorld;
    const entries: { blas: Blas; slot: number; batch: MeshBatch }[] = [];
    for (const batch of batches) {
      const blas = this.#blas.get(batch.mesh);
      if (!blas || blas === 'building') continue;
      for (let i = 0; i < batch.count; i++) entries.push({ blas, slot: batch.slots[i]!, batch });
    }
    const boxes = new Float32Array(entries.length * 6);
    entries.forEach(({ slot, batch }, k) => worldBox(world, slot * 16, batch.mesh.cullBounds, boxes, k * 6));
    this.#tlasBuilding = true;
    void game.native.buildBoxBvh(boxes).then(({ nodes, order }) => {
      // 实例按叶子的顺序排：叶子里的"第一个图元"直接是实例的下标
      const instances = new Float32Array(Math.max(1, entries.length) * RT_INSTANCE_WORDS);
      const words = new Uint32Array(instances.buffer);
      for (let k = 0; k < entries.length; k++) {
        const { blas, slot, batch } = entries[order[k]!]!;
        const o = k * RT_INSTANCE_WORDS;
        inverseAffine(world, slot * 16, instances, o);
        words[o + 12] = blas.nodeOffset;
        words[o + 13] = blas.triangleOffset;
        const { baseColor, emissive } = batch.material;
        instances.set([baseColor.r, baseColor.g, baseColor.b, 1, emissive[0], emissive[1], emissive[2], 0], o + 16);
      }
      this.#tlas = { nodes, instances };
      this.instanceCount = entries.length;
    }, (error: unknown) => console.error('ray tracing: building the top-level BVH failed', error)).finally(() => {
      this.#tlasBuilding = false;
    });
  }

  #upload(): void {
    const device = this.#device;
    let changed = false;
    const write = (key: 'tlas' | 'instances' | 'blas' | 'triangles', label: string, data: ArrayBufferView & ArrayLike<number>, words: number) => {
      const bytes = Math.max(words, 4) * 4;
      let buffer = this.#buffers[key];
      if (!buffer || buffer.size < bytes) {
        buffer?.destroy();
        buffer = device.createBuffer({ label: `RayTracingScene ${label}`, size: 2 ** Math.ceil(Math.log2(bytes)), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
        this.#buffers[key] = buffer;
        changed = true;
      }
      device.queue.writeBuffer(buffer, 0, data.buffer, data.byteOffset, Math.max(words, 4) * 4);
    };
    if (this.#uploadedBlas !== this.#blasVersion && this.#nodeWords > 0) {
      write('blas', 'BLAS nodes', this.#nodes, this.#nodeWords);
      write('triangles', 'triangles', this.#triangles, this.#triangleWords);
      this.#uploadedBlas = this.#blasVersion;
    }
    const tlas = this.#tlas;
    if (tlas && tlas !== this.#uploadedTlas) {
      write('tlas', 'TLAS nodes', tlas.nodes, tlas.nodes.length);
      write('instances', 'instances', tlas.instances, tlas.instances.length);
      this.#uploadedTlas = tlas;
    }
    const { tlas: t, instances, blas, triangles } = this.#buffers;
    if (!t || !instances || !blas || !triangles) return;
    if (changed || !this.#group) {
      this.#group = device.createBindGroup({ label: 'RayTracingScene', layout: this.bindGroupLayout, entries: [t, instances, blas, triangles].map((buffer, binding) => ({ binding, resource: { buffer } })) });
    }
  }

  destroy(): void {
    for (const buffer of Object.values(this.#buffers)) buffer?.destroy();
  }
}

/** 光追得到的批：不透明、不蒙皮、不形变、不是地形的高度页网格、不是远处卡片。 */
function traceable(batch: MeshBatch): boolean {
  const mesh = batch.mesh;
  return batch.count > 0 && !batch.skinned && !batch.material.isTransparent && !mesh.heightfield && !mesh.impostor && mesh.data.morph === undefined;
}

function append(target: Uint32Array | Float32Array, used: number, data: Uint32Array | Float32Array): Uint32Array | Float32Array {
  let out = target;
  if (used + data.length > target.length) {
    out = new (target.constructor as Uint32ArrayConstructor | Float32ArrayConstructor)(2 ** Math.ceil(Math.log2(used + data.length)));
    out.set(target.subarray(0, used));
  }
  out.set(data, used);
  return out;
}

/** 局部包围盒按世界矩阵（列主序，渲染空间）变成世界的轴对齐盒，写到 out[at..at+6]。 */
function worldBox(world: Float32Array, m: number, bounds: { readonly min: readonly number[]; readonly max: readonly number[] }, out: Float32Array, at: number): void {
  for (let r = 0; r < 3; r++) {
    const center = (k: number) => (bounds.min[k]! + bounds.max[k]!) / 2, extent = (k: number) => (bounds.max[k]! - bounds.min[k]!) / 2;
    const c = world[m + r]! * center(0) + world[m + 4 + r]! * center(1) + world[m + 8 + r]! * center(2) + world[m + 12 + r]!;
    const e = Math.abs(world[m + r]!) * extent(0) + Math.abs(world[m + 4 + r]!) * extent(1) + Math.abs(world[m + 8 + r]!) * extent(2);
    out[at + r] = c - e;
    out[at + 3 + r] = c + e;
  }
}

/** 仿射的世界矩阵（列主序）的逆，按 3 行 × 4 写到 out[at..at+12]（第 r 行：local[r] = dot(row, (x, y, z, 1))）。 */
function inverseAffine(world: Float32Array, m: number, out: Float32Array, at: number): void {
  const a = world[m]!, b = world[m + 4]!, c = world[m + 8]!;
  const d = world[m + 1]!, e = world[m + 5]!, f = world[m + 9]!;
  const g = world[m + 2]!, h = world[m + 6]!, i = world[m + 10]!;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  const s = Math.abs(det) > 1e-20 ? 1 / det : 0;
  // 3x3 的逆（行主序）
  const inv = [
    A * s, -(b * i - c * h) * s, (b * f - c * e) * s,
    B * s, (a * i - c * g) * s, -(a * f - c * d) * s,
    C * s, -(a * h - b * g) * s, (a * e - b * d) * s,
  ];
  const tx = world[m + 12]!, ty = world[m + 13]!, tz = world[m + 14]!;
  for (let r = 0; r < 3; r++) {
    const row = inv.slice(r * 3, r * 3 + 3);
    out.set([row[0]!, row[1]!, row[2]!, -(row[0]! * tx + row[1]! * ty + row[2]! * tz)], at + r * 4);
  }
}
