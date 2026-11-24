/**
 * 自发光的面当光源（ReSTIR 的直接光，Bitterli 等 2020，光源是发光的三角形）：材质开了 emissiveLighting 的网格（屏幕、灯箱、霓虹）
 * 进光追场景的发光体表（RayTracingScene.emitters：世界矩阵、三角形的范围、按功率的累积分布），这里每个主画面的像素直接对它们
 * 抽样，算出照到这一点的漫反射光：
 * 1. 追踪（计算着色器，半分辨率，每个 2×2 块按帧号轮着挑一个像素）：8 个候选，每个按功率挑一个发光体、在里面均匀挑一个三角形、
 *    三角形上均匀取一点，按不带遮挡的贡献（自发光的亮度 × 两头的余弦 / 距离²）做 RIS，再和上一帧这个位置的蓄水池合并（历史的
 *    个数封顶 4 倍）；选中的点打一条阴影射线，输出余弦加权的平均辐亮度 Ē = Le·G·V·W / π（漫反射颜色乘它就是出射的光，同辐照度
 *    体的约定：发光体铺满半球时 Ē 就是它的辐亮度）。单个样本的亮度封在发光体亮度的 4 倍以内，近处的萤火虫少些。
 * 2. ScreenDenoiser：时间累积、三遍 à-trous，结果当 RenderView.screenEmissive，网格着色器不透明阶段乘漫反射颜色加上。
 * 发光体照亮的光这时不再由辐照度体、路径追踪第一次弹到的表面算（rtEmission），反射里照旧看得见它们。
 * 发光体的自发光按整个网格的平均（SurfaceColors 烘的），不按贴图逐点：适合大致均匀发光的面。
 */
import { Matrix } from '../../data/Matrix';
import { GpuProfiler } from '../../graphics/GpuProfiler';
import { createCheckedShaderModule } from '../../graphics/shaderModule';
import type { RenderView } from '../RenderSystem';
import type { EffectFrame } from '../postfx/ImageEffect';
import { RT_EMITTER_WORDS, rayTracingWgsl, type RayTracingScene } from './RayTracingScene';
import { DENOISE_VIEW_FLOATS, DENOISE_VIEW_WGSL, ScreenDenoiser, traceSurfaceWgsl, writeDenoiseView } from './ScreenDenoiser';

/** 每个像素的候选数。 */
const CANDIDATES = 8;
/** 时间上复用时历史的个数最多是这一帧候选数的几倍（同 RayTracedLocalLights）。 */
const HISTORY_CAP = 4;
/** 单个样本的亮度最多是发光体亮度的几倍（萤火虫）。 */
const SAMPLE_CLAMP = 4;
/** 算贡献时距离的平方至少这么大（米²）：贴着发光体的点不至于除以接近 0 的数。 */
const MIN_DISTANCE_SQUARED = 0.01;

const traceShader = () => /* wgsl */ `
${DENOISE_VIEW_WGSL}
// DenoiseView：eye.w 是发光体的个数，params.w 是上一帧的蓄水池、历史能不能用
@group(0) @binding(0) var<uniform> lights: DenoiseView;
@group(0) @binding(1) var depth: texture_depth_2d;
@group(0) @binding(2) var traced: texture_storage_2d<rgba16float, write>;
// 发光体表（RayTracingScene.emitters）：每项 4 个 vec4f，世界矩阵的三行，(三角形起点, 个数, 实例, 累积分布)
@group(0) @binding(3) var<storage, read> emitters: array<vec4f>;
// 蓄水池（半分辨率每个块一个）：发光体 | M << 20、三角形、重心坐标（pack2x16unorm）、权重 W（bitcast）；上一帧的读、这一帧的写
@group(0) @binding(4) var<storage, read> previousReservoirs: array<vec4u>;
@group(0) @binding(5) var<storage, read_write> reservoirs: array<vec4u>;
${rayTracingWgsl(1)}
${traceSurfaceWgsl('lights')}

const NO_SAMPLE = 0xffffffffu;

fn cumulative(e: u32) -> f32 { return emitters[e * ${RT_EMITTER_WORDS / 4}u + 3u].w; }

/** 按功率挑一个发光体（累积分布上二分）。 */
fn pickEmitter(u: f32, count: u32) -> u32 {
  var low = 0u;
  var high = count - 1u;
  while (low < high) {
    let middle = (low + high) / 2u;
    if (cumulative(middle) < u) { low = middle + 1u; } else { high = middle; }
  }
  return low;
}

fn emitterProbability(e: u32) -> f32 {
  return cumulative(e) - select(0.0, cumulative(max(e, 1u) - 1u), e > 0u);
}

/** 发光体上的一点：位置、朝外的法线（双面时朝哪边都算）、所在三角形在世界里的面积、辐亮度。 */
struct EmitterPoint {
  position: vec3f,
  normal: vec3f,
  area: f32,
  radiance: vec3f,
  twoSided: bool,
  triangles: u32,
};

fn emitterPoint(e: u32, triangle: u32, b: vec2f) -> EmitterPoint {
  let o = e * ${RT_EMITTER_WORDS / 4}u;
  let r0 = emitters[o];
  let r1 = emitters[o + 1u];
  let r2 = emitters[o + 2u];
  let info = bitcast<vec4u>(emitters[o + 3u]);
  let base = (info.x + triangle) * 3u;
  let v0 = rtTriangles[base].xyz;
  let e1 = rtTriangles[base + 1u].xyz;
  let e2 = rtTriangles[base + 2u].xyz;
  let local = v0 + e1 * b.x + e2 * b.y;
  var point: EmitterPoint;
  point.position = vec3f(dot(r0.xyz, local) + r0.w, dot(r1.xyz, local) + r1.w, dot(r2.xyz, local) + r2.w);
  let w1 = vec3f(dot(r0.xyz, e1), dot(r1.xyz, e1), dot(r2.xyz, e1));
  let w2 = vec3f(dot(r0.xyz, e2), dot(r1.xyz, e2), dot(r2.xyz, e2));
  point.area = 0.5 * length(cross(w1, w2));
  // 朝向同 rtFaceNormal（逆矩阵的转置：镜像的实例也朝对）
  let hit = RtHit(0.0, info.z, base / 3u, vec2f(0.0), false, 0u);
  point.normal = rtFaceNormal(hit);
  point.radiance = rtEmissive(hit);
  point.twoSided = (bitcast<vec4u>(rtInstances[info.z * 6u + 3u]).z & 1u) != 0u;
  point.triangles = info.y;
  return point;
}

/** 不带遮挡时这一点照到 p（法线 n）的光：辐亮度 × 两头的余弦 / 距离²（rgb），和它的亮度（目标函数 p̂）。 */
fn contributionOf(point: EmitterPoint, p: vec3f, n: vec3f) -> vec4f {
  let d = point.position - p;
  let squared = dot(d, d);
  let dir = d * inverseSqrt(max(squared, 1e-12));
  let facing = dot(point.normal, -dir);
  let emitterCosine = select(max(facing, 0.0), abs(facing), point.twoSided);
  let g = max(dot(n, dir), 0.0) * emitterCosine / max(squared, ${MIN_DISTANCE_SQUARED});
  let c = point.radiance * g;
  return vec4f(c, dot(c, vec3f(0.2126, 0.7152, 0.0722)));
}

fn barycentric(u: vec2f) -> vec2f {
  let s = sqrt(u.x);
  return vec2f(s * (1.0 - u.y), s * u.y);
}

@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) id: vec3u) {
  let blocks = textureDimensions(traced);
  if (any(id.xy >= blocks)) { return; }
  let slot = id.y * blocks.x + id.x;
  let size = vec2i(lights.params.xy);
  let pixel = min(vec2i(id.xy) * 2 + blockOffset(lights.params.z), size - 1);
  let z = textureLoad(depth, pixel, 0);
  let world = worldAtPixel(pixel);
  let n = depthNormal(pixel, world);
  let count = u32(lights.eye.w);
  if (z <= 0.0 || !(dot(n, n) > 0.5) || count == 0u) {
    reservoirs[slot] = vec4u(NO_SAMPLE, 0u, 0u, 0u);
    textureStore(traced, id.xy, vec4f(0.0));
    return;
  }
  seed = hash(u32(pixel.x) + hash(u32(pixel.y) + hash(u32(lights.params.z))));
  var chosen = vec4u(NO_SAMPLE, 0u, 0u, 0u);
  var chosenTarget = 0.0;
  var weightSum = 0.0;
  for (var k = 0u; k < ${CANDIDATES}u; k++) {
    let e = pickEmitter(random(), count);
    let triangleCount = bitcast<vec4u>(emitters[e * ${RT_EMITTER_WORDS / 4}u + 3u]).y;
    let triangle = min(u32(random() * f32(triangleCount)), triangleCount - 1u);
    let b = barycentric(vec2f(random(), random()));
    let point = emitterPoint(e, triangle, b);
    let score = contributionOf(point, world, n).w;
    // 这一点的概率密度（按面积）：挑中发光体 × 挑中三角形 × 三角形上均匀
    let w = score * f32(triangleCount) * point.area / max(emitterProbability(e), 1e-12);
    weightSum += w;
    if (random() * weightSum < w) {
      chosen = vec4u(e, triangle, pack2x16unorm(b), 0u);
      chosenTarget = score;
    }
  }
  var m = ${CANDIDATES}.0;
  // 时间上的复用：上一帧这个位置的蓄水池按这一帧的目标函数重新算权重再合并
  if (lights.params.w > 0.5) {
    let previous = lights.previousViewProjection * vec4f(world, 1.0);
    let uv = vec2f(previous.x / previous.w * 0.5 + 0.5, 0.5 - previous.y / previous.w * 0.5);
    if (previous.w > 0.0 && all(uv >= vec2f(0.0)) && all(uv < vec2f(1.0))) {
      let old = previousReservoirs[u32(uv.y * f32(blocks.y)) * blocks.x + u32(uv.x * f32(blocks.x))];
      let e = old.x & 0xfffffu;
      if (old.x != NO_SAMPLE && e < count) {
        let oldM = min(f32(old.x >> 20u), ${HISTORY_CAP}.0 * m);
        let score = contributionOf(emitterPoint(e, old.y, unpack2x16unorm(old.z)), world, n).w;
        let w = score * bitcast<f32>(old.w) * oldM;
        weightSum += w;
        m += oldM;
        if (random() * weightSum < w) {
          chosen = vec4u(e, old.y, old.z, 0u);
          chosenTarget = score;
        }
      }
    }
  }
  if (chosen.x == NO_SAMPLE || chosenTarget <= 0.0) {
    reservoirs[slot] = vec4u(NO_SAMPLE, 0u, 0u, 0u);
    textureStore(traced, id.xy, vec4f(0.0));
    return;
  }
  // 无偏的贡献权重 W = 权重和 / (M · p̂(y))
  let contribution = weightSum / (m * chosenTarget);
  reservoirs[slot] = vec4u(chosen.x | (min(u32(m), 0xfffu) << 20u), chosen.y, chosen.z, bitcast<u32>(contribution));
  let point = emitterPoint(chosen.x, chosen.y, unpack2x16unorm(chosen.z));
  // 阴影射线：从表面打到发光体上那一点（起点沿法线挪开一点，到那一点前一点停：别打到发光体自己）
  let distance = length(lights.eye.xyz - world);
  let origin = world + n * (2e-3 + 4e-4 * distance);
  let toPoint = point.position - origin;
  let span = length(toPoint);
  let visible = !rtOccluded(origin, toPoint / max(span, 1e-6), span * 0.999 - 2e-3);
  var estimate = select(vec3f(0.0), contributionOf(point, world, n).rgb * contribution / 3.14159265, visible);
  // 单个样本封顶：Ē 不会超过发光体的辐亮度，一个样本远超它多半是近处的萤火虫
  let limit = ${SAMPLE_CLAMP}.0 * dot(point.radiance, vec3f(0.2126, 0.7152, 0.0722));
  let brightness = dot(estimate, vec3f(0.2126, 0.7152, 0.0722));
  estimate *= min(1.0, limit / max(brightness, 1e-6));
  textureStore(traced, id.xy, vec4f(estimate, 1.0));
}
`;

/** 最后一遍：滤好的就是结果。 */
const FINISH = /* wgsl */ `
fn denoiseFinish(filtered: vec3f, pixel: vec2i) -> vec4f {
  return vec4f(filtered, 1.0);
}
`;

/** 发光体照亮的光的通道（前向渲染器持有；合成器的 emissiveLighting 开，画质要开全局光照）。 */
export class RayTracedEmissive {
  /** 合成器的 emissiveLighting（调试命令 emissive）。 */
  enabled = false;
  readonly #device: GPUDevice;
  readonly #denoiser: ScreenDenoiser;
  #uniforms: GPUBuffer | undefined;
  readonly #data = new Float32Array(DENOISE_VIEW_FLOATS);
  #reservoirs: [GPUBuffer, GPUBuffer] | undefined;
  #current = 0;
  #traced: GPUTexture | undefined;
  readonly #previous = Matrix.identity();
  #historyValid = false;
  /** 上一帧用的发光体表的版本：表换了（下标对不上）蓄水池和历史作废。 */
  #emitterVersion = -1;
  #frame = 0;
  #pipeline: { readonly pipeline: GPUComputePipeline; readonly layout: GPUBindGroupLayout } | Promise<unknown> | undefined;

  constructor(device: GPUDevice) {
    this.#device = device;
    this.#denoiser = new ScreenDenoiser(device, 'Ray traced emissive', FINISH, 'rgba16float');
  }

  /** 这一帧能用：光追场景里有发光体、管线都编好了；没编时在后台开始编。 */
  ready(scene: RayTracingScene): boolean {
    if (!scene.bindGroup || scene.emitters.count === 0 || !scene.emitters.buffer) return false;
    if (!this.#pipeline) {
      const creating = this.#createPipeline(scene.bindGroupLayout);
      this.#pipeline = creating;
      creating.then((ready) => (this.#pipeline = ready), (error: unknown) => console.error('Ray traced emissive: creating the pipeline failed', error));
    }
    return this.#denoiser.ready() && !(this.#pipeline instanceof Promise);
  }

  /** 往渲染图里加这几遍（深度有了以后、不透明阶段之前），返回全分辨率的结果（rgb：余弦加权的平均辐亮度）。ready 之后调。 */
  record(frame: EffectFrame, depth: GPUTexture, view: RenderView, scene: RayTracingScene): GPUTexture {
    const device = this.#device;
    const { pipeline, layout } = this.#pipeline as { readonly pipeline: GPUComputePipeline; readonly layout: GPUBindGroupLayout };
    const { width, height } = depth;
    this.#resize(width, height);
    const emitters = scene.emitters;
    if (emitters.version !== this.#emitterVersion) {
      this.#emitterVersion = emitters.version;
      this.#historyValid = false;
    }
    const d = this.#data;
    writeDenoiseView(d, view, this.#previous, width, height, this.#frame++ % 1024, this.#historyValid);
    d[39] = emitters.count;
    const uniforms = (this.#uniforms ??= device.createBuffer({ label: 'RayTracedEmissive', size: d.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }));
    device.queue.writeBuffer(uniforms, 0, d);
    this.#previous.set(view.viewProjection);
    this.#historyValid = true;

    const traced = this.#traced!;
    const reservoirs = this.#reservoirs!;
    const previousReservoirs = reservoirs[1 - this.#current]!, nextReservoirs = reservoirs[this.#current]!;
    this.#current = 1 - this.#current;
    const emitterBuffer = emitters.buffer!;
    frame.pass('Ray traced emissive', (pass) => pass.sideEffect(), () => {
      const timestampWrites = GpuProfiler.of(device)?.passTimestamps('Ray traced emissive');
      const pass = frame.encoder.beginComputePass({ label: 'Ray traced emissive', ...(timestampWrites ? { timestampWrites } : {}) });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, device.createBindGroup({
        label: 'Ray traced emissive',
        layout,
        entries: [
          { binding: 0, resource: { buffer: uniforms } },
          { binding: 1, resource: depth.createView() },
          { binding: 2, resource: traced.createView() },
          { binding: 3, resource: { buffer: emitterBuffer } },
          { binding: 4, resource: { buffer: previousReservoirs } },
          { binding: 5, resource: { buffer: nextReservoirs } },
        ],
      }));
      pass.setBindGroup(1, scene.bindGroup!);
      pass.dispatchWorkgroups(Math.ceil(traced.width / 8), Math.ceil(traced.height / 8));
      pass.end();
    });
    return this.#denoiser.record(frame, depth, uniforms, traced);
  }

  reset(): void {
    this.#historyValid = false;
  }

  #resize(width: number, height: number): void {
    const half: [number, number] = [Math.ceil(width / 2), Math.ceil(height / 2)];
    if (this.#traced?.width === half[0] && this.#traced.height === half[1]) return;
    this.#traced?.destroy();
    for (const buffer of this.#reservoirs ?? []) buffer.destroy();
    this.#traced = this.#device.createTexture({ label: `Ray traced emissive traced ${half[0]}x${half[1]}`, size: half, format: 'rgba16float', usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING });
    const reservoir = () => this.#device.createBuffer({ label: 'Ray traced emissive reservoirs', size: half[0] * half[1] * 16, usage: GPUBufferUsage.STORAGE });
    this.#reservoirs = [reservoir(), reservoir()];
    this.#historyValid = false;
  }

  async #createPipeline(sceneLayout: GPUBindGroupLayout): Promise<{ pipeline: GPUComputePipeline; layout: GPUBindGroupLayout }> {
    const device = this.#device;
    const compute = GPUShaderStage.COMPUTE;
    const layout = device.createBindGroupLayout({
      label: 'Ray traced emissive',
      entries: [
        { binding: 0, visibility: compute, buffer: {} },
        { binding: 1, visibility: compute, texture: { sampleType: 'depth' } },
        { binding: 2, visibility: compute, storageTexture: { access: 'write-only', format: 'rgba16float' } },
        { binding: 3, visibility: compute, buffer: { type: 'read-only-storage' } },
        { binding: 4, visibility: compute, buffer: { type: 'read-only-storage' } },
        { binding: 5, visibility: compute, buffer: { type: 'storage' } },
      ],
    });
    const module = createCheckedShaderModule(device, 'Ray traced emissive', traceShader());
    const pipeline = await device.createComputePipelineAsync({
      label: 'Ray traced emissive',
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout, sceneLayout] }),
      compute: { module, entryPoint: 'main' },
    });
    return { pipeline, layout };
  }

  destroy(): void {
    this.#uniforms?.destroy();
    for (const buffer of this.#reservoirs ?? []) buffer.destroy();
    this.#traced?.destroy();
    this.#denoiser.destroy();
  }
}
