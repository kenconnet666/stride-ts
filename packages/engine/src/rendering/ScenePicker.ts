/**
 * 在画面上点一下，问"这个像素上最前面的是哪个实体"（编辑器的视口选物体，游戏里点选也能用）。做法是 GPU 上的编号缓冲：
 * 把主相机看到的网格再画一遍，颜色写的是实例的变换槽位加一，裁剪矩形只留被点的那一个像素，读回那 4 个字节。
 *
 * 选这种做法而不是在 CPU 上拿射线去和三角形求交：蒙皮、形变、位移贴图、Alpha 裁剪的结果都在顶点和片元着色器里，画出来是什么
 * 样点到的就是什么样，不用在 CPU 上再算一遍；只画一个像素，开销就是一遍顶点着色。代价是结果要等读回（下一帧才有），
 * 所以 pick 返回 Promise。
 *
 * pickSurface 另外读回那个像素的深度（点到的表面在世界里的位置：编辑器拖东西吸附到表面），可以把一些渲染组排除在外
 * （拖着的东西自己不挡）。
 *
 * 认网格（MeshRenderFeature）、精灵（SpriteRenderFeature），还有不是渲染特性的高斯泼溅、粒子和放在 3D 里的 UI：它们在网格、精灵之后
 * 画（`renderSystem.splats.drawPicking`、`game.particles.drawPicking`、`game.ui.drawPicking`），写泼溅、粒子系统、UI 所在的实体。全屏的 UI 不参加（见 UISystem）。
 */
import { RenderStage, type RenderContext, type RenderSystem, type RenderView } from './RenderSystem';

const ID_FORMAT: GPUTextureFormat = 'r32uint';
/** 编号缓冲自己的深度：要能在着色器里按像素读（主画面的 depth24plus 读出来不是浮点数）。 */
const PICK_DEPTH_FORMAT: GPUTextureFormat = 'depth32float';
/**
 * 读深度的一个像素：深度贴图只能整张拷贝，所以用一个计算着色器读出被点的那个像素写进缓冲（一个线程）。
 */
const READ_DEPTH_WGSL = /* wgsl */ `
@group(0) @binding(0) var depth: texture_depth_2d;
@group(0) @binding(1) var<storage, read_write> result: array<f32>;
@group(0) @binding(2) var<uniform> pixel: vec2u;
@compute @workgroup_size(1) fn main() { result[0] = textureLoad(depth, pixel, 0); }
`;

interface Targets {
  readonly width: number;
  readonly height: number;
  readonly id: GPUTexture;
  readonly depth: GPUTexture;
}

/** 点到的东西：变换槽位（没点到网格、只点到表面时也可能是 undefined）和那里的深度（0 到 1，1 是什么都没有）。 */
export interface PickHit {
  readonly slot: number | undefined;
  readonly depth: number;
}

interface Request {
  readonly x: number;
  readonly y: number;
  /** 不画这些渲染组（位掩码）。 */
  readonly exclude: number;
  readonly resolve: (hit: PickHit | undefined) => void;
}

export class ScenePicker {
  /** 编号缓冲的阶段：特性里支持点选的（supportsPicking）才画。 */
  readonly stage = new RenderStage('Picking', { colorFormat: ID_FORMAT, depthFormat: PICK_DEPTH_FORMAT }, { picking: true });
  readonly #renderSystem: RenderSystem;
  #targets: Targets | undefined;
  #requests: Request[] = [];
  /** 上一帧录进命令里的读回：这一帧开头（那些命令已经提交了）才能映射缓冲。 */
  #readbacks: { buffer: GPUBuffer; resolve: Request['resolve'] }[] = [];
  readonly #freeBuffers: GPUBuffer[] = [];
  #readDepth: { readonly pipeline: GPUComputePipeline; readonly result: GPUBuffer } | undefined;
  /** 这一帧读深度用的像素坐标（每个请求一个：writeBuffer 在提交前就全写完了，共用一个时都读成最后那个）；下一帧放掉。 */
  #pixelBuffers: GPUBuffer[] = [];

  constructor(renderSystem: RenderSystem) {
    this.#renderSystem = renderSystem;
  }

  /** 有没有等着画的请求（渲染器看它决定这一帧要不要画编号缓冲）。 */
  get pending(): boolean {
    return this.#requests.length > 0 || this.#readbacks.length > 0;
  }

  /**
   * 主画面上 (x, y)（设备像素，左上角是原点）最前面的网格实例的变换槽位；那里没有网格（或者点在画面外）时是 undefined。
   * 下一帧画完、读回以后给结果。
   */
  async pick(x: number, y: number): Promise<number | undefined> {
    return (await this.pickSurface(x, y))?.slot;
  }

  /**
   * 同 pick，另外给出那个像素的深度（换成世界坐标见 Game.pickSurface）；exclude 里的渲染组（位掩码）不画，后面的东西露出来。
   * 点在画面外、没有相机时是 undefined；什么都没点到时 slot 是 undefined、depth 是 1。
   */
  pickSurface(x: number, y: number, exclude = 0): Promise<PickHit | undefined> {
    return new Promise((resolve) => this.#requests.push({ x: Math.floor(x), y: Math.floor(y), exclude, resolve }));
  }

  /** @internal 主画面画完以后（同一帧，用的是这一帧剔除好的实例）。view 是 undefined（没有相机）时请求都落空。 */
  draw(context: RenderContext, encoder: GPUCommandEncoder, view: RenderView | undefined, width: number, height: number): void {
    this.#map();
    const requests = this.#requests;
    if (requests.length === 0) return;
    this.#requests = [];
    const device = this.#renderSystem.graphicsDevice.device;
    const targets = this.#targetsFor(device, width, height);
    for (const { x, y, exclude, resolve } of requests) {
      if (!view || x < 0 || y < 0 || x >= width || y >= height) {
        resolve(undefined);
        continue;
      }
      const pass = encoder.beginRenderPass({
        label: 'ScenePicker',
        colorAttachments: [{ view: targets.id.createView(), clearValue: [0, 0, 0, 0], loadOp: 'clear', storeOp: 'store' }],
        depthStencilAttachment: { view: targets.depth.createView(), depthClearValue: 0, depthLoadOp: 'clear', depthStoreOp: 'store' },
      });
      // 只画被点的那个像素；排除的渲染组只在这一遍里不画（视图的掩码马上放回去）
      pass.setScissorRect(x, y, 1, 1);
      const mask = view.cullingMask;
      view.cullingMask = mask & ~exclude;
      try {
        this.#renderSystem.draw(context, pass, view, this.stage);
      } finally {
        view.cullingMask = mask;
      }
      this.#renderSystem.splats.drawPicking(pass, view, ID_FORMAT, PICK_DEPTH_FORMAT);
      context.game.particles.drawPicking(context.game, pass, view, ID_FORMAT, PICK_DEPTH_FORMAT);
      context.game.ui.drawPicking(context.game, pass, view, [width, height], [x, y, 1, 1], ID_FORMAT, PICK_DEPTH_FORMAT);
      pass.end();
      // 编号放前 4 个字节，深度放后 4 个
      const buffer = this.#freeBuffers.pop() ?? device.createBuffer({ label: 'ScenePicker readback', size: 8, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      encoder.copyTextureToBuffer({ texture: targets.id, origin: [x, y] }, { buffer }, [1, 1]);
      this.#copyDepth(device, encoder, targets.depth, x, y, buffer);
      this.#readbacks.push({ buffer, resolve });
    }
  }

  destroy(): void {
    this.#targets?.id.destroy();
    this.#targets?.depth.destroy();
    this.#targets = undefined;
    for (const { buffer, resolve } of this.#readbacks) {
      resolve(undefined);
      buffer.destroy();
    }
    for (const { resolve } of this.#requests) resolve(undefined);
    for (const buffer of this.#freeBuffers) buffer.destroy();
    this.#readDepth?.result.destroy();
    this.#readDepth = undefined;
    for (const buffer of this.#pixelBuffers) buffer.destroy();
    this.#pixelBuffers = [];
    this.#readbacks = [];
    this.#requests = [];
    this.#freeBuffers.length = 0;
  }

  /** 上一帧的读回：命令已经提交，可以映射了。编号是槽位加一，0 是什么都没画到。 */
  #map(): void {
    // 上一帧读深度用的像素坐标：那些命令已经提交了
    for (const buffer of this.#pixelBuffers) buffer.destroy();
    this.#pixelBuffers = [];
    const readbacks = this.#readbacks;
    if (readbacks.length === 0) return;
    this.#readbacks = [];
    for (const { buffer, resolve } of readbacks) {
      void buffer.mapAsync(GPUMapMode.READ).then(() => {
        const range = buffer.getMappedRange();
        const id = new Uint32Array(range, 0, 1)[0]!, depth = new Float32Array(range, 4, 1)[0]!;
        buffer.unmap();
        this.#freeBuffers.push(buffer);
        resolve({ slot: id === 0 ? undefined : id - 1, depth });
      }, () => resolve(undefined));
    }
  }

  /** 深度贴图上 (x, y) 那个像素的深度写进 buffer 的第 4 个字节起（计算着色器读，见 READ_DEPTH_WGSL）。 */
  #copyDepth(device: GPUDevice, encoder: GPUCommandEncoder, depth: GPUTexture, x: number, y: number, buffer: GPUBuffer): void {
    const read = (this.#readDepth ??= {
      pipeline: device.createComputePipeline({ label: 'ScenePicker read depth', layout: 'auto', compute: { module: device.createShaderModule({ label: 'ScenePicker read depth', code: READ_DEPTH_WGSL }), entryPoint: 'main' } }),
      result: device.createBuffer({ label: 'ScenePicker depth result', size: 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC }),
    });
    const pixel = device.createBuffer({ label: 'ScenePicker depth pixel', size: 8, usage: GPUBufferUsage.UNIFORM, mappedAtCreation: true });
    new Uint32Array(pixel.getMappedRange()).set([x, y]);
    pixel.unmap();
    this.#pixelBuffers.push(pixel);
    const pass = encoder.beginComputePass({ label: 'ScenePicker read depth' });
    pass.setPipeline(read.pipeline);
    pass.setBindGroup(0, device.createBindGroup({
      layout: read.pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: depth.createView() }, { binding: 1, resource: { buffer: read.result } }, { binding: 2, resource: { buffer: pixel } }],
    }));
    pass.dispatchWorkgroups(1);
    pass.end();
    encoder.copyBufferToBuffer(read.result, 0, buffer, 4, 4);
  }

  #targetsFor(device: GPUDevice, width: number, height: number): Targets {
    let targets = this.#targets;
    if (!targets || targets.width !== width || targets.height !== height) {
      targets?.id.destroy();
      targets?.depth.destroy();
      targets = this.#targets = {
        width, height,
        id: device.createTexture({ label: 'ScenePicker ids', size: [width, height], format: ID_FORMAT, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC }),
        depth: device.createTexture({ label: 'ScenePicker depth', size: [width, height], format: PICK_DEPTH_FORMAT, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING }),
      };
    }
    return targets;
  }
}
