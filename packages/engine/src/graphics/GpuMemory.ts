/**
 * 显存的账：浏览器不告诉页面占了多少显存，自己记。给设备的 createBuffer、createTexture 套一层，建的时候加上、销毁的时候
 * 减掉；引擎里所有的缓冲和贴图都经设备建，所以不用每处各记各的。数的是我们要的大小，驱动实际分配的（对齐、多出来的
 * mip）会略多；没有调用 destroy、等垃圾回收的资源一直算在里面（那本身就是该查的）。
 */

export interface GpuResourceCount {
  count: number;
  bytes: number;
}

/** 每个像素（或者压缩格式的每个块）几个字节、一个块几乘几个像素；没列的按 4 字节一个像素算。 */
const FORMATS: Readonly<Record<string, readonly [bytes: number, blockWidth: number, blockHeight: number]>> = {
  r8unorm: [1, 1, 1], r8snorm: [1, 1, 1], r8uint: [1, 1, 1], r8sint: [1, 1, 1],
  r16uint: [2, 1, 1], r16sint: [2, 1, 1], r16float: [2, 1, 1], rg8unorm: [2, 1, 1], rg8snorm: [2, 1, 1], rg8uint: [2, 1, 1], rg8sint: [2, 1, 1], depth16unorm: [2, 1, 1],
  rg16uint: [4, 1, 1], rg16sint: [4, 1, 1], rg16float: [4, 1, 1], rg32float: [8, 1, 1], rg32uint: [8, 1, 1], rg32sint: [8, 1, 1],
  rgba16uint: [8, 1, 1], rgba16sint: [8, 1, 1], rgba16float: [8, 1, 1], rgba32uint: [16, 1, 1], rgba32sint: [16, 1, 1], rgba32float: [16, 1, 1],
  'depth32float-stencil8': [8, 1, 1],
  'bc1-rgba-unorm': [8, 4, 4], 'bc1-rgba-unorm-srgb': [8, 4, 4], 'bc4-r-unorm': [8, 4, 4], 'bc4-r-snorm': [8, 4, 4],
  'bc2-rgba-unorm': [16, 4, 4], 'bc2-rgba-unorm-srgb': [16, 4, 4], 'bc3-rgba-unorm': [16, 4, 4], 'bc3-rgba-unorm-srgb': [16, 4, 4],
  'bc5-rg-unorm': [16, 4, 4], 'bc5-rg-snorm': [16, 4, 4], 'bc6h-rgb-ufloat': [16, 4, 4], 'bc6h-rgb-float': [16, 4, 4],
  'bc7-rgba-unorm': [16, 4, 4], 'bc7-rgba-unorm-srgb': [16, 4, 4],
  'etc2-rgb8unorm': [8, 4, 4], 'etc2-rgb8unorm-srgb': [8, 4, 4], 'etc2-rgb8a1unorm': [8, 4, 4], 'etc2-rgb8a1unorm-srgb': [8, 4, 4],
  'etc2-rgba8unorm': [16, 4, 4], 'etc2-rgba8unorm-srgb': [16, 4, 4],
  'eac-r11unorm': [8, 4, 4], 'eac-r11snorm': [8, 4, 4], 'eac-rg11unorm': [16, 4, 4], 'eac-rg11snorm': [16, 4, 4],
};

/** 一张贴图占多少字节：各级 mip、各层（或 3D 贴图的各个切片）、多重采样都算上。 */
export function textureBytes({ size, format, mipLevelCount = 1, sampleCount = 1, dimension = '2d' }: GPUTextureDescriptor): number {
  const [width, height = 1, depthOrLayers = 1] = Symbol.iterator in size ? [...size] : [size.width, size.height, size.depthOrArrayLayers];
  // ASTC 的块：名字里写着几乘几，每块 16 字节
  const astc = /^astc-(\d+)x(\d+)-/.exec(format);
  const [bytes, blockWidth, blockHeight] = astc ? [16, Number(astc[1]), Number(astc[2])] : (FORMATS[format] ?? [4, 1, 1]);
  let total = 0;
  for (let level = 0; level < mipLevelCount; level++) {
    const w = Math.max(1, width >> level), h = Math.max(1, height >> level);
    const layers = dimension === '3d' ? Math.max(1, depthOrLayers >> level) : depthOrLayers;
    total += Math.ceil(w / blockWidth) * Math.ceil(h / blockHeight) * bytes * layers;
  }
  return total * sampleCount;
}

/**
 * 管线是怎么建的：当场建的（createRenderPipeline、createComputePipeline，着色器的编译堵住这一帧，画面会卡一下）有几条、
 * 后台编的（…Async，预热）有几条。和显存一样在设备上套一层来数，所以哪个渲染器建的都算。
 */
export class PipelineCounts {
  /** 当场建的条数。 */
  sync = 0;
  /** 后台编的条数。 */
  warmed = 0;
  /** 最近当场建的管线的标签（查是谁没预热）。 */
  readonly recentSync: string[] = [];

  constructor(device: GPUDevice) {
    const createRender = device.createRenderPipeline.bind(device), createCompute = device.createComputePipeline.bind(device);
    const createRenderAsync = device.createRenderPipelineAsync.bind(device), createComputeAsync = device.createComputePipelineAsync.bind(device);
    const sync = (label: string | undefined) => {
      this.sync++;
      this.recentSync.push(label ?? '(unlabeled)');
      if (this.recentSync.length > 64) this.recentSync.shift();
    };
    device.createRenderPipeline = (descriptor) => (sync(descriptor.label), createRender(descriptor));
    device.createComputePipeline = (descriptor) => (sync(descriptor.label), createCompute(descriptor));
    device.createRenderPipelineAsync = (descriptor) => (this.warmed++, createRenderAsync(descriptor));
    device.createComputePipelineAsync = (descriptor) => (this.warmed++, createComputeAsync(descriptor));
  }
}

/**
 * 一帧的绘制次数，按 GPU 的渲染通道（beginRenderPass 的标签）分：场景的各阶段、阴影、后处理的每一步、UI、调试线都算，
 * 不只数渲染特性的。和管线一样在设备上套一层（每个编码器的 beginRenderPass），所以谁画的都数得到；一个渲染通道里的
 * draw、drawIndexed、两种 indirect 各算一次。
 */
const RECENT_FRAMES = 64;

export class DrawCounts {
  /** 上一帧的总数（endFrame 时换过来）。 */
  total = 0;
  /** 上一帧按通道标签的次数，按第一次画的顺序；没有标签的在 (unlabeled) 上。 */
  byPass: ReadonlyMap<string, number> = new Map();
  #current = new Map<string, number>();
  /** 最近几帧的总数（环形），算中位数用。 */
  readonly #recent = new Float64Array(RECENT_FRAMES);
  #frames = 0;

  /**
   * 最近约一秒（RECENT_FRAMES 帧）每帧总数的中位数：平常一帧画多少。偶尔一帧的大活（天空的环境光重算预滤波、探针重拍）
   * 不算进去，预算按它比（上一帧的 total 碰上那一帧会忽高忽低）。
   */
  get median(): number {
    const count = Math.min(this.#frames, RECENT_FRAMES);
    if (count === 0) return 0;
    const sorted = this.#recent.slice(0, count).sort();
    return sorted[count >> 1]!;
  }

  constructor(device: GPUDevice) {
    const createEncoder = device.createCommandEncoder.bind(device);
    device.createCommandEncoder = (descriptor) => {
      const encoder = createEncoder(descriptor);
      const begin = encoder.beginRenderPass.bind(encoder);
      encoder.beginRenderPass = (pass) => this.#count(begin(pass), pass.label ?? '(unlabeled)');
      return encoder;
    };
  }

  /** 帧末（提交以后）：这一帧数的成为"上一帧"的。 */
  endFrame(): void {
    this.byPass = this.#current;
    this.total = [...this.#current.values()].reduce((sum, count) => sum + count, 0);
    this.#recent[this.#frames++ % RECENT_FRAMES] = this.total;
    this.#current = new Map();
  }

  #count(pass: GPURenderPassEncoder, label: string): GPURenderPassEncoder {
    const add = () => this.#current.set(label, (this.#current.get(label) ?? 0) + 1);
    const draw = pass.draw.bind(pass), drawIndexed = pass.drawIndexed.bind(pass);
    const drawIndirect = pass.drawIndirect.bind(pass), drawIndexedIndirect = pass.drawIndexedIndirect.bind(pass);
    pass.draw = (...args) => (add(), draw(...args));
    pass.drawIndexed = (...args) => (add(), drawIndexed(...args));
    pass.drawIndirect = (...args) => (add(), drawIndirect(...args));
    pass.drawIndexedIndirect = (...args) => (add(), drawIndexedIndirect(...args));
    return pass;
  }
}

export class GpuMemory {
  readonly buffers: GpuResourceCount = { count: 0, bytes: 0 };
  readonly textures: GpuResourceCount = { count: 0, bytes: 0 };
  /** 按标签的第一个词分的字节数（'ForwardRenderer HDR color 1280x720' 算在 ForwardRenderer 上；没有标签的在 (unlabeled) 上）。 */
  readonly #groups = new Map<string, number>();

  /** 给这个设备的 createBuffer、createTexture 记账。 */
  constructor(device: GPUDevice) {
    const createBuffer = device.createBuffer.bind(device), createTexture = device.createTexture.bind(device);
    device.createBuffer = (descriptor) => this.#track(createBuffer(descriptor), this.buffers, descriptor.size, descriptor.label);
    device.createTexture = (descriptor) => this.#track(createTexture(descriptor), this.textures, textureBytes(descriptor), descriptor.label);
  }

  /** 各组占的字节，从大到小。 */
  groups(): Record<string, number> {
    return Object.fromEntries([...this.#groups].filter(([, bytes]) => bytes > 0).sort((a, b) => b[1] - a[1]));
  }

  #track<T extends GPUBuffer | GPUTexture>(resource: T, counter: GpuResourceCount, bytes: number, label: string | undefined): T {
    const group = label?.split(' ', 1)[0] || '(unlabeled)';
    counter.count++;
    counter.bytes += bytes;
    this.#groups.set(group, (this.#groups.get(group) ?? 0) + bytes);
    const destroy = resource.destroy.bind(resource);
    let alive = true;
    resource.destroy = () => {
      if (alive) {
        alive = false;
        counter.count--;
        counter.bytes -= bytes;
        this.#groups.set(group, this.#groups.get(group)! - bytes);
      }
      destroy();
    };
    return resource;
  }
}
