/**
 * 测试用的假 WebGPU：没有真的 GPU 时检查"录了什么命令"。设备、通道编码器上的任何方法都能调用，按顺序记进 calls
 * （方法名和参数）；createBuffer 给的缓冲带 size，queue.writeBuffer 记下写进去的字节（拷一份）。
 * 用前调 stubGpuGlobals()：GPUBufferUsage 这些常量在 Node 里没有。
 */
import { vi } from 'vitest';

export interface GpuCall {
  readonly method: string;
  readonly args: readonly unknown[];
}

/** 一次 queue.writeBuffer：写进哪个缓冲的哪里、写的字节。 */
export interface BufferWrite {
  readonly buffer: unknown;
  readonly offset: number;
  readonly bytes: Uint8Array;
}

/** WebGPU 的标志常量（值随便给，不同就行）。 */
export function stubGpuGlobals(): void {
  const flags = (names: readonly string[]) => Object.fromEntries(names.map((name, i) => [name, 1 << i]));
  vi.stubGlobal('GPUBufferUsage', flags(['MAP_READ', 'MAP_WRITE', 'COPY_SRC', 'COPY_DST', 'INDEX', 'VERTEX', 'UNIFORM', 'STORAGE', 'INDIRECT', 'QUERY_RESOLVE']));
  vi.stubGlobal('GPUTextureUsage', flags(['COPY_SRC', 'COPY_DST', 'TEXTURE_BINDING', 'STORAGE_BINDING', 'RENDER_ATTACHMENT']));
  vi.stubGlobal('GPUShaderStage', flags(['VERTEX', 'FRAGMENT', 'COMPUTE']));
  vi.stubGlobal('GPUMapMode', flags(['READ', 'WRITE']));
}

/** 什么方法都能调、调了返回另一个这样的对象；调用记进 calls。 */
function recorder(calls: GpuCall[], overrides: Record<string, (...args: never[]) => unknown> = {}): never {
  return new Proxy({}, {
    get: (_target, key) => {
      // 不是 thenable，await 不会把它当 Promise
      if (key === 'then' || typeof key === 'symbol') return undefined;
      if (Object.hasOwn(overrides, key)) return overrides[key];
      return (...args: unknown[]) => {
        calls.push({ method: key, args });
        return recorder(calls);
      };
    },
  }) as never;
}

/** 假设备和它录下的东西。pass 是给被测代码画进去的通道编码器。 */
export function fakeGpu(): { device: GPUDevice; pass: GPURenderPassEncoder; calls: GpuCall[]; writes: BufferWrite[] } {
  const calls: GpuCall[] = [];
  const writes: BufferWrite[] = [];
  const queue = recorder(calls, {
    writeBuffer: (buffer: unknown, offset: number, data: ArrayBufferView | ArrayBuffer, dataOffset = 0, size?: number) => {
      // dataOffset、size 对 TypedArray 按元素算，对 ArrayBuffer 按字节算（同 WebGPU）
      const view = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      const unit = data instanceof ArrayBuffer ? 1 : (data as unknown as { BYTES_PER_ELEMENT?: number }).BYTES_PER_ELEMENT ?? 1;
      const start = dataOffset * unit;
      writes.push({ buffer, offset, bytes: view.slice(start, size === undefined ? undefined : start + size * unit) });
    },
  });
  const device = recorder(calls, {
    createBuffer: (descriptor: GPUBufferDescriptor) => {
      calls.push({ method: 'createBuffer', args: [descriptor] });
      return { label: descriptor.label, size: descriptor.size, destroy: () => {} };
    },
    // 异步建管线：下一个微任务就编好
    createRenderPipelineAsync: (descriptor: GPURenderPipelineDescriptor) => {
      calls.push({ method: 'createRenderPipelineAsync', args: [descriptor] });
      return Promise.resolve(recorder(calls));
    },
    createComputePipelineAsync: (descriptor: GPUComputePipelineDescriptor) => {
      calls.push({ method: 'createComputePipelineAsync', args: [descriptor] });
      return Promise.resolve(recorder(calls));
    },
  });
  // queue 是属性不是方法
  const withQueue = new Proxy(device as object, { get: (target, key) => (key === 'queue' ? queue : Reflect.get(target, key)) }) as GPUDevice;
  return { device: withQueue, pass: recorder(calls), calls, writes };
}

/** calls 里某个方法的所有调用的第一个参数。 */
export function firstArgs<T>(calls: readonly GpuCall[], method: string): T[] {
  return calls.filter((call) => call.method === method).map((call) => call.args[0] as T);
}
