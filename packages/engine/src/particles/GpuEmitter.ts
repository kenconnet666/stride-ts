/**
 * 一个放到 GPU 上模拟的发射器：粒子的存储缓冲（容量同 CPU 的粒子池：最长寿命 × 每秒最多生成数，或者 MaxParticlesOverride），
 * 环形生成的记账，每帧的模拟派发和按深度的排序，画的时候用的绑定组。
 *
 * 环形生成：新粒子写在环的头往后的槽里，写之前那里的粒子必须已经死了。GPU 上的存活数 CPU 不读回来，而是按生成的历史算
 * 上限：最近"最长寿命"秒里生成的个数（之前生成的一定死了）。这一帧最多再生成 容量 - 上限 个，多出来的丢掉，同 CPU 的粒子池满了
 * 不生成。
 */
import type { ParticleEmitter } from './ParticleEmitter';
import { buildKernel, HEADER_VEC4S, PARTICLE_BYTES, WORKGROUP_SIZE, type GpuKernel } from './gpuKernel';
import { packShape, verticesPerParticle } from './gpuDraw';
import { SORT_BLOCK, SORT_KEYS_WGSL, SORT_STEP_WGSL, sortPasses, sortSize, STAGE_STRIDE } from './gpuSort';

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
  /** 带深度碰撞的内核（多一张深度图和它的 uniform）。 */
  readonly surfaceSimLayout: GPUBindGroupLayout;
  /** 内核代码 → 编好的管线（还在编的是 undefined）。 */
  readonly simPipelines: Map<string, GPUComputePipeline | undefined>;
  readonly keysLayout: GPUBindGroupLayout;
  keysPipeline: GPUComputePipeline | undefined;
  readonly stepLayout: GPUBindGroupLayout;
  stepPipeline: GPUComputePipeline | undefined;
  /** 块内的排序（共享内存里做完步距小的那些步），和 stepPipeline 同一个布局。 */
  blockPipeline: GPUComputePipeline | undefined;
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
    // 4、5：间接绘制的参数和存活列表
    simLayout: layout('GPU particles simulate', [storage(0, 'uniform'), storage(1, 'storage'), storage(4, 'storage'), storage(5, 'storage')]),
    surfaceSimLayout: layout('GPU particles simulate with depth collision', [
      storage(0, 'uniform'), storage(1, 'storage'),
      { binding: 2, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'depth' } }, storage(3, 'uniform'),
      storage(4, 'storage'), storage(5, 'storage'),
    ]),
    simPipelines: new Map(),
    keysLayout,
    keysPipeline: undefined,
    stepLayout,
    stepPipeline: undefined,
    blockPipeline: undefined,
    stageBuffers: new Map(),
    drawLayout: layout('GPU particles draw', [
      storage(0, 'read-only-storage', GPUShaderStage.VERTEX),
      storage(1, 'read-only-storage', GPUShaderStage.VERTEX),
      { binding: 2, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
      storage(3, 'read-only-storage', GPUShaderStage.VERTEX),
    ]),
  };
  shared.set(device, found);
  const ready = found;
  void computeAsync(device, 'GPU particles sort keys', SORT_KEYS_WGSL, 'sortKeys', [keysLayout]).then((pipeline) => (ready.keysPipeline = pipeline));
  void computeAsync(device, 'GPU particles sort step', SORT_STEP_WGSL, 'sortStep', [stepLayout]).then((pipeline) => (ready.stepPipeline = pipeline));
  void computeAsync(device, 'GPU particles sort block', SORT_STEP_WGSL, 'sortBlock', [stepLayout]).then((pipeline) => (ready.blockPipeline = pipeline));
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
  #simGroup: GPUBindGroup | undefined;
  /** 绑定组里的深度表面的图和 uniform（换了要重建绑定组：主画面的深度随画布的尺寸换）。 */
  #boundSurface: { readonly view: GPUTextureView; readonly uniform: GPUBuffer } | undefined;
  /** 间接绘制的参数（顶点数、实例数 = 活着的粒子数、0、0），模拟时数出来。 */
  readonly #drawArgs: GPUBuffer;
  /** 活着的粒子的槽号（不排序的发射器按它画）。 */
  readonly #alive: GPUBuffer;
  readonly #vertices: number;
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
    // COPY_SRC：调试时读回（read）
    this.#particles = device.createBuffer({ label, size: size * PARTICLE_BYTES, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    this.#simData = new Float32Array((HEADER_VEC4S + Math.max(this.kernel.slots, 1)) * 4);
    this.#simBits = new Uint32Array(this.#simData.buffer);
    this.#sim = device.createBuffer({ label: `${label} simulate`, size: this.#simData.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.#vertices = verticesPerParticle(emitter);
    this.#drawArgs = device.createBuffer({ label: `${label} draw`, size: 16, usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.#alive = device.createBuffer({ label: `${label} alive`, size: size * 4, usage: GPUBufferUsage.STORAGE });
    const simLayout = this.kernel.collider ? sharedGpu.surfaceSimLayout : sharedGpu.simLayout;
    const code = this.kernel.code;
    if (!sharedGpu.simPipelines.has(code)) {
      sharedGpu.simPipelines.set(code, undefined);
      void computeAsync(device, 'GPU particles simulate', code, 'simulate', [simLayout]).then((pipeline) => sharedGpu.simPipelines.set(code, pipeline));
    }
    // 排好的下标：按深度排序的才真的排，别的只占位（画的着色器按排序方式决定读不读）
    const sorted = emitter.sortingPolicy === 'byDepth';
    this.#sortSize = sorted ? sortSize(size) : 1;
    // COPY_SRC：调试时读回（readSortKeys）
    this.#keys = device.createBuffer({ label: `${label} sort`, size: this.#sortSize * 8, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    if (sorted) {
      this.#sortView = device.createBuffer({ label: `${label} sort view`, size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      this.#keysGroup = device.createBindGroup({ layout: sharedGpu.keysLayout, entries: [{ binding: 0, resource: { buffer: this.#sortView } }, { binding: 1, resource: { buffer: this.#particles } }, { binding: 2, resource: { buffer: this.#keys } }] });
      this.#stepGroup = device.createBindGroup({ layout: sharedGpu.stepLayout, entries: [{ binding: 0, resource: { buffer: this.#stages(), size: 8 } }, { binding: 1, resource: { buffer: this.#keys } }] });
    }
    this.#shape = device.createBuffer({ label: `${label} shape`, size: packShape(emitter).byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.#shape, 0, packShape(emitter));
    this.drawGroup = device.createBindGroup({
      label, layout: sharedGpu.drawLayout,
      entries: [
        { binding: 0, resource: { buffer: this.#particles } }, { binding: 1, resource: { buffer: this.#keys } },
        { binding: 2, resource: { buffer: this.#shape } }, { binding: 3, resource: { buffer: this.#alive } },
      ],
    });
  }

  get capacity(): number {
    return this.ring.capacity;
  }

  /** 粒子缓冲占的字节（统计显存用）。 */
  get bytes(): number {
    return this.ring.capacity * PARTICLE_BYTES + this.#sortSize * 8;
  }

  /** 这一帧的模拟：dt 秒、要生成 wanted 个，time 是游戏时间。录进 pass。管线还在编时什么都不做（这几帧生成的丢掉）。 */
  simulate(pass: GPUComputePassEncoder, dt: number, wanted: number, time = 0): void {
    const pipeline = this.#shared.simPipelines.get(this.kernel.code);
    const group = this.#simBindGroup();
    if (!pipeline || !group) return;
    const window = this.#packStep(dt, wanted, time);
    this.#device.queue.writeBuffer(this.#sim, 0, this.#simData);
    // 活着的粒子数从 0 数起（模拟里每个活着的加一）
    this.#device.queue.writeBuffer(this.#drawArgs, 0, new Uint32Array([this.#vertices, 0, 0, 0]));
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    if (window > 0) pass.dispatchWorkgroups(Math.ceil(window / WORKGROUP_SIZE));
  }

  /**
   * 预热（ParticleSystem 的 warmupTime）：steps 是每一步的 [步长, 生成几个]，time 是预热完的那一刻的游戏时间。一步一次派发，
   * 用自己的命令编码器马上提交（在这一帧的模拟之前）：每步要自己的 uniform（同一次提交里写同一个缓冲，最后一次会盖掉前面的），
   * 每步之前存活数清零。管线还在编、深度表面还没有时返回 false（下一帧再试），做完返回 true。
   */
  warmup(steps: readonly (readonly [number, number])[], time: number): boolean {
    const pipeline = this.#shared.simPipelines.get(this.kernel.code);
    if (!pipeline || !this.#simBindGroup()) return false;
    const encoder = this.#device.createCommandEncoder({ label: 'GPU particles warmup' });
    const uniforms: GPUBuffer[] = [];
    let elapsed = steps.reduce((sum, [dt]) => sum + dt, 0);
    for (const [dt, wanted] of steps) {
      elapsed -= dt;
      const window = this.#packStep(dt, wanted, time - elapsed);
      const uniform = this.#device.createBuffer({ label: 'GPU particles warmup step', size: this.#simData.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      this.#device.queue.writeBuffer(uniform, 0, this.#simData);
      uniforms.push(uniform);
      encoder.clearBuffer(this.#drawArgs, 4, 4);
      const pass = encoder.beginComputePass({ label: 'GPU particles warmup' });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, this.#simBindGroupWith(uniform));
      if (window > 0) pass.dispatchWorkgroups(Math.ceil(window / WORKGROUP_SIZE));
      pass.end();
    }
    this.#device.queue.submit([encoder.finish()]);
    for (const uniform of uniforms) uniform.destroy();
    return true;
  }

  /** 一步的 uniform 写进 #simData（生成的记账往前走）；返回这一步要处理的那段环有多长。 */
  #packStep(dt: number, wanted: number, time: number): number {
    const emitter = this.emitter;
    // 留两帧的余量：寿命正好到期的粒子要在窗口里被判死，不能先掉出窗口
    const spawn = this.ring.advance(dt, wanted, emitter.particleLifetime[1] + 2 * dt);
    const capacity = this.ring.capacity, window = Math.min(capacity, this.ring.aliveBound);
    const data = this.#simData, bits = this.#simBits;
    const { position, rotation, scale } = emitter.defaultFields;
    data[0] = dt;
    bits[1] = this.ring.capacity;
    bits[2] = spawn.start;
    bits[3] = spawn.count;
    bits[4] = spawn.seed;
    data[5] = emitter.particleLifetime[0];
    data[6] = emitter.particleLifetime[1];
    data[7] = time;
    data.set(position, 8);
    data[11] = scale;
    data.set(rotation, 12);
    bits[16] = (this.ring.head + capacity - window) % capacity;
    bits[17] = window;
    this.kernel.pack(data.subarray(HEADER_VEC4S * 4));
    return window;
  }

  /**
   * 画（渲染器设好管线和绑定组以后调用）：按新旧画的（ByAge，要环的顺序）画最近"最长寿命"秒里生成的那一段环，别的按模拟时
   * 数出来的活着的粒子数间接绘制（不排序的按存活列表，按深度排序的死了的排在最后）。容量大、粒子少时不白跑顶点。
   */
  draw(pass: GPURenderPassEncoder): void {
    if (this.emitter.sortingPolicy === 'byAge') pass.draw(this.#vertices, Math.min(this.ring.capacity, this.ring.aliveBound));
    else pass.drawIndirect(this.#drawArgs, 0);
  }

  /** 按深度排序（只有 ByDepth 的发射器）：back 是相机的朝后方向（世界）。录进 pass。 */
  sort(pass: GPUComputePassEncoder, back: readonly [number, number, number]): void {
    const { keysPipeline, stepPipeline, blockPipeline } = this.#shared;
    if (!this.#sortView || !this.#keysGroup || !this.#stepGroup || !keysPipeline || !stepPipeline || !blockPipeline) return;
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
    // 步距小的步在共享内存里一块一块做（一个工作组 SORT_BLOCK 个），大的一步一次全局派发
    sortPasses(this.#sortSize).forEach(({ block }, i) => {
      pass.setPipeline(block ? blockPipeline : stepPipeline);
      pass.setBindGroup(0, this.#stepGroup!, [i * STAGE_STRIDE]);
      pass.dispatchWorkgroups(Math.ceil(this.#sortSize / (block ? SORT_BLOCK : WORKGROUP_SIZE)));
    });
  }

  /** 调试、测试用：把粒子缓冲读回来（每个粒子 PARTICLE_BYTES / 4 个数，排法见 PARTICLE_WGSL：位置 0..2、寿命 3、速度 4..6）。 */
  async read(): Promise<Float32Array> {
    const size = this.ring.capacity * PARTICLE_BYTES;
    const staging = this.#device.createBuffer({ label: 'GPU particles readback', size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const encoder = this.#device.createCommandEncoder({ label: 'GPU particles readback' });
    encoder.copyBufferToBuffer(this.#particles, 0, staging, 0, size);
    this.#device.queue.submit([encoder.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const data = new Float32Array(staging.getMappedRange().slice(0));
    staging.unmap();
    staging.destroy();
    return data;
  }

  /** 调试、测试用：把排好的键读回来（每个两个 u32：深度的位、槽号；按深度排序的发射器才有意义）。 */
  async readSortKeys(): Promise<{ depth: Float32Array; slot: Uint32Array }> {
    const size = this.#sortSize * 8;
    const staging = this.#device.createBuffer({ label: 'GPU particles sort readback', size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const encoder = this.#device.createCommandEncoder({ label: 'GPU particles sort readback' });
    encoder.copyBufferToBuffer(this.#keys, 0, staging, 0, size);
    this.#device.queue.submit([encoder.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const words = new Uint32Array(staging.getMappedRange().slice(0));
    staging.unmap();
    staging.destroy();
    const depth = new Float32Array(this.#sortSize), slot = new Uint32Array(this.#sortSize);
    const bits = new Float32Array(words.buffer);
    for (let i = 0; i < this.#sortSize; i++) {
      depth[i] = bits[i * 2]!;
      slot[i] = words[i * 2 + 1]!;
    }
    return { depth, slot };
  }

  destroy(): void {
    this.#particles.destroy();
    this.#sim.destroy();
    this.#keys.destroy();
    this.#drawArgs.destroy();
    this.#alive.destroy();
    this.#sortView?.destroy();
    this.#shape.destroy();
  }

  /** 模拟的绑定组；有深度碰撞时按它这一帧的深度表面（换了就重建），还没有表面时是 undefined（不模拟）。 */
  #simBindGroup(): GPUBindGroup | undefined {
    const collider = this.kernel.collider;
    const surface = collider?.depthSurface;
    if (collider && !surface) return undefined;
    const bound = surface && { view: surface.depthView, uniform: surface.uniform };
    if (this.#simGroup && bound?.view === this.#boundSurface?.view && bound?.uniform === this.#boundSurface?.uniform) return this.#simGroup;
    this.#boundSurface = bound;
    return (this.#simGroup = this.#simBindGroupWith(this.#sim));
  }

  /** 模拟的绑定组，uniform 用给的缓冲（预热每一步一个）；深度表面用 #simBindGroup 定下的那个。 */
  #simBindGroupWith(uniform: GPUBuffer): GPUBindGroup {
    const bound = this.#boundSurface;
    return this.#device.createBindGroup({
      label: `GPU particles ${this.emitter.name || 'emitter'}`, layout: bound ? this.#shared.surfaceSimLayout : this.#shared.simLayout,
      entries: [
        { binding: 0, resource: { buffer: uniform } }, { binding: 1, resource: { buffer: this.#particles } },
        ...(bound ? [{ binding: 2, resource: bound.view }, { binding: 3, resource: { buffer: bound.uniform } }] : []),
        { binding: 4, resource: { buffer: this.#drawArgs } }, { binding: 5, resource: { buffer: this.#alive } },
      ],
    });
  }

  /** 这个大小的排序每一次派发的参数（同样大小的发射器共用一块）。 */
  #stages(): GPUBuffer {
    const n = this.#sortSize;
    let buffer = this.#shared.stageBuffers.get(n);
    if (!buffer) {
      const passes = sortPasses(n);
      const data = new Uint32Array((passes.length * STAGE_STRIDE) / 4);
      passes.forEach(({ k, j }, i) => data.set([k, j], (i * STAGE_STRIDE) / 4));
      buffer = this.#device.createBuffer({ label: `GPU particles sort stages ${n}`, size: data.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      this.#device.queue.writeBuffer(buffer, 0, data);
      this.#shared.stageBuffers.set(n, buffer);
    }
    return buffer;
  }
}
