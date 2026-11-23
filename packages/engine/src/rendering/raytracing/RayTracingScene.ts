/**
 * GPU 上的光追场景（路线图 R2，WebGPU 没有硬件光追，在计算着色器里遍历）：两层的 BVH——
 * - 底层（BLAS）：每个网格一棵，原生在工作线程上按 SAH 建（StrideNative.buildTriangleBvh），节点和三角形接在两个大缓冲里；
 * - 顶层（TLAS）：所有画出来的不透明实例的世界包围盒建一棵（buildBoxBvh），实例按叶子的顺序排；实例或变换变了才重建，新的
 *   建好以前接着用上一棵（晚一两帧，给全局光照用看不出来）。
 * 每个实例存世界矩阵的逆（射线变到网格自己的坐标里：方向不归一，所以 t 和世界里的一样）、BLAS 的起点、材质的颜色和自发光。
 * 着色器里用 RAY_TRACING_WGSL 的 rtTrace（最近的交点）和 rtNormal（世界的法线）。没算进去的：带蒙皮和形变的网格、地形的高度页
 * 网格、透明的材质。
 */
import type { Game } from '../../engine/Game';
import type { Mesh } from '../mesh/Mesh';
import { SurfaceColors } from './SurfaceColors';
import { RayTracedLighting } from './RayTracedLighting';
import { HEIGHT_PAGE_HEADER, HEIGHT_PAGE_SAMPLES } from '../mesh/HeightPages';
import type { MeshBatch } from '../mesh/MeshRenderFeature';

/** 一个实例几个 32 位：世界矩阵的逆（3 行 × 4）、BLAS 的节点和三角形起点、标志（第 1 位：双面的材质）、表面颜色的格号 + 1（0 是没有）、材质的颜色（rgba）、自发光（rgb、0）。 */
export const RT_INSTANCE_WORDS = 24;
const NODE_WORDS = 8;
/**
 * 一次遍历最多访问几个节点：坏了的 BVH（下标指回自己）也不会让着色器死循环、把显卡卡到驱动重置（DXGI_ERROR_DEVICE_HUNG，整个
 * 浏览器都卡死）。BLAS 里正常的射线几十到几百个；顶层在大世界里贴着地面横穿整张图的射线能过几千个实例的盒子，给得多些。
 */
const MAX_TRAVERSAL_STEPS = 4096;
const MAX_TLAS_STEPS = 16384;
const TRIANGLE_WORDS = 12;

/**
 * 光追的着色器代码（group 是绑定组号）：rtTrace(原点, 方向, 最远) 返回最近的交点（instance 是 0xffffffff 时没打到），
 * rtOccluded(原点, 方向, 最远) 只问挡没挡（阴影射线：碰到第一个交点就停，不找最近的，被挡住的射线快得多），
 * rtNormal 是交点的世界法线（朝着射线来的方向），rtBackFace 判断打到的是不是单面材质的背面，rtAlbedo、rtEmissive 是实例材质的
 * 颜色和自发光。
 */
export function rayTracingWgsl(group: number): string {
  return /* wgsl */ `
@group(${group}) @binding(0) var<storage, read> rtTlas: array<vec4u>;
@group(${group}) @binding(1) var<storage, read> rtInstances: array<vec4f>;
@group(${group}) @binding(2) var<storage, read> rtBlas: array<vec4u>;
@group(${group}) @binding(3) var<storage, read> rtTriangles: array<vec4f>;
// 表面颜色（SurfaceColors）：每格漫反射色和有没有、自发光
@group(${group}) @binding(4) var<storage, read> rtSurfaces: array<vec4f>;

struct RtHit {
  t: f32,
  instance: u32,
  triangle: u32,
  uv: vec2f,
  // 遍历走满了 MAX_TRAVERSAL_STEPS 步被截断（BVH 坏了：结果不可信）
  capped: bool,
  // 这次遍历最多的一个循环走了几步（调试用）
  steps: u32,
};

/** 射线和节点（两个 vec4u：最小角 + 第一个、最大角 + 个数）的盒子相交：进入的距离，没交上是 1e30。 */
fn rtBox(node0: vec4u, node1: vec4u, origin: vec3f, inverse: vec3f, tMax: f32) -> f32 {
  let t0 = (bitcast<vec3f>(node0.xyz) - origin) * inverse;
  let t1 = (bitcast<vec3f>(node1.xyz) - origin) * inverse;
  let near = max(max(min(t0.x, t1.x), min(t0.y, t1.y)), max(min(t0.z, t1.z), 0.0));
  let far = min(min(max(t0.x, t1.x), max(t0.y, t1.y)), min(max(t0.z, t1.z), tMax));
  return select(1e30, near, near <= far);
}

/** 一个实例的 BLAS 里最近的三角形（局部的射线，t 和世界里的一样），比 hit.t 近才改；any 时打到一个就停（阴影射线）。 */
fn rtTraceBlas(instance: u32, origin: vec3f, dir: vec3f, hit: ptr<function, RtHit>, any: bool) {
  let header = bitcast<vec4u>(rtInstances[instance * 6u + 3u]);
  let nodeBase = header.x;
  let triangleBase = header.y;
  let inverse = 1.0 / select(dir, vec3f(1e-20), abs(dir) < vec3f(1e-20));
  // 根节点也要先比盒子：根是叶子（一个三角形的网格）时下面直接按叶子算
  if (rtBox(rtBlas[nodeBase * 2u], rtBlas[nodeBase * 2u + 1u], origin, inverse, (*hit).t) >= 1e30) { return; }
  var stack: array<u32, 48>;
  var sp = 0u;
  var node = 0u;
  var steps = 0u;
  loop {
    if (steps >= ${MAX_TRAVERSAL_STEPS}u) {
      (*hit).capped = true;
      break;
    }
    steps++;
    let node0 = rtBlas[(nodeBase + node) * 2u];
    let node1 = rtBlas[(nodeBase + node) * 2u + 1u];
    if (node1.w == 0u) {
      // 内部节点：两个孩子挨着，先走近的
      let a = node0.w;
      let da = rtBox(rtBlas[(nodeBase + a) * 2u], rtBlas[(nodeBase + a) * 2u + 1u], origin, inverse, (*hit).t);
      let db = rtBox(rtBlas[(nodeBase + a + 1u) * 2u], rtBlas[(nodeBase + a + 1u) * 2u + 1u], origin, inverse, (*hit).t);
      if (da < 1e30 && db < 1e30 && sp < 48u) {
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
          *hit = RtHit(t, instance, triangleBase + i, vec2f(u, v), (*hit).capped, (*hit).steps);
          if (any) {
            (*hit).steps = max((*hit).steps, steps);
            return;
          }
        }
      }
    }
    if (sp == 0u) { break; }
    sp--;
    node = stack[sp];
  }
  (*hit).steps = max((*hit).steps, steps);
}

/** 最近的交点（世界的射线，dir 可以不归一；没打到时 instance 是 0xffffffff，t 是 tMax）。 */
fn rtTrace(origin: vec3f, dir: vec3f, tMax: f32) -> RtHit {
  return rtTraverse(origin, dir, tMax, false);
}

/** 原点到 tMax 之间有没有挡着的（阴影射线）：打到任何一个三角形就停。 */
fn rtOccluded(origin: vec3f, dir: vec3f, tMax: f32) -> bool {
  return rtTraverse(origin, dir, tMax, true).instance != 0xffffffffu;
}

/** 两层 BVH 的遍历：any 是假时找最近的交点，真时打到任何一个就停。 */
fn rtTraverse(origin: vec3f, dir: vec3f, tMax: f32, any: bool) -> RtHit {
  var hit = RtHit(tMax, 0xffffffffu, 0u, vec2f(0.0), false, 0u);
  if (arrayLength(&rtTlas) < 2u) { return hit; }
  let inverse = 1.0 / select(dir, vec3f(1e-20), abs(dir) < vec3f(1e-20));
  var stack: array<u32, 48>;
  var sp = 0u;
  var node = 0u;
  if (rtBox(rtTlas[0], rtTlas[1], origin, inverse, tMax) >= 1e30) { return hit; }
  var steps = 0u;
  loop {
    if (steps >= ${MAX_TLAS_STEPS}u) {
      hit.capped = true;
      break;
    }
    steps++;
    let node0 = rtTlas[node * 2u];
    let node1 = rtTlas[node * 2u + 1u];
    if (node1.w == 0u) {
      let a = node0.w;
      let da = rtBox(rtTlas[a * 2u], rtTlas[a * 2u + 1u], origin, inverse, hit.t);
      let db = rtBox(rtTlas[(a + 1u) * 2u], rtTlas[(a + 1u) * 2u + 1u], origin, inverse, hit.t);
      if (da < 1e30 && db < 1e30 && sp < 48u) {
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
        rtTraceBlas(i, o, d, &hit, any);
        if (any && hit.instance != 0xffffffffu) {
          hit.steps = max(hit.steps, steps);
          return hit;
        }
      }
    }
    if (sp == 0u) { break; }
    sp--;
    node = stack[sp];
  }
  hit.steps = max(hit.steps, steps);
  return hit;
}

/** 交点的世界几何法线，朝着三角形的正面（逆时针是正面，同光栅化的 frontFace: 'ccw'）。 */
fn rtFaceNormal(hit: RtHit) -> vec3f {
  let e1 = rtTriangles[hit.triangle * 3u + 1u].xyz;
  let e2 = rtTriangles[hit.triangle * 3u + 2u].xyz;
  let local = cross(e1, e2);
  // 法线按逆矩阵的转置变到世界
  let r0 = rtInstances[hit.instance * 6u].xyz;
  let r1 = rtInstances[hit.instance * 6u + 1u].xyz;
  let r2 = rtInstances[hit.instance * 6u + 2u].xyz;
  return normalize(r0 * local.x + r1 * local.y + r2 * local.z);
}

/** 交点的世界法线（几何的，朝着射线来的那面）。 */
fn rtNormal(hit: RtHit, dir: vec3f) -> vec3f {
  let n = rtFaceNormal(hit);
  return select(n, -n, dot(n, dir) > 0.0);
}

/** 射线打到的是单面材质的背面（光栅化时剔掉的那面：探针在墙里、物体里）；双面的材质两面都算正面。 */
fn rtBackFace(hit: RtHit, dir: vec3f) -> bool {
  let doubleSided = (bitcast<vec4u>(rtInstances[hit.instance * 6u + 3u]).z & 1u) != 0u;
  return !doubleSided && dot(rtFaceNormal(hit), dir) > 0.0;
}

/** 实例的表面颜色在 rtSurfaces 里的下标（烘好了的），没有时 -1。 */
fn rtSurface(hit: RtHit) -> i32 {
  let tile = bitcast<vec4u>(rtInstances[hit.instance * 6u + 3u]).w;
  if (tile == 0u || rtSurfaces[(tile - 1u) * 2u].a < 0.5) { return -1; }
  return i32(tile - 1u) * 2;
}

/** 打到的表面的漫反射色：烘好的材质平均色（贴图、颜色树、节点图都算），还没烘好时是材质的颜色。 */
fn rtAlbedo(hit: RtHit) -> vec3f {
  let surface = rtSurface(hit);
  return select(rtInstances[hit.instance * 6u + 4u].rgb, rtSurfaces[max(surface, 0)].rgb, surface >= 0);
}

fn rtEmissive(hit: RtHit) -> vec3f {
  let surface = rtSurface(hit);
  return select(rtInstances[hit.instance * 6u + 5u].rgb, rtSurfaces[max(surface, 0) + 1].rgb, surface >= 0);
}
`;
}

/** 一个几何（网格，或者地形块的一页高度）的 BLAS 在大缓冲里的位置和长度（float/u32 个数），局部的包围盒。 */
interface Blas {
  readonly nodeOffset: number;
  readonly nodeWords: number;
  readonly triangleOffset: number;
  readonly triangleWords: number;
  readonly bounds: { readonly min: readonly number[]; readonly max: readonly number[] };
  /** 网格原来几个三角形、BVH 里用了几个（太多时原生先简化）。 */
  readonly sourceTriangles: number;
  readonly triangles: number;
}

/** 一个实例用哪个几何：网格的按网格认，地形块的按高度页和它写过几次（`page:版本`）。 */
type GeometryKey = Mesh | string;

/** 顶层的一个实例。 */
interface Entry {
  readonly geometry: GeometryKey;
  readonly slot: number;
  readonly batch: MeshBatch;
  /** 表面颜色的那一格（SurfaceColors 的键）。 */
  readonly surface: object | string;
}

/**
 * 一个网格进 BVH 最多几个三角形，多了原生把小零件按格子换成包围盒（sn_bvh_build_triangles 的 max_triangles）：光追只算间接光、
 * 反射里的大致形状，打到的颜色是整个批的平均色（SurfaceColors），货架连同几千件商品的几十万个三角形没必要原样进去。
 */
const MAX_BLAS_TRIANGLES = 65536;
/** 地形块光追用的网格隔几个高度取一个（32 格的块取成 16 格：间接光够了，BVH 小四倍）。 */
const TERRAIN_STEP = 2;
/** 不再用的 BLAS 占的比用着的多（而且超过这么多 u32）时整理大缓冲。 */
const COMPACT_MIN_WORDS = 1 << 20;

/** 光追场景（RenderSystem.rayTracing）：用到它的特性（全局光照、调试视图）每帧先 update，再按 bindGroupLayout 绑它的缓冲。 */
export class RayTracingScene {
  readonly #device: GPUDevice;
  readonly #blas = new Map<GeometryKey, Blas | 'building'>();
  #nodes: Uint32Array = new Uint32Array(1 << 12);
  #nodeWords = 0;
  #triangles: Float32Array = new Float32Array(1 << 12);
  #triangleWords = 0;
  /** 大缓冲里已经不用的 u32 个数（几何没了，整理时去掉）。 */
  #wastedWords = 0;
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
  #surfaceBuffer: GPUBuffer | undefined;
  /** 每个表面的平均漫反射色和自发光（光追打到的表面的颜色），前向渲染器在 pending 的帧画。 */
  readonly surfaces: SurfaceColors;
  /** 光追打到的表面受的光（这一帧的光照），用到光追的帧前向渲染器写一次。 */
  readonly lighting: RayTracedLighting;
  /** 上次 update 是第几帧（一帧里几个特性都用到光追时只更新一次）。 */
  #updatedFrame = -1;
  /** 顶层里有几个实例（统计）。 */
  instanceCount = 0;
  /** 传上去的场景变了（新的 BLAS 或者 TLAS）就加一：用光追结果的特性按它判断要不要重算。 */
  version = 0;

  constructor(device: GPUDevice) {
    this.#device = device;
    this.surfaces = new SurfaceColors(device);
    this.lighting = new RayTracedLighting(device);
  }

  /** 五个只读的存储缓冲（TLAS、实例、BLAS、三角形、表面颜色），计算着色器用。 */
  get bindGroupLayout(): GPUBindGroupLayout {
    return (this.#layout ??= this.#device.createBindGroupLayout({
      label: 'RayTracingScene',
      entries: [0, 1, 2, 3, 4].map((binding) => ({ binding, visibility: GPUShaderStage.COMPUTE | GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' as const } })),
    }));
  }

  /** 这一帧的绑定组（update 以后）；还没有能遍历的场景时 undefined。 */
  get bindGroup(): GPUBindGroup | undefined {
    return this.#group;
  }

  /** 几何的 BLAS 都建好了、顶层也建好了。 */
  /** BLAS 的个数、网格原来的和 BVH 里用的三角形数、大缓冲占的字节（调试命令 raytrace-stats）。 */
  stats(): { readonly blas: number; readonly building: number; readonly sourceTriangles: number; readonly triangles: number; readonly bytes: number } {
    let blas = 0, building = 0, sourceTriangles = 0, triangles = 0;
    for (const entry of this.#blas.values()) {
      if (entry === 'building') {
        building++;
        continue;
      }
      blas++;
      sourceTriangles += entry.sourceTriangles;
      triangles += entry.triangles;
    }
    return { blas, building, sourceTriangles, triangles, bytes: (this.#nodeWords + this.#triangleWords) * 4 };
  }

  get ready(): boolean {
    return this.#tlas !== undefined && ![...this.#blas.values()].includes('building') && !this.#tlasBuilding;
  }

  /** 每帧（用到光追的那帧）：给新几何建 BLAS，实例或变换变了重建 TLAS，建好的传上去。 */
  update(game: Game): void {
    if (this.#updatedFrame === game.frames) return;
    this.#updatedFrame = game.frames;
    const meshes = game.meshes;
    const entries: Entry[] = [];
    for (const batch of meshes.batches) {
      if (!traceable(batch)) continue;
      for (let i = 0; i < batch.count; i++) {
        const slot = batch.slots[i]!;
        if (batch.mesh.heightfield) {
          const page = meshes.heightPageOf(slot);
          const key = `${page}:${meshes.heightPages.versionOf(page)}`;
          entries.push({ geometry: key, slot, batch, surface: key });
        } else {
          entries.push({ geometry: batch.mesh, slot, batch, surface: batch });
        }
      }
    }
    const surfaces = new Map<object | string, Entry>();
    for (const entry of entries) if (!surfaces.has(entry.surface)) surfaces.set(entry.surface, entry);
    this.surfaces.assign([...surfaces.values()].map(({ surface, batch, slot }) => ({ key: surface, batch, slot })), meshes);
    const live = new Set<GeometryKey>();
    for (const { geometry, batch } of entries) {
      live.add(geometry);
      if (!this.#blas.has(geometry)) this.#buildBlas(game, geometry, batch.mesh);
    }
    this.#forget(live);
    // 实例变了（几何、材质、槽位）或者有东西动了：重建 TLAS
    const key = entries.map(({ geometry, batch, slot }) => `${typeof geometry === 'string' ? geometry : geometry.id}:${batch.material.id}:${batch.material.version}:${slot}`).join(',');
    if (key !== this.#instanceKey || game.transforms.changedSlots().length > 0) this.#tlasDirty = true;
    this.#instanceKey = key;
    if (this.#tlasDirty && !this.#tlasBuilding && entries.every(({ geometry }) => this.#blas.get(geometry) !== 'building')) this.#buildTlas(game, entries);
    this.#upload();
  }

  /** 网格的 BLAS 按网格的顶点建；地形块的按它那页高度建（隔 TERRAIN_STEP 取一个，坐标同高度场的顶点着色器：格坐标、高度）。 */
  #buildBlas(game: Game, geometry: GeometryKey, mesh: Mesh): void {
    this.#blas.set(geometry, 'building');
    const { positions, indices } = typeof geometry === 'string' ? terrainGrid(game.meshes.heightPages.data, Number(geometry.split(':')[0])) : { positions: mesh.positions(), indices: Uint32Array.from(mesh.data.indices) };
    const bounds = boundsOf(positions);
    const name = typeof geometry === 'string' ? `terrain page ${geometry}` : mesh.name;
    void game.native.buildTriangleBvh(positions, indices, { maxTriangles: MAX_BLAS_TRIANGLES }).then(({ nodes, triangles, triangleCount }) => {
      // 等着建的时候几何没了（地形块换了页）：不要了
      if (this.#blas.get(geometry) !== 'building') return;
      const blas: Blas = {
        nodeOffset: this.#nodeWords / NODE_WORDS, nodeWords: nodes.length, triangleOffset: this.#triangleWords / TRIANGLE_WORDS, triangleWords: triangles.length, bounds,
        sourceTriangles: indices.length / 3, triangles: triangleCount,
      };
      this.#nodes = append(this.#nodes, this.#nodeWords, nodes) as Uint32Array;
      this.#nodeWords += nodes.length;
      this.#triangles = append(this.#triangles, this.#triangleWords, triangles) as Float32Array;
      this.#triangleWords += triangles.length;
      this.#blas.set(geometry, blas);
      this.#blasVersion++;
      this.#tlasDirty = true;
    }, (error: unknown) => {
      this.#blas.delete(geometry);
      console.error(`ray tracing: building the BVH of ${name} failed`, error);
    });
  }

  /** 这一帧没用到的几何去掉；不用的占得比用着的多时把大缓冲整理紧（偏移都变了：顶层重建好以前不给绑定组）。 */
  #forget(live: ReadonlySet<GeometryKey>): void {
    for (const [geometry, blas] of this.#blas) {
      if (live.has(geometry)) continue;
      this.#blas.delete(geometry);
      if (blas !== 'building') this.#wastedWords += blas.nodeWords + blas.triangleWords;
    }
    if (this.#wastedWords < COMPACT_MIN_WORDS || this.#wastedWords < this.#nodeWords + this.#triangleWords - this.#wastedWords) return;
    const nodes = new Uint32Array(this.#nodes.length), triangles = new Float32Array(this.#triangles.length);
    let nodeWords = 0, triangleWords = 0;
    for (const [geometry, blas] of this.#blas) {
      if (blas === 'building') continue;
      nodes.set(this.#nodes.subarray(blas.nodeOffset * NODE_WORDS, blas.nodeOffset * NODE_WORDS + blas.nodeWords), nodeWords);
      triangles.set(this.#triangles.subarray(blas.triangleOffset * TRIANGLE_WORDS, blas.triangleOffset * TRIANGLE_WORDS + blas.triangleWords), triangleWords);
      this.#blas.set(geometry, { ...blas, nodeOffset: nodeWords / NODE_WORDS, triangleOffset: triangleWords / TRIANGLE_WORDS });
      nodeWords += blas.nodeWords;
      triangleWords += blas.triangleWords;
    }
    this.#nodes = nodes;
    this.#triangles = triangles;
    this.#nodeWords = nodeWords;
    this.#triangleWords = triangleWords;
    this.#wastedWords = 0;
    this.#blasVersion++;
    this.#tlas = undefined;
    this.#uploadedTlas = undefined;
    this.#group = undefined;
    this.#tlasDirty = true;
  }

  #buildTlas(game: Game, all: readonly Entry[]): void {
    this.#tlasDirty = false;
    const world = game.transforms.renderWorld;
    const entries: (Entry & { blas: Blas })[] = [];
    for (const entry of all) {
      const blas = this.#blas.get(entry.geometry);
      if (blas && blas !== 'building') entries.push({ ...entry, blas });
    }
    if (entries.length === 0) {
      // 没有能光追的实例：不建 TLAS（空的 BVH 的根是个数为 0、盒子反着的节点，GPU 上会当成指回自己的内部节点死循环），也不给绑定组
      this.#tlas = undefined;
      this.#uploadedTlas = undefined;
      this.#group = undefined;
      this.instanceCount = 0;
      return;
    }
    const boxes = new Float32Array(entries.length * 6);
    entries.forEach(({ slot, blas }, k) => worldBox(world, slot * 16, blas.bounds, boxes, k * 6));
    this.#tlasBuilding = true;
    const blasVersion = this.#blasVersion;
    void game.native.buildBoxBvh(boxes).then(({ nodes, order }) => {
      // 建的时候大缓冲整理过（偏移变了）：这棵作废，下一帧重建
      if (blasVersion !== this.#blasVersion && this.#tlas === undefined) return;
      // 实例按叶子的顺序排：叶子里的"第一个图元"直接是实例的下标
      const instances = new Float32Array(Math.max(1, entries.length) * RT_INSTANCE_WORDS);
      const words = new Uint32Array(instances.buffer);
      for (let k = 0; k < entries.length; k++) {
        const { blas, slot, batch, surface } = entries[order[k]!]!;
        const o = k * RT_INSTANCE_WORDS;
        inverseAffine(world, slot * 16, instances, o);
        words[o + 12] = blas.nodeOffset;
        words[o + 13] = blas.triangleOffset;
        words[o + 14] = batch.material.doubleSided ? 1 : 0;
        words[o + 15] = (this.surfaces.tileOf(surface) ?? -1) + 1;
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
        buffer = device.createBuffer({ label: `RayTracingScene ${label}`, size: 2 ** Math.ceil(Math.log2(bytes)), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
        this.#buffers[key] = buffer;
        changed = true;
      }
      device.queue.writeBuffer(buffer, 0, data.buffer, data.byteOffset, Math.max(words, 4) * 4);
    };
    if (this.#uploadedBlas !== this.#blasVersion && this.#nodeWords > 0) {
      write('blas', 'BLAS nodes', this.#nodes, this.#nodeWords);
      write('triangles', 'triangles', this.#triangles, this.#triangleWords);
      this.#uploadedBlas = this.#blasVersion;
      this.version++;
    }
    const tlas = this.#tlas;
    if (tlas && tlas !== this.#uploadedTlas) {
      write('tlas', 'TLAS nodes', tlas.nodes, tlas.nodes.length);
      write('instances', 'instances', tlas.instances, tlas.instances.length);
      this.#uploadedTlas = tlas;
      this.version++;
    }
    const { tlas: t, instances, blas, triangles } = this.#buffers;
    if (!this.#tlas || !t || !instances || !blas || !triangles) return;
    const surfaces = this.surfaces.buffer;
    if (changed || !this.#group || surfaces !== this.#surfaceBuffer) {
      this.#surfaceBuffer = surfaces;
      this.#group = device.createBindGroup({ label: 'RayTracingScene', layout: this.bindGroupLayout, entries: [t, instances, blas, triangles, surfaces].map((buffer, binding) => ({ binding, resource: { buffer } })) });
    }
  }

  /** 读回 GPU 上的四个缓冲（调试：check、和 CPU 上照着着色器走一遍比）；还没建好时 undefined。 */
  async readBack(): Promise<{ tlas: Uint32Array; instances: Uint32Array; blas: Uint32Array; triangles: Uint32Array } | undefined> {
    const { tlas, instances, blas, triangles } = this.#buffers;
    if (!tlas || !instances || !blas || !triangles) return undefined;
    const read = async (buffer: GPUBuffer) => {
      const readback = this.#device.createBuffer({ size: buffer.size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      const encoder = this.#device.createCommandEncoder();
      encoder.copyBufferToBuffer(buffer, 0, readback, 0, buffer.size);
      this.#device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ);
      const words = new Uint32Array(readback.getMappedRange().slice(0));
      readback.destroy();
      return words;
    };
    const [t, i, b, tr] = await Promise.all([tlas, instances, blas, triangles].map(read));
    return { tlas: t!, instances: i!, blas: b!, triangles: tr! };
  }

  /**
   * 查 GPU 上的数据（调试命令 raytrace-check）：读回四个缓冲，每个实例的 BLAS、顶层的 TLAS 按 GPU 的走法遍历一遍，报下标越界、
   * 有环（走回走过的节点）、叶子的三角形越界。
   */
  async check(): Promise<{ instances: number; problems: string[] }> {
    const data = await this.readBack();
    if (!data) return { instances: 0, problems: ['not built'] };
    const { tlas: tlasWords, instances: instanceWords, blas: blasWords, triangles: triangleWords } = data;
    const problems: string[] = [];
    const walk = (label: string, words: Uint32Array, base: number, leaf: (first: number, count: number) => void) => {
      const seen = new Set<number>();
      const stack = [0];
      while (stack.length > 0 && problems.length < 20) {
        const node = stack.pop()!;
        const at = (base + node) * NODE_WORDS;
        if (at + NODE_WORDS > words.length) { problems.push(`${label}: node ${node} is outside the buffer`); continue; }
        if (seen.has(node)) { problems.push(`${label}: node ${node} is reached twice (cycle)`); continue; }
        seen.add(node);
        const first = words[at + 3]!, count = words[at + 7]!;
        if (count === 0) {
          if (first <= node) problems.push(`${label}: interior node ${node} has children at ${first} (not after it)`);
          else stack.push(first, first + 1);
        } else leaf(first, count);
      }
    };
    const count = this.instanceCount;
    walk('TLAS', tlasWords, 0, (first, n) => {
      if (first + n > count) problems.push(`TLAS: leaf instances ${first}..${first + n} past ${count}`);
    });
    for (let i = 0; i < count && problems.length < 20; i++) {
      const nodeBase = instanceWords[i * RT_INSTANCE_WORDS + 12]!, triangleBase = instanceWords[i * RT_INSTANCE_WORDS + 13]!;
      walk(`instance ${i} (BLAS at ${nodeBase})`, blasWords, nodeBase, (first, n) => {
        if ((triangleBase + first + n) * TRIANGLE_WORDS > triangleWords.length) problems.push(`instance ${i}: triangles ${triangleBase + first}..${triangleBase + first + n} past the buffer`);
      });
    }
    return { instances: count, problems };
  }

  destroy(): void {
    this.surfaces.destroy();
    this.lighting.destroy();
    for (const buffer of Object.values(this.#buffers)) buffer?.destroy();
  }
}

/**
 * 光追得到的批：不透明、不蒙皮、不形变、不是远处卡片、有三角形（空网格的 BVH 根是个数为 0 的叶子，GPU 上和内部节点分不开）。
 * 地形块（高度页的网格）按每块的高度建。
 */
function traceable(batch: MeshBatch): boolean {
  const mesh = batch.mesh;
  return batch.count > 0 && batch.visibleInRayTracing && mesh.data.indices.length >= 3 && !batch.skinned && !batch.material.isTransparent && !mesh.impostor && mesh.data.morph === undefined;
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

/**
 * 地形块那页高度的光追网格（同 meshShader 的 heightfieldVertex：x、z 是格坐标 0..32，y 是高度，不要裙边），每隔 TERRAIN_STEP 取一个；
 * 三角形逆时针朝上（同光栅化的正面）。
 */
function terrainGrid(data: Float32Array, page: number): { positions: Float32Array; indices: Uint32Array } {
  const cells = HEIGHT_PAGE_SAMPLES - 3, n = cells / TERRAIN_STEP + 1;
  const positions = new Float32Array(n * n * 3);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = i * TERRAIN_STEP, z = j * TERRAIN_STEP;
      positions.set([x, data[page + HEIGHT_PAGE_HEADER + (z + 1) * HEIGHT_PAGE_SAMPLES + x + 1]!, z], (j * n + i) * 3);
    }
  }
  const indices = new Uint32Array((n - 1) * (n - 1) * 6);
  for (let j = 0, k = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++, k += 6) {
      const a = j * n + i, b = a + n;
      indices.set([a, b, a + 1, a + 1, b, b + 1], k);
    }
  }
  return { positions, indices };
}

/** 顶点（xyz 连着）的包围盒。 */
function boundsOf(positions: Float32Array): { min: number[]; max: number[] } {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let v = 0; v < positions.length; v += 3) {
    for (let c = 0; c < 3; c++) {
      min[c] = Math.min(min[c]!, positions[v + c]!);
      max[c] = Math.max(max[c]!, positions[v + c]!);
    }
  }
  return positions.length > 0 ? { min, max } : { min: [0, 0, 0], max: [0, 0, 0] };
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
