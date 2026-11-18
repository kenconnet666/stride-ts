/**
 * 图形合成器的前向渲染器（Stride 的 GraphicsCompositor 里的 ForwardRenderer）：一个相机、一个不透明阶段，
 * 画进 RGBA16F 的 HDR 颜色缓冲加深度缓冲（同 Stride 的 HDR 渲染模式），再经色调映射（ToneMap）写进后备缓冲。
 * 以后加透明阶段、阴影、其余后处理（Bloom、FXAA……）、多个相机槽位。
 * 每帧：Collect（相机变成视图）→ Extract → Prepare → Draw → 后处理。
 */
import { system } from '../engine/system';
import { Transform } from '../engine/transform';
import { Matrix } from '../mathematics/Matrix';
import { Color4 } from '../mathematics/vectors';
import { Camera, Light } from './components';
import { RenderStage, RenderView, type RenderContext, type RenderSystem, type SkyboxLight } from './RenderSystem';
import { Skybox } from './Skybox';
import { ToneMap } from './ToneMap';

const DEPTH_FORMAT: GPUTextureFormat = 'depth24plus';
const HDR_FORMAT: GPUTextureFormat = 'rgba16float';

export class ForwardRenderer {
  readonly renderSystem: RenderSystem;
  readonly opaqueStage: RenderStage;
  /** 线性空间的清屏色；默认是 sRGB 的 (0.1, 0.12, 0.16)。 */
  readonly clearColor = new Color4(0.01, 0.0134, 0.022, 1);
  /** 这一帧用的相机实体找到了没有；没有相机时只清屏（同 Stride）。 */
  hasCamera = false;
  /** HDR 画面到显示范围的映射（设置同 Stride 的 ToneMap，可以改）。 */
  readonly toneMap: ToneMap;

  readonly #mainView = new RenderView();
  #targets: { color: GPUTexture; depth: GPUTexture } | undefined;
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

  // 光源：第一个方向光、第一个天空盒光，加上所有环境光
  #directionalFound = false;
  #lightFound = false;
  #skyboxLight: SkyboxLight | undefined;
  readonly #lightColor = new Color4();
  readonly #collectLights = system('ForwardRenderer.lights', {
    with: { light: Light, transform: Transform },
    update: ({ light, transform, count }) => {
      const lighting = this.renderSystem.lighting;
      if (count > 0) this.#lightFound = true;
      for (let i = 0; i < count; i++) {
        const color = this.#lightColor.set(light.color[i * 4]!, light.color[i * 4 + 1]!, light.color[i * 4 + 2]!, 1).toLinear();
        const intensity = light.intensity[i]!;
        if (light.type[i] === 'skybox') {
          const skybox = Skybox.byId(light.skybox[i]!);
          if (!skybox || lighting.skybox) continue;
          const sky = (this.#skyboxLight ??= { skybox, intensity, rotation: new Float32Array(16) });
          sky.skybox = skybox;
          sky.intensity = intensity;
          Matrix.rotationOf(sky.rotation, transform.world, transform.slot[i]! * 16);
          lighting.skybox = sky;
        } else if (light.type[i] === 'ambient') {
          lighting.ambient.set(lighting.ambient.r + color.r * intensity, lighting.ambient.g + color.g * intensity, lighting.ambient.b + color.b * intensity, 1);
        } else if (!this.#directionalFound) {
          this.#directionalFound = true;
          // 照向本地 -Z：世界矩阵第三列（Z 轴）取反
          const w = transform.slot[i]! * 16;
          lighting.direction.set(-transform.world[w + 8]!, -transform.world[w + 9]!, -transform.world[w + 10]!);
          lighting.color.set(color.r * intensity, color.g * intensity, color.b * intensity, 1);
        }
      }
    },
  });

  constructor(renderSystem: RenderSystem) {
    this.renderSystem = renderSystem;
    this.opaqueStage = new RenderStage('Opaque', { colorFormat: HDR_FORMAT, depthFormat: DEPTH_FORMAT });
    this.toneMap = new ToneMap(renderSystem.device, renderSystem.resources.linearClamp);
  }

  draw(context: RenderContext): void {
    const { renderSystem } = this;
    const graphicsDevice = renderSystem.graphicsDevice;

    this.#cameraFound = false;
    context.game.entities.run(this.#findCamera, context.time);
    this.hasCamera = this.#cameraFound;
    renderSystem.collect(this.hasCamera ? [this.#mainView] : []);
    this.#gatherLighting(context);
    if (this.hasCamera) {
      renderSystem.extract(context);
      renderSystem.prepare(context);
    }

    const encoder = graphicsDevice.device.createCommandEncoder({ label: 'ForwardRenderer' });
    const { r, g, b, a } = this.clearColor;
    const targets = this.#targetsForCanvas();
    const pass = encoder.beginRenderPass({
      label: 'ForwardRenderer opaque',
      colorAttachments: [{ view: targets.color.createView(), clearValue: [r, g, b, a], loadOp: 'clear', storeOp: 'store' }],
      depthStencilAttachment: { view: targets.depth.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'discard' },
    });
    if (this.hasCamera) renderSystem.draw(context, pass, this.#mainView, this.opaqueStage);
    pass.end();
    this.toneMap.draw(encoder, targets.color, graphicsDevice.currentBackBufferView(), graphicsDevice.backBufferViewFormat, context.time.elapsed);
    graphicsDevice.queue.submit([encoder.finish()]);
  }

  destroy(): void {
    this.#targets?.color.destroy();
    this.#targets?.depth.destroy();
    this.toneMap.destroy();
  }

  /** 从 Light 组件收集这一帧的光照；一个都没有时用默认光照。 */
  #gatherLighting(context: RenderContext): void {
    const { lighting, defaultLighting } = this.renderSystem;
    lighting.ambient.set(0, 0, 0, 1);
    lighting.color.set(0, 0, 0, 1);
    lighting.direction.set(0, -1, 0);
    lighting.skybox = undefined;
    this.#directionalFound = false;
    this.#lightFound = false;
    context.game.entities.run(this.#collectLights, context.time);
    if (this.#lightFound) return;
    lighting.direction.copy(defaultLighting.direction);
    lighting.color.copy(defaultLighting.color);
    lighting.ambient.copy(defaultLighting.ambient);
  }

  /** 和后备缓冲同样大小的 HDR 颜色缓冲和深度缓冲；画布尺寸变了就重建。 */
  #targetsForCanvas(): { color: GPUTexture; depth: GPUTexture } {
    const { canvas, device } = this.renderSystem.graphicsDevice;
    const current = this.#targets;
    if (current && current.color.width === canvas.width && current.color.height === canvas.height) return current;
    current?.color.destroy();
    current?.depth.destroy();
    const size = [canvas.width, canvas.height];
    return (this.#targets = {
      color: device.createTexture({ label: 'ForwardRenderer HDR color', size, format: HDR_FORMAT, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING }),
      depth: device.createTexture({ label: 'ForwardRenderer depth', size, format: DEPTH_FORMAT, usage: GPUTextureUsage.RENDER_ATTACHMENT }),
    });
  }
}

