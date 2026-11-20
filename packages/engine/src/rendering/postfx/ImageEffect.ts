/**
 * 后处理效果的公共部分（Stride 的 ImageEffect、ImageEffectShader 的角色）：
 * - RenderTargetPool：每帧借用的临时渲染目标（Stride 的 NewScopedRenderTarget2D），尺寸和格式不变时每帧拿回同一批纹理；
 * - UniformArena：一帧里每次绘制的参数各占一段（256 字节对齐）。同一个缓冲在提交前写两次，两次绘制读到的都是后写的值
 *   （docs/lessons.md 的 writeBuffer 生效时机），所以参数不共用缓冲；
 * - FullscreenShader：一个全屏着色器按目标格式和混合方式缓存管线（按设备共用，fullscreenPipeline），录通道时顺便说出要哪条，
 *   加载场景时可以先在后台编好（RenderGraph.warm、PostProcessingEffects.warm）。
 */
import { GpuProfiler } from '../../graphics/GpuProfiler';
import { FULLSCREEN_VERTEX } from '../wgsl';
import type { GraphTexture, PassBuilder, PassResources, RenderGraph } from '../RenderGraph';
import type { GaussianBlur } from './GaussianBlur';
import type { ImageScaler } from './ImageScaler';


/** 一帧的后处理里各效果共用的东西（PostProcessingEffects 每帧给一份）。 */
export interface ImageEffectContext {
  readonly frame: EffectFrame;
  readonly arena: UniformArena;
  readonly scaler: ImageScaler;
  readonly blur: GaussianBlur;
}

/** 效果读写的画面：这一帧的临时目标（渲染图的句柄），或者一张真的贴图（场景的 HDR 画面这种图外面的）。 */
export type Image = GraphTexture | GPUTexture;

export const isGraphTexture = (value: object): value is GraphTexture => 'imported' in value;

/**
 * 一帧后处理的录制：效果往渲染图里加通道（FullscreenShader.draw）、要临时目标（acquire），都录完了由 PostProcessingEffects
 * 执行。临时目标用到才占一张真的贴图、最后一次用完就让给后面的（见 RenderGraph），所以一串中间结果只占同时要用的那几张。
 */
export class EffectFrame {
  readonly encoder: GPUCommandEncoder;
  readonly graph: RenderGraph;
  readonly #profiler: GpuProfiler | undefined;

  constructor(encoder: GPUCommandEncoder, graph: RenderGraph, profiler: GpuProfiler | undefined) {
    this.encoder = encoder;
    this.graph = graph;
    this.#profiler = profiler;
  }

  /** 这一帧的一个临时渲染目标（可以采样）。 */
  acquire(width: number, height: number, format: GPUTextureFormat, label: string): GraphTexture {
    return this.graph.texture({ label, width: Math.max(1, width), height: Math.max(1, height), format });
  }

  /**
   * 加一个通道（同 RenderGraph.pass，warm 是它要的管线的预热）；GPU 耗时的分组（GpuProfiler.scope）按加的时候的算，执行时
   * 换过去、执行完换回来（不换回来的话，最后一个通道的分组会留到下一帧，下一帧先加的通道就记到它名下）。
   */
  pass(name: string, setup: (builder: PassBuilder) => void, execute: (resources: PassResources) => void, warm?: () => Promise<void> | undefined): void {
    const profiler = this.#profiler;
    if (!profiler) return this.graph.pass(name, setup, execute, warm);
    const scope = profiler.scope;
    this.graph.pass(name, setup, (resources) => {
      const outer = profiler.scope;
      profiler.scope = scope;
      try {
        execute(resources);
      } finally {
        profiler.scope = outer;
      }
    }, warm);
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
function viewOf(texture: GPUTexture): GPUTextureView {
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
/** 录制时给的资源：还可以是这一帧的临时目标。 */
export type RecordedResource = FullscreenResource | GraphTexture;

/**
 * 全屏管线按设备缓存：着色器代码、目标格式、混合方式一样就是同一条（模块也按代码共用）。所以预热时另建的一份后处理
 * （PostProcessingEffects.warm）编好的，真的那份直接用上。还在后台编的是 Promise。
 */
interface FullscreenCache {
  readonly modules: Map<string, GPUShaderModule>;
  readonly pipelines: Map<string, GPURenderPipeline | Promise<GPURenderPipeline>>;
}
const FULLSCREEN_CACHE = new WeakMap<GPUDevice, FullscreenCache>();

function fullscreenCache(device: GPUDevice): FullscreenCache {
  let cache = FULLSCREEN_CACHE.get(device);
  if (!cache) FULLSCREEN_CACHE.set(device, (cache = { modules: new Map(), pipelines: new Map() }));
  return cache;
}

function fullscreenDescriptor(device: GPUDevice, label: string, code: string, formats: readonly GPUTextureFormat[], blend: GPUBlendState | undefined): [key: string, descriptor: GPURenderPipelineDescriptor] {
  const { modules } = fullscreenCache(device);
  let module = modules.get(code);
  if (!module) modules.set(code, (module = device.createShaderModule({ label, code })));
  return [
    `${code}\n${formats.join(',')}\n${blend ? JSON.stringify(blend) : ''}`,
    {
      label,
      layout: 'auto',
      vertex: { module, entryPoint: 'fullscreenVertex' },
      fragment: { module, entryPoint: 'fs', targets: formats.map((format) => ({ format, ...(blend ? { blend } : {}) })) },
    },
  ];
}

/**
 * 全屏着色器（code 里有入口 fullscreenVertex 和 fs）画进 formats 这几个目标的管线。没编过（也没在后台编完）时当场编：
 * 这一帧会卡一下，预热（warmFullscreenPipeline）就是为了不走到这里。
 */
export function fullscreenPipeline(device: GPUDevice, label: string, code: string, formats: readonly GPUTextureFormat[], blend?: GPUBlendState): GPURenderPipeline {
  const [key, descriptor] = fullscreenDescriptor(device, label, code, formats, blend);
  const { pipelines } = fullscreenCache(device);
  const cached = pipelines.get(key);
  if (cached && !(cached instanceof Promise)) return cached;
  const pipeline = device.createRenderPipeline(descriptor);
  pipelines.set(key, pipeline);
  return pipeline;
}

/** 在后台编这条管线（createRenderPipelineAsync，不卡帧），编好放进缓存；已经有了（或者正在编）时返回 undefined。 */
export function warmFullscreenPipeline(device: GPUDevice, label: string, code: string, formats: readonly GPUTextureFormat[], blend?: GPUBlendState): Promise<void> | undefined {
  const [key, descriptor] = fullscreenDescriptor(device, label, code, formats, blend);
  const { pipelines } = fullscreenCache(device);
  if (pipelines.has(key)) return undefined;
  const pending = device.createRenderPipelineAsync(descriptor);
  pipelines.set(key, pending);
  return pending.then(
    (pipeline) => {
      if (pipelines.get(key) === pending) pipelines.set(key, pipeline);
    },
    async (error: unknown) => {
      // 编不出来：去掉，用到时当场编会把错误报在那一帧。WGSL 写错时管线的错误只说模块无效，行号和原因在模块的编译信息里
      if (pipelines.get(key) === pending) pipelines.delete(key);
      const messages = await fullscreenCache(device).modules.get(code)?.getCompilationInfo().then((info) => info.messages.filter((m) => m.type === 'error'));
      const details = messages?.length ? `\n${messages.map((m) => `  line ${m.lineNum}:${m.linePos} ${m.message}`).join('\n')}` : '';
      console.warn(`${label}: warming the pipeline failed${details}`, error);
    },
  );
}

/** 绑定组缓存的上限：池里的纹理换了（画布尺寸变了）以后，旧的键不会再命中，到上限就清空。 */
const MAX_CACHED_BIND_GROUPS = 512;

/**
 * 一个全屏着色器（入口 fullscreenVertex 和 fs），管线按目标格式和混合方式缓存（fullscreenPipeline）。绑定组按资源缓存：池里的
 * 纹理每帧是同一批，uniform 每帧写在同样的偏移上，所以每帧的绘制都能复用上一帧的绑定组；有临时视图（后备缓冲）时不缓存。
 */
export class FullscreenShader {
  readonly device: GPUDevice;
  readonly #code: string;
  readonly #label: string;
  readonly #bindGroups = new Map<string, GPUBindGroup>();

  constructor(device: GPUDevice, label: string, code: string) {
    this.device = device;
    this.#label = label;
    this.#code = `${FULLSCREEN_VERTEX}\n${code}`;
  }

  /** formats 是各渲染目标（@location 0、1、…）的格式，混合方式各目标相同。 */
  pipeline(formats: readonly GPUTextureFormat[], blend?: GPUBlendState): GPURenderPipeline {
    return fullscreenPipeline(this.device, this.#label, this.#code, formats, blend);
  }

  /** 在后台编这条管线（同 warmFullscreenPipeline）。 */
  warm(formats: readonly GPUTextureFormat[], blend?: GPUBlendState): Promise<void> | undefined {
    return warmFullscreenPipeline(this.device, this.#label, this.#code, formats, blend);
  }

  /**
   * 往这一帧的渲染图里加一个通道：画一次全屏三角形。target 是一个或几个渲染目标（几个时着色器按 @location 顺序输出）；
   * resources 按绑定号排；load 为真时保留目标原来的内容（混合用）；format 是目标为纹理视图时的格式。读写了哪些临时目标
   * 从参数里看得出来，不用另外声明；目标是图外面的贴图、视图时算有副作用（一定会画）。
   */
  draw(frame: EffectFrame, target: Image | GPUTextureView | readonly Image[], resources: readonly RecordedResource[], options: { blend?: GPUBlendState; load?: boolean; format?: GPUTextureFormat } = {}): void {
    const targets: readonly (Image | GPUTextureView)[] = Array.isArray(target) ? target : [target as Image | GPUTextureView];
    const formats = targets.map((item) => ('format' in item ? item.format : options.format));
    frame.pass(this.#label, (pass) => {
      for (const item of targets) {
        if (!isGraphTexture(item)) pass.sideEffect();
        else if (options.load) pass.readWrite(item);
        else pass.write(item);
      }
      for (const resource of resources) if (isGraphTexture(resource)) pass.read(resource);
    }, (real) => {
      this.drawNow(
        frame.encoder,
        targets.map((item) => (isGraphTexture(item) ? real.texture(item) : item)),
        resources.map((resource) => (isGraphTexture(resource) ? real.texture(resource) : resource)),
        options,
      );
    }, () => (formats.every((format) => format !== undefined) ? this.warm(formats as GPUTextureFormat[], options.blend) : undefined));
  }

  /** 马上录进 encoder（不经渲染图）：画一次全屏三角形，参数同 draw，但都是真的贴图。 */
  drawNow(encoder: GPUCommandEncoder, target: GPUTexture | GPUTextureView | readonly (GPUTexture | GPUTextureView)[], resources: readonly FullscreenResource[], { blend, load = false, format }: { blend?: GPUBlendState; load?: boolean; format?: GPUTextureFormat } = {}): void {
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
