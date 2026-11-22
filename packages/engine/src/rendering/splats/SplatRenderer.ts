/**
 * 高斯泼溅（3D Gaussian Splatting，Kerbl 等 2023）的渲染：GaussianSplat 组件引用一个泼溅资源（`.splat`，content/splatFile.ts），
 * 每个要画它的视图（主画面、反射探针的面、平面反射、渲染目标贴图的相机）每帧在 GPU 上按视深给它的泼溅排序（16 位的计数排序：
 * 数桶、前缀和、分发，相机和实体都没动时不重排），再在不透明的东西画完以后、透明的之前从远到近画（EWA：每个泼溅的 3D 协方差
 * 投到屏幕上成一个椭圆，片元按高斯衰减的不透明度预乘混合），读深度，所以被网格挡住的地方看不见、泼溅后面的网格照常看得见。
 *
 * 和透明物体的遮挡：颜色画完再画一遍只写深度的（不用排序，片元的不透明度过 DEPTH_ALPHA 才写，写泼溅中心的深度），之后的透明
 * 网格、粒子、水按深度测——在扫描的墙面后面的玻璃看不见、前面的盖在泼溅上；雾、景深这些按深度算的也把泼溅当表面。只有薄薄
 * 一层（每个泼溅都很淡）的地方不写，后面的透明物体会画在它上面。
 *
 * 细节层次（资源版本 3，导入时建）：每个视图每帧按节点投到屏幕上的粗细、预算和视锥选一刀（splatLod.ts），只给选中的节点
 * 的泼溅排序、画——远处画合并过的粗一级，近处画原样的；选中的变了才重排。排序按选中的几段（节点的范围）走，第 i 个在哪段
 * 二分查。
 *
 * 颜色是球谐的 0 阶加上资源里有的高阶（1～3 阶：视角相关的颜色，反光的地面、玻璃、金属靠它），方向在泼溅自己的坐标里算
 * （相机位置按实体的逆变换换过去）。参考 PlayCanvas 的 gsplat、apps/bench 的 capabilities.html 里量过的那一版。
 */
import { Matrix } from '../../data/Matrix';
import { system } from '../../engine/system';
import { Transform } from '../../engine/transform';
import { ResourceTable } from '../../engine/ResourceTable';
import type { Branded } from '../../data/prop';
import { decodeSplats, shWords, SPLAT_WORDS, type SplatNode } from '../../content/splatFile';
import { selectSplatNodes, type SplatLodLimits } from './splatLod';
import { GaussianSplat } from '../components';
import type { RenderContext, RenderView } from '../RenderSystem';

export type SplatCloudId = Branded<number, 'SplatCloudId'>;

const clouds = new ResourceTable<SplatCloud>();

/** 一个泼溅资源（`.splat`）：解码好的字和包围盒；GPU 上的存储缓冲由渲染器第一次画它时建。 */
export class SplatCloud {
  readonly id: SplatCloudId;
  readonly name: string;
  readonly count: number;
  readonly words: Uint32Array;
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
  /** 高阶球谐的阶数（0 是没有）、量化范围和数据（content/splatFile.ts）。 */
  readonly shBands: number;
  readonly shRange: number;
  readonly sh: Uint32Array;
  /** 细节层次的节点（至少一个根）。 */
  readonly nodes: readonly SplatNode[];

  constructor(name: string, bytes: ArrayBuffer) {
    const decoded = decodeSplats(bytes, name);
    this.name = name;
    this.count = decoded.count;
    this.words = decoded.words;
    this.min = decoded.min;
    this.max = decoded.max;
    this.shBands = decoded.shBands;
    this.shRange = decoded.shRange;
    this.sh = decoded.sh;
    this.nodes = decoded.nodes;
    this.id = clouds.add(this) as SplatCloudId;
  }

  /** @internal GaussianSplat 组件里存的 id 对应的资源。 */
  static byId(id: number): SplatCloud | undefined {
    return id === 0 ? undefined : clouds.get(id);
  }
}

/**
 * 每个实例的常量：世界矩阵、视图矩阵、投影、(视口宽高、焦距 x y)、(选中的个数、视深的近、远、选中的段数)、(相机在泼溅坐标里的位置, 0)、
 * (球谐的阶数、量化范围、每个泼溅的字数、0)。
 */
const PARAMS_FLOATS = 16 * 3 + 16;
const PARAMS_BYTES = PARAMS_FLOATS * 4;
const BINS = 65536;
/** 写深度的那一遍：片元的不透明度到这么多才写（见文件开头）。 */
const DEPTH_ALPHA = 0.5;

const COMMON = /* wgsl */ `
struct Params { world: mat4x4f, view: mat4x4f, projection: mat4x4f, viewport: vec4f, range: vec4f, eye: vec4f, sh: vec4f };
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> splats: array<u32>;
const SPLAT_WORDS = ${SPLAT_WORDS}u;
fn splatCenter(i: u32) -> vec3f {
  let o = i * SPLAT_WORDS;
  return vec3f(bitcast<f32>(splats[o]), bitcast<f32>(splats[o + 1u]), bitcast<f32>(splats[o + 2u]));
}
`;

const SORT = /* wgsl */ `${COMMON}
@group(0) @binding(2) var<storage, read_write> keys: array<u32>;
@group(0) @binding(3) var<storage, read_write> bins: array<atomic<u32>>;
@group(0) @binding(4) var<storage, read_write> order: array<u32>;
// 选中的节点的段：(第一个泼溅, 在选中的里从第几个起)，按后者递增
@group(0) @binding(5) var<storage, read> ranges: array<vec2u>;
// 选中的第 i 个是哪个泼溅（count 时记下，scatter 用）
@group(0) @binding(6) var<storage, read_write> ids: array<u32>;

fn activeSplat(i: u32) -> u32 {
  var lo = 0u;
  var hi = u32(params.range.w) - 1u;
  while (lo < hi) {
    let mid = (lo + hi + 1u) / 2u;
    if (ranges[mid].y <= i) { lo = mid; } else { hi = mid - 1u; }
  }
  return ranges[lo].x + (i - ranges[lo].y);
}

@compute @workgroup_size(256) fn clear(@builtin(global_invocation_id) id: vec3u) {
  atomicStore(&bins[id.x], 0u);
}

// 远的键小、排在前面（从后往前混合）；视深的范围是这个实例的包围盒在视图里的前后
@compute @workgroup_size(256) fn count(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= u32(params.range.x)) { return; }
  let splat = activeSplat(i);
  let depth = -(params.view * params.world * vec4f(splatCenter(splat), 1.0)).z;
  let key = 65535u - u32(clamp((depth - params.range.y) / max(params.range.z - params.range.y, 1e-6), 0.0, 1.0) * 65535.0);
  keys[i] = key;
  ids[i] = splat;
  atomicAdd(&bins[key], 1u);
}

var<workgroup> sums: array<u32, 256>;

// 65536 个桶的前缀和：一个工作组，每个线程管连着的 256 个桶
@compute @workgroup_size(256) fn scan(@builtin(local_invocation_index) t: u32) {
  var total = 0u;
  for (var k = 0u; k < 256u; k++) { total += atomicLoad(&bins[t * 256u + k]); }
  sums[t] = total;
  workgroupBarrier();
  for (var step = 1u; step < 256u; step <<= 1u) {
    var add = 0u;
    if (t >= step) { add = sums[t - step]; }
    workgroupBarrier();
    sums[t] += add;
    workgroupBarrier();
  }
  var running = sums[t] - total;
  for (var k = 0u; k < 256u; k++) {
    let c = atomicLoad(&bins[t * 256u + k]);
    atomicStore(&bins[t * 256u + k], running);
    running += c;
  }
}

@compute @workgroup_size(256) fn scatter(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= u32(params.range.x)) { return; }
  order[atomicAdd(&bins[keys[i]], 1u)] = ids[i];
}
`;

const DRAW = /* wgsl */ `${COMMON}
@group(0) @binding(2) var<storage, read> order: array<u32>;
@group(0) @binding(3) var<storage, read> shData: array<u32>;

/**
 * 高阶球谐的颜色（3DGS 的 eval_sh，1～3 阶）：dir 是相机指向泼溅的单位向量（泼溅坐标），加到 0 阶的颜色上（显示空间）。
 * 系数 8 位，按通道排（r 的 n 个、g 的、b 的）。
 */
fn shColor(i: u32, dir: vec3f) -> vec3f {
  let bands = u32(params.sh.x);
  if (bands == 0u) { return vec3f(0.0); }
  let n = select(select(15u, 8u, bands == 2u), 3u, bands == 1u);
  let x = dir.x;
  let y = dir.y;
  let z = dir.z;
  let xx = x * x;
  let yy = y * y;
  let zz = z * z;
  var basis = array<f32, 15>(
    -0.4886025 * y, 0.4886025 * z, -0.4886025 * x,
    1.0925484 * x * y, -1.0925484 * y * z, 0.3153916 * (2.0 * zz - xx - yy), -1.0925484 * x * z, 0.5462742 * (xx - yy),
    -0.5900436 * y * (3.0 * xx - yy), 2.8906114 * x * y * z, -0.4570458 * y * (4.0 * zz - xx - yy), 0.3731763 * z * (2.0 * zz - 3.0 * xx - 3.0 * yy),
    -0.4570458 * x * (4.0 * zz - xx - yy), 1.4453057 * z * (xx - yy), -0.5900436 * x * (xx - 3.0 * yy));
  let base = i * u32(params.sh.z);
  var color = vec3f(0.0);
  for (var c = 0u; c < 3u; c++) {
    var sum = 0.0;
    for (var k = 0u; k < n; k++) {
      let index = c * n + k;
      let byte = (shData[base + index / 4u] >> ((index % 4u) * 8u)) & 0xffu;
      sum += (f32(byte) / 255.0 * 2.0 - 1.0) * params.sh.y * basis[k];
    }
    color[c] = sum;
  }
  return color;
}

struct Varyings { @builtin(position) position: vec4f, @location(0) offset: vec2f, @location(1) color: vec4f };

const DEPTH_ALPHA = ${DEPTH_ALPHA.toFixed(3)};

fn decodeSrgb(c: vec3f) -> vec3f {
  return select(pow((c + 0.055) / 1.055, vec3f(2.4)), c / 12.92, c <= vec3f(0.04045));
}

@vertex fn vs(@builtin(vertex_index) corner: u32, @builtin(instance_index) instance: u32) -> Varyings {
  return project(corner, order[instance], true);
}

// 写深度：不透明度本来就不到 DEPTH_ALPHA 的泼溅整个跳过（多数飘着的、边缘的），省掉投影和光栅化；次序不要紧，order 只是选中的那些
@vertex fn vsDepth(@builtin(vertex_index) corner: u32, @builtin(instance_index) instance: u32) -> Varyings {
  let i = order[instance];
  if (unpack4x8unorm(splats[i * SPLAT_WORDS + 6u]).a < DEPTH_ALPHA) {
    var out: Varyings;
    out.position = vec4f(0.0, 0.0, 2.0, 1.0);
    return out;
  }
  return project(corner, i, false);
}

fn project(corner: u32, i: u32, colored: bool) -> Varyings {
  var out: Varyings;
  out.position = vec4f(0.0, 0.0, 2.0, 1.0);
  let o = i * SPLAT_WORDS;
  let modelView = params.view * params.world;
  let p = (modelView * vec4f(splatCenter(i), 1.0)).xyz;
  let clip = params.projection * vec4f(p, 1.0);
  if (clip.w <= 0.01 || any(abs(clip.xy) > vec2f(1.2 * clip.w))) { return out; }
  let scale = vec3f(unpack2x16float(splats[o + 3u]), unpack2x16float(splats[o + 4u]).x);
  let q = normalize(unpack4x8snorm(splats[o + 5u]));
  let r = mat3x3f(
    1.0 - 2.0 * (q.y * q.y + q.z * q.z), 2.0 * (q.x * q.y + q.w * q.z), 2.0 * (q.x * q.z - q.w * q.y),
    2.0 * (q.x * q.y - q.w * q.z), 1.0 - 2.0 * (q.x * q.x + q.z * q.z), 2.0 * (q.y * q.z + q.w * q.x),
    2.0 * (q.x * q.z + q.w * q.y), 2.0 * (q.y * q.z - q.w * q.x), 1.0 - 2.0 * (q.x * q.x + q.y * q.y));
  // 3D 协方差：模型视图的 3×3 · 旋转 · 缩放（实体的缩放、旋转一起算进去）
  let m = mat3x3f(modelView[0].xyz, modelView[1].xyz, modelView[2].xyz) * r * mat3x3f(scale.x, 0.0, 0.0, 0.0, scale.y, 0.0, 0.0, 0.0, scale.z);
  let covariance = m * transpose(m);
  // 透视投影在这一点的雅可比（EWA）：视空间的协方差投到屏幕上（像素）
  let z = -p.z;
  let focal = params.viewport.zw;
  let j = mat3x3f(focal.x / z, 0.0, 0.0, 0.0, focal.y / z, 0.0, focal.x * p.x / (z * z), focal.y * p.y / (z * z), 0.0);
  let screen = j * covariance * transpose(j);
  // 加 0.3 像素的低通（抗锯齿），再求椭圆的两个轴
  let a = screen[0][0] + 0.3;
  let b = screen[0][1];
  let c = screen[1][1] + 0.3;
  let mid = 0.5 * (a + c);
  let radius = sqrt(max(mid * mid - (a * c - b * b), 0.1));
  let major = mid + radius;
  let minor = max(mid - radius, 0.1);
  let axis = normalize(vec2f(b, major - a + 1e-6));
  let v1 = min(sqrt(2.0 * major), 1024.0) * axis;
  let v2 = min(sqrt(2.0 * minor), 1024.0) * vec2f(axis.y, -axis.x);
  let color = unpack4x8unorm(splats[o + 6u]);
  // 画颜色的盖到 2σ（不透明度衰减到 e⁻⁴）；写深度的只要 exp(−r²)·a ≥ DEPTH_ALPHA 的那一圈：r = √ln(a / DEPTH_ALPHA)，面积小好几倍
  let extent = select(sqrt(max(log(color.a / DEPTH_ALPHA), 0.0)), 2.0, colored);
  let quad = (vec2f(f32(corner & 1u), f32(corner >> 1u)) * 2.0 - 1.0) * extent;
  // 深度用泼溅中心的：和网格比深度
  out.position = vec4f(clip.xy / clip.w + (quad.x * v1 + quad.y * v2) * 2.0 / params.viewport.xy, clip.z / clip.w, 1.0);
  out.offset = quad;
  out.color = vec4f(0.0, 0.0, 0.0, color.a);
  if (colored) {
    let direction = normalize(splatCenter(i) - params.eye.xyz);
    out.color = vec4f(decodeSrgb(max(color.rgb + shColor(i, direction), vec3f(0.0))), color.a);
  }
  return out;
}

@fragment fn fs(in: Varyings) -> @location(0) vec4f {
  let power = -dot(in.offset, in.offset);
  if (power < -4.0) { discard; }
  let alpha = min(exp(power) * in.color.a, 0.99);
  if (alpha < 1.0 / 255.0) { discard; }
  return vec4f(in.color.rgb * alpha, alpha);
}

@fragment fn fsDepth(in: Varyings) {
  if (exp(-dot(in.offset, in.offset)) * in.color.a < DEPTH_ALPHA) { discard; }
}
`;

/**
 * 一个视图里一个 GaussianSplat 实体在 GPU 上的东西：常量、排序的键、排好的次序，和上一次排序时的矩阵（没变就不重排）。每个
 * 视图各有一份（排序按各自的视深）。
 */
interface Instance {
  cloud: SplatCloud;
  readonly params: GPUBuffer;
  readonly keys: GPUBuffer;
  readonly order: GPUBuffer;
  readonly ids: GPUBuffer;
  /** 选中的节点的段（splatLod.ts 选的）。 */
  readonly ranges: GPUBuffer;
  /** 选中的节点（变了才重传段、重排）和它们的泼溅总数。 */
  selected: number[];
  active: number;
  readonly sortGroup: GPUBindGroup;
  readonly drawGroup: GPUBindGroup;
  readonly sorted: Float32Array;
  /** 这一帧要画（collect 时设）。 */
  live: boolean;
}

/** 一个视图这一帧的：各实体的实例，和要画的（按实体到相机的距离从远到近）。 */
interface ViewSplats {
  readonly instances: Map<number, Instance>;
  frame: Instance[];
}

/** 这一帧场景里的一个泼溅实体（collect 时收集，再分给各视图）。 */
interface SplatEntity {
  readonly entity: number;
  readonly cloud: SplatCloud;
  readonly world: Float32Array;
}

export class SplatRenderer {
  readonly #device: GPUDevice;
  /** 着色器、管线和共用的缓冲：场景里第一次有泼溅时才建（没用泼溅的游戏一条管线也不建）。 */
  #gpu: SplatGpu | undefined;
  readonly #drawPipelines = new Map<string, GPURenderPipeline>();
  /** 泼溅资源的存储缓冲（多个实体、多个视图共用一个资源时共用）和它的高阶球谐（没有时是空的那个）。 */
  readonly #data = new Map<SplatCloud, GPUBuffer>();
  readonly #sh = new Map<SplatCloud, GPUBuffer>();
  readonly #views = new Map<RenderView, ViewSplats>();
  readonly #params = new Float32Array(PARAMS_FLOATS);
  readonly #inverse = new Float32Array(16);
  readonly #selection: number[] = [];
  readonly #localPlanes = new Float32Array(24);
  #entities: SplatEntity[] = [];
  /**
   * 细节层次：每个视图里一个泼溅实体最多画几个（默认 300 万，实测这台机器上一个视图画得动）；一级的粗细投到屏幕上不超过
   * 几个像素（越大越省、远处越糊）。
   */
  limits: SplatLodLimits = { budget: 3_000_000, pixelError: 1 };

  constructor(device: GPUDevice) {
    this.#device = device;
  }

  #shared(): SplatGpu {
    if (this.#gpu) return this.#gpu;
    const device = this.#device;
    const entry = (binding: number, visibility: number, type: GPUBufferBindingType): GPUBindGroupLayoutEntry => ({ binding, visibility, buffer: { type } });
    const sortLayout = device.createBindGroupLayout({
      label: 'Splats sort',
      entries: [
        entry(0, GPUShaderStage.COMPUTE, 'uniform'), entry(1, GPUShaderStage.COMPUTE, 'read-only-storage'), ...[2, 3, 4].map((b) => entry(b, GPUShaderStage.COMPUTE, 'storage')),
        entry(5, GPUShaderStage.COMPUTE, 'read-only-storage'), entry(6, GPUShaderStage.COMPUTE, 'storage'),
      ],
    });
    // 画颜色和写深度的两条管线共用一个绑定组（写深度的不读球谐、次序，自动的布局会少这两项）
    const drawLayout = device.createBindGroupLayout({
      label: 'Splats draw',
      entries: [entry(0, GPUShaderStage.VERTEX, 'uniform'), ...[1, 2, 3].map((b) => entry(b, GPUShaderStage.VERTEX, 'read-only-storage'))],
    });
    const sortModule = device.createShaderModule({ label: 'Splats sort', code: SORT });
    const layout = device.createPipelineLayout({ bindGroupLayouts: [sortLayout] });
    const sortPipelines = Object.fromEntries((['clear', 'count', 'scan', 'scatter'] as const).map((entryPoint) => [entryPoint, device.createComputePipeline({
      label: `Splats ${entryPoint}`, layout, compute: { module: sortModule, entryPoint },
    })])) as SplatGpu['sortPipelines'];
    this.#gpu = {
      sortLayout, sortPipelines, drawLayout,
      drawPipelineLayout: device.createPipelineLayout({ bindGroupLayouts: [drawLayout] }),
      drawModule: device.createShaderModule({ label: 'Splats draw', code: DRAW }),
      bins: device.createBuffer({ label: 'Splats bins', size: BINS * 4, usage: GPUBufferUsage.STORAGE }),
      noSh: device.createBuffer({ label: 'Splats no SH', size: 16, usage: GPUBufferUsage.STORAGE }),
    };
    return this.#gpu;
  }

  /** 这一帧这个视图有没有要画的泼溅（collect 之后）。 */
  active(view: RenderView): boolean {
    return (this.#views.get(view)?.frame.length ?? 0) > 0;
  }

  /** 每帧开头：收集这一帧的 GaussianSplat 实体，分给要画泼溅的视图（主画面、反射、渲染目标贴图的相机）。 */
  collect(context: RenderContext, views: readonly RenderView[]): void {
    this.#entities = [];
    if (views.length > 0) context.game.entities.run(this.#collect, context.time);
    for (const view of views) {
      let state = this.#views.get(view);
      if (!state) this.#views.set(view, (state = { instances: new Map(), frame: [] }));
      for (const instance of state.instances.values()) instance.live = false;
      const frame: { instance: Instance; distance: number }[] = [];
      for (const { entity, cloud, world } of this.#entities) {
        const instance = this.#instance(state, entity, cloud);
        instance.live = true;
        const reselected = this.#select(instance, world, view);
        if (this.#writeParams(instance, world, view) || reselected) instance.sorted[0] = NaN;
        frame.push({ instance, distance: this.#distance(cloud, world, view) });
      }
      // 实体之间按到相机的距离从远到近（同一个实体里的泼溅在 GPU 上排）
      state.frame = frame.filter(({ instance }) => instance.active > 0).sort((a, b) => b.distance - a.distance).map(({ instance }) => instance);
    }
    // 实体没了的、这一帧不画泼溅的视图（探针拍完了、平面反射关了），释放缓冲
    for (const [view, state] of this.#views) {
      if (!views.includes(view)) state.instances.forEach((instance) => (instance.live = false));
      for (const [entity, instance] of state.instances) {
        if (instance.live) continue;
        destroyInstance(instance);
        state.instances.delete(entity);
      }
      if (state.instances.size === 0) this.#views.delete(view);
    }
  }

  readonly #collect = system('SplatRenderer.collect', {
    with: { splat: GaussianSplat, transform: Transform },
    update: ({ splat, transform, count, entities }) => {
      for (let i = 0; i < count; i++) {
        const cloud = SplatCloud.byId(splat.splats[i]!);
        if (!cloud || cloud.count === 0) continue;
        const w = transform.slot[i]! * 16;
        this.#entities.push({ entity: entities[i]!, cloud, world: transform.renderWorld.slice(w, w + 16) });
      }
    },
  });

  /** 录进编码器（这个视图画泼溅的通道之前）：要重排的实例排一遍。 */
  sort(encoder: GPUCommandEncoder, view: RenderView, timestampWrites?: GPUComputePassTimestampWrites): void {
    const stale = this.#views.get(view)?.frame.filter((instance) => Number.isNaN(instance.sorted[0]!)) ?? [];
    if (stale.length === 0) return;
    const { sortPipelines } = this.#shared();
    const pass = encoder.beginComputePass({ label: 'Splats sort', ...(timestampWrites ? { timestampWrites } : {}) });
    for (const instance of stale) {
      const count = instance.active;
      pass.setBindGroup(0, instance.sortGroup);
      pass.setPipeline(sortPipelines.clear);
      pass.dispatchWorkgroups(BINS / 256);
      pass.setPipeline(sortPipelines.count);
      pass.dispatchWorkgroups(Math.ceil(count / 256));
      pass.setPipeline(sortPipelines.scan);
      pass.dispatchWorkgroups(1);
      pass.setPipeline(sortPipelines.scatter);
      pass.dispatchWorkgroups(Math.ceil(count / 256));
      // 排序时的矩阵：collect 写常量时记在 pending 里
      instance.sorted.set(instance.sorted.subarray(32, 64), 0);
    }
    pass.end();
  }

  /** 在这个视图的通道里画（不透明的之后、透明的之前）：先画颜色，再写深度（见文件开头）。 */
  draw(pass: GPURenderPassEncoder, view: RenderView, colorFormat: GPUTextureFormat, surfaceFormats: readonly GPUTextureFormat[], depthFormat: GPUTextureFormat): void {
    const frame = this.#views.get(view)?.frame ?? [];
    if (frame.length === 0) return;
    pass.setPipeline(this.#drawPipeline(colorFormat, surfaceFormats, depthFormat, false));
    for (const instance of frame) {
      pass.setBindGroup(0, instance.drawGroup);
      pass.draw(4, instance.active);
    }
    pass.setPipeline(this.#drawPipeline(colorFormat, surfaceFormats, depthFormat, true));
    for (const instance of frame) {
      pass.setBindGroup(0, instance.drawGroup);
      pass.draw(4, instance.active);
    }
  }

  /** 这一帧各视图画了几个泼溅（调试命令 splats 报）。 */
  stats(): { readonly views: number; readonly instances: number; readonly drawn: number; readonly total: number; readonly nodes: number } {
    let instances = 0, drawn = 0, total = 0, nodes = 0;
    for (const state of this.#views.values()) {
      for (const instance of state.frame) {
        instances++;
        drawn += instance.active;
        total += instance.cloud.count;
        nodes += instance.selected.length;
      }
    }
    return { views: this.#views.size, instances, drawn, total, nodes };
  }

  destroy(): void {
    for (const state of this.#views.values()) state.instances.forEach(destroyInstance);
    this.#views.clear();
    for (const buffer of [...this.#data.values(), ...this.#sh.values()]) buffer.destroy();
    this.#gpu?.bins.destroy();
    this.#gpu?.noSh.destroy();
  }

  #instance(state: ViewSplats, entity: number, cloud: SplatCloud): Instance {
    const existing = state.instances.get(entity);
    if (existing && existing.cloud === cloud) return existing;
    if (existing) destroyInstance(existing);
    let data = this.#data.get(cloud);
    if (!data) {
      data = this.#device.createBuffer({ label: `Splats ${cloud.name}`, size: Math.max(16, cloud.words.byteLength), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      this.#device.queue.writeBuffer(data, 0, cloud.words);
      this.#data.set(cloud, data);
      if (cloud.shBands > 0) {
        const sh = this.#device.createBuffer({ label: `Splats SH ${cloud.name}`, size: Math.max(16, cloud.sh.byteLength), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
        this.#device.queue.writeBuffer(sh, 0, cloud.sh);
        this.#sh.set(cloud, sh);
      }
    }
    const device = this.#device;
    const shared = this.#shared();
    const params = device.createBuffer({ label: 'Splats params', size: PARAMS_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const keys = device.createBuffer({ label: 'Splats keys', size: Math.max(16, cloud.count * 4), usage: GPUBufferUsage.STORAGE });
    const order = device.createBuffer({ label: 'Splats order', size: Math.max(16, cloud.count * 4), usage: GPUBufferUsage.STORAGE });
    const ids = device.createBuffer({ label: 'Splats ids', size: Math.max(16, cloud.count * 4), usage: GPUBufferUsage.STORAGE });
    const ranges = device.createBuffer({ label: 'Splats ranges', size: Math.max(16, cloud.nodes.length * 8), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    const group = (layout: GPUBindGroupLayout, buffers: GPUBuffer[], label: string) => device.createBindGroup({ label, layout, entries: buffers.map((buffer, binding) => ({ binding, resource: { buffer } })) });
    const instance: Instance = {
      cloud, params, keys, order, ids, ranges, selected: [], active: 0,
      sortGroup: group(shared.sortLayout, [params, data, keys, shared.bins, order, ranges, ids], 'Splats sort'),
      drawGroup: group(shared.drawLayout, [params, data, order, this.#sh.get(cloud) ?? shared.noSh], 'Splats draw'),
      // 前 32 个：上次排序时的世界、视图矩阵；后 32 个：这一帧的（排了才挪到前面）
      sorted: new Float32Array(64).fill(NaN),
      live: true,
    };
    state.instances.set(entity, instance);
    return instance;
  }

  /** 写这个实例这一帧的常量；世界矩阵、视图矩阵和上次排序时比变了没有（变了要重排）。 */
  #writeParams(instance: Instance, world: Float32Array, view: RenderView): boolean {
    const p = this.#params;
    p.set(world, 0);
    p.set(view.view, 16);
    p.set(view.projection, 32);
    // 焦距（像素）：平面反射的投影 x 取反，焦距跟着是负的，椭圆照样镜像过去
    const focalX = (view.projection[0]! * view.width) / 2, focalY = (view.projection[5]! * view.height) / 2;
    p.set([view.width, view.height, focalX, focalY], 48);
    const [near, far] = this.#depthRange(instance.cloud, world, view);
    p.set([instance.active, near, far, instance.selected.length], 52);
    // 相机在泼溅坐标里的位置（球谐按它算方向）
    const inverse = this.#inverse;
    Matrix.invert(inverse, world);
    const { x, y, z } = view.eye;
    p.set([inverse[0]! * x + inverse[4]! * y + inverse[8]! * z + inverse[12]!, inverse[1]! * x + inverse[5]! * y + inverse[9]! * z + inverse[13]!, inverse[2]! * x + inverse[6]! * y + inverse[10]! * z + inverse[14]!, 0], 56);
    p.set([instance.cloud.shBands, instance.cloud.shRange, shWords(instance.cloud.shBands), 0], 60);
    this.#device.queue.writeBuffer(instance.params, 0, p);
    instance.sorted.set(p.subarray(0, 32), 32);
    for (let k = 0; k < 32; k++) if (p[k] !== instance.sorted[k]) return true;
    return false;
  }

  /**
   * 选这个视图里画哪些节点（splatLod.ts）：相机和视锥换进泼溅的坐标里选。选中的变了时重传段，返回 true（要重排）。
   */
  #select(instance: Instance, world: Float32Array, view: RenderView): boolean {
    const inverse = this.#inverse;
    Matrix.invert(inverse, world);
    const { x, y, z } = view.eye;
    const eye: [number, number, number] = [
      inverse[0]! * x + inverse[4]! * y + inverse[8]! * z + inverse[12]!, inverse[1]! * x + inverse[5]! * y + inverse[9]! * z + inverse[13]!, inverse[2]! * x + inverse[6]! * y + inverse[10]! * z + inverse[14]!,
    ];
    // 世界里的平面 n·p + w 换到泼溅坐标：n' = Mᵀn，w' = w + n·平移
    const planes = this.#localPlanes;
    for (let p = 0; p < 24; p += 4) {
      const n = view.frustumPlanes.subarray(p, p + 4);
      for (let j = 0; j < 3; j++) planes[p + j] = n[0]! * world[j * 4]! + n[1]! * world[j * 4 + 1]! + n[2]! * world[j * 4 + 2]!;
      planes[p + 3] = n[3]! + n[0]! * world[12]! + n[1]! * world[13]! + n[2]! * world[14]!;
    }
    // 泼溅坐标里节点的粗细和到相机的距离按同样的比例缩放，像素数只看焦距
    const pixelsPerUnit = Math.abs(view.projection[5]! * view.height) / 2;
    const selection = this.#selection;
    const active = selectSplatNodes(instance.cloud.nodes, { eye, pixelsPerUnit, planes }, this.limits, selection);
    if (selection.length === instance.selected.length && selection.every((n, k) => n === instance.selected[k])) return false;
    instance.selected = [...selection];
    instance.active = active;
    if (selection.length === 0) return true;
    const ranges = new Uint32Array(selection.length * 2);
    let start = 0;
    selection.forEach((n, k) => {
      const node = instance.cloud.nodes[n]!;
      ranges[k * 2] = node.first;
      ranges[k * 2 + 1] = start;
      start += node.count;
    });
    this.#device.queue.writeBuffer(instance.ranges, 0, ranges);
    return true;
  }

  /** 泼溅的包围盒中心到这个视图的相机的距离（实体之间排远近）。 */
  #distance(cloud: SplatCloud, world: Float32Array, view: RenderView): number {
    const cx = (cloud.min[0] + cloud.max[0]) / 2, cy = (cloud.min[1] + cloud.max[1]) / 2, cz = (cloud.min[2] + cloud.max[2]) / 2;
    const x = world[0]! * cx + world[4]! * cy + world[8]! * cz + world[12]! - view.eye.x;
    const y = world[1]! * cx + world[5]! * cy + world[9]! * cz + world[13]! - view.eye.y;
    const z = world[2]! * cx + world[6]! * cy + world[10]! * cz + world[14]! - view.eye.z;
    return Math.hypot(x, y, z);
  }

  /** 包围盒的 8 个角在视图里的视深范围（排序的键按它量化：比用相机的近、远平面精细得多）。 */
  #depthRange(cloud: SplatCloud, world: Float32Array, view: RenderView): [number, number] {
    const modelView = Matrix.multiply(new Float32Array(16), view.view, world);
    let near = Infinity, far = -Infinity;
    for (let corner = 0; corner < 8; corner++) {
      const x = corner & 1 ? cloud.max[0] : cloud.min[0], y = corner & 2 ? cloud.max[1] : cloud.min[1], z = corner & 4 ? cloud.max[2] : cloud.min[2];
      const depth = -(modelView[2]! * x + modelView[6]! * y + modelView[10]! * z + modelView[14]!);
      near = Math.min(near, depth);
      far = Math.max(far, depth);
    }
    return [Math.max(near, 0), Math.max(far, near + 1e-3)];
  }

  /**
   * 画颜色的（预乘混合、读深度）或者写深度的（不写颜色）管线，按格式建一次。主画面不透明的那一遍还写着表面（法线、材质……），
   * 泼溅不写它们（写掩码 0）。
   */
  #drawPipeline(colorFormat: GPUTextureFormat, surfaceFormats: readonly GPUTextureFormat[], depthFormat: GPUTextureFormat, depth: boolean): GPURenderPipeline {
    const key = `${colorFormat}|${surfaceFormats.join(',')}|${depthFormat}|${depth}`;
    let pipeline = this.#drawPipelines.get(key);
    if (!pipeline) {
      const { drawModule: module, drawPipelineLayout: layout } = this.#shared();
      const blend: GPUBlendState = { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } };
      pipeline = this.#device.createRenderPipeline({
        label: depth ? 'Splats depth' : 'Splats draw',
        layout,
        vertex: { module, entryPoint: depth ? 'vsDepth' : 'vs' },
        fragment: { module, entryPoint: depth ? 'fsDepth' : 'fs', targets: [depth ? { format: colorFormat, writeMask: 0 } : { format: colorFormat, blend }, ...surfaceFormats.map((format) => ({ format, writeMask: 0 }))] },
        primitive: { topology: 'triangle-strip' },
        depthStencil: { format: depthFormat, depthWriteEnabled: depth, depthCompare: 'greater-equal' },
      });
      this.#drawPipelines.set(key, pipeline);
    }
    return pipeline;
  }
}

function destroyInstance(instance: Instance): void {
  for (const buffer of [instance.params, instance.keys, instance.order, instance.ids, instance.ranges]) buffer.destroy();
}

/** 渲染器共用的 GPU 东西（SplatRenderer.#shared 第一次用到时建）。 */
interface SplatGpu {
  readonly sortLayout: GPUBindGroupLayout;
  readonly sortPipelines: Record<'clear' | 'count' | 'scan' | 'scatter', GPUComputePipeline>;
  readonly drawLayout: GPUBindGroupLayout;
  readonly drawPipelineLayout: GPUPipelineLayout;
  readonly drawModule: GPUShaderModule;
  readonly bins: GPUBuffer;
  readonly noSh: GPUBuffer;
}
