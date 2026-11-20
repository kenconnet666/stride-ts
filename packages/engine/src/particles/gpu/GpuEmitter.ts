/**
 * 一个放到 GPU 上模拟的发射器：粒子的存储缓冲（容量同 CPU 的粒子池：最长寿命 × 每秒最多生成数，或者 MaxParticlesOverride），
 * 环形生成的记账，每帧的模拟派发和按深度的排序，画的时候用的绑定组。
 *
 * 环形生成：新粒子写在环的头往后的槽里，写之前那里的粒子必须已经死了。GPU 上的存活数 CPU 不读回来，而是按生成的历史算
 * 上限：最近"最长寿命"秒里生成的个数（之前生成的一定死了）。这一帧最多再生成 容量 - 上限 个，多出来的丢掉，同 CPU 的粒子池满了
 * 不生成。
 */
import type { ParticleEmitter } from '../ParticleEmitter';
import { buildKernel, HEADER_VEC4S, PARTICLE_BYTES, WORKGROUP_SIZE, type GpuKernel } from './kernel';
import { packShape } from './draw';
import { bitonicStages, SORT_KEYS_WGSL, SORT_STEP_WGSL, sortSize, STAGE_STRIDE } from './sort';

/** 生成的历史：每帧一条（生成了几个，过了多久）。 */
interface SpawnRecord {
  count: number;
  age: number;
}

/**
 * 记账（不碰 GPU，可以单测）：环的头、这一帧从哪个槽起生成几个、种子的起点；按生成的历史限制生成数。
 */
export class SpawnRing {
  readonly capacity: number;
  /** 下一个新粒子写在哪个槽。 */
  head = 0;
  /** 下一个新粒子的种子（每生成一个加一）。 */
  seed: number;
  readonly #history: SpawnRecord[] = [];
  #recent = 0;

  constructor(capacity: number, seed: number) {
    this.capacity = capacity;
    this.seed = seed >>> 0;
  }

  /** 最近 maxLifetime 秒里生成的个数（还可能活着的上限）。 */
  get aliveBound(): number {
    return this.#recent;
  }

  /**
   * 过了 dt 秒、要生成 wanted 个：丢掉早于 maxLifetime 的历史，在容量里能生成多少就生成多少。返回这一帧生成的范围和种子起点，
   * 头往后挪。
   */
  advance(dt: number, wanted: number, maxLifetime: number): { start: number; count: number; seed: number } {
    for (const record of this.#history) record.age += dt;
    while (this.#history.length > 0 && this.#history[0]!.age > maxLifetime) this.#recent -= this.#history.shift()!.count;
    const count = Math.max(0, Math.min(wanted, this.capacity - this.#recent));
    const start = this.head, seed = this.seed;
    if (count > 0) {
      this.#history.push({ count, age: 0 });
      this.#recent += count;
      this.head = (this.head + count) % this.capacity;
      this.seed = (this.seed + count) >>> 0;
    }
    return { start, count, seed };
  }
}

/**
 * 同一个设备上共用的管线和布局（同样的模块组合拼出同样的内核代码，共用一条管线）。管线都在后台编
 * （createComputePipelineAsync），编好之前是 undefined：那几帧不模拟、不排序，不卡帧。
 */
interface Shared {
  readonly simLayout: GPUBindGroupLayout;
  /** 内核代码 → 编好的管线（还在编的是 undefined）。 */
  readonly simPipelines: Map<string, GPUComputePipeline | undefined>;
  readonly keysLayout: GPUBindGroupLayout;
  keysPipeline: GPUComputePipeline | undefined;
  readonly stepLayout: GPUBindGroupLayout;
  stepPipeline: GPUComputePipeline | undefined;
  /** 排序每一步的 [k, j]，按排序的大小。 */
  readonly stageBuffers: Map<number, GPUBuffer>;
  /** 画的时候的第 2 个绑定组（粒子、排好的下标、形状）。 */
  readonly drawLayout: GPUBindGroupLayout;
}

const shared = new WeakMap<GPUDevice, Shared>();

function sharedFor(device: GPUDevice): Shared {
  let found = shared.get(device);
  if (found) return found;
  const layout = (label: string, entries: GPUBindGroupLayoutEntry[]) => device.createBindGroupLayout({ label, entries });
  const storage = (binding: number, type: GPUBufferBindingType, visibility = GPUShaderStage.COMPUTE): GPUBindGroupLayoutEntry => ({ binding, visibility, buffer: { type } });
  const keysLayout = layout('GPU particles sort keys', [storage(0, 'uniform'), storage(1, 'read-only-storage'), storage(2, 'storage')]);
  const stepLayout = layout('GPU particles sort step', [{ binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 8 } }, storage(1, 'storage')]);
  found = {
    simLayout: layout('GPU particles simulate', [storage(0, 'uniform'), storage(1, 'storage')]),
    simPipelines: new Map(),
    keysLayout,
    keysPipeline: undefined,
    stepLayout,
    stepPipeline: undefined,
    stageBuffers: new Map(),
    drawLayout: layout('GPU particles draw', [
      storage(0, 'read-only-storage', GPUShaderStage.VERTEX),
      storage(1, 'read-only-storage', GPUShaderStage.VERTEX),
      { binding: 2, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
    ]),
  };
  shared.set(device, found);
  const ready = found;
  void computeAsync(device, 'GPU particles sort keys', SORT_KEYS_WGSL, 'sortKeys', [keysLayout]).then((pipeline) => (ready.keysPipeline = pipeline));
  void computeAsync(device, 'GPU particles sort step', SORT_STEP_WGSL, 'sortStep', [stepLayout]).then((pipeline) => (ready.stepPipeline = pipeline));
  return found;
}

function computeAsync(device: GPUDevice, label: string, code: string, entryPoint: string, groups: GPUBindGroupLayout[]): Promise<GPUComputePipeline> {
  return device.createComputePipelineAsync({
    label, layout: device.createPipelineLayout({ bindGroupLayouts: groups }), compute: { module: device.createShaderModule({ label, code }), entryPoint },
  });
}

/** 画 GPU 粒子的管线要的第 2 个绑定组的布局。 */
export function gpuDrawLayout(device: GPUDevice): GPUBindGroupLayout {
  return sharedFor(device).drawLayout;
}

export class GpuEmitter {
  readonly emitter: ParticleEmitter;
  readonly ring: SpawnRing;
  readonly kernel: GpuKernel;
  readonly #device: GPUDevice;
  readonly #shared: Shared;
  readonly #particles: GPUBuffer;
  readonly #sim: GPUBuffer;
  readonly #simData: Float32Array;
  readonly #simBits: Uint32Array;
  readonly #simGroup: GPUBindGroup;
  readonly #sortSize: number;
  readonly #keys: GPUBuffer;
  readonly #sortView: GPUBuffer | undefined;
  readonly #keysGroup: GPUBindGroup | undefined;
  readonly #stepGroup: GPUBindGroup | undefined;
  readonly #shape: GPUBuffer;
  readonly drawGroup: GPUBindGroup;

  constructor(device: GPUDevice, emitter: ParticleEmitter, capacity: number, seed: number) {
    this.#device = device;
    this.emitter = emitter;
    this.ring = new SpawnRing(Math.max(1, capacity), seed);
    this.kernel = buildKernel(emitter);
    const sharedGpu = (this.#shared = sharedFor(device));
    const label = `GPU particles ${emitter.name || 'emitter'}`;
    const size = this.ring.capacity;
    // 新建的缓冲是 0：life 是 0，都是死的
    this.#particles = device.createBuffer({ label, size: size * PARTICLE_BYTES, usage: GPUBufferUsage.STORAGE });
    this.#simData = new Float32Array((HEADER_VEC4S + Math.max(this.kernel.slots, 1)) * 4);
    this.#simBits = new Uint32Array(this.#simData.buffer);
    this.#sim = device.createBuffer({ label: `${label} simulate`, size: this.#simData.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.#simGroup = device.createBindGroup({ label, layout: sharedGpu.simLayout, entries: [{ binding: 0, resource: { buffer: this.#sim } }, { binding: 1, resource: { buffer: this.#particles } }] });
    const code = this.kernel.code;
    if (!sharedGpu.simPipelines.has(code)) {
      sharedGpu.simPipelines.set(code, undefined);
      void computeAsync(device, 'GPU particles simulate', code, 'simulate', [sharedGpu.simLayout]).then((pipeline) => sharedGpu.simPipelines.set(code, pipeline));
    }
    // 排好的下标：按深度排序的才真的排，别的只占位（画的着色器按排序方式决定读不读）
    const sorted = emitter.sortingPolicy === 'byDepth';
    this.#sortSize = sorted ? sortSize(size) : 1;
    this.#keys = device.createBuffer({ label: `${label} sort`, size: this.#sortSize * 8, usage: GPUBufferUsage.STORAGE });
    if (sorted) {
      this.#sortView = device.createBuffer({ label: `${label} sort view`, size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      this.#keysGroup = device.createBindGroup({ layout: sharedGpu.keysLayout, entries: [{ binding: 0, resource: { buffer: this.#sortView } }, { binding: 1, resource: { buffer: this.#particles } }, { binding: 2, resource: { buffer: this.#keys } }] });
      this.#stepGroup = device.createBindGroup({ layout: sharedGpu.stepLayout, entries: [{ binding: 0, resource: { buffer: this.#stages(), size: 8 } }, { binding: 1, resource: { buffer: this.#keys } }] });
    }
    this.#shape = device.createBuffer({ label: `${label} shape`, size: packShape(emitter).byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.#shape, 0, packShape(emitter));
    this.drawGroup = device.createBindGroup({
      label, layout: sharedGpu.drawLayout,
      entries: [{ binding: 0, resource: { buffer: this.#particles } }, { binding: 1, resource: { buffer: this.#keys } }, { binding: 2, resource: { buffer: this.#shape } }],
    });
  }

  get capacity(): number {
    return this.ring.capacity;
  }

  /** 粒子缓冲占的字节（统计显存用）。 */
  get bytes(): number {
    return this.ring.capacity * PARTICLE_BYTES + this.#sortSize * 8;
  }

  /** 这一帧的模拟：dt 秒、要生成 wanted 个。录进 pass。管线还在编时什么都不做（这几帧生成的丢掉）。 */
  simulate(pass: GPUComputePassEncoder, dt: number, wanted: number): void {
    const pipeline = this.#shared.simPipelines.get(this.kernel.code);
    if (!pipeline) return;
    const emitter = this.emitter;
    const spawn = this.ring.advance(dt, wanted, emitter.particleLifetime[1]);
    const data = this.#simData, bits = this.#simBits;
    const { position, rotation, scale } = emitter.defaultFields;
    data[0] = dt;
    bits[1] = this.ring.capacity;
    bits[2] = spawn.start;
    bits[3] = spawn.count;
    bits[4] = spawn.seed;
    data[5] = emitter.particleLifetime[0];
    data[6] = emitter.particleLifetime[1];
    data.set(position, 8);
    data[11] = scale;
    data.set(rotation, 12);
    this.kernel.pack(data.subarray(HEADER_VEC4S * 4));
    this.#device.queue.writeBuffer(this.#sim, 0, data);
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, this.#simGroup);
    pass.dispatchWorkgroups(Math.ceil(this.ring.capacity / WORKGROUP_SIZE));
  }

  /** 按深度排序（只有 ByDepth 的发射器）：back 是相机的朝后方向（世界）。录进 pass。 */
  sort(pass: GPUComputePassEncoder, back: readonly [number, number, number]): void {
    const { keysPipeline, stepPipeline } = this.#shared;
    if (!this.#sortView || !this.#keysGroup || !this.#stepGroup || !keysPipeline || !stepPipeline) return;
    const view = new ArrayBuffer(64), f32 = new Float32Array(view), u32 = new Uint32Array(view);
    const space = this.emitter.drawTransform;
    f32.set([...back, 0], 0);
    f32.set([...space.worldPosition, space.worldScale[0]], 4);
    f32.set(space.worldRotation, 8);
    u32.set([this.ring.capacity, this.#sortSize, this.emitter.simulationSpace === 'local' ? 1 : 0, 0], 12);
    this.#device.queue.writeBuffer(this.#sortView, 0, view);
    pass.setPipeline(keysPipeline);
    pass.setBindGroup(0, this.#keysGroup);
    pass.dispatchWorkgroups(Math.ceil(this.#sortSize / WORKGROUP_SIZE));
    pass.setPipeline(stepPipeline);
    const stages = bitonicStages(this.#sortSize).length;
    for (let i = 0; i < stages; i++) {
      pass.setBindGroup(0, this.#stepGroup, [i * STAGE_STRIDE]);
      pass.dispatchWorkgroups(Math.ceil(this.#sortSize / WORKGROUP_SIZE));
    }
  }

  destroy(): void {
    this.#particles.destroy();
    this.#sim.destroy();
    this.#keys.destroy();
    this.#sortView?.destroy();
    this.#shape.destroy();
  }

  /** 这个大小的排序每一步的参数（同样大小的发射器共用一块）。 */
  #stages(): GPUBuffer {
    const n = this.#sortSize;
    let buffer = this.#shared.stageBuffers.get(n);
    if (!buffer) {
      const stages = bitonicStages(n);
      const data = new Uint32Array((stages.length * STAGE_STRIDE) / 4);
      stages.forEach(([k, j], i) => data.set([k, j], (i * STAGE_STRIDE) / 4));
      buffer = this.#device.createBuffer({ label: `GPU particles sort stages ${n}`, size: data.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      this.#device.queue.writeBuffer(buffer, 0, data);
      this.#shared.stageBuffers.set(n, buffer);
    }
    return buffer;
  }
}
