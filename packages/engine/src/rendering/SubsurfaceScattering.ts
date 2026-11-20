/**
 * 次表面散射的后处理（Stride 的 SubsurfaceScatteringBlur，Jimenez 2015 "Separable Subsurface Scattering"）：不透明阶段画完、
 * 透明阶段之前，把有散射材质的像素的漫反射光在屏幕上横、竖各模糊一遍，权重按材质的散射核（几个高斯之和的皮肤轮廓）。
 *
 * - 哪些像素、哪种材质、多强：不透明阶段写表面时（RenderSystem 的 SURFACE_FORMATS），第 3 张表面的 a 是"槽位 + 强度"
 *   （整数部分是 SubsurfaceMaterials 给材质的槽位，1 起，0 是没有散射；小数部分是透光度）。所以有散射材质的场景用写表面的
 *   不透明阶段（同屏幕空间反射）。
 * - 和 Stride 不同：只糊漫反射光。散射材质的像素在第 3 张表面的 rgb 里存颜色里不散射的部分（直射光和环境的镜面反射、
 *   自发光），模糊之前减掉、模糊完加回去，高光不会糊成十字（Stride 连整个颜色一起糊）；这些像素因此不做屏幕空间反射。
 *   邻居不是散射材质的（槽位 0）不混进来，深度差得多的（别的表面）按 Stride 的 SSSS_FOLLOW_SURFACE 拉回中心的颜色。
 * - 散射核在 CPU 上按材质的强度、衰减生成（scatteringKernel，同 Stride 的 SubsurfaceScatteringKernelGenerator），材质改了
 *   （version 变了）就重新生成、上传。
 */
import type { Material, MaterialSubsurfaceScattering } from './Material';
import { Matrix } from '../mathematics/Matrix';
import { FullscreenShader, UniformArena, type EffectFrame, type Image } from './postfx/ImageEffect';
import type { RenderView } from './RenderSystem';

/** 每个核的采样数（Stride 的默认 KernelLength 25）。 */
export const KERNEL_LENGTH = 25;
/** 最多几种散射材质（Stride 的 MaxMaterialCount 16）。 */
export const MAX_SUBSURFACE_MATERIALS = 16;

/** 一个高斯分量（Stride 的 GaussianComponent，照抄它的 3.14）。 */
function gaussian(variance: number, r: number, falloff: number): number {
  const rr = r / (0.001 + falloff);
  return Math.exp(-(rr * rr) / (2 * variance)) / (2 * 3.14 * variance);
}

/** 皮肤的散射轮廓（d'Eon 的几个高斯之和；最窄的那个是直接弹回去的光，归 strength 管，不在这里）。 */
function profile(r: number, falloff: readonly [number, number, number]): [number, number, number] {
  return falloff.map((f) => 0.1 * gaussian(0.0484, r, f) + 0.118 * gaussian(0.187, r, f) + 0.113 * gaussian(0.567, r, f) + 0.358 * gaussian(1.99, r, f) + 0.078 * gaussian(7.41, r, f)) as [number, number, number];
}

/**
 * 散射核（同 Stride 的 CalculateScatteringKernel）：sampleCount 个 (r, g, b 的权重, 偏移)；第 0 个是中心，偏移是相对散射宽度的，
 * 已经除过 3。每个通道的权重加起来是 1，strength 是有多少散出去（1 - strength 留在中心）。
 */
export function scatteringKernel(sampleCount: number, strength: readonly [number, number, number], falloff: readonly [number, number, number]): Float32Array {
  const range = sampleCount > 20 ? 3 : 2;
  const step = (2 * range) / (sampleCount - 1);
  const kernel = Array.from({ length: sampleCount }, (_, i) => {
    const o = -range + i * step;
    return [0, 0, 0, range * Math.sign(o || 1) * (Math.abs(o) ** 2 / range ** 2)];
  });
  for (let i = 0; i < sampleCount; i++) {
    const w0 = i > 0 ? Math.abs(kernel[i]![3]! - kernel[i - 1]![3]!) : 0;
    const w1 = i < sampleCount - 1 ? Math.abs(kernel[i]![3]! - kernel[i + 1]![3]!) : 0;
    const area = (w0 + w1) / 2;
    const p = profile(kernel[i]![3]!, falloff);
    for (let c = 0; c < 3; c++) kernel[i]![c] = area * p[c]!;
  }
  // 中心挪到第 0 个
  const center = kernel[Math.floor(sampleCount / 2)]!;
  kernel.splice(Math.floor(sampleCount / 2), 1);
  kernel.unshift(center);
  for (let c = 0; c < 3; c++) {
    const sum = kernel.reduce((total, k) => total + k[c]!, 0);
    for (const k of kernel) k[c]! /= sum;
    kernel[0]![c] = 1 - strength[c]! + strength[c]! * kernel[0]![c]!;
    for (let i = 1; i < sampleCount; i++) kernel[i]![c]! *= strength[c]!;
  }
  for (let i = 1; i < sampleCount; i++) kernel[i]![3]! /= 3;
  return Float32Array.from(kernel.flat());
}

/**
 * 场景里用到的散射材质：每种一个槽位（1 起），槽位里放它的核和散射宽度。MeshRenderFeature 上传材质时问 slotOf，
 * 着色器把槽位写进表面；SubsurfaceScattering 模糊时读 kernels。槽位满了的材质不散射（警告一次）。
 */
export class SubsurfaceMaterials {
  readonly #slots = new Map<Material, { slot: number; version: number }>();
  /** 每个槽位 KERNEL_LENGTH 个 vec4（槽位 0 不用）。 */
  readonly kernels = new Float32Array((MAX_SUBSURFACE_MATERIALS + 1) * KERNEL_LENGTH * 4);
  /** 每个槽位的散射宽度（世界单位）。 */
  readonly widths = new Float32Array(MAX_SUBSURFACE_MATERIALS + 1);
  /** 核或宽度改过、还没上传。 */
  dirty = true;
  #warned = false;

  /** 有没有散射材质（有才用写表面的不透明阶段、才做模糊）。 */
  get count(): number {
    return this.#slots.size;
  }

  /** 材质的槽位（1 起）；没有散射或槽位满了是 0。材质改过（version 变了）时重新生成它的核。 */
  slotOf(material: Material): number {
    const scattering = material.subsurfaceScattering;
    const known = this.#slots.get(material);
    if (!scattering) {
      if (known) this.#slots.delete(material);
      return 0;
    }
    if (known && known.version === material.version) return known.slot;
    const slot = known?.slot ?? this.#freeSlot();
    if (slot === 0) {
      if (!this.#warned) console.warn(`SubsurfaceScattering: more than ${MAX_SUBSURFACE_MATERIALS} subsurface scattering materials; '${material.name}' is drawn without scattering`);
      this.#warned = true;
      return 0;
    }
    this.#slots.set(material, { slot, version: material.version });
    this.#write(slot, scattering);
    return slot;
  }

  #freeSlot(): number {
    const used = new Set([...this.#slots.values()].map((entry) => entry.slot));
    for (let slot = 1; slot <= MAX_SUBSURFACE_MATERIALS; slot++) if (!used.has(slot)) return slot;
    return 0;
  }

  #write(slot: number, { width, strength, falloff }: MaterialSubsurfaceScattering): void {
    this.kernels.set(scatteringKernel(KERNEL_LENGTH, strength, falloff), slot * KERNEL_LENGTH * 4);
    this.widths[slot] = width;
    this.dirty = true;
  }
}

const BLUR_SHADER = /* wgsl */ `
struct Blur {
  inverseProjection: mat4x4f,
  // xy：深度 1 处一个世界单位在画面上是多少（UV），zw：这一遍的方向（横 (1, 0)、竖 (0, 1)）
  params: vec4f,
};
@group(0) @binding(0) var<uniform> blur: Blur;
@group(0) @binding(1) var color: texture_2d<f32>;
// 第 3 张表面：散射材质的像素 rgb 是颜色里不散射的部分（镜面反射、自发光），a 是槽位 + 强度
@group(0) @binding(2) var surface: texture_2d<f32>;
@group(0) @binding(3) var depth: texture_depth_2d;
@group(0) @binding(4) var<storage, read> kernels: array<vec4f>;
@group(0) @binding(5) var<storage, read> widths: array<f32>;

const KERNEL_LENGTH = ${KERNEL_LENGTH}u;

fn viewDepth(pixel: vec2i) -> f32 {
  let v = blur.inverseProjection * vec4f(0.0, 0.0, textureLoad(depth, pixel, 0), 1.0);
  return -v.z / v.w;
}

/** 这个像素的漫反射光（减掉不散射的部分）；不是散射材质的返回 fallback。 */
fn diffuseAt(pixel: vec2i, fallback: vec3f) -> vec3f {
  let s = textureLoad(surface, pixel, 0);
  if (s.a < 1.0) { return fallback; }
  return textureLoad(color, pixel, 0).rgb - s.rgb;
}

@fragment fn fs(in: FullscreenVaryings) -> @location(0) vec4f {
  let pixel = vec2i(in.position.xy);
  let here = textureLoad(color, pixel, 0);
  let s = textureLoad(surface, pixel, 0);
  if (s.a < 1.0) { return vec4f(here.rgb, 1.0); }
  let slot = u32(s.a);
  let strength = fract(s.a);
  let width = widths[slot];
  let center = here.rgb - s.rgb;
  let depthM = viewDepth(pixel);
  let size = vec2f(textureDimensions(color));
  // 一个世界单位在这个深度上是多少像素，乘散射宽度、强度（Stride 用 alpha 调步长）
  let stepPixels = width * strength * blur.params.xy / depthM * size * blur.params.zw;
  var sum = center * kernels[slot * KERNEL_LENGTH].rgb;
  for (var i = 1u; i < KERNEL_LENGTH; i++) {
    let k = kernels[slot * KERNEL_LENGTH + i];
    let p = clamp(vec2i(round(in.position.xy + k.a * stepPixels)), vec2i(0), vec2i(size) - 1);
    var c = diffuseAt(p, center);
    // 深度差得多的是别的表面：拉回中心的颜色（Stride 的 SSSS_FOLLOW_SURFACE）
    let follow = saturate(abs(depthM - viewDepth(p)) / width * 0.5);
    c = mix(c, center, follow);
    sum += k.rgb * c;
  }
  return vec4f(sum + s.rgb, 1.0);
}`;

const HDR_FORMAT: GPUTextureFormat = 'rgba16float';

export class SubsurfaceScattering {
  /** 合成器给的：开不开（Stride 的 ForwardRenderer.SubsurfaceScatteringBlurEffect 不是 null）。 */
  enabled = false;
  readonly #device: GPUDevice;
  readonly #blur: FullscreenShader;
  readonly #arena: UniformArena;
  #kernels: GPUBuffer | undefined;
  #widths: GPUBuffer | undefined;
  readonly #inverseProjection = Matrix.identity();

  constructor(device: GPUDevice) {
    this.#device = device;
    this.#blur = new FullscreenShader(device, 'SubsurfaceScattering blur', BLUR_SHADER);
    this.#arena = new UniformArena(device, 1024);
  }

  /**
   * 往这一帧的渲染图里加横、竖两遍模糊：color 读写（结果写回 color），surface 是第 3 张表面（SURFACE_FORMATS[2]），
   * depth 是这一帧的深度。materials 是场景里的散射材质（核和宽度）。
   */
  record(frame: EffectFrame, color: Image, surface: Image, depth: GPUTexture, view: RenderView, materials: SubsurfaceMaterials): void {
    this.#arena.reset();
    this.#upload(materials);
    if (!Matrix.invert(this.#inverseProjection, view.projection)) Matrix.setIdentity(this.#inverseProjection);
    // 投影的 [0][0]、[1][1]：深度 1 处一个单位在 NDC 里是多少，UV 是它的一半
    const scale = [view.projection[0]! / 2, view.projection[5]! / 2];
    // 颜色和深度一样大
    const temp = frame.acquire(depth.width, depth.height, HDR_FORMAT, 'SubsurfaceScattering horizontal');
    const buffers = [{ buffer: this.#kernels! }, { buffer: this.#widths! }];
    this.#blur.draw(frame, temp, [this.#arena.push([...this.#inverseProjection, ...scale, 1, 0]), color, surface, depth, ...buffers]);
    this.#blur.draw(frame, color, [this.#arena.push([...this.#inverseProjection, ...scale, 0, 1]), temp, surface, depth, ...buffers]);
  }

  warm(): Promise<void> | undefined {
    return this.#blur.warm([HDR_FORMAT]);
  }

  flush(): void {
    this.#arena.flush();
  }

  destroy(): void {
    this.#kernels?.destroy();
    this.#widths?.destroy();
    this.#arena.destroy();
  }

  #upload(materials: SubsurfaceMaterials): void {
    if (!this.#kernels) {
      this.#kernels = this.#device.createBuffer({ label: 'SubsurfaceScattering kernels', size: materials.kernels.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      this.#widths = this.#device.createBuffer({ label: 'SubsurfaceScattering widths', size: materials.widths.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      materials.dirty = true;
    }
    if (!materials.dirty) return;
    this.#device.queue.writeBuffer(this.#kernels, 0, materials.kernels);
    this.#device.queue.writeBuffer(this.#widths!, 0, materials.widths);
    materials.dirty = false;
  }
}
