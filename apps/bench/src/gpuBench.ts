// 量 GPU 时间的实验页面（displacement、procedural）共用的那一套：设备、离屏的颜色和深度、时间戳查询、读像素、往页面上打字。
// 画到离屏的贴图上，不走画布：面板藏起来时 requestAnimationFrame 不触发，时间戳查询照样能量。
export const COLOR_FORMAT: GPUTextureFormat = 'rgba8unorm';
export const DEPTH_FORMAT: GPUTextureFormat = 'depth24plus';

export type Draw = (pass: GPURenderPassEncoder) => void;

export interface GpuBench {
  readonly device: GPUDevice;
  readonly width: number;
  readonly height: number;
  /** timestamp：时间戳查询；wall：没有这个特性，退回"等提交的命令做完"的墙钟时间。 */
  readonly timing: 'timestamp' | 'wall';
  print(line: string): void;
  upload(data: ArrayBufferView, usage: number): GPUBuffer;
  /** 画一帧（draw 里发绘制命令），返回 GPU 时间（毫秒）。 */
  render(draw: Draw): Promise<number>;
  /** 先画 5 帧预热，再画 frames 帧，返回 GPU 时间的中位数（毫秒）。 */
  measure(draw: Draw, frames?: number): Promise<number>;
  /** 上一帧的画面（RGBA，一行行从上到下）。 */
  readPixels(): Promise<Uint8Array>;
  /** 把一帧画面放到页面上，肉眼也能看一眼。 */
  show(pixels: Uint8Array): void;
}

/**
 * 跑一个实验：结果放进 globalThis.<name>Results，出错时错误信息放进 globalThis.<name>Error
 * （`node tools/run-page.ts <地址> <name>Results --error <name>Error` 等这两个）。打出来的字在页面的 #out 里。
 */
export function runBench<T>(name: string, [width, height]: readonly [number, number], main: (bench: GpuBench) => Promise<T>): void {
  const out = document.getElementById('out')!, lines: string[] = [], globals = globalThis as Record<string, unknown>;
  const print = (line: string) => {
    lines.push(line);
    out.textContent = lines.join('\n');
  };
  createBench(width, height, print).then(main).then((results) => {
    globals[`${name}Results`] = results;
    print('\ndone');
  }).catch((error: unknown) => {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    globals[`${name}Error`] = message;
    print(`failed: ${message}`);
  });
}

async function createBench(width: number, height: number, print: (line: string) => void): Promise<GpuBench> {
  const adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('WebGPU is not available');
  const timestamps = adapter.features.has('timestamp-query');
  const device = await adapter.requestDevice({ requiredFeatures: timestamps ? ['timestamp-query'] : [] });
  print(`GPU ${adapter.info.vendor} ${adapter.info.architecture} ${adapter.info.description}; timing: ${timestamps ? 'timestamp queries' : 'wall clock until the queue is done'}`);

  const color = device.createTexture({ size: [width, height], format: COLOR_FORMAT, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
  const depth = device.createTexture({ size: [width, height], format: DEPTH_FORMAT, usage: GPUTextureUsage.RENDER_ATTACHMENT });
  const querySet = timestamps ? device.createQuerySet({ type: 'timestamp', count: 2 }) : undefined;
  const resolved = device.createBuffer({ size: 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
  const readable = device.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });

  const render = async (draw: Draw): Promise<number> => {
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: color.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0.1, 0.1, 0.1, 1] }],
      depthStencilAttachment: { view: depth.createView(), depthLoadOp: 'clear', depthStoreOp: 'store', depthClearValue: 1 },
      ...(querySet ? { timestampWrites: { querySet, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 } } : {}),
    });
    draw(pass);
    pass.end();
    if (querySet) {
      encoder.resolveQuerySet(querySet, 0, 2, resolved, 0);
      encoder.copyBufferToBuffer(resolved, 0, readable, 0, 16);
    }
    const start = performance.now();
    device.queue.submit([encoder.finish()]);
    if (!querySet) {
      await device.queue.onSubmittedWorkDone();
      return performance.now() - start;
    }
    await readable.mapAsync(GPUMapMode.READ);
    const times = new BigUint64Array(readable.getMappedRange().slice(0));
    readable.unmap();
    return Number(times[1]! - times[0]!) / 1e6;
  };

  return {
    device, width, height, print, render,
    timing: timestamps ? 'timestamp' : 'wall',
    // 缓冲的大小要是 4 的倍数（writeBuffer 写的字节数也是），所以建的时候映射着拷进去
    upload(data, usage) {
      const buffer = device.createBuffer({ size: (data.byteLength + 3) & ~3, usage: usage | GPUBufferUsage.COPY_DST, mappedAtCreation: true });
      new Uint8Array(buffer.getMappedRange()).set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      buffer.unmap();
      return buffer;
    },
    async measure(draw, frames = 40) {
      for (let i = 0; i < 5; i++) await render(draw);
      const times: number[] = [];
      for (let i = 0; i < frames; i++) times.push(await render(draw));
      return times.sort((a, b) => a - b)[times.length >> 1]!;
    },
    async readPixels() {
      const buffer = device.createBuffer({ size: width * height * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      const encoder = device.createCommandEncoder();
      encoder.copyTextureToBuffer({ texture: color }, { buffer, bytesPerRow: width * 4 }, [width, height]);
      device.queue.submit([encoder.finish()]);
      await buffer.mapAsync(GPUMapMode.READ);
      const pixels = new Uint8Array(buffer.getMappedRange().slice(0));
      buffer.destroy();
      return pixels;
    },
    show(pixels) {
      const canvas = document.createElement('canvas');
      [canvas.width, canvas.height] = [width, height];
      canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(pixels), width, height), 0, 0);
      document.body.append(canvas);
    },
  };
}
