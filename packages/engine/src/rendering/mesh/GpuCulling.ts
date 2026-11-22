/**
 * GPU 上的视锥剔除（W7 第一步；Unity 的 GPU Resident Drawer、Bevy 的 gpu_preprocessing 同一个思路）：一帧一次计算着色器，对所有
 * 实例 × 所有视图做和原生剔除（sn_transforms_cull，Stride 的 FrustumContainsBox）一样的判定——实例的本地包围盒按世界矩阵变成
 * 世界的轴对齐盒，和视图朝内的平面比；可见的把这一批在这个视图的间接绘制参数里的实例数原子加一，槽位写进实例列表里这一批这个
 * 视图的那段（和 CPU 剔除同样的布局：视图的起点 + 批的起点 + 第几个），画的时候 drawIndexedIndirect。CPU 上没有逐实例的活。
 *
 * 可见物体到近平面的距离范围（阴影级联按它切）每个工作组先在共享内存里归约，再原子地并进每个视图的结果；结果异步读回，下一帧
 * 用（级联的范围本来就按阈值慢慢变，晚一帧看不出来）。
 */
import type { RenderView } from '../RenderSystem';

/** 一个视图的常量（见着色器的 CullView）：平面 6 个、距离平面、实例列表的起点、参数的起点、平面数、量不量距离。 */
const VIEW_FLOATS = 32;
/** 一批的常量（见 CullBatch）：本地包围盒的中心、这批在实例列表里的起点、半长、标记。 */
const BATCH_FLOATS = 8;
/** 一条间接绘制参数：indexCount、instanceCount、firstIndex、baseVertex、firstInstance。 */
export const INDIRECT_WORDS = 5;
/** 每个视图读回的结果：最近、最远距离（保序的位）、可见的个数、空。 */
const RESULT_WORDS = 4;
const WORKGROUP = 64;

/** 批的标记：包围盒是 0（总是可见，Stride 的做法）、这批留给 CPU 剔除（透明的要从远到近排）。 */
export const CULL_ALWAYS_VISIBLE = 1;
export const CULL_ON_CPU = 2;

const SHADER = /* wgsl */ `
struct CullView {
  planes: array<vec4f, 6>,
  distancePlane: vec4f,
  // 实例列表里这个视图的起点、参数里这个视图的起点（第几条）、平面数、量不量距离
  region: u32,
  argsBase: u32,
  planeCount: u32,
  measure: u32,
};
struct CullBatch {
  center: vec3f,
  first: u32,
  extent: vec3f,
  flags: u32,
};
struct Params {
  itemCount: u32,
  worldsBase: u32,
  pad0: u32,
  pad1: u32,
};
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> items: array<vec2u>;
@group(0) @binding(2) var<storage, read> batches: array<CullBatch>;
@group(0) @binding(3) var<storage, read> views: array<CullView>;
@group(0) @binding(4) var<storage, read> worlds: array<mat4x4f>;
@group(0) @binding(5) var<storage, read_write> args: array<atomic<u32>>;
@group(0) @binding(6) var<storage, read_write> instances: array<u32>;
@group(0) @binding(7) var<storage, read_write> results: array<atomic<u32>>;

var<workgroup> nearest: atomic<u32>;
var<workgroup> farthest: atomic<u32>;
var<workgroup> visibleCount: atomic<u32>;

/** 浮点数换成保序的无符号整数（负数也对），好用整数的原子 min、max。 */
fn orderedBits(value: f32) -> u32 {
  let bits = bitcast<u32>(value);
  return select(bits | 0x80000000u, ~bits, (bits & 0x80000000u) != 0u);
}

@compute @workgroup_size(${WORKGROUP}) fn cull(@builtin(global_invocation_id) id: vec3u, @builtin(local_invocation_index) local: u32) {
  if (local == 0u) {
    atomicStore(&nearest, 0xffffffffu);
    atomicStore(&farthest, 0u);
    atomicStore(&visibleCount, 0u);
  }
  workgroupBarrier();
  let view = views[id.y];
  if (id.x < params.itemCount) {
    let item = items[id.x];
    let batch = batches[item.y];
    if ((batch.flags & ${CULL_ON_CPU}u) == 0u) {
      let always = (batch.flags & ${CULL_ALWAYS_VISIBLE}u) != 0u;
      var visible = true;
      var center = vec3f(0.0);
      var extent = vec3f(0.0);
      if (!always) {
        let world = worlds[params.worldsBase + item.x];
        center = (world * vec4f(batch.center, 1.0)).xyz;
        extent = abs(world[0].xyz) * batch.extent.x + abs(world[1].xyz) * batch.extent.y + abs(world[2].xyz) * batch.extent.z;
        for (var i = 0u; i < view.planeCount; i++) {
          let plane = view.planes[i];
          if (dot(plane.xyz, center) + dot(abs(plane.xyz), extent) <= -plane.w) {
            visible = false;
          }
        }
      }
      if (visible) {
        let index = atomicAdd(&args[(view.argsBase + item.y) * ${INDIRECT_WORDS}u + 1u], 1u);
        instances[view.region + batch.first + index] = item.x;
        atomicAdd(&visibleCount, 1u);
        if (!always && view.measure != 0u) {
          // 离距离平面最近、最远的两个角：按法线各分量的符号在最小、最大角之间挑（同原生的）
          let normal = view.distancePlane.xyz;
          let low = center - extent;
          let high = center + extent;
          let negative = normal < vec3f(0.0);
          let nearCorner = select(low, high, negative);
          let farCorner = select(high, low, negative);
          atomicMin(&nearest, orderedBits(dot(normal, nearCorner) - view.distancePlane.w));
          atomicMax(&farthest, orderedBits(dot(normal, farCorner) - view.distancePlane.w));
        }
      }
    }
  }
  workgroupBarrier();
  if (local == 0u) {
    let count = atomicLoad(&visibleCount);
    if (count > 0u) {
      atomicMin(&results[id.y * ${RESULT_WORDS}u], atomicLoad(&nearest));
      atomicMax(&results[id.y * ${RESULT_WORDS}u + 1u], atomicLoad(&farthest));
      atomicAdd(&results[id.y * ${RESULT_WORDS}u + 2u], count);
    }
  }
}
`;

/** 保序的位换回浮点数（orderedBits 的逆）。 */
function fromOrdered(bits: number): number {
  const raw = bits & 0x80000000 ? bits & 0x7fffffff : ~bits >>> 0;
  RAW[0] = raw;
  return FLOAT[0]!;
}
const RAW = new Uint32Array(1);
const FLOAT = new Float32Array(RAW.buffer);

/** 一个视图上一次读回来的结果：可见物体到近平面的最近、最远距离（没看见东西时是 ±∞），可见的实例数。 */
export interface CullResult {
  readonly minimumDistance: number;
  readonly maximumDistance: number;
  readonly visible: number;
}

/** 一批要给剔除的数据。 */
export interface CullBatchInput {
  /** 本地包围盒的中心、半长（Mesh.cullBounds 换的）。 */
  readonly center: ArrayLike<number>;
  readonly extent: ArrayLike<number>;
  /** 这批在实例列表里的起点（MeshBatch.first）。 */
  readonly first: number;
  /** 画一个实例用几个索引（间接参数的 indexCount）。 */
  readonly indexCount: number;
  /** CULL_ALWAYS_VISIBLE、CULL_ON_CPU 的组合。 */
  readonly flags: number;
}

/** 一个要剔除的视图：实例列表里它的起点、量不量距离。 */
export interface CullViewInput {
  readonly view: RenderView;
  readonly region: number;
}

/** GPU 上的视锥剔除：每帧 setFrame 给这一帧的实例、批、视图，record 录进编码器，画的时候按 argsOffset 间接绘制。 */
export class GpuCulling {
  readonly #device: GPUDevice;
  readonly #pipeline: GPUComputePipeline;
  readonly #params: GPUBuffer;
  #items: GPUBuffer | undefined;
  #batches: GPUBuffer | undefined;
  #views: GPUBuffer | undefined;
  #args: GPUBuffer | undefined;
  #results: GPUBuffer | undefined;
  #group: GPUBindGroup | undefined;
  #groupKey: readonly unknown[] = [];
  /** 读回用的暂存缓冲（轮着用；还在映射的跳过这一帧）。 */
  readonly #staging: { buffer: GPUBuffer; views: RenderView[]; busy: boolean }[] = [];
  readonly #results_ = new WeakMap<RenderView, CullResult>();
  #frameViews: RenderView[] = [];
  #itemCount = 0;
  #batchCount = 0;
  /** 上一帧传上去的实例（槽位、批号），没变就不再传。 */
  #lastItems = new Uint32Array(0);
  #viewData = new Float32Array(0);
  #batchData = new Float32Array(0);
  #argsData = new Uint32Array(0);

  constructor(device: GPUDevice) {
    this.#device = device;
    const module = device.createShaderModule({ label: 'GpuCulling', code: SHADER });
    this.#pipeline = device.createComputePipeline({ label: 'GpuCulling', layout: 'auto', compute: { module, entryPoint: 'cull' } });
    this.#params = device.createBuffer({ label: 'GpuCulling params', size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  }

  /** 间接绘制的参数（drawIndexedIndirect 的缓冲）。 */
  get args(): GPUBuffer | undefined {
    return this.#args;
  }

  /** 这一帧第 view 个视图（setFrame 给的顺序）、第 batch 批的间接参数在 args 里的字节偏移。 */
  argsOffset(view: number, batch: number): number {
    return (view * this.#batchCount + batch) * INDIRECT_WORDS * 4;
  }

  /** 这个视图上一次读回来的结果（还没有时是 undefined）。 */
  result(view: RenderView): CullResult | undefined {
    return this.#results_.get(view);
  }

  /**
   * 这一帧要剔除的：items 是实例（槽位、批号）按批连着排的前 itemCount 对，batches 是各批，views 是所有剔除的视图（参数按这个
   * 顺序排）。上传改了的部分，间接参数的实例数清零。
   */
  setFrame(items: Uint32Array, itemCount: number, batches: readonly CullBatchInput[], views: readonly CullViewInput[]): void {
    const device = this.#device;
    this.#itemCount = itemCount;
    this.#batchCount = batches.length;
    this.#frameViews = views.map((entry) => entry.view);
    const grow = (buffer: GPUBuffer | undefined, label: string, bytes: number, usage: number) => {
      if (buffer && buffer.size >= bytes) return buffer;
      buffer?.destroy();
      return device.createBuffer({ label: `GpuCulling ${label}`, size: 2 ** Math.ceil(Math.log2(Math.max(bytes, 256))), usage });
    };
    const storage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
    const before = [this.#items, this.#batches, this.#views, this.#args, this.#results];
    this.#items = grow(this.#items, 'items', itemCount * 8, storage);
    this.#batches = grow(this.#batches, 'batches', batches.length * BATCH_FLOATS * 4, storage);
    this.#views = grow(this.#views, 'views', views.length * VIEW_FLOATS * 4, storage);
    this.#args = grow(this.#args, 'args', views.length * batches.length * INDIRECT_WORDS * 4, storage | GPUBufferUsage.INDIRECT);
    this.#results = grow(this.#results, 'results', views.length * RESULT_WORDS * 4, storage | GPUBufferUsage.COPY_SRC);
    const recreated = before.some((buffer, i) => buffer !== [this.#items, this.#batches, this.#views, this.#args, this.#results][i]);
    // 实例：和上一帧一样就不传
    const pairs = items.subarray(0, itemCount * 2);
    if (recreated || pairs.length !== this.#lastItems.length || pairs.some((value, i) => value !== this.#lastItems[i])) {
      device.queue.writeBuffer(this.#items, 0, pairs);
      this.#lastItems = pairs.slice();
    }
    if (this.#batchData.length < batches.length * BATCH_FLOATS) this.#batchData = new Float32Array(batches.length * BATCH_FLOATS * 2);
    const batchWords = new Uint32Array(this.#batchData.buffer);
    batches.forEach((batch, b) => {
      const o = b * BATCH_FLOATS;
      this.#batchData.set([batch.center[0]!, batch.center[1]!, batch.center[2]!], o);
      batchWords[o + 3] = batch.first;
      this.#batchData.set([batch.extent[0]!, batch.extent[1]!, batch.extent[2]!], o + 4);
      batchWords[o + 7] = batch.flags;
    });
    device.queue.writeBuffer(this.#batches, 0, this.#batchData, 0, batches.length * BATCH_FLOATS);
    if (this.#viewData.length < views.length * VIEW_FLOATS) this.#viewData = new Float32Array(views.length * VIEW_FLOATS * 2);
    const viewWords = new Uint32Array(this.#viewData.buffer);
    const argsWords = views.length * batches.length * INDIRECT_WORDS;
    if (this.#argsData.length < argsWords) this.#argsData = new Uint32Array(argsWords * 2);
    views.forEach(({ view, region }, v) => {
      const o = v * VIEW_FLOATS;
      this.#viewData.set(view.frustumPlanes, o);
      this.#viewData.set(view.nearPlane, o + 24);
      viewWords[o + 28] = region;
      viewWords[o + 29] = v * batches.length;
      viewWords[o + 30] = view.ignoreDepthPlanes ? 4 : 6;
      viewWords[o + 31] = view.ignoreDepthPlanes ? 0 : 1;
      batches.forEach((batch, b) => {
        const a = (v * batches.length + b) * INDIRECT_WORDS;
        this.#argsData.set([batch.indexCount, 0, 0, 0, region + batch.first], a);
      });
    });
    device.queue.writeBuffer(this.#views, 0, this.#viewData, 0, views.length * VIEW_FLOATS);
    device.queue.writeBuffer(this.#args, 0, this.#argsData, 0, argsWords);
    const reset = new Uint32Array(views.length * RESULT_WORDS);
    for (let v = 0; v < views.length; v++) reset[v * RESULT_WORDS] = 0xffffffff;
    device.queue.writeBuffer(this.#results, 0, reset);
  }

  /** 录进编码器（在画之前）：worlds 是世界矩阵的缓冲，worldsBase 是这一帧那一半的起点（第几个矩阵），instances 是实例列表。 */
  record(encoder: GPUCommandEncoder, worlds: GPUBuffer, worldsBase: number, instances: GPUBuffer, timestampWrites?: GPUComputePassTimestampWrites): void {
    if (this.#frameViews.length === 0 || this.#itemCount === 0) return;
    const key = [this.#items, this.#batches, this.#views, worlds, this.#args, instances, this.#results];
    if (!this.#group || key.some((item, i) => item !== this.#groupKey[i])) {
      this.#group = this.#device.createBindGroup({
        label: 'GpuCulling',
        layout: this.#pipeline.getBindGroupLayout(0),
        entries: [this.#params, this.#items!, this.#batches!, this.#views!, worlds, this.#args!, instances, this.#results!].map((buffer, binding) => ({ binding, resource: { buffer } })),
      });
      this.#groupKey = key;
    }
    this.#device.queue.writeBuffer(this.#params, 0, new Uint32Array([this.#itemCount, worldsBase, 0, 0]));
    const pass = encoder.beginComputePass({ label: 'GpuCulling', ...(timestampWrites ? { timestampWrites } : {}) });
    pass.setPipeline(this.#pipeline);
    pass.setBindGroup(0, this.#group);
    pass.dispatchWorkgroups(Math.ceil(this.#itemCount / WORKGROUP), this.#frameViews.length);
    pass.end();
    this.#readBack(encoder);
  }

  /** 结果拷进一个空着的暂存缓冲，映射好了记到各视图上（下一帧用）。 */
  #readBack(encoder: GPUCommandEncoder): void {
    const bytes = this.#frameViews.length * RESULT_WORDS * 4;
    let slot = this.#staging.find((entry) => !entry.busy && entry.buffer.size >= bytes);
    if (!slot) {
      if (this.#staging.length >= 3) return;
      slot = { buffer: this.#device.createBuffer({ label: 'GpuCulling readback', size: 2 ** Math.ceil(Math.log2(Math.max(bytes, 256))), usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }), views: [], busy: false };
      this.#staging.push(slot);
    }
    encoder.copyBufferToBuffer(this.#results!, 0, slot.buffer, 0, bytes);
    slot.views = this.#frameViews;
    slot.busy = true;
    const entry = slot;
    // 编码器提交以后才能映射：等这一帧交给队列再说
    queueMicrotask(() => {
      entry.buffer.mapAsync(GPUMapMode.READ, 0, bytes).then(() => {
        const words = new Uint32Array(entry.buffer.getMappedRange(0, bytes).slice(0));
        entry.buffer.unmap();
        entry.views.forEach((view, v) => {
          const visible = words[v * RESULT_WORDS + 2]!;
          this.#results_.set(view, {
            minimumDistance: visible > 0 && words[v * RESULT_WORDS]! !== 0xffffffff ? fromOrdered(words[v * RESULT_WORDS]!) : Infinity,
            maximumDistance: visible > 0 && words[v * RESULT_WORDS + 1]! !== 0 ? fromOrdered(words[v * RESULT_WORDS + 1]!) : -Infinity,
            visible,
          });
        });
        entry.busy = false;
      }, () => {
        entry.busy = false;
      });
    });
  }

  destroy(): void {
    for (const buffer of [this.#params, this.#items, this.#batches, this.#views, this.#args, this.#results]) buffer?.destroy();
    for (const entry of this.#staging) entry.buffer.destroy();
    this.#staging.length = 0;
  }
}
