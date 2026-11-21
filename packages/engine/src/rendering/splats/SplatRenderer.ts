/**
 * 高斯泼溅（3D Gaussian Splatting，Kerbl 等 2023）的渲染：GaussianSplat 组件引用一个泼溅资源（`.splat`，content/splatFile.ts），
 * 主画面每帧在 GPU 上按视深给它的泼溅排序（16 位的计数排序：数桶、前缀和、分发，相机和实体都没动时不重排），再在不透明的
 * 东西画完以后、透明的之前从远到近画（EWA：每个泼溅的 3D 协方差投到屏幕上成一个椭圆，片元按高斯衰减的不透明度预乘混合），
 * 读深度、不写深度，所以被网格挡住的地方看不见、泼溅后面的网格照常看得见。
 *
 * 颜色是球谐的 0 阶加上资源里有的高阶（1～3 阶：视角相关的颜色，反光的地面、玻璃、金属靠它），方向在泼溅自己的坐标里算
 * （相机位置按实体的逆变换换过去）。只画主画面（反射探针、平面反射、渲染目标贴图的相机里没有）；泼溅和透明的网格之间不排序
 * （泼溅先画）。参考 PlayCanvas 的 gsplat、apps/bench 的 capabilities.html 里量过的那一版。
 */
import { Matrix } from '../../data/Matrix';
import { system } from '../../engine/system';
import { Transform } from '../../engine/transform';
import { ResourceTable } from '../../engine/ResourceTable';
import type { Branded } from '../../data/prop';
import { decodeSplats, shWords, SPLAT_WORDS } from '../../content/splatFile';
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
    this.id = clouds.add(this) as SplatCloudId;
  }

  /** @internal GaussianSplat 组件里存的 id 对应的资源。 */
  static byId(id: number): SplatCloud | undefined {
    return id === 0 ? undefined : clouds.get(id);
  }
}

/**
 * 每个实例的常量：世界矩阵、视图矩阵、投影、(视口宽高、焦距 x y)、(个数、视深的近、远、0)、(相机在泼溅坐标里的位置, 0)、
 * (球谐的阶数、量化范围、每个泼溅的字数、0)。
 */
const PARAMS_FLOATS = 16 * 3 + 16;
const PARAMS_BYTES = PARAMS_FLOATS * 4;
const BINS = 65536;

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

@compute @workgroup_size(256) fn clear(@builtin(global_invocation_id) id: vec3u) {
  atomicStore(&bins[id.x], 0u);
}

// 远的键小、排在前面（从后往前混合）；视深的范围是这个实例的包围盒在视图里的前后
@compute @workgroup_size(256) fn count(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= u32(params.range.x)) { return; }
  let depth = -(params.view * params.world * vec4f(splatCenter(i), 1.0)).z;
  let key = 65535u - u32(clamp((depth - params.range.y) / max(params.range.z - params.range.y, 1e-6), 0.0, 1.0) * 65535.0);
  keys[i] = key;
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
  order[atomicAdd(&bins[keys[i]], 1u)] = i;
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

fn decodeSrgb(c: vec3f) -> vec3f {
  return select(pow((c + 0.055) / 1.055, vec3f(2.4)), c / 12.92, c <= vec3f(0.04045));
}

@vertex fn vs(@builtin(vertex_index) corner: u32, @builtin(instance_index) instance: u32) -> Varyings {
  var out: Varyings;
  out.position = vec4f(0.0, 0.0, 2.0, 1.0);
  let i = order[instance];
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
  let quad = vec2f(f32(corner & 1u), f32(corner >> 1u)) * 4.0 - 2.0;
  // 深度用泼溅中心的：和网格比深度（读、不写）
  out.position = vec4f(clip.xy / clip.w + (quad.x * v1 + quad.y * v2) * 2.0 / params.viewport.xy, clip.z / clip.w, 1.0);
  out.offset = quad;
  let color = unpack4x8unorm(splats[o + 6u]);
  let direction = normalize(splatCenter(i) - params.eye.xyz);
  out.color = vec4f(decodeSrgb(max(color.rgb + shColor(i, direction), vec3f(0.0))), color.a);
  return out;
}

@fragment fn fs(in: Varyings) -> @location(0) vec4f {
  let power = -dot(in.offset, in.offset);
  if (power < -4.0) { discard; }
  let alpha = min(exp(power) * in.color.a, 0.99);
  if (alpha < 1.0 / 255.0) { discard; }
  return vec4f(in.color.rgb * alpha, alpha);
}
`;

/** 一个 GaussianSplat 实体在 GPU 上的东西：常量、排序的键和桶、排好的次序，和上一次排序时的矩阵（没变就不重排）。 */
interface Instance {
  cloud: SplatCloud;
  readonly params: GPUBuffer;
  readonly keys: GPUBuffer;
  readonly order: GPUBuffer;
  readonly sortGroup: GPUBindGroup;
  drawGroup: GPUBindGroup | undefined;
  readonly sorted: Float32Array;
  /** 这一帧要画（collect 时设）。 */
  live: boolean;
}

export class SplatRenderer {
  readonly #device: GPUDevice;
  /** 着色器、管线和共用的缓冲：场景里第一次有泼溅时才建（没用泼溅的游戏一条管线也不建）。 */
  #gpu: SplatGpu | undefined;
  readonly #drawPipelines = new Map<string, GPURenderPipeline>();
  /** 泼溅资源的存储缓冲（多个实体共用一个资源时共用）和它的高阶球谐（没有时是空的那个）。 */
  readonly #data = new Map<SplatCloud, GPUBuffer>();
  readonly #sh = new Map<SplatCloud, GPUBuffer>();
  readonly #instances = new Map<number, Instance>();
  readonly #params = new Float32Array(PARAMS_FLOATS);
  readonly #inverse = new Float32Array(16);
  /** 这一帧要画的（按实体到相机的距离从远到近）。 */
  #frame: { instance: Instance; distance: number }[] = [];
  #view: RenderView | undefined;

  constructor(device: GPUDevice) {
    this.#device = device;
  }

  #shared(): SplatGpu {
    if (this.#gpu) return this.#gpu;
    const device = this.#device;
    const storage = (type: GPUBufferBindingType) => ({ buffer: { type } });
    const sortLayout = device.createBindGroupLayout({
      label: 'Splats sort',
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, ...storage('read-only-storage') },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, ...storage('storage') },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, ...storage('storage') },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, ...storage('storage') },
      ],
    });
    const sortModule = device.createShaderModule({ label: 'Splats sort', code: SORT });
    const layout = device.createPipelineLayout({ bindGroupLayouts: [sortLayout] });
    const sortPipelines = Object.fromEntries((['clear', 'count', 'scan', 'scatter'] as const).map((entryPoint) => [entryPoint, device.createComputePipeline({
      label: `Splats ${entryPoint}`, layout, compute: { module: sortModule, entryPoint },
    })])) as SplatGpu['sortPipelines'];
    this.#gpu = {
      sortLayout, sortPipelines,
      drawModule: device.createShaderModule({ label: 'Splats draw', code: DRAW }),
      bins: device.createBuffer({ label: 'Splats bins', size: BINS * 4, usage: GPUBufferUsage.STORAGE }),
      noSh: device.createBuffer({ label: 'Splats no SH', size: 16, usage: GPUBufferUsage.STORAGE }),
    };
    return this.#gpu;
  }

  /** 这一帧主画面有没有要画的泼溅（collect 之后）。 */
  get active(): boolean {
    return this.#frame.length > 0;
  }

  /** 每帧开头：收集这一帧要画的 GaussianSplat 实体（主画面）。 */
  collect(context: RenderContext, view: RenderView | undefined): void {
    for (const instance of this.#instances.values()) instance.live = false;
    this.#frame = [];
    this.#view = view;
    if (!view) return;
    context.game.entities.run(this.#collect, context.time);
    // 实体之间按到相机的距离从远到近（同一个实体里的泼溅在 GPU 上排）
    this.#frame.sort((a, b) => b.distance - a.distance);
    // 实体没了的，释放它的缓冲
    for (const [id, instance] of this.#instances) {
      if (instance.live) continue;
      for (const buffer of [instance.params, instance.keys, instance.order]) buffer.destroy();
      this.#instances.delete(id);
    }
  }

  readonly #collect = system('SplatRenderer.collect', {
    with: { splat: GaussianSplat, transform: Transform },
    update: ({ splat, transform, count, entities }) => {
      const view = this.#view!;
      for (let i = 0; i < count; i++) {
        const cloud = SplatCloud.byId(splat.splats[i]!);
        if (!cloud || cloud.count === 0) continue;
        const instance = this.#instance(entities[i]!, cloud);
        instance.live = true;
        const w = transform.slot[i]! * 16, world = transform.renderWorld.subarray(w, w + 16);
        const changed = this.#writeParams(instance, world, view);
        if (changed) instance.sorted[0] = NaN;
        const center = [(cloud.min[0] + cloud.max[0]) / 2, (cloud.min[1] + cloud.max[1]) / 2, (cloud.min[2] + cloud.max[2]) / 2];
        const x = world[0]! * center[0]! + world[4]! * center[1]! + world[8]! * center[2]! + world[12]! - view.eye.x;
        const y = world[1]! * center[0]! + world[5]! * center[1]! + world[9]! * center[2]! + world[13]! - view.eye.y;
        const z = world[2]! * center[0]! + world[6]! * center[1]! + world[10]! * center[2]! + world[14]! - view.eye.z;
        this.#frame.push({ instance, distance: Math.hypot(x, y, z) });
      }
    },
  });

  /** 录进编码器（主画面的通道之前）：要重排的实例排一遍。 */
  sort(encoder: GPUCommandEncoder, timestampWrites?: GPUComputePassTimestampWrites): void {
    const stale = this.#frame.filter(({ instance }) => Number.isNaN(instance.sorted[0]!));
    if (stale.length === 0) return;
    const { sortPipelines } = this.#shared();
    const pass = encoder.beginComputePass({ label: 'Splats sort', ...(timestampWrites ? { timestampWrites } : {}) });
    for (const { instance } of stale) {
      const count = instance.cloud.count;
      pass.setBindGroup(0, instance.sortGroup);
      pass.setPipeline(sortPipelines.clear);
      pass.dispatchWorkgroups(BINS / 256);
      pass.setPipeline(sortPipelines.count);
      pass.dispatchWorkgroups(Math.ceil(count / 256));
      pass.setPipeline(sortPipelines.scan);
      pass.dispatchWorkgroups(1);
      pass.setPipeline(sortPipelines.scatter);
      pass.dispatchWorkgroups(Math.ceil(count / 256));
      instance.sorted.set(this.#params.subarray(0, 32));
    }
    pass.end();
  }

  /** 在主画面的通道里画（不透明的之后、透明的之前）。 */
  draw(pass: GPURenderPassEncoder, colorFormat: GPUTextureFormat, depthFormat: GPUTextureFormat): void {
    if (this.#frame.length === 0) return;
    pass.setPipeline(this.#drawPipeline(colorFormat, depthFormat));
    for (const { instance } of this.#frame) {
      instance.drawGroup ??= this.#device.createBindGroup({
        label: 'Splats draw',
        layout: this.#drawPipeline(colorFormat, depthFormat).getBindGroupLayout(0),
        entries: [instance.params, this.#data.get(instance.cloud)!, instance.order, this.#sh.get(instance.cloud) ?? this.#shared().noSh].map((buffer, binding) => ({ binding, resource: { buffer } })),
      });
      pass.setBindGroup(0, instance.drawGroup);
      pass.draw(4, instance.cloud.count);
    }
  }

  destroy(): void {
    for (const instance of this.#instances.values()) for (const buffer of [instance.params, instance.keys, instance.order]) buffer.destroy();
    for (const buffer of [...this.#data.values(), ...this.#sh.values()]) buffer.destroy();
    this.#gpu?.bins.destroy();
    this.#gpu?.noSh.destroy();
  }

  #instance(entity: number, cloud: SplatCloud): Instance {
    const existing = this.#instances.get(entity);
    if (existing && existing.cloud === cloud) return existing;
    if (existing) for (const buffer of [existing.params, existing.keys, existing.order]) buffer.destroy();
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
    const params = device.createBuffer({ label: 'Splats params', size: PARAMS_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const keys = device.createBuffer({ label: 'Splats keys', size: Math.max(16, cloud.count * 4), usage: GPUBufferUsage.STORAGE });
    const order = device.createBuffer({ label: 'Splats order', size: Math.max(16, cloud.count * 4), usage: GPUBufferUsage.STORAGE });
    const sortGroup = device.createBindGroup({
      label: 'Splats sort', layout: this.#shared().sortLayout,
      entries: [params, data, keys, this.#shared().bins, order].map((buffer, binding) => ({ binding, resource: { buffer } })),
    });
    const instance: Instance = { cloud, params, keys, order, sortGroup, drawGroup: undefined, sorted: new Float32Array(32).fill(NaN), live: true };
    this.#instances.set(entity, instance);
    return instance;
  }

  /** 写这个实例这一帧的常量；世界矩阵、视图矩阵和上次排序时比变了没有（变了要重排）。 */
  #writeParams(instance: Instance, world: Float32Array, view: RenderView): boolean {
    const p = this.#params;
    p.set(world, 0);
    p.set(view.view, 16);
    p.set(view.projection, 32);
    const focalX = (view.projection[0]! * view.width) / 2, focalY = (view.projection[5]! * view.height) / 2;
    p.set([view.width, view.height, focalX, focalY], 48);
    const [near, far] = this.#depthRange(instance.cloud, world, view);
    p.set([instance.cloud.count, near, far, 0], 52);
    // 相机在泼溅坐标里的位置（球谐按它算方向）
    const inverse = this.#inverse;
    Matrix.invert(inverse, world);
    const { x, y, z } = view.eye;
    p.set([inverse[0]! * x + inverse[4]! * y + inverse[8]! * z + inverse[12]!, inverse[1]! * x + inverse[5]! * y + inverse[9]! * z + inverse[13]!, inverse[2]! * x + inverse[6]! * y + inverse[10]! * z + inverse[14]!, 0], 56);
    p.set([instance.cloud.shBands, instance.cloud.shRange, shWords(instance.cloud.shBands), 0], 60);
    this.#device.queue.writeBuffer(instance.params, 0, p);
    for (let k = 0; k < 32; k++) if (p[k] !== instance.sorted[k]) return true;
    return false;
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

  #drawPipeline(colorFormat: GPUTextureFormat, depthFormat: GPUTextureFormat): GPURenderPipeline {
    const key = `${colorFormat}|${depthFormat}`;
    let pipeline = this.#drawPipelines.get(key);
    if (!pipeline) {
      pipeline = this.#device.createRenderPipeline({
        label: 'Splats draw',
        layout: 'auto',
        vertex: { module: this.#shared().drawModule, entryPoint: 'vs' },
        fragment: {
          module: this.#shared().drawModule, entryPoint: 'fs',
          targets: [{ format: colorFormat, blend: { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } } }],
        },
        primitive: { topology: 'triangle-strip' },
        depthStencil: { format: depthFormat, depthWriteEnabled: false, depthCompare: 'greater-equal' },
      });
      this.#drawPipelines.set(key, pipeline);
    }
    return pipeline;
  }
}

/** 渲染器共用的 GPU 东西（SplatRenderer.#shared 第一次用到时建）。 */
interface SplatGpu {
  readonly sortLayout: GPUBindGroupLayout;
  readonly sortPipelines: Record<'clear' | 'count' | 'scan' | 'scatter', GPUComputePipeline>;
  readonly drawModule: GPUShaderModule;
  readonly bins: GPUBuffer;
  readonly noSh: GPUBuffer;
}
