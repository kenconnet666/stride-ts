/**
 * 在画面上点一下，问"这个像素上最前面的是哪个实体"（编辑器的视口选物体，游戏里点选也能用）。做法是 GPU 上的编号缓冲：
 * 把主相机看到的网格再画一遍，颜色写的是实例的变换槽位加一，裁剪矩形只留被点的那一个像素，读回那 4 个字节。
 *
 * 选这种做法而不是在 CPU 上拿射线去和三角形求交：蒙皮、形变、位移贴图、Alpha 裁剪的结果都在顶点和片元着色器里，画出来是什么
 * 样点到的就是什么样，不用在 CPU 上再算一遍；只画一个像素，开销就是一遍顶点着色。代价是结果要等读回（下一帧才有），
 * 所以 pick 返回 Promise。
 *
 * 现在认网格（MeshRenderFeature）和精灵（SpriteRenderFeature）；粒子、放在场景里的 UI 还点不到。
 */
import { DEPTH_FORMAT } from './ForwardRenderer';
import { RenderStage, type RenderContext, type RenderSystem, type RenderView } from './RenderSystem';

const ID_FORMAT: GPUTextureFormat = 'r32uint';

interface Targets {
  readonly width: number;
  readonly height: number;
  readonly id: GPUTexture;
  readonly depth: GPUTexture;
}

interface Request {
  readonly x: number;
  readonly y: number;
  readonly resolve: (slot: number | undefined) => void;
}

export class ScenePicker {
  /** 编号缓冲的阶段：特性里支持点选的（supportsPicking）才画。 */
  readonly stage = new RenderStage('Picking', { colorFormat: ID_FORMAT, depthFormat: DEPTH_FORMAT }, { picking: true });
  readonly #renderSystem: RenderSystem;
  #targets: Targets | undefined;
  #requests: Request[] = [];
  /** 上一帧录进命令里的读回：这一帧开头（那些命令已经提交了）才能映射缓冲。 */
  #readbacks: { buffer: GPUBuffer; resolve: Request['resolve'] }[] = [];
  readonly #freeBuffers: GPUBuffer[] = [];

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
  pick(x: number, y: number): Promise<number | undefined> {
    return new Promise((resolve) => this.#requests.push({ x: Math.floor(x), y: Math.floor(y), resolve }));
  }

  /** @internal 主画面画完以后（同一帧，用的是这一帧剔除好的实例）。view 是 undefined（没有相机）时请求都落空。 */
  draw(context: RenderContext, encoder: GPUCommandEncoder, view: RenderView | undefined, width: number, height: number): void {
    this.#map();
    const requests = this.#requests;
    if (requests.length === 0) return;
    this.#requests = [];
    const device = this.#renderSystem.graphicsDevice.device;
    const targets = this.#targetsFor(device, width, height);
    for (const { x, y, resolve } of requests) {
      if (!view || x < 0 || y < 0 || x >= width || y >= height) {
        resolve(undefined);
        continue;
      }
      const pass = encoder.beginRenderPass({
        label: 'ScenePicker',
        colorAttachments: [{ view: targets.id.createView(), clearValue: [0, 0, 0, 0], loadOp: 'clear', storeOp: 'store' }],
        depthStencilAttachment: { view: targets.depth.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'discard' },
      });
      // 只画被点的那个像素
      pass.setScissorRect(x, y, 1, 1);
      this.#renderSystem.draw(context, pass, view, this.stage);
      pass.end();
      const buffer = this.#freeBuffers.pop() ?? device.createBuffer({ label: 'ScenePicker readback', size: 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      encoder.copyTextureToBuffer({ texture: targets.id, origin: [x, y] }, { buffer }, [1, 1]);
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
    this.#readbacks = [];
    this.#requests = [];
    this.#freeBuffers.length = 0;
  }

  /** 上一帧的读回：命令已经提交，可以映射了。编号是槽位加一，0 是什么都没画到。 */
  #map(): void {
    const readbacks = this.#readbacks;
    if (readbacks.length === 0) return;
    this.#readbacks = [];
    for (const { buffer, resolve } of readbacks) {
      void buffer.mapAsync(GPUMapMode.READ).then(() => {
        const id = new Uint32Array(buffer.getMappedRange())[0]!;
        buffer.unmap();
        this.#freeBuffers.push(buffer);
        resolve(id === 0 ? undefined : id - 1);
      }, () => resolve(undefined));
    }
  }

  #targetsFor(device: GPUDevice, width: number, height: number): Targets {
    let targets = this.#targets;
    if (!targets || targets.width !== width || targets.height !== height) {
      targets?.id.destroy();
      targets?.depth.destroy();
      targets = this.#targets = {
        width, height,
        id: device.createTexture({ label: 'ScenePicker ids', size: [width, height], format: ID_FORMAT, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC }),
        depth: device.createTexture({ label: 'ScenePicker depth', size: [width, height], format: DEPTH_FORMAT, usage: GPUTextureUsage.RENDER_ATTACHMENT }),
      };
    }
    return targets;
  }
}
