/**
 * 后处理效果的公共部分（Stride 的 ImageEffect、ImageEffectShader 的角色）：
 * - RenderTargetPool：每帧借用的临时渲染目标（Stride 的 NewScopedRenderTarget2D），尺寸和格式不变时每帧拿回同一批纹理；
 * - UniformArena：一帧里每次绘制的参数各占一段（256 字节对齐）。同一个缓冲在提交前写两次，两次绘制读到的都是后写的值
 *   （docs/lessons.md 的 writeBuffer 生效时机），所以参数不共用缓冲；
 * - FullscreenShader：一个全屏着色器按目标格式和混合方式缓存管线。
 */
import { GpuProfiler } from '../../graphics/GpuProfiler';
import { FULLSCREEN_VERTEX } from '../fullscreen';
import type { GaussianBlur } from './GaussianBlur';
import type { ImageScaler } from './ImageScaler';

export { FULLSCREEN_VERTEX };

/** 一帧的后处理里各效果共用的东西（PostProcessingEffects 每帧给一份）。 */
export interface ImageEffectContext {
  readonly encoder: GPUCommandEncoder;
  readonly pool: RenderTargetPool;
  readonly arena: UniformArena;
  readonly scaler: ImageScaler;
  readonly blur: GaussianBlur;
}

export class RenderTargetPool {
  readonly #device: GPUDevice;
  readonly #free = new Map<string, GPUTexture[]>();
  readonly #used = new Map<string, GPUTexture[]>();

  constructor(device: GPUDevice) {
    this.#device = device;
  }

  /** 借一个渲染目标（可以采样）；这一帧内不会再借给别人。 */
  acquire(width: number, height: number, format: GPUTextureFormat, label: string): GPUTexture {
    const key = `${width}x${height}:${format}`;
    const texture = this.#free.get(key)?.pop() ?? this.#device.createTexture({
      label,
      size: [Math.max(1, width), Math.max(1, height)],
      format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    let used = this.#used.get(key);
    if (!used) this.#used.set(key, (used = []));
    used.push(texture);
    return texture;
  }

  /** 每帧开始时调用：上一帧借出的都还回来；上一帧没用到的销毁（画布尺寸变了以后的旧纹理）。 */
  recycle(): void {
    for (const textures of this.#free.values()) for (const texture of textures) texture.destroy();
    this.#free.clear();
    for (const [key, textures] of this.#used) this.#free.set(key, textures);
    this.#used.clear();
  }

  destroy(): void {
    for (const map of [this.#free, this.#used]) {
      for (const textures of map.values()) for (const texture of textures) texture.destroy();
      map.clear();
    }
  }
}

/** 一帧的 uniform 参数：各次绘制写在同一个缓冲的不同位置。 */
export class UniformArena {
  readonly #device: GPUDevice;
  readonly #buffer: GPUBuffer;
  readonly #data: ArrayBuffer;
  #offset = 0;

  /** 容量固定：一帧的后处理参数只有几 KB，超出说明有效果在循环里漏了 reset。 */
  constructor(device: GPUDevice, capacity = 64 * 1024) {
    this.#device = device;
    this.#data = new ArrayBuffer(capacity);
    this.#buffer = device.createBuffer({ label: 'post-processing parameters', size: capacity, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  }

  /** 每帧开始时调用。 */
  reset(): void {
    this.#offset = 0;
  }

  /** 放一段参数，返回绑定用的 { buffer, offset, size }。提交前要调用 flush。 */
  push(values: ArrayLike<number>): GPUBufferBinding {
    const size = Math.max(16, Math.ceil((values.length * 4) / 16) * 16);
    const offset = this.#offset;
    if (offset + size > this.#data.byteLength) throw new RangeError(`UniformArena: post-processing parameters of one frame exceed ${this.#data.byteLength} bytes`);
    new Float32Array(this.#data, offset, values.length).set(values);
    this.#offset = Math.ceil((offset + size) / 256) * 256;
    return { buffer: this.#buffer, offset, size };
  }

  /** 把这一帧的参数一次写进 GPU。 */
  flush(): void {
    if (this.#offset > 0) this.#device.queue.writeBuffer(this.#buffer, 0, this.#data, 0, Math.min(this.#offset, this.#data.byteLength));
  }

  destroy(): void {
    this.#buffer.destroy();
  }
}

/** 纹理的默认视图，每张纹理只建一次。 */
const views = new WeakMap<GPUTexture, GPUTextureView>();
export function viewOf(texture: GPUTexture): GPUTextureView {
  let view = views.get(texture);
  if (!view) views.set(texture, (view = texture.createView()));
  return view;
}

/** 给 GPU 对象编号，拼绑定组的缓存键用。 */
const ids = new WeakMap<object, number>();
let nextId = 1;
function idOf(object: object): number {
  let id = ids.get(object);
  if (id === undefined) ids.set(object, (id = nextId++));
  return id;
}

/** 绑定的资源：纹理直接给（用它的默认视图），其余同 GPUBindingResource。 */
export type FullscreenResource = GPUTexture | GPUSampler | GPUBufferBinding | GPUTextureView;

/** 绑定组缓存的上限：池里的纹理换了（画布尺寸变了）以后，旧的键不会再命中，到上限就清空。 */
const MAX_CACHED_BIND_GROUPS = 512;

/**
 * 一个全屏着色器（入口 fullscreenVertex 和 fs），按目标格式和混合方式缓存管线。绑定组按资源缓存：池里的纹理每帧是同一批，
 * uniform 每帧写在同样的偏移上，所以每帧的绘制都能复用上一帧的绑定组；有临时视图（后备缓冲）时不缓存。
 */
export class FullscreenShader {
  readonly device: GPUDevice;
  readonly #module: GPUShaderModule;
  readonly #label: string;
  readonly #pipelines = new Map<string, GPURenderPipeline>();
  readonly #bindGroups = new Map<string, GPUBindGroup>();

  constructor(device: GPUDevice, label: string, code: string) {
    this.device = device;
    this.#label = label;
    this.#module = device.createShaderModule({ label, code: `${FULLSCREEN_VERTEX}\n${code}` });
  }

  /** formats 是各渲染目标（@location 0、1、…）的格式，混合方式各目标相同。 */
  pipeline(formats: readonly GPUTextureFormat[], blend?: GPUBlendState): GPURenderPipeline {
    const key = `${formats.join(',')}:${blend ? idOf(blend) : ''}`;
    let pipeline = this.#pipelines.get(key);
    if (!pipeline) {
      pipeline = this.device.createRenderPipeline({
        label: this.#label,
        layout: 'auto',
        vertex: { module: this.#module, entryPoint: 'fullscreenVertex' },
        fragment: { module: this.#module, entryPoint: 'fs', targets: formats.map((format) => ({ format, ...(blend ? { blend } : {}) })) },
      });
      this.#pipelines.set(key, pipeline);
    }
    return pipeline;
  }

  /**
   * 画一次全屏三角形：target 是一个或几个渲染目标（几个时着色器按 @location 顺序输出）；resources 按绑定号排；
   * load 为真时保留目标原来的内容（混合用）；format 是目标为纹理视图时的格式。
   */
  draw(encoder: GPUCommandEncoder, target: GPUTexture | GPUTextureView | readonly GPUTexture[], resources: readonly FullscreenResource[], { blend, load = false, format }: { blend?: GPUBlendState; load?: boolean; format?: GPUTextureFormat } = {}): void {
    const targets: readonly (GPUTexture | GPUTextureView)[] = target instanceof GPUTexture || target instanceof GPUTextureView ? [target] : target;
    const formats = targets.map((t) => {
      const targetFormat = t instanceof GPUTexture ? t.format : format;
      if (!targetFormat) throw new Error(`${this.#label}: drawing into a texture view needs its format`);
      return targetFormat;
    });
    const pipeline = this.pipeline(formats, blend);
    const timestampWrites = GpuProfiler.of(this.device)?.passTimestamps(this.#label);
    const pass = encoder.beginRenderPass({
      label: this.#label,
      colorAttachments: targets.map((t) => ({ view: t instanceof GPUTexture ? viewOf(t) : t, loadOp: load ? 'load' : 'clear', clearValue: [0, 0, 0, 0], storeOp: 'store' })),
      ...(timestampWrites ? { timestampWrites } : {}),
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, this.#bindGroup(pipeline, resources));
    pass.draw(3);
    pass.end();
  }

  #bindGroup(pipeline: GPURenderPipeline, resources: readonly FullscreenResource[]): GPUBindGroup {
    const create = () => this.device.createBindGroup({
      label: this.#label,
      layout: pipeline.getBindGroupLayout(0),
      entries: resources.map((resource, binding) => ({ binding, resource: resource instanceof GPUTexture ? viewOf(resource) : resource })),
    });
    if (resources.some((resource) => resource instanceof GPUTextureView)) return create();
    let key = String(idOf(pipeline));
    for (const resource of resources) {
      key += 'buffer' in resource ? `|${idOf(resource.buffer)}:${resource.offset ?? 0}:${resource.size ?? ''}` : `|${idOf(resource)}`;
    }
    let group = this.#bindGroups.get(key);
    if (!group) {
      if (this.#bindGroups.size >= MAX_CACHED_BIND_GROUPS) this.#bindGroups.clear();
      this.#bindGroups.set(key, (group = create()));
    }
    return group;
  }
}

/** 直接相加（Stride 的 BlendStates.Additive 是源先乘源的 alpha，需要时在着色器里乘）。 */
export const ADD_BLEND: GPUBlendState = {
  color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
};
