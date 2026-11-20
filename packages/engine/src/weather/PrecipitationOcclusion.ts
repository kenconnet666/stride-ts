/**
 * 雨雪的遮挡：一张从上往下看的深度图（Godot 的 GPUParticlesCollisionHeightField3D、别处叫 rain occlusion map），跟着相机。
 * GPU 粒子到了深度图记的表面以下（屋顶、树冠下面）就死，所以屋里、桥下不下雨。
 *
 * 正交视图从相机上方往下看，覆盖 size 米见方、resolution 像素；中心按 snap 米吸附在相机上（挪了不到一格不重画，像素也不跟着
 * 抖），refreshInterval 秒重画一次（场景里动了的东西）。没有雨雪时不画。前向渲染器在主画面的视图旁边要它的视图（begin），
 * 和主画面一起剔除，用深度预通道的阶段画进 depthView，画完调 finish；下一帧开头 commit 才把它的视图投影交给粒子（这一帧的
 * 模拟已经录在画之前，那时深度图还是旧的）。
 *
 * 只能表示"头顶有没有东西"：悬空的结构下面一样不下（深度图记的是最高的表面），斜着吹的雨照竖直判断。
 */
import { Matrix } from '../mathematics/Matrix';
import { DEPTH_FORMAT } from '../rendering/ForwardRenderer';
import { RenderView } from '../rendering/RenderSystem';

/** GPU 粒子的遮挡（particles/gpu 的内核按它采样）。 */
export interface GpuOccluder {
  readonly depthView: GPUTextureView;
  /** Occlusion：视图投影（mat4）、有效（u32，0 时不判断）。 */
  readonly uniform: GPUBuffer;
}

/** 视图在相机上方多高、往下看多深，米。 */
const ABOVE = 150;
const BELOW = 300;

export class PrecipitationOcclusion implements GpuOccluder {
  /** 覆盖的边长，米。改了下一次画生效。 */
  size = 96;
  /** 深度图的边长，像素。只在第一次用之前改。 */
  resolution = 512;
  /** 中心吸附的格子，米：相机挪出一格才重画。 */
  snap = 4;
  /** 多久重画一次，秒（动了的东西）。 */
  refreshInterval = 1;
  /** 这一帧有没有雨雪要用（PrecipitationSystem 设）；没有时不画。 */
  active = false;
  readonly view = Object.assign(new RenderView(), { receivesShadows: false });
  readonly #device: GPUDevice;
  readonly #texture: GPUTexture;
  readonly depthView: GPUTextureView;
  readonly uniform: GPUBuffer;
  #center: [number, number, number] | undefined;
  #drawnAt = -Infinity;
  /** 画好了、还没交给粒子的视图投影。 */
  #pending: Float32Array | undefined;

  constructor(device: GPUDevice) {
    this.#device = device;
    this.#texture = device.createTexture({ label: 'Precipitation occlusion', size: [this.resolution, this.resolution], format: DEPTH_FORMAT, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
    this.depthView = this.#texture.createView();
    this.uniform = device.createBuffer({ label: 'Precipitation occlusion', size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  }

  /**
   * @internal 前向渲染器每帧调用：这一帧要画就设好视图（中心按格子吸附在相机上方）返回它，不画时返回 undefined。
   * eye 是主相机的位置，time 是游戏时间（秒）。
   */
  begin(eye: { readonly x: number; readonly y: number; readonly z: number }, time: number): RenderView | undefined {
    if (!this.active) return undefined;
    const center = occlusionCenter(eye, this.snap);
    const moved = !this.#center || center.some((c, k) => c !== this.#center![k]);
    if (!moved && time - this.#drawnAt < this.refreshInterval) return undefined;
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

  /** @internal 前向渲染器画完这一帧的深度图以后调用。 */
  finish(): void {
    this.#pending = new Float32Array(this.view.viewProjection);
  }

  /** @internal 每帧在粒子模拟之前（PrecipitationSystem.update）：上一帧画好的深度图交给粒子。 */
  commit(): void {
    const pending = this.#pending;
    if (!pending) return;
    this.#pending = undefined;
    const data = new ArrayBuffer(80);
    new Float32Array(data).set(pending);
    new Uint32Array(data, 64, 4).set([1, 0, 0, 0]);
    this.#device.queue.writeBuffer(this.uniform, 0, data);
  }

  destroy(): void {
    this.#texture.destroy();
    this.uniform.destroy();
  }
}

/** 视图的中心：相机的 x、z 吸附到 snap 米的格子上，高度同相机（也吸附，免得上下动一点就重画）。 */
export function occlusionCenter(eye: { readonly x: number; readonly y: number; readonly z: number }, snap: number): [number, number, number] {
  const cell = (c: number) => Math.round(c / snap) * snap;
  return [cell(eye.x), cell(eye.y), cell(eye.z)];
}

/** 内核里的遮挡判断（particles/gpu/kernel.ts 在有遮挡时拼进去）：粒子在深度图记的表面以下时是 true。 */
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
