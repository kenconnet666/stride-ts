/**
 * 按名字缓存的管线，每个设备一份（`pipelineCache(device)`）：用到时还没有就当场建（createRenderPipeline、createComputePipeline，
 * 着色器的编译堵住这一帧），`warm*` 在后台编（create*PipelineAsync，不卡帧），编好放进来。给固定的、整个设备共用一条的管线用
 * （天空、云、预滤波、DFG 表、文字）：各处按 label 当键，有变体（颜色格式）的把变体拼进键里。
 *
 *   const pipeline = pipelineCache(device).compute('Atmosphere sky view', () => ({ label: 'Atmosphere sky view', layout: 'auto', compute: … }));
 *   await pipelineCache(device).warmCompute('Atmosphere sky view', describe);   // 加载场景时
 */
export class PipelineCache {
  readonly #device: GPUDevice;
  readonly #ready = new Map<string, GPURenderPipeline | GPUComputePipeline>();
  readonly #warming = new Map<string, Promise<void>>();

  constructor(device: GPUDevice) {
    this.#device = device;
  }

  render(key: string, describe: () => GPURenderPipelineDescriptor): GPURenderPipeline {
    return this.#get(key, () => this.#device.createRenderPipeline(describe())) as GPURenderPipeline;
  }

  compute(key: string, describe: () => GPUComputePipelineDescriptor): GPUComputePipeline {
    return this.#get(key, () => this.#device.createComputePipeline(describe())) as GPUComputePipeline;
  }

  /** 后台编；已经有了返回 undefined，正在编返回同一个 Promise。编不出来时去掉，用到时当场编、把错误报在那一帧。 */
  warmRender(key: string, describe: () => GPURenderPipelineDescriptor): Promise<void> | undefined {
    return this.#warm(key, () => this.#device.createRenderPipelineAsync(describe()));
  }

  warmCompute(key: string, describe: () => GPUComputePipelineDescriptor): Promise<void> | undefined {
    return this.#warm(key, () => this.#device.createComputePipelineAsync(describe()));
  }

  #get(key: string, create: () => GPURenderPipeline | GPUComputePipeline): GPURenderPipeline | GPUComputePipeline {
    let pipeline = this.#ready.get(key);
    if (!pipeline) this.#ready.set(key, (pipeline = create()));
    return pipeline;
  }

  #warm(key: string, create: () => Promise<GPURenderPipeline | GPUComputePipeline>): Promise<void> | undefined {
    if (this.#ready.has(key)) return undefined;
    let warming = this.#warming.get(key);
    if (!warming) {
      warming = create().then(
        (pipeline) => {
          if (!this.#ready.has(key)) this.#ready.set(key, pipeline);
        },
        (error: unknown) => console.warn(`${key}: warming the pipeline failed`, error),
      ).finally(() => this.#warming.delete(key));
      this.#warming.set(key, warming);
    }
    return warming;
  }
}

const caches = new WeakMap<GPUDevice, PipelineCache>();

/** 这个设备的管线缓存。 */
export function pipelineCache(device: GPUDevice): PipelineCache {
  let cache = caches.get(device);
  if (!cache) caches.set(device, (cache = new PipelineCache(device)));
  return cache;
}
