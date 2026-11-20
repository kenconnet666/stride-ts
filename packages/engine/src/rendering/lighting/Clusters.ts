/**
 * 分簇（Olsson 2012 "Clustered Deferred and Forward Shading"，Doom 2016 的分簇前向）：视图按屏幕分成 16x9 格、沿视线按
 * 指数分 24 层，每一簇记下和它相交的点光、聚光、贴花、反射探针（按包围球）。网格着色时像素只看自己那一簇的，不再把所有的都看一遍。
 *
 * - 要着色的视图（主画面、反射探针的面、渲染目标贴图的相机）各占一个槽（RenderView.clusterSlot），每个视图在它不透明的那一遍
 *   之前算一次（ForwardRenderer）。CPU 每帧把光、贴花、反射探针的包围球（世界坐标的球心、半径）传上去一次，所有视图共用。
 * - 计算着色器每个线程一个簇：算簇在视图空间里的包围盒，先数和它相交的光、贴花、探针，原子加从这个视图的索引池里拿一段，再按
 *   下标从小到大写进去（贴花的先后、探针从小到大的先后不变）。每簇的个数不设上限；池子放不下时这一帧截断（先保光，再贴花），
 *   读回这一帧要了多少，下一帧把池子扩大（按 2 的幂）。
 * - 缓冲的布局（u32）：先是各槽的簇头，每槽 HEADER_WORDS 个（第 0 个是池子的计数器，然后每簇三个：这一簇的索引在整个缓冲里
 *   的起点、光数 | 贴花数 << 16、探针数；索引按光、贴花、探针排），再是各槽的索引池，每槽 capacity 个。网格着色器绑整个缓冲。
 * - 层的深度：第 k 层到 near · (far / near)^((k + 1) / 24)，near、far 是视图的近、远平面。着色器按像素到相机的视线方向的
 *   距离（世界坐标和视图的前方点乘）算层：clusterParams 给的两个 vec4 放在视图常量里。
 * - 没有光和贴花时不分。点光、聚光因此不设总数的上限。
 */
import { Matrix } from '../../data/Matrix';
import type { RenderView } from '../RenderSystem';

/** 簇的格子：屏幕横、竖几格，沿视线几层。 */
export const CLUSTER_GRID = [16, 9, 24] as const;
const CLUSTER_COUNT = CLUSTER_GRID[0] * CLUSTER_GRID[1] * CLUSTER_GRID[2];
/** 每簇的簇头几个 u32：起点、光数 | 贴花数 << 16、探针数。 */
const CLUSTER_HEADER = 3;
/** 一个槽的簇头占几个 u32：计数器加每簇 CLUSTER_HEADER 个，补到 64 的倍数（按槽绑定时偏移要对齐 256 字节）。 */
const HEADER_WORDS = Math.ceil((1 + CLUSTER_HEADER * CLUSTER_COUNT) / 64) * 64;
/** 每个槽的索引池一开始的大小（平均每簇 16 个），不够时按 2 的幂变大。 */
const INITIAL_CAPACITY = CLUSTER_COUNT * 16;
/** 最多几个槽（视图）；再多的视图不分簇（看所有的光和贴花），第一次超出时警告。 */
const MAX_TABLES = 64;
const WORKGROUP = 64;

/**
 * 视图常量里的分簇参数（两个 vec4）：(格数 / 视图宽、格数 / 视图高、层数 / ln(far / near)、槽 + 1)，(视图的前方, ln near)。
 * 没分簇时第一个的 w 是 0。
 */
export function clusterParams(view: RenderView): [number, number, number, number, number, number, number, number] {
  if (!view.clustered) return [0, 0, 0, 0, 0, 0, 0, 0];
  const { near, far } = clusterDepthRange(view);
  // 视图矩阵的第三行是视图空间的 +Z（相机朝 -Z 看）
  const v = view.view;
  return [
    CLUSTER_GRID[0] / Math.max(1, view.width), CLUSTER_GRID[1] / Math.max(1, view.height), CLUSTER_GRID[2] / Math.log(far / near), view.clusterSlot + 1,
    -v[2]!, -v[6]!, -v[10]!, Math.log(near),
  ];
}

/** 分层用的深度范围：视图的近、远平面（近平面太近时层都挤在相机前面，至少 5 厘米）。 */
export function clusterDepthRange(view: RenderView): { near: number; far: number } {
  const near = Math.max(view.nearClipPlane, 0.05);
  return { near, far: Math.max(view.farClipPlane, near * 2) };
}

/** 像素所在的簇在这个视图里的下标（单测用，和着色器的 clusterOf 同一个算法）：x、y 是视图里的像素，depth 是沿视线的距离。 */
export function clusterIndex(view: RenderView, x: number, y: number, depth: number): number {
  const [sx, sy, scale, , , , , logNear] = clusterParams(view);
  const slice = Math.min(CLUSTER_GRID[2] - 1, Math.max(0, Math.floor((Math.log(Math.max(depth, 1e-4)) - logNear) * scale)));
  const tx = Math.min(CLUSTER_GRID[0] - 1, Math.floor(x * sx)), ty = Math.min(CLUSTER_GRID[1] - 1, Math.floor(y * sy));
  return (slice * CLUSTER_GRID[1] + ty) * CLUSTER_GRID[0] + tx;
}

/** 网格着色器的 clusterOf 用的常量。 */
export const CLUSTER_WGSL = /* wgsl */ `
const CLUSTER_X = ${CLUSTER_GRID[0]}u;
const CLUSTER_Y = ${CLUSTER_GRID[1]}u;
const CLUSTER_Z = ${CLUSTER_GRID[2]}u;
const CLUSTER_HEADER_WORDS = ${HEADER_WORDS}u;
const CLUSTER_HEADER = ${CLUSTER_HEADER}u;
`;

const BUILD_SHADER = /* wgsl */ `
${CLUSTER_WGSL}
struct Build {
  inverseProjection: mat4x4f,
  view: mat4x4f,
  // x：光的个数，y：贴花的个数，z：近平面的视线距离，w：远平面的
  counts: vec4f,
  // x：这个槽的索引池在整个缓冲里的起点（u32 的下标），y：池子的大小，z：探针的个数（球排在贴花后面）
  pool: vec4u,
};
struct Header {
  // 这一帧要了多少个下标（截断之前），CPU 读回来定池子的大小
  requested: atomic<u32>,
  // 每簇 CLUSTER_HEADER 个：起点、光数 | 贴花数 << 16、探针数
  entries: array<u32>,
};
@group(0) @binding(0) var<uniform> build: Build;
// 先光后贴花：球心（世界）和半径
@group(0) @binding(1) var<storage, read> spheres: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> header: Header;
@group(0) @binding(3) var<storage, read_write> pool: array<u32>;

/** 屏幕上 ndc 那一点、沿视线距离 depth 处的视图空间坐标（透视、正交都对：在近、远平面上各取一点，按距离插值）。 */
fn pointAt(ndc: vec2f, depth: f32) -> vec3f {
  let a = build.inverseProjection * vec4f(ndc, 0.0, 1.0);
  let b = build.inverseProjection * vec4f(ndc, 1.0, 1.0);
  let p0 = a.xyz / a.w;
  let p1 = b.xyz / b.w;
  let t = (depth + p0.z) / (p0.z - p1.z);
  return mix(p0, p1, t);
}

var<private> lo: vec3f;
var<private> hi: vec3f;

/** 第 i 个球和这一簇的包围盒相不相交。 */
fn touches(i: u32) -> bool {
  let sphere = spheres[i];
  let center = (build.view * vec4f(sphere.xyz, 1.0)).xyz;
  let offset = center - clamp(center, lo, hi);
  return dot(offset, offset) <= sphere.w * sphere.w;
}

@compute @workgroup_size(${WORKGROUP}) fn main(@builtin(global_invocation_id) id: vec3u) {
  let index = id.x;
  if (index >= CLUSTER_X * CLUSTER_Y * CLUSTER_Z) {
    return;
  }
  let x = index % CLUSTER_X;
  let y = (index / CLUSTER_X) % CLUSTER_Y;
  let z = index / (CLUSTER_X * CLUSTER_Y);
  // 这一簇的视图空间包围盒：屏幕上的一格（y 向下）乘这一层的前后两个深度
  let near = build.counts.z;
  let far = build.counts.w;
  let d0 = near * pow(far / near, f32(z) / f32(CLUSTER_Z));
  let d1 = near * pow(far / near, f32(z + 1u) / f32(CLUSTER_Z));
  let ndcMin = vec2f(f32(x) / f32(CLUSTER_X) * 2.0 - 1.0, 1.0 - f32(y + 1u) / f32(CLUSTER_Y) * 2.0);
  let ndcMax = vec2f(f32(x + 1u) / f32(CLUSTER_X) * 2.0 - 1.0, 1.0 - f32(y) / f32(CLUSTER_Y) * 2.0);
  lo = vec3f(1e30);
  hi = vec3f(-1e30);
  for (var corner = 0u; corner < 8u; corner++) {
    let ndc = vec2f(select(ndcMin.x, ndcMax.x, (corner & 1u) != 0u), select(ndcMin.y, ndcMax.y, (corner & 2u) != 0u));
    let p = pointAt(ndc, select(d0, d1, (corner & 4u) != 0u));
    lo = min(lo, p);
    hi = max(hi, p);
  }
  let lightCount = u32(build.counts.x);
  let decalEnd = lightCount + u32(build.counts.y);
  let total = decalEnd + build.pool.z;
  // 先数，再从池子里拿一段（光、贴花的个数各自不超过 16 位）
  var lights = 0u;
  var decals = 0u;
  var probes = 0u;
  for (var i = 0u; i < total; i++) {
    if (touches(i)) {
      if (i < lightCount) { lights++; } else if (i < decalEnd) { decals++; } else { probes++; }
    }
  }
  lights = min(lights, 0xffffu);
  decals = min(decals, 0xffffu);
  let offset = atomicAdd(&header.requested, lights + decals + probes);
  // 池子不够时截断：先保光，再贴花
  let room = select(0u, build.pool.y - offset, offset < build.pool.y);
  let keptLights = min(lights, room);
  let keptDecals = min(decals, room - keptLights);
  let keptProbes = min(probes, room - keptLights - keptDecals);
  var writtenLights = 0u;
  var writtenDecals = 0u;
  var writtenProbes = 0u;
  for (var i = 0u; i < total && writtenLights + writtenDecals + writtenProbes < keptLights + keptDecals + keptProbes; i++) {
    if (!touches(i)) {
      continue;
    }
    if (i < lightCount) {
      if (writtenLights < keptLights) {
        pool[offset + writtenLights] = i;
        writtenLights++;
      }
    } else if (i < decalEnd) {
      if (writtenDecals < keptDecals) {
        pool[offset + keptLights + writtenDecals] = i - lightCount;
        writtenDecals++;
      }
    } else if (writtenProbes < keptProbes) {
      pool[offset + keptLights + keptDecals + writtenProbes] = i - decalEnd;
      writtenProbes++;
    }
  }
  header.entries[index * CLUSTER_HEADER] = build.pool.x + offset;
  header.entries[index * CLUSTER_HEADER + 1u] = keptLights | (keptDecals << 16u);
  header.entries[index * CLUSTER_HEADER + 2u] = keptProbes;
}
`;

/**
 * 各视图的簇（渲染系统一份）：reserve 定这一帧要几个槽，upload 传光和贴花的包围球，再在各视图不透明的那一遍之前 record；
 * 网格着色时绑 buffer、按视图常量里的槽号找自己的簇头。
 */
export class Clusters {
  /** 簇头和索引池（布局见文件头）；槽多了、池子不够时换一个更大的。 */
  buffer: GPUBuffer;
  readonly #device: GPUDevice;
  /** 缓冲按几个槽、每槽多大的池子建的。 */
  #tables = 0;
  #capacity = INITIAL_CAPACITY;
  /** 读回的这几帧里某个槽要的最多的下标数；超过 #capacity 时下一次 reserve 扩大池子。 */
  #requested = 0;
  readonly #uniforms: GPUBuffer[] = [];
  readonly #groups: (GPUBindGroup | undefined)[] = [];
  readonly #uniformData = new Float32Array(40);
  /** 这一帧的光、贴花、探针的个数（包围球按这个顺序排）。 */
  #counts: [number, number, number] = [0, 0, 0];
  #spheres: GPUBuffer | undefined;
  #sphereData = new Float32Array(0);
  #pipeline: GPUComputePipeline | undefined;
  /** 每槽的计数器读回来（MAP_READ）；还在 map 的那一帧不再写。 */
  readonly #readback: GPUBuffer;
  #readbackBusy = false;
  /** 这一帧拷进读回缓冲的槽数（0 是这一帧还没拷）。 */
  #readbackSlots = 0;
  #warned = false;

  constructor(device: GPUDevice) {
    this.#device = device;
    this.buffer = this.#createBuffer(1);
    this.#readback = device.createBuffer({ label: 'Clusters requested', size: MAX_TABLES * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  }

  /** 这一帧要 count 个槽：缓冲不够（槽数或池子）时换大的；返回实际能用的槽数（最多 MAX_TABLES）。 */
  reserve(count: number): number {
    if (count > MAX_TABLES && !this.#warned) {
      this.#warned = true;
      console.warn(`Clusters: ${count} views need clustering; only ${MAX_TABLES} get clusters, the rest shade every light and decal`);
    }
    const tables = Math.min(count, MAX_TABLES);
    const capacity = this.#requested > this.#capacity ? this.#fitCapacity(this.#requested, Math.max(tables, this.#tables)) : this.#capacity;
    if (tables > this.#tables || capacity > this.#capacity) {
      this.#capacity = capacity;
      this.buffer.destroy();
      this.buffer = this.#createBuffer(Math.max(tables, this.#tables));
      this.#groups.fill(undefined);
    }
    while (this.#uniforms.length < tables) {
      this.#uniforms.push(this.#device.createBuffer({ label: `Clusters build ${this.#uniforms.length}`, size: this.#uniformData.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }));
    }
    this.#readbackSlots = 0;
    return tables;
  }

  /**
   * 这一帧的包围球（每个 4 个数：世界坐标的球心、半径）：先 lightCount 个光，再 decalCount 个贴花，再 probeCount 个反射探针；
   * 下标和着色器里 localLights、decals、probes 的一致。所有视图共用。
   */
  upload(lights: Float32Array, lightCount: number, decals: Float32Array, decalCount: number, probes: Float32Array, probeCount: number): void {
    const floats = (lightCount + decalCount + probeCount) * 4;
    if (this.#sphereData.length < Math.max(floats, 4)) {
      this.#sphereData = new Float32Array(2 ** Math.ceil(Math.log2(Math.max(floats, 4))));
      this.#spheres?.destroy();
      this.#spheres = this.#device.createBuffer({ label: 'Clusters spheres', size: this.#sphereData.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      this.#groups.fill(undefined);
    }
    this.#sphereData.set(lights.subarray(0, lightCount * 4), 0);
    this.#sphereData.set(decals.subarray(0, decalCount * 4), lightCount * 4);
    this.#sphereData.set(probes.subarray(0, probeCount * 4), (lightCount + decalCount) * 4);
    if (floats > 0) this.#device.queue.writeBuffer(this.#spheres!, 0, this.#sphereData, 0, floats);
    this.#counts = [lightCount, decalCount, probeCount];
  }

  /** 算 view 的簇（写进它那个槽的簇头和索引池）。 */
  record(encoder: GPUCommandEncoder, view: RenderView, timestampWrites?: GPUComputePassTimestampWrites): void {
    const slot = view.clusterSlot;
    const uniforms = this.#uniforms[slot];
    if (!uniforms || !this.#spheres) return;
    const { near, far } = clusterDepthRange(view);
    const data = this.#uniformData;
    Matrix.invert(data.subarray(0, 16) as never, view.projection);
    data.set(view.view, 16);
    data.set([this.#counts[0], this.#counts[1], near, far], 32);
    new Uint32Array(data.buffer, 36 * 4, 4).set([this.#poolStart(slot), this.#capacity, this.#counts[2], 0]);
    // 每个槽自己的常量缓冲：同一帧里几个视图的写入都在提交之前，共用一个的话最后一次写的会盖掉前面的
    this.#device.queue.writeBuffer(uniforms, 0, data);
    const pipeline = (this.#pipeline ??= this.#device.createComputePipeline({
      label: 'Clusters build', layout: 'auto',
      compute: { module: this.#device.createShaderModule({ label: 'Clusters build', code: BUILD_SHADER }), entryPoint: 'main' },
    }));
    const group = (this.#groups[slot] ??= this.#device.createBindGroup({
      label: `Clusters build ${slot}`, layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: uniforms } },
        { binding: 1, resource: { buffer: this.#spheres } },
        { binding: 2, resource: { buffer: this.buffer, offset: slot * HEADER_WORDS * 4, size: HEADER_WORDS * 4 } },
        { binding: 3, resource: { buffer: this.buffer, offset: this.#poolStart(slot) * 4, size: this.#capacity * 4 } },
      ],
    }));
    // 计数器清零（簇头的第 0 个）
    encoder.clearBuffer(this.buffer, slot * HEADER_WORDS * 4, 4);
    const pass = encoder.beginComputePass({ label: 'Clusters build', ...(timestampWrites ? { timestampWrites } : {}) });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(Math.ceil(CLUSTER_COUNT / WORKGROUP));
    pass.end();
    this.#copyRequested(encoder, slot);
  }

  /** 调试用：读回一个槽的簇头，统计每簇的光数，以及池子要了多少、放得下多少（要的多于放得下时这一帧有光被截掉）。 */
  async occupancy(slot: number): Promise<{ lit: number; max: number; mean: number; requested: number; capacity: number }> {
    const read = this.#device.createBuffer({ label: 'Clusters occupancy', size: HEADER_WORDS * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const encoder = this.#device.createCommandEncoder({ label: 'Clusters occupancy' });
    encoder.copyBufferToBuffer(this.buffer, slot * HEADER_WORDS * 4, read, 0, HEADER_WORDS * 4);
    this.#device.queue.submit([encoder.finish()]);
    await read.mapAsync(GPUMapMode.READ);
    const words = new Uint32Array(read.getMappedRange().slice(0));
    read.destroy();
    let lit = 0, max = 0, sum = 0;
    for (let i = 0; i < CLUSTER_COUNT; i++) {
      const lights = words[2 + i * CLUSTER_HEADER]! & 0xffff;
      if (lights > 0) lit++;
      max = Math.max(max, lights);
      sum += lights;
    }
    return { lit, max, mean: lit > 0 ? sum / lit : 0, requested: words[0]!, capacity: this.#capacity };
  }

  /** 槽 slot 的索引池在整个缓冲里的起点（u32 的下标）：所有槽的簇头在前。 */
  #poolStart(slot: number): number {
    return this.#tables * HEADER_WORDS + slot * this.#capacity;
  }

  /** 放得下 requested 个下标的池子（2 的幂、64 的倍数），整个缓冲不超过一次能绑定的大小。 */
  #fitCapacity(requested: number, tables: number): number {
    const limit = Math.floor((this.#device.limits.maxStorageBufferBindingSize / tables / 4 - HEADER_WORDS) / 64) * 64;
    return Math.min(limit, Math.max(INITIAL_CAPACITY, 2 ** Math.ceil(Math.log2(requested * 1.25))));
  }

  /** 把这个槽的计数器拷进读回缓冲；这一帧第一次拷时排一次读回（提交之后才能 map：放到微任务里，同 GpuProfiler）。 */
  #copyRequested(encoder: GPUCommandEncoder, slot: number): void {
    if (this.#readbackBusy && this.#readbackSlots === 0) return;
    encoder.copyBufferToBuffer(this.buffer, slot * HEADER_WORDS * 4, this.#readback, slot * 4, 4);
    if (this.#readbackSlots === 0) {
      this.#readbackBusy = true;
      queueMicrotask(() => void this.#collectRequested());
    }
    this.#readbackSlots = Math.max(this.#readbackSlots, slot + 1);
  }

  async #collectRequested(): Promise<void> {
    const slots = this.#readbackSlots;
    try {
      await this.#readback.mapAsync(GPUMapMode.READ, 0, slots * 4);
    } catch {
      this.#readbackBusy = false; // 设备销毁时 map 会失败
      return;
    }
    const requested = new Uint32Array(this.#readback.getMappedRange(0, slots * 4));
    this.#requested = Math.max(...requested);
    this.#readback.unmap();
    this.#readbackBusy = false;
  }

  #createBuffer(tables: number): GPUBuffer {
    this.#tables = tables;
    const words = tables * (HEADER_WORDS + this.#capacity);
    return this.#device.createBuffer({ label: `Clusters ×${tables}`, size: words * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
  }

  destroy(): void {
    this.buffer.destroy();
    for (const uniforms of this.#uniforms) uniforms.destroy();
    this.#spheres?.destroy();
    this.#readback.destroy();
  }
}
