/**
 * 图形合成器的前向渲染器（Stride 的 GraphicsCompositor 里的 ForwardRenderer，骨架阶段）：一个相机、
 * 一个不透明阶段，画进后备缓冲加深度缓冲。以后加透明阶段、阴影、后处理、多个相机槽位。
 * 每帧：Collect（相机变成视图）→ Extract → Prepare → Draw。
 */
import { system } from '../engine/system';
import { Transform } from '../engine/transform';
import { Matrix } from '../mathematics/Matrix';
import { Color4 } from '../mathematics/vectors';
import { Camera } from './components';
import { RenderStage, RenderView, type RenderContext, type RenderSystem } from './RenderSystem';

const DEPTH_FORMAT: GPUTextureFormat = 'depth24plus';

export class ForwardRenderer {
  readonly renderSystem: RenderSystem;
  readonly opaqueStage: RenderStage;
  /** 线性空间的清屏色；默认是 sRGB 的 (0.1, 0.12, 0.16)。 */
  readonly clearColor = new Color4(0.01, 0.0134, 0.022, 1);
  /** 这一帧用的相机实体找到了没有；没有相机时只清屏（同 Stride）。 */
  hasCamera = false;

  readonly #mainView = new RenderView();
  #depth: GPUTexture | undefined;
  // 找相机：第一个带 Camera 和 Transform 的实体
  #cameraFound = false;
  readonly #findCamera = system('ForwardRenderer.camera', {
    with: { camera: Camera, transform: Transform },
    update: ({ camera, transform, count }) => {
      if (this.#cameraFound || count === 0) return;
      this.#cameraFound = true;
      const view = this.#mainView;
      const slot = transform.slot[0]!;
      if (!Matrix.invert(view.view, transform.world.subarray(slot * 16, slot * 16 + 16))) Matrix.setIdentity(view.view);
      view.nearClipPlane = camera.nearClipPlane[0]!;
      view.farClipPlane = camera.farClipPlane[0]!;
      const { width, height } = this.renderSystem.graphicsDevice.canvas;
      Matrix.perspectiveFovRH(view.projection, (camera.verticalFieldOfView[0]! * Math.PI) / 180, width / height, view.nearClipPlane, view.farClipPlane);
      view.update();
    },
  });

  constructor(renderSystem: RenderSystem) {
    this.renderSystem = renderSystem;
    this.opaqueStage = new RenderStage('Opaque', { colorFormat: renderSystem.graphicsDevice.backBufferViewFormat, depthFormat: DEPTH_FORMAT });
  }

  draw(context: RenderContext): void {
    const { renderSystem } = this;
    const graphicsDevice = renderSystem.graphicsDevice;

    this.#cameraFound = false;
    context.game.entities.run(this.#findCamera, context.time);
    this.hasCamera = this.#cameraFound;
    renderSystem.collect(this.hasCamera ? [this.#mainView] : []);
    if (this.hasCamera) {
      renderSystem.extract(context);
      renderSystem.prepare(context);
    }

    const encoder = graphicsDevice.device.createCommandEncoder({ label: 'ForwardRenderer' });
    const { r, g, b, a } = this.clearColor;
    const pass = encoder.beginRenderPass({
      label: 'ForwardRenderer opaque',
      colorAttachments: [{ view: graphicsDevice.currentBackBufferView(), clearValue: [r, g, b, a], loadOp: 'clear', storeOp: 'store' }],
      depthStencilAttachment: { view: this.#depthView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'discard' },
    });
    if (this.hasCamera) renderSystem.draw(context, pass, this.#mainView, this.opaqueStage);
    pass.end();
    graphicsDevice.queue.submit([encoder.finish()]);
  }

  destroy(): void {
    this.#depth?.destroy();
  }

  /** 和后备缓冲同样大小的深度缓冲；画布尺寸变了就重建。 */
  #depthView(): GPUTextureView {
    const { canvas, device } = this.renderSystem.graphicsDevice;
    if (!this.#depth || this.#depth.width !== canvas.width || this.#depth.height !== canvas.height) {
      this.#depth?.destroy();
      this.#depth = device.createTexture({ label: 'ForwardRenderer depth', size: [canvas.width, canvas.height], format: DEPTH_FORMAT, usage: GPUTextureUsage.RENDER_ATTACHMENT });
    }
    return this.#depth.createView();
  }
}
