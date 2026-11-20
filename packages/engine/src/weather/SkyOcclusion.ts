/**
 * 天空遮挡（Stride 没有）：一张从上往下看的深度图，跟着相机，记着"头顶有没有东西挡着天"。Godot 的
 * GPUParticlesCollisionHeightField3D、别处的 rain occlusion map 都是这个。雨雪是第一个用户（GPU 粒子到了表面以下就死，屋里、
 * 桥下不下雨），以后地面的湿润、积水积雪查"哪里淋得到"也用它。`renderSystem.skyOcclusion`。
 *
 * - 只有能挡阳光的才挡天：用阴影投射者的阶段画（ShadowMapRenderer.casterStage，不透明、投阴影的网格；透明的、不投阴影的、
 *   粒子、精灵不画），管线和阴影共用、加载时就预热了。蒙皮的网格（角色、动物）也不画：它们一直在动，脚下不该留一块不湿、
 *   不积雪的地，雨点穿过角色看不出来。
 * - 正交视图从相机上方往下看，覆盖 size 米见方、resolution 像素。中心按纹素吸附（size / resolution 米一格），相机走远了
 *   redrawDistance 米才重画，两次之间贴图在世界里不动，遮挡的边缘不随相机游动；refreshInterval 秒也重画一次，跟上动的
 *   遮挡物（开着的门、移动的平台）。
 * - 没人用就不画、不建贴图：用户每帧调 use()；画质档位关掉时（skyOcclusion: false，低档）也不画。
 * - 对外给：深度贴图 depthView、世界到贴图的矩阵 worldToTexture（视图投影：xy 是 -1..1，z 是深度）、version（重画了才变）。
 *   GPU 上的用户绑 uniform（矩阵加有效位）。前向渲染器画完的这一张，下一帧开头（begin）才换成对外的那张：这一帧的粒子
 *   模拟录在画之前，那时深度图还是旧的。
 *
 * 只能表示"头顶最高的表面"：悬空的结构下面一样算挡着，斜着吹的雨照竖直判断。
 */
import { Matrix } from '../data/Matrix';
import type { RenderContext, RenderStage, RenderSystem } from '../rendering/RenderSystem';
import { RenderView } from '../rendering/RenderSystem';

/** GPU 粒子的遮挡（particles/gpu 的内核按它采样）。 */
export interface GpuOccluder {
  readonly depthView: GPUTextureView;
  /** 视图投影（mat4）和有效位（u32，0 时不判断）。 */
  readonly uniform: GPUBuffer;
}

/** 阴影投射者阶段的深度格式（ShadowMapRenderer 的 SHADOW_ATLAS_FORMAT）。 */
const FORMAT: GPUTextureFormat = 'depth32float';
/** 视图在相机上方多高、往下看多深，米。 */
const ABOVE = 150;
const BELOW = 300;

export class SkyOcclusion implements GpuOccluder {
  /** 覆盖的边长，米。 */
  size = 64;
  /** 深度图的边长，像素（64 米、512 像素是一格 12.5 厘米，深度图 1 MB）。在第一次用之前改。 */
  resolution = 512;
  /** 相机离上次画的中心多远才重画，米。 */
  redrawDistance = 8;
  /** 多久重画一次，秒（动的遮挡物）。 */
  refreshInterval = 1;
  /** 画质档位开着（前向渲染器每帧设）。 */
  enabled = true;
  readonly view = Object.assign(new RenderView(), { receivesShadows: false, skipsSkinned: true });
  readonly #device: GPUDevice;
  #texture: GPUTexture | undefined;
  #depthView: GPUTextureView | undefined;
  #uniform: GPUBuffer | undefined;
  #used = false;
  #center: [number, number, number] | undefined;
  #drawnAt = -Infinity;
  /** 画好了、还没换成对外那张的视图投影。 */
  #pending: Float32Array<ArrayBuffer> | undefined;
  #worldToTexture: Float32Array<ArrayBuffer> = new Float32Array(16);
  #version = 0;

  constructor(device: GPUDevice) {
    this.#device = device;
  }

  /** 这一帧要用（每帧在画之前调用；没人调就不画）。 */
  use(): void {
    this.#used = true;
  }

  /** 重画并换上了一次就加一；0 是还没有。 */
  get version(): number {
    return this.#version;
  }

  /** 世界到贴图的矩阵（视图投影）：version 是 0 时没意义。 */
  get worldToTexture(): Readonly<Float32Array> {
    return this.#worldToTexture;
  }

  get depthView(): GPUTextureView {
    this.#ensure();
    return this.#depthView!;
  }

  get uniform(): GPUBuffer {
    this.#ensure();
    return this.#uniform!;
  }

  /**
   * @internal 前向渲染器每帧调用（剔除之前）：上一次画好的换成对外那张；这一帧要画就设好视图返回它，不画时返回 undefined。
   * eye 是主相机的位置，time 是游戏时间（秒）。
   */
  begin(eye: { readonly x: number; readonly y: number; readonly z: number }, time: number): RenderView | undefined {
    this.#commit();
    const used = this.#used;
    this.#used = false;
    if (!used || !this.enabled) return undefined;
    const far = !this.#center || Math.hypot(eye.x - this.#center[0], eye.z - this.#center[2]) > this.redrawDistance || Math.abs(eye.y - this.#center[1]) > this.redrawDistance;
    if (!far && time - this.#drawnAt < this.refreshInterval) return undefined;
    const center = skyOcclusionCenter(eye, this.size / this.resolution);
    this.#center = center;
    this.#drawnAt = time;
    const view = this.view, half = this.size / 2;
    const [x, y, z] = center;
    // 从上往下看：屏幕的上方是世界的 -Z
    Matrix.lookAtRH(view.view, [x, y + ABOVE, z], [x, y, z], [0, 0, -1]);
    Matrix.orthoOffCenterRH(view.projection, -half, half, -half, half, 0, ABOVE + BELOW);
    view.nearClipPlane = 0;
    view.farClipPlane = ABOVE + BELOW;
    view.width = view.height = this.resolution;
    view.update();
    return view;
  }

  /** @internal 前向渲染器在阴影之后调用：用阴影投射者的阶段 stage 把 begin 给的视图画进深度图。 */
  draw(context: RenderContext, encoder: GPUCommandEncoder, renderSystem: RenderSystem, stage: RenderStage): void {
    const timestampWrites = renderSystem.graphicsDevice.profiler.passTimestamps('SkyOcclusion');
    const pass = encoder.beginRenderPass({
      label: 'SkyOcclusion',
      ...(timestampWrites ? { timestampWrites } : {}),
      colorAttachments: [],
      depthStencilAttachment: { view: this.depthView, depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' },
    });
    renderSystem.draw(context, pass, this.view, stage);
    pass.end();
    this.#pending = new Float32Array(this.view.viewProjection);
  }

  destroy(): void {
    this.#texture?.destroy();
    this.#uniform?.destroy();
    this.#texture = undefined;
    this.#uniform = undefined;
  }

  /** 画好的那张换成对外的：矩阵、uniform、版本号。 */
  #commit(): void {
    const pending = this.#pending;
    if (!pending) return;
    this.#pending = undefined;
    this.#worldToTexture = pending;
    this.#version++;
    const data = new ArrayBuffer(80);
    new Float32Array(data).set(pending);
    new Uint32Array(data, 64, 4).set([1, 0, 0, 0]);
    this.#device.queue.writeBuffer(this.uniform, 0, data);
  }

  #ensure(): void {
    if (this.#texture) return;
    this.#texture = this.#device.createTexture({ label: 'SkyOcclusion', size: [this.resolution, this.resolution], format: FORMAT, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
    this.#depthView = this.#texture.createView();
    // 有效位是 0：还没画过时用户不判断
    this.#uniform = this.#device.createBuffer({ label: 'SkyOcclusion', size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  }
}

/** 视图的中心：相机的位置吸附到 texel 米的格子上（纹素对齐，重画以后遮挡的边缘落在同样的位置）。 */
export function skyOcclusionCenter(eye: { readonly x: number; readonly y: number; readonly z: number }, texel: number): [number, number, number] {
  const cell = (c: number) => Math.round(c / texel) * texel;
  return [cell(eye.x), cell(eye.y), cell(eye.z)];
}

/** 内核里的遮挡判断（particles/gpu/kernel.ts 在发射器有遮挡时拼进去）：粒子在深度图记的表面以下时是 true。 */
export const OCCLUSION_WGSL = /* wgsl */ `
struct Occlusion {
  viewProjection: mat4x4f,
  valid: vec4u,
};
@group(0) @binding(2) var occlusionDepth: texture_depth_2d;
@group(0) @binding(3) var<uniform> occlusion: Occlusion;

fn occluded(p: vec3f) -> bool {
  if (occlusion.valid.x == 0u) {
    return false;
  }
  let c = occlusion.viewProjection * vec4f(p, 1.0);
  let uv = vec2f(c.x * 0.5 + 0.5, 0.5 - c.y * 0.5);
  if (any(uv < vec2f(0.0)) || any(uv >= vec2f(1.0))) {
    return false;
  }
  let size = vec2f(textureDimensions(occlusionDepth));
  let surface = textureLoad(occlusionDepth, vec2i(uv * size), 0);
  // 深度从上往下增大：比表面深就是在它下面（留一点余量，表面本身不算）
  return surface < 1.0 && c.z > surface + 0.0005;
}
`;
