import { DrawCounts, GpuMemory, PipelineCounts } from './GpuMemory';
import type { TextureTarget } from '@stride-ts/native';
import { GpuProfiler } from './GpuProfiler';

/** 贴图压缩格式的特性和对应的 Basis 转码目标，按优先级：桌面 GPU 有 BC，移动 GPU 有 ASTC 或 ETC2。 */
const COMPRESSION: readonly (readonly [GPUFeatureName, TextureTarget])[] = [
  ['texture-compression-bc', 'bc7'],
  ['texture-compression-astc', 'astc4x4'],
  ['texture-compression-etc2', 'etc2rgba8'],
];

/** 默认上限的设备也请求的特性（回归按它模拟最低配的设备，退回的路要有人测）。 */
const BASIC_FEATURES: readonly GPUFeatureName[] = ['depth-clip-control', 'timestamp-query', 'indirect-first-instance'];

/**
 * 适配器有就请求的特性：引擎按 GraphicsDevice.has 选路，没有的走原来的路（画面一样、只是慢）。只用正式发布的特性，不用
 * `chromium-experimental-` 的实验特性（用户 2026-11-23 定）。各自用在哪见 docs/research.md 的"浏览器的新特性和实验特性"。
 */
const OPTIONAL_FEATURES: readonly string[] = [
  ...BASIC_FEATURES,
  'shader-f16', 'subgroups', 'subgroup-size-control', 'primitive-index', 'atomic-vec2u-min-max',
  'texture-formats-tier1', 'texture-formats-tier2', 'float32-filterable', 'float32-blendable', 'rg11b10ufloat-renderable',
  'dual-source-blending', 'clip-distances', 'texture-component-swizzle', 'depth32float-stencil8', 'bgra8unorm-storage',
];

/**
 * 适配器能给的全部限制。不要的话设备只有规范的默认值（存储缓冲单次绑定 128 MB、单个缓冲 256 MB、2D 贴图 8192、贴图数组 256 层、
 * 每个阶段 16 张采样贴图），桌面显卡大得多（RX 9070 GRE 上 2 GB、2 GB、16384、2048、48）；GPU 驱动的场景数据、虚拟贴图的页图集、
 * 代替 bindless 的贴图数组都会先撞上默认值。要得到的都是适配器给的，手机和集显上自然小，渲染器按 device.limits 选路径。
 */
function adapterLimits(adapter: GPUAdapter): Record<string, number> {
  const limits: Record<string, number> = {};
  // GPUSupportedLimits 的属性在原型上（for...in 列得出来）；只会有这个浏览器认识的名字
  for (const name in adapter.limits) {
    const value = adapter.limits[name as keyof GPUSupportedLimits];
    if (typeof value === 'number') limits[name] = value;
  }
  return limits;
}

/** WebGPU 设备和它呈现到的画布（对应 Stride 的 GraphicsDevice 和 GraphicsPresenter）。 */
export class GraphicsDevice {
  readonly device: GPUDevice;
  readonly canvas: HTMLCanvasElement;
  readonly backBufferFormat: GPUTextureFormat;
  /**
   * 渲染时用的后备缓冲视图格式：画布格式的 sRGB 版本。着色器输出线性颜色，写入时由硬件转成 sRGB，
   * 和 Stride 默认的线性颜色空间一致（画布本身不能配置成 sRGB 格式，只能在视图上用）。
   */
  readonly backBufferViewFormat: GPUTextureFormat;
  /** KTX2 贴图转码成什么：设备支持的第一个压缩格式，都不支持时是 RGBA8。 */
  readonly textureTarget: TextureTarget;
  /** 设备能关掉深度裁剪（'depth-clip-control'）：阴影投射者用它把视锥前面的物体压到近平面上（Stride 的 DepthClipEnable = false）。 */
  readonly depthClipControl: boolean;
  /** 间接绘制的参数里能带 firstInstance（'indirect-first-instance'）：GPU 上的剔除（rendering/mesh/GpuCulling.ts）要它。 */
  readonly indirectFirstInstance: boolean;
  /** 渲染通道的 GPU 耗时（开发时测量，默认关；设备不支持 timestamp-query 时打开也不记录）。 */
  readonly profiler: GpuProfiler;
  /** 这个设备上的缓冲和贴图占了多少显存（自己记的账，见 GpuMemory）。 */
  readonly memory: GpuMemory;
  /** 管线里当场建的、后台编的各几条（见 PipelineCounts）。 */
  readonly pipelines: PipelineCounts;
  /** 上一帧的绘制次数，按渲染通道分（见 DrawCounts）。 */
  readonly draws: DrawCounts;
  /**
   * 设备丢了（GPU 进程崩溃、驱动重置、浏览器回收；不包括自己 destroy 的）时兑现，值是说明原因的错误。丢了以后所有调用都静默
   * 失效、什么也画不出来，Game 收到它就停下并报错（status 变成 'failed'），不留一个看着在跑的空壳。
   */
  readonly lost: Promise<Error>;
  private readonly context: GPUCanvasContext;
  #frameEncoder: GPUCommandEncoder | undefined;
  #viewTexture: GPUTexture | undefined;
  #view: GPUTextureView | undefined;

  /** defaultLimits：不要适配器能给的上限，只要 WebGPU 的默认上限（查绑定有没有超出最小的设备）。 */
  static async create(canvas: HTMLCanvasElement, { defaultLimits = false }: { defaultLimits?: boolean } = {}): Promise<GraphicsDevice> {
    if (!navigator.gpu) throw new Error('WebGPU is not available in this browser');
    // 没有硬件适配器时（没有显卡的机器、CI 里用 SwiftShader 的 Chrome）退回软件的后备适配器：慢，但画得出来。
    // 要独立显卡：macOS、Linux 上双显卡的笔记本按它挑；Windows 上 Chrome 不理它（用哪块由系统的图形设置定，crbug.com/369219127），
    // 传了每次启动都在控制台警告一次，所以不传
    const windows = /Windows/.test((navigator as { userAgentData?: { platform: string } }).userAgentData?.platform ?? navigator.userAgent);
    const adapter = await navigator.gpu.requestAdapter(windows ? {} : { powerPreference: 'high-performance' }) ?? await navigator.gpu.requestAdapter({ forceFallbackAdapter: true });
    if (!adapter) throw new Error('No WebGPU adapter is available');
    if (adapter.info.isFallbackAdapter) console.warn('WebGPU: using the software fallback adapter (no hardware adapter is available); rendering is slow');
    const compression = COMPRESSION.filter(([feature]) => adapter.features.has(feature));
    // 默认上限的设备也只要最基本的几个特性：模拟最低配的设备，退回的路要走到
    const optional = (defaultLimits ? BASIC_FEATURES : OPTIONAL_FEATURES).filter((feature) => adapter.features.has(feature)) as GPUFeatureName[];
    const device = await adapter.requestDevice({ requiredFeatures: [...compression.map(([feature]) => feature), ...optional], ...(defaultLimits ? {} : { requiredLimits: adapterLimits(adapter) }) });
    const context = canvas.getContext('webgpu');
    if (!context) throw new Error('The canvas has no WebGPU context');
    return new GraphicsDevice(device, canvas, context, compression[0]?.[1] ?? 'rgba8');
  }

  private constructor(device: GPUDevice, canvas: HTMLCanvasElement, context: GPUCanvasContext, textureTarget: TextureTarget) {
    this.device = device;
    this.textureTarget = textureTarget;
    this.depthClipControl = this.has('depth-clip-control');
    this.indirectFirstInstance = this.has('indirect-first-instance');
    const timestampQuery = this.has('timestamp-query');
    // 先装上记账，后面建的资源（包括剖析器自己的）才都算进去
    this.memory = new GpuMemory(device);
    this.pipelines = new PipelineCounts(device);
    this.draws = new DrawCounts(device);
    this.profiler = new GpuProfiler(device, timestampQuery);
    this.canvas = canvas;
    this.context = context;
    this.backBufferFormat = navigator.gpu.getPreferredCanvasFormat();
    this.backBufferViewFormat = `${this.backBufferFormat}-srgb` as GPUTextureFormat;
    this.#configure(false);
    logUncapturedErrors(device);
    this.lost = device.lost.then((info) => (info.reason === 'destroyed' ? new Promise<never>(() => {}) : new Error(`WebGPU device lost (${info.reason}): ${info.message || 'no message'}`)));
  }

  /**
   * 后备缓冲能不能拷出去（COPY_SRC）：离线渲染（offline/OfflineRenderer）把每个子帧的画面拷出去累积时打开，平时关着——
   * 画布纹理带 COPY_SRC 时浏览器可能走不了直接呈现的路（CI 的软件 WebGPU 上每帧都慢了一半）。改了以后从下一帧起生效。
   */
  get backBufferCopySource(): boolean {
    return this.#copySource;
  }

  set backBufferCopySource(enabled: boolean) {
    if (enabled !== this.#copySource) this.#configure(enabled);
  }

  #copySource = false;

  #configure(copySource: boolean): void {
    this.#copySource = copySource;
    // 用 opaque：预乘 alpha 的画布在 alpha 小于 1 的地方会透出页面背景
    this.context.configure({
      device: this.device, format: this.backBufferFormat, alphaMode: 'opaque', viewFormats: [this.backBufferViewFormat],
      usage: GPUTextureUsage.RENDER_ATTACHMENT | (copySource ? GPUTextureUsage.COPY_SRC : 0),
    });
  }

  /** 设备有没有这个特性（请求到了的；名字可以是 @webgpu/types 还没收的新特性）。 */
  has(feature: string): boolean {
    return this.device.features.has(feature);
  }

  /** WGSL 有没有这个语言特性（navigator.gpu.wgslLanguageFeatures：不用请求，浏览器认就能写）。 */
  hasWgsl(feature: string): boolean {
    return navigator.gpu.wgslLanguageFeatures.has(feature);
  }

  get queue(): GPUQueue {
    return this.device.queue;
  }

  /**
   * 把后备缓冲调成画布显示尺寸对应的设备像素；Game 在启动时和每帧开头调用。超过 GPU 纹理尺寸上限时截断，
   * 否则在超大或高缩放比的屏幕上 getCurrentTexture 会失败。
   */
  resizeToDisplaySize(): void {
    // 离线渲染（成片导出）按导出的分辨率画，不跟窗口
    if (this.fixedSize) {
      const [w, h] = this.fixedSize;
      if (this.canvas.width !== w) this.canvas.width = w;
      if (this.canvas.height !== h) this.canvas.height = h;
      return;
    }
    const ratio = window.devicePixelRatio;
    const limit = this.device.limits.maxTextureDimension2D;
    const width = Math.min(limit, Math.max(1, Math.round(this.canvas.clientWidth * ratio)));
    const height = Math.min(limit, Math.max(1, Math.round(this.canvas.clientHeight * ratio)));
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
  }

  /** 画布固定成这么大（像素，离线渲染时）；undefined 是跟着窗口（resizeToDisplaySize）。 */
  fixedSize: readonly [number, number] | undefined;

  /** 这一帧要画进去的纹理；每帧都是新的。 */
  currentBackBuffer(): GPUTexture {
    return this.context.getCurrentTexture();
  }

  /** 这一帧后备缓冲的 sRGB 视图（backBufferViewFormat），渲染目标用它；同一帧里只建一次。 */
  currentBackBufferView(): GPUTextureView {
    const texture = this.context.getCurrentTexture();
    if (texture !== this.#viewTexture) {
      this.#viewTexture = texture;
      this.#view = texture.createView({ format: this.backBufferViewFormat });
    }
    return this.#view!;
  }

  /**
   * 这一帧的命令编码器：场景、UI、调试文字都录进它，帧末 Game 一次提交（每次提交都有固定开销）。用 queue.writeBuffer 写的数据
   * 在提交之前就写好了，所以同一个缓冲在一帧里只能写一份（要写几份的用几个缓冲）。
   */
  get frameEncoder(): GPUCommandEncoder {
    return (this.#frameEncoder ??= this.device.createCommandEncoder({ label: 'frame' }));
  }

  /** @internal 帧末：GPU 计时的查询解析进来，提交这一帧的命令。 */
  submitFrame(): void {
    const encoder = this.#frameEncoder;
    if (!encoder) return;
    this.#frameEncoder = undefined;
    this.profiler.resolve(encoder);
    this.queue.submit([encoder.finish()]);
    this.draws.endFrame();
  }

  destroy(): void {
    this.profiler.destroy();
    this.context.unconfigure();
    this.device.destroy();
  }
}

/** 同一条没接住的 WebGPU 错误最多报几次（每帧都出的错不刷屏）。 */
const UNCAPTURED_REPEATS = 3;

/**
 * 没有错误作用域接住的 WebGPU 错误（管线无效、绑定不对、命令缓冲无效：画面全黑、某个通道没画）打到控制台，进调试 CLI 的日志；
 * 不然只有 Chrome 自己在控制台里警告几次（调试 CLI 看不到）。同一条消息报 UNCAPTURED_REPEATS 次以后不再报。
 */
function logUncapturedErrors(device: GPUDevice): void {
  const seen = new Map<string, number>();
  device.addEventListener('uncapturederror', (event) => {
    const message = (event as GPUUncapturedErrorEvent).error.message;
    const count = (seen.get(message) ?? 0) + 1;
    seen.set(message, count);
    if (count <= UNCAPTURED_REPEATS) console.error(`[stride] WebGPU error${count === UNCAPTURED_REPEATS ? ' (repeated, not reported again)' : ''}: ${message}`);
  });
}
