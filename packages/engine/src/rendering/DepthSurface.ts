/**
 * 深度表面：一张深度图加上画它的视图，GPU 粒子拿来碰撞（particles/updaters.ts 的 UpdaterDepthCollision）。有两种：
 * - 天空遮挡（weather/SkyOcclusion.ts）：从上往下看的高度场，相机周围几十米，屏幕外也有；
 * - 主视图上一帧的深度（ViewDepthSurface，前向渲染器的 `viewDepth`）：只有画面里看得见的表面，Unity VFX Graph、Niagara 的
 *   "按深度缓冲碰撞"。
 *
 * 粒子在画之前模拟，读的是上一帧画好的深度；常量（视图投影、它的逆、视线方向）也得是上一帧的：画完先存着，下一帧画之前
 * （begin、commit）才写进 uniform——写缓冲在提交之前生效，这一帧的模拟正好看到它，而这一帧的画在模拟之后才盖掉深度图。
 */
import type { RenderView } from './RenderSystem';

/** GPU 粒子的内核按它采样（绑定 2：深度图，3：uniform，布局见 DEPTH_SURFACE_WGSL）。 */
export interface GpuDepthSurface {
  readonly depthView: GPUTextureView;
  readonly uniform: GPUBuffer;
  /** 这一帧要用（每帧在画之前调用；没人调时不画、不留深度）。 */
  use(): void;
}

/** uniform 的字节数：视图投影、有效位和尺寸、视图投影的逆、视线方向、相机位置。 */
export const DEPTH_SURFACE_BYTES = 176;

/** 按 view 打包 uniform（width、height 是深度图的尺寸）。前 80 字节（视图投影、有效位和边长）网格着色器也读（天空遮挡）。 */
export function packDepthSurface(view: RenderView, width: number, height: number): ArrayBuffer {
  const data = new ArrayBuffer(DEPTH_SURFACE_BYTES);
  const f32 = new Float32Array(data);
  f32.set(view.viewProjection, 0);
  new Uint32Array(data, 64, 4).set([1, width, height, 0]);
  f32.set(view.inverseViewProjection, 20);
  // 视图矩阵的第三行是视图空间的 +Z（相机朝 -Z 看）
  const v = view.view;
  const forward = [-v[2]!, -v[6]!, -v[10]!];
  const length = Math.hypot(...forward) || 1;
  f32.set([forward[0]! / length, forward[1]! / length, forward[2]! / length, 0], 36);
  f32.set([view.eye.x, view.eye.y, view.eye.z, 0], 40);
  return data;
}

/**
 * 粒子内核里的深度表面（gpuKernel.ts 在有碰撞时拼进去）：surfaceHit(p, thickness) 看 p 是不是落到了表面后面（沿视线方向
 * 不超过 thickness 米：再深的是在物体后面，不算），是的话给出表面上那一点、朝着视图的法线（相邻纹素重建，同 Godot 的高度场
 * 碰撞）、沿法线陷进去多深。
 */
export const DEPTH_SURFACE_WGSL = /* wgsl */ `
struct DepthSurface {
  viewProjection: mat4x4f,
  // x：有效（0 时没有表面），y、z：深度图的宽、高
  valid: vec4u,
  inverseViewProjection: mat4x4f,
  // 视图看的方向（世界，单位向量）
  forward: vec4f,
  eye: vec4f,
};
@group(0) @binding(2) var surfaceDepth: texture_depth_2d;
@group(0) @binding(3) var<uniform> surface: DepthSurface;

struct SurfaceHit {
  hit: bool,
  point: vec3f,
  normal: vec3f,
  // 陷进表面多深（沿法线，米；同 Godot 粒子的 COLLISION_DEPTH），沿法线推出这么多就回到表面上
  depth: f32,
};

/** 深度图上那个纹素的表面在世界里的位置；没画到东西（深度 1）时 w 是 0。 */
fn surfacePoint(texel: vec2i) -> vec4f {
  let size = vec2i(surface.valid.yz);
  let t = clamp(texel, vec2i(0), size - 1);
  let depth = textureLoad(surfaceDepth, t, 0);
  let uv = (vec2f(t) + 0.5) / vec2f(size);
  let world = surface.inverseViewProjection * vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, depth, 1.0);
  return vec4f(world.xyz / world.w, select(1.0, 0.0, depth >= 1.0));
}

/** 相邻两个点里离中间那个近的（沿视线）那一边的差：边缘上不跨到后面的背景去。 */
fn surfaceEdge(center: vec3f, before: vec4f, after: vec4f) -> vec3f {
  let a = select(vec3f(0.0), center - before.xyz, before.w > 0.0);
  let b = select(vec3f(0.0), after.xyz - center, after.w > 0.0);
  let pickB = after.w > 0.0 && (before.w == 0.0 || abs(dot(b, surface.forward.xyz)) < abs(dot(a, surface.forward.xyz)));
  return select(a, b, pickB);
}

fn surfaceHit(p: vec3f, thickness: f32) -> SurfaceHit {
  var result = SurfaceHit(false, p, -surface.forward.xyz, 0.0);
  if (surface.valid.x == 0u) {
    return result;
  }
  let c = surface.viewProjection * vec4f(p, 1.0);
  if (c.w <= 0.0) {
    return result;
  }
  let ndc = c.xyz / c.w;
  let uv = vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
  if (any(uv < vec2f(0.0)) || any(uv >= vec2f(1.0)) || ndc.z < 0.0 || ndc.z > 1.0) {
    return result;
  }
  let texel = vec2i(uv * vec2f(surface.valid.yz));
  let s = surfacePoint(texel);
  if (s.w == 0.0) {
    return result;
  }
  let behind = dot(p - s.xyz, surface.forward.xyz);
  if (behind <= 0.0 || behind > thickness) {
    return result;
  }
  let ex = surfaceEdge(s.xyz, surfacePoint(texel - vec2i(1, 0)), surfacePoint(texel + vec2i(1, 0)));
  let ey = surfaceEdge(s.xyz, surfacePoint(texel - vec2i(0, 1)), surfacePoint(texel + vec2i(0, 1)));
  var n = cross(ex, ey);
  let l = length(n);
  n = select(-surface.forward.xyz, n / l, l > 1e-10);
  // 朝着视图（看得见的那一面）
  n = select(n, -n, dot(n, surface.forward.xyz) > 0.0);
  result.hit = true;
  result.point = s.xyz;
  result.normal = n;
  result.depth = max(dot(n, s.xyz - p), 0.0);
  return result;
}
`;

/**
 * 主视图上一帧的深度（前向渲染器的 `viewDepth`）：有人 use() 的帧前向渲染器把主画面的深度留下来（不丢弃），画完 finish 记下
 * 深度图和矩阵；下一帧第一次 use()（粒子模拟之前）时换成对外的。上一帧没留（没人要、没有相机）时对外的是一张 1x1 的空深度图、
 * 有效位 0。前向渲染器换掉的主深度晚一帧才销毁：这一帧的模拟还绑着它。
 */
export class ViewDepthSurface implements GpuDepthSurface {
  readonly #device: GPUDevice;
  #used = false;
  #placeholder: GPUTexture | undefined;
  #depthView: GPUTextureView | undefined;
  #texture: GPUTexture | undefined;
  #uniform: GPUBuffer | undefined;
  /** 上一帧画完记下的；null 是那一帧没留深度，undefined 是已经换上了。 */
  #pending: { readonly texture: GPUTexture; readonly data: ArrayBuffer } | null | undefined = null;

  constructor(device: GPUDevice) {
    this.#device = device;
  }

  use(): void {
    this.#used = true;
    const pending = this.#pending;
    if (pending === undefined) return;
    this.#pending = undefined;
    if (!pending) {
      this.#texture = undefined;
      this.#depthView = undefined;
      this.#device.queue.writeBuffer(this.uniform, 64, new Uint32Array([0, 1, 1, 0]));
      return;
    }
    if (pending.texture !== this.#texture) {
      this.#texture = pending.texture;
      this.#depthView = pending.texture.createView();
    }
    this.#device.queue.writeBuffer(this.uniform, 0, pending.data);
  }

  /** @internal 这一帧有没有人要（前向渲染器按它留深度）。 */
  get wanted(): boolean {
    return this.#used;
  }

  get depthView(): GPUTextureView {
    if (this.#depthView) return this.#depthView;
    this.#placeholder ??= this.#device.createTexture({ label: 'ViewDepthSurface placeholder', size: [1, 1], format: 'depth32float', usage: GPUTextureUsage.TEXTURE_BINDING });
    return (this.#depthView = this.#placeholder.createView());
  }

  get uniform(): GPUBuffer {
    return (this.#uniform ??= this.#device.createBuffer({ label: 'ViewDepthSurface', size: DEPTH_SURFACE_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }));
  }

  /** @internal 前向渲染器每帧画完调用：有人要、留了深度时给 view 和它的深度图 depth，否则不给。 */
  finish(view?: RenderView, depth?: GPUTexture): void {
    this.#pending = this.#used && view && depth ? { texture: depth, data: packDepthSurface(view, depth.width, depth.height) } : null;
    this.#used = false;
  }

  destroy(): void {
    this.#placeholder?.destroy();
    this.#uniform?.destroy();
  }
}
