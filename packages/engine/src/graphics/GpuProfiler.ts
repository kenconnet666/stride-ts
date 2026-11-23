/**
 * 渲染通道的 GPU 耗时（WebGPU 的 timestamp-query）。打开后（enabled）每个渲染通道在开始和结束各写一个时间戳，
 * 帧末解析进缓冲、复制到读回缓冲，提交后异步读回，按"作用域/通道名"累计。作用域由调用方设（后处理按效果设），
 * 这样同一个着色器（比如 ImageScaler）用在不同效果里的时间分得开。
 * Chrome 默认把时间戳量化到 100 µs，测细的通道要开 --enable-webgpu-developer-features。
 * 只用来开发时测量：关着时 passTimestamps 返回 undefined，没有开销。
 */

/** 一帧最多记录的通道数。 */
const MAX_PASSES = 256;

export interface GpuTiming {
  /** 平均每帧的毫秒数（同名的通道一帧里多次出现时加起来）。 */
  readonly milliseconds: number;
  /** 平均每帧的通道数。 */
  readonly passes: number;
}

/** 逐帧的记录最多留多少帧（120 Hz 下 5 秒）。 */
const FRAME_LOG = 600;

/** 一帧的 GPU 时间：各通道加起来、从第一个通道开始到最后一个结束的跨度（含通道之间的空档），和每个通道的毫秒数。 */
export interface GpuFrame {
  readonly totalMs: number;
  readonly spanMs: number;
  readonly passes: readonly (readonly [label: string, ms: number])[];
}

const profilers = new WeakMap<GPUDevice, GpuProfiler>();

export class GpuProfiler {
  /** 打开后从下一帧开始记录。 */
  enabled = false;
  /** 之后的通道记在这个作用域下。 */
  scope = '';
  readonly supported: boolean;
  readonly #device: GPUDevice;
  readonly #querySet: GPUQuerySet | undefined;
  readonly #resolve: GPUBuffer | undefined;
  /** 读回缓冲：还在 mapAsync 的那一帧不再写它，空闲的轮流用。 */
  readonly #readbacks: { buffer: GPUBuffer; busy: boolean }[] = [];
  #labels: string[] = [];
  readonly #totals = new Map<string, { nanoseconds: number; passes: number }>();
  #frames = 0;
  /** 最近 FRAME_LOG 帧逐帧的记录（找偶发的长帧用），reset 清掉。 */
  readonly #frameLog: GpuFrame[] = [];

  constructor(device: GPUDevice, supported: boolean) {
    this.#device = device;
    this.supported = supported;
    if (supported) {
      this.#querySet = device.createQuerySet({ label: 'GpuProfiler', type: 'timestamp', count: MAX_PASSES * 2 });
      this.#resolve = device.createBuffer({ label: 'GpuProfiler resolve', size: MAX_PASSES * 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
    }
    profilers.set(device, this);
  }

  /** 这个设备的分析器（GraphicsDevice 创建）；渲染代码按 GPUDevice 找，不用层层传。 */
  static of(device: GPUDevice): GpuProfiler | undefined {
    return profilers.get(device);
  }

  /** beginRenderPass 的 timestampWrites；没打开、不支持或者这一帧记满了时是 undefined。 */
  passTimestamps(label: string): GPURenderPassTimestampWrites | undefined {
    if (!this.enabled || !this.#querySet || this.#labels.length >= MAX_PASSES) return undefined;
    const index = this.#labels.length;
    this.#labels.push(this.scope ? `${this.scope}/${label}` : label);
    return { querySet: this.#querySet, beginningOfPassWriteIndex: index * 2, endOfPassWriteIndex: index * 2 + 1 };
  }

  /** 帧末、提交之前调用：把这一帧的时间戳解析出来，复制到一个空闲的读回缓冲。 */
  resolve(encoder: GPUCommandEncoder): void {
    const count = this.#labels.length;
    if (count === 0 || !this.#querySet || !this.#resolve) return;
    let readback = this.#readbacks.find((r) => !r.busy);
    if (!readback) {
      readback = { buffer: this.#device.createBuffer({ label: 'GpuProfiler readback', size: MAX_PASSES * 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }), busy: false };
      this.#readbacks.push(readback);
    }
    encoder.resolveQuerySet(this.#querySet, 0, count * 2, this.#resolve, 0);
    encoder.copyBufferToBuffer(this.#resolve, 0, readback.buffer, 0, count * 16);
    readback.busy = true;
    const labels = this.#labels;
    this.#labels = [];
    // 提交之后才能 map：放到微任务里，调用方这一帧的 submit 已经发出
    queueMicrotask(() => void this.#collect(readback, labels));
  }

  /** 累计以来每个"作用域/通道"的平均耗时，按耗时从大到小。 */
  report(): [string, GpuTiming][] {
    const frames = Math.max(1, this.#frames);
    return [...this.#totals].map(([label, { nanoseconds, passes }]) => [label, { milliseconds: nanoseconds / 1e6 / frames, passes: passes / frames }] as [string, GpuTiming])
      .sort((a, b) => b[1].milliseconds - a[1].milliseconds);
  }

  /** 累计以来逐帧的记录（最多最近 FRAME_LOG 帧），按时间先后。 */
  frames(): readonly GpuFrame[] {
    return this.#frameLog;
  }

  /** 清掉累计，重新开始。 */
  reset(): void {
    this.#totals.clear();
    this.#frames = 0;
    this.#frameLog.length = 0;
  }

  destroy(): void {
    this.#querySet?.destroy();
    this.#resolve?.destroy();
    for (const { buffer } of this.#readbacks) buffer.destroy();
  }

  async #collect(readback: { buffer: GPUBuffer; busy: boolean }, labels: readonly string[]): Promise<void> {
    try {
      await readback.buffer.mapAsync(GPUMapMode.READ, 0, labels.length * 16);
    } catch {
      readback.busy = false; // 设备销毁时 map 会失败
      return;
    }
    const times = new BigUint64Array(readback.buffer.getMappedRange(0, labels.length * 16));
    const passes: [string, number][] = [];
    let first = times[0]!, last = times[1]!, frameTotal = 0;
    labels.forEach((label, i) => {
      const begin = times[i * 2]!, end = times[i * 2 + 1]!;
      const nanoseconds = end > begin ? Number(end - begin) : 0;
      const total = this.#totals.get(label) ?? { nanoseconds: 0, passes: 0 };
      total.nanoseconds += nanoseconds;
      total.passes++;
      this.#totals.set(label, total);
      passes.push([label, nanoseconds / 1e6]);
      frameTotal += nanoseconds;
      if (begin < first) first = begin;
      if (end > last) last = end;
    });
    readback.buffer.unmap();
    this.#frameLog.push({ totalMs: frameTotal / 1e6, spanMs: last > first ? Number(last - first) / 1e6 : 0, passes });
    if (this.#frameLog.length > FRAME_LOG) this.#frameLog.shift();
    readback.busy = false;
    this.#frames++;
  }
}
