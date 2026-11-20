/**
 * 分簇（Olsson 2012 "Clustered Deferred and Forward Shading"，Doom 2016 的分簇前向）：主视图按屏幕分成 16x9 格、沿视线按
 * 指数分 24 层，每一簇记下和它相交的点光、聚光、贴花（按包围球）。网格着色时像素只看自己那一簇的，不再把所有的都看一遍。
 *
 * - 一帧一次，在主视图不透明的那一遍之前（ForwardRenderer）：CPU 把光和贴花的包围球（世界坐标的球心、半径）传上去，计算
 *   着色器每个线程一个簇，算簇在视图空间里的包围盒，和每个球比，按下标从小到大写进这一簇的表（贴花的先后不变）。
 * - 每簇的表：光的个数、贴花的个数，再是最多 MAX_CLUSTER_LIGHTS 个光、MAX_CLUSTER_DECALS 个贴花的下标；多了的丢掉。
 * - 层的深度：第 k 层到 near · (far / near)^((k + 1) / 24)，near、far 是视图的近、远平面。着色器按像素到相机的视线方向的
 *   距离（世界坐标和视图的前方点乘）算层：clusterParams 给的两个 vec4 放在视图常量里。
 * - 只给主视图分簇（RenderView.clustered）；别的视图（渲染目标贴图的相机、反射探针的面）还是看所有的。没有光和贴花时不分。
 */
import { Matrix } from '../../data/Matrix';
import type { RenderView } from '../RenderSystem';

/** 簇的格子：屏幕横、竖几格，沿视线几层。 */
export const CLUSTER_GRID = [16, 9, 24] as const;
export const MAX_CLUSTER_LIGHTS = 64;
export const MAX_CLUSTER_DECALS = 32;
/** 每簇在缓冲里占几个 u32。 */
export const CLUSTER_STRIDE = 2 + MAX_CLUSTER_LIGHTS + MAX_CLUSTER_DECALS;
const CLUSTER_COUNT = CLUSTER_GRID[0] * CLUSTER_GRID[1] * CLUSTER_GRID[2];
const WORKGROUP = 64;

/**
 * 视图常量里的分簇参数（两个 vec4）：(格数 / 视图宽、格数 / 视图高、层数 / ln(far / near)、分不分簇)，(视图的前方, ln near)。
 * 没分簇时第一个的 w 是 0。
 */
export function clusterParams(view: RenderView): [number, number, number, number, number, number, number, number] {
  if (!view.clustered) return [0, 0, 0, 0, 0, 0, 0, 0];
  const { near, far } = clusterDepthRange(view);
  // 视图矩阵的第三行是视图空间的 +Z（相机朝 -Z 看）
  const v = view.view;
  return [
    CLUSTER_GRID[0] / Math.max(1, view.width), CLUSTER_GRID[1] / Math.max(1, view.height), CLUSTER_GRID[2] / Math.log(far / near), 1,
    -v[2]!, -v[6]!, -v[10]!, Math.log(near),
  ];
}

/** 分层用的深度范围：视图的近、远平面（近平面太近时层都挤在相机前面，至少 5 厘米）。 */
export function clusterDepthRange(view: RenderView): { near: number; far: number } {
  const near = Math.max(view.nearClipPlane, 0.05);
  return { near, far: Math.max(view.farClipPlane, near * 2) };
}

/** 像素所在的簇（单测用，和着色器的 clusterOf 同一个算法）：x、y 是视图里的像素，depth 是沿视线的距离。 */
export function clusterIndex(view: RenderView, x: number, y: number, depth: number): number {
  const [sx, sy, scale, , , , , logNear] = clusterParams(view);
  const slice = Math.min(CLUSTER_GRID[2] - 1, Math.max(0, Math.floor((Math.log(Math.max(depth, 1e-4)) - logNear) * scale)));
  const tx = Math.min(CLUSTER_GRID[0] - 1, Math.floor(x * sx)), ty = Math.min(CLUSTER_GRID[1] - 1, Math.floor(y * sy));
  return (slice * CLUSTER_GRID[1] + ty) * CLUSTER_GRID[0] + tx;
}

/** 着色器里的 clusterOf：网格着色器、计算着色器共用的常量。 */
export const CLUSTER_WGSL = /* wgsl */ `
const CLUSTER_X = ${CLUSTER_GRID[0]}u;
const CLUSTER_Y = ${CLUSTER_GRID[1]}u;
const CLUSTER_Z = ${CLUSTER_GRID[2]}u;
const CLUSTER_STRIDE = ${CLUSTER_STRIDE}u;
const MAX_CLUSTER_LIGHTS = ${MAX_CLUSTER_LIGHTS}u;
const MAX_CLUSTER_DECALS = ${MAX_CLUSTER_DECALS}u;
`;

const BUILD_SHADER = /* wgsl */ `
${CLUSTER_WGSL}
struct Build {
  inverseProjection: mat4x4f,
  view: mat4x4f,
  // x：光的个数，y：贴花的个数，z：近平面的视线距离，w：远平面的
  counts: vec4f,
};
@group(0) @binding(0) var<uniform> build: Build;
// 先光后贴花：球心（世界）和半径
@group(0) @binding(1) var<storage, read> spheres: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> clusters: array<u32>;

/** 屏幕上 ndc 那一点、沿视线距离 depth 处的视图空间坐标（透视、正交都对：在近、远平面上各取一点，按距离插值）。 */
fn pointAt(ndc: vec2f, depth: f32) -> vec3f {
  let a = build.inverseProjection * vec4f(ndc, 0.0, 1.0);
  let b = build.inverseProjection * vec4f(ndc, 1.0, 1.0);
  let p0 = a.xyz / a.w;
  let p1 = b.xyz / b.w;
  let t = (depth + p0.z) / (p0.z - p1.z);
  return mix(p0, p1, t);
}

@compute @workgroup_size(${WORKGROUP}) fn main(@builtin(global_invocation_id) id: vec3u) {
  let index = id.x;
  if (index >= CLUSTER_X * CLUSTER_Y * CLUSTER_Z) {
    return;
  }
  let x = index % CLUSTER_X;
  let y = (index / CLUSTER_X) % CLUSTER_Y;
  let z = index / (CLUSTER_X * CLUSTER_Y);
  // 这一簇的视图空间包围盒：屏幕上的一格（y 向下）乘这一层的前后两个深度
  let near = build.counts.z;
  let far = build.counts.w;
  let d0 = near * pow(far / near, f32(z) / f32(CLUSTER_Z));
  let d1 = near * pow(far / near, f32(z + 1u) / f32(CLUSTER_Z));
  let ndcMin = vec2f(f32(x) / f32(CLUSTER_X) * 2.0 - 1.0, 1.0 - f32(y + 1u) / f32(CLUSTER_Y) * 2.0);
  let ndcMax = vec2f(f32(x + 1u) / f32(CLUSTER_X) * 2.0 - 1.0, 1.0 - f32(y) / f32(CLUSTER_Y) * 2.0);
  var lo = vec3f(1e30);
  var hi = vec3f(-1e30);
  for (var corner = 0u; corner < 8u; corner++) {
    let ndc = vec2f(select(ndcMin.x, ndcMax.x, (corner & 1u) != 0u), select(ndcMin.y, ndcMax.y, (corner & 2u) != 0u));
    let p = pointAt(ndc, select(d0, d1, (corner & 4u) != 0u));
    lo = min(lo, p);
    hi = max(hi, p);
  }
  let base = index * CLUSTER_STRIDE;
  let lightCount = u32(build.counts.x);
  let decalCount = u32(build.counts.y);
  var lights = 0u;
  var decals = 0u;
  for (var i = 0u; i < lightCount + decalCount; i++) {
    let sphere = spheres[i];
    let center = (build.view * vec4f(sphere.xyz, 1.0)).xyz;
    let nearest = clamp(center, lo, hi);
    let offset = center - nearest;
    if (dot(offset, offset) > sphere.w * sphere.w) {
      continue;
    }
    if (i < lightCount) {
      if (lights < MAX_CLUSTER_LIGHTS) {
        clusters[base + 2u + lights] = i;
        lights++;
      }
    } else if (decals < MAX_CLUSTER_DECALS) {
      clusters[base + 2u + MAX_CLUSTER_LIGHTS + decals] = i - lightCount;
      decals++;
    }
  }
  clusters[base] = lights;
  clusters[base + 1u] = decals;
}
`;

/** 主视图的簇（渲染系统一份）：record 在主视图不透明的那一遍之前算，网格着色时绑 buffer。 */
export class Clusters {
  /** 每簇的光和贴花的下标（CLUSTER_STRIDE 个 u32 一簇）。 */
  readonly buffer: GPUBuffer;
  readonly #device: GPUDevice;
  readonly #uniforms: GPUBuffer;
  readonly #uniformData = new Float32Array(36);
  #spheres: GPUBuffer | undefined;
  #sphereData = new Float32Array(0);
  #pipeline: GPUComputePipeline | undefined;
  #group: GPUBindGroup | undefined;

  constructor(device: GPUDevice) {
    this.#device = device;
    this.buffer = device.createBuffer({ label: 'Clusters', size: CLUSTER_COUNT * CLUSTER_STRIDE * 4, usage: GPUBufferUsage.STORAGE });
    this.#uniforms = device.createBuffer({ label: 'Clusters build', size: this.#uniformData.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  }

  /**
   * 算 view 的簇。lights、decals 是包围球（每个 4 个数：世界坐标的球心、半径），各 lightCount、decalCount 个；下标和着色器里
   * localLights、decals 的一致。
   */
  record(encoder: GPUCommandEncoder, view: RenderView, lights: Float32Array, lightCount: number, decals: Float32Array, decalCount: number, timestampWrites?: GPUComputePassTimestampWrites): void {
    const floats = (lightCount + decalCount) * 4;
    if (this.#sphereData.length < Math.max(floats, 4)) {
      this.#sphereData = new Float32Array(2 ** Math.ceil(Math.log2(Math.max(floats, 4))));
      this.#spheres?.destroy();
      this.#spheres = this.#device.createBuffer({ label: 'Clusters spheres', size: this.#sphereData.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      this.#group = undefined;
    }
    this.#sphereData.set(lights.subarray(0, lightCount * 4), 0);
    this.#sphereData.set(decals.subarray(0, decalCount * 4), lightCount * 4);
    if (floats > 0) this.#device.queue.writeBuffer(this.#spheres!, 0, this.#sphereData, 0, floats);
    const { near, far } = clusterDepthRange(view);
    const data = this.#uniformData;
    Matrix.invert(data.subarray(0, 16) as never, view.projection);
    data.set(view.view, 16);
    data.set([lightCount, decalCount, near, far], 32);
    this.#device.queue.writeBuffer(this.#uniforms, 0, data);
    const pipeline = (this.#pipeline ??= this.#device.createComputePipeline({
      label: 'Clusters build', layout: 'auto',
      compute: { module: this.#device.createShaderModule({ label: 'Clusters build', code: BUILD_SHADER }), entryPoint: 'main' },
    }));
    this.#group ??= this.#device.createBindGroup({
      label: 'Clusters build', layout: pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.#uniforms } }, { binding: 1, resource: { buffer: this.#spheres! } }, { binding: 2, resource: { buffer: this.buffer } }],
    });
    const pass = encoder.beginComputePass({ label: 'Clusters build', ...(timestampWrites ? { timestampWrites } : {}) });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, this.#group);
    pass.dispatchWorkgroups(Math.ceil(CLUSTER_COUNT / WORKGROUP));
    pass.end();
  }

  destroy(): void {
    this.buffer.destroy();
    this.#uniforms.destroy();
    this.#spheres?.destroy();
  }
}
