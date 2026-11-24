/**
 * 大量灯光的光追阴影（ReSTIR，Bitterli 等 2020 的直接光部分，按 Heitz 等 2018 "Combining Analytic Direct Illumination and
 * Stochastic Shadows" 的比值合成）：网格着色器照旧精确地算点光、聚光、面光源（LTC）不带阴影的光，这里每个像素估一个"这些光里
 * 被挡住了多少"的比值乘上去，开销不随灯数涨：
 * 1. 追踪（计算着色器，半分辨率，每个 2×2 块按帧号轮着挑一个像素）：从像素所在的簇里均匀取 CANDIDATES 盏当候选，按不带遮挡
 *    的贡献（颜色的亮度 × 衰减 × N·L，按深度还原的法线）做重要性重抽样（RIS），得到一盏灯和它的权重；在这盏灯上随机取一点
 *    （面光源取面上的点：软阴影）打一条阴影射线。输出两个无偏估计：带遮挡的 S = p̂·W·V、不带遮挡的 U = p̂·W（U 的期望是簇里所有
 *    灯不带遮挡的贡献之和）。时间上的平均交给降噪（同一个像素一帧一帧换灯，32 帧攒成平均）。
 *    不做 ReSTIR 的时间复用（上一帧的蓄水池并进来）：上一帧的灯可能不在这一帧的簇里（候选的范围不同）、复用时也不看几何像不像，
 *    托盘侧面上攒出大权重的远处的灯被搬到地面上，比值估计跟着偏向那盏灯的可见度，货堆周围成片的黑斑（11-24 超市里看到的）。
 * 2. 两个估计一起降噪（ScreenDenoiser：时间累积、三遍 à-trous），最后一遍算比值 S / U，和太阳的可见度拼成 rg（r 太阳、g 局部光）
 *    当 RenderView.screenShadow。
 * 着色时局部光不再查阴影图集（RenderView.rayTracedLocalLights，视图常量的 decal.z），所有局部光的和乘 g。
 */
import { Matrix } from '../../data/Matrix';
import { GpuProfiler } from '../../graphics/GpuProfiler';
import { createCheckedShaderModule } from '../../graphics/shaderModule';
import { LOCAL_LIGHT_WGSL } from '../lighting/LocalLights';
import { CLUSTER_WGSL, clusterParams } from '../lighting/Clusters';
import type { RenderView } from '../RenderSystem';
import type { EffectFrame } from '../postfx/ImageEffect';
import { rayTracingWgsl, type RayTracingScene } from './RayTracingScene';
import { DENOISE_VIEW_FLOATS, DENOISE_VIEW_WGSL, ScreenDenoiser, traceSurfaceWgsl, writeDenoiseView } from './ScreenDenoiser';

/** 每次抽样的候选数（只算不带遮挡的贡献，便宜）。 */
const CANDIDATES = 16;
/** 每个像素每帧几次独立的抽样（每次一条阴影射线）。 */
const RAYS = 1;
/** 最后一遍：滤好的 (S, U) 取比值，和太阳的可见度（extra 的 r，没有时白图）拼成 rg。 */
const FINISH = /* wgsl */ `
fn denoiseFinish(filtered: vec3f, pixel: vec2i) -> vec4f {
  let sunSize = vec2i(textureDimensions(extra));
  let sun = textureLoad(extra, min(pixel, sunSize - 1), 0).r;
  // 不带遮挡的估计接近 0（没有照得到的局部光）时比值没意义：当没被挡
  let ratio = select(1.0, saturate(filtered.x / filtered.y), filtered.y > 1e-6);
  return vec4f(sun, ratio, 0.0, 1.0);
}
`;

/** 追踪（和 RenderSystem 互相引用，用到时才拼）。 */
const traceShader = () => /* wgsl */ `
${DENOISE_VIEW_WGSL}
struct Lights {
  // 开头同降噪的 DenoiseView；eye.w 是局部光的个数
  view: DenoiseView,
  // 分簇的参数（Clusters.clusterParams）
  cluster: vec4f,
  clusterView: vec4f,
};
${CLUSTER_WGSL}
@group(0) @binding(0) var<uniform> lights: Lights;
@group(0) @binding(1) var depth: texture_depth_2d;
@group(0) @binding(2) var traced: texture_storage_2d<rg32float, write>;
@group(0) @binding(3) var<storage, read> localLightData: array<vec4f>;
@group(0) @binding(4) var<storage, read> clusters: array<u32>;
// 蓄水池（半分辨率每个块一个）：灯的下标、个数 M、权重 W（bitcast）、0；上一帧的读、这一帧的写
${LOCAL_LIGHT_WGSL}
${rayTracingWgsl(1)}
${traceSurfaceWgsl('lights.view')}

/** 像素所在的簇（同网格着色器的 clusterOf）；没分簇时 -1。 */
fn clusterAt(pixel: vec2i, world: vec3f) -> i32 {
  if (lights.cluster.w == 0.0) { return -1; }
  let d = max(dot(world - lights.view.eye.xyz, lights.clusterView.xyz), 1e-4);
  let slice = u32(clamp((log(d) - lights.clusterView.w) * lights.cluster.z, 0.0, f32(CLUSTER_Z - 1u)));
  let tile = min(vec2u(vec2f(pixel) * lights.cluster.xy), vec2u(CLUSTER_X - 1u, CLUSTER_Y - 1u));
  let slot = u32(lights.cluster.w) - 1u;
  return i32(slot * CLUSTER_HEADER_WORDS + 1u + ((slice * CLUSTER_Y + tile.y) * CLUSTER_X + tile.x) * CLUSTER_HEADER);
}

/** 不带遮挡时这盏灯对这一点的贡献（目标函数 p̂）：颜色的亮度 × 衰减 × N·L。 */
fn targetOf(index: u32, p: vec3f, n: vec3f) -> f32 {
  let light = localLight(index);
  let at = localLightAt(light, p);
  return dot(light.color.rgb, vec3f(0.2126, 0.7152, 0.0722)) * max(at.w, 0.0) * max(dot(n, at.xyz), 0.0);
}

/** 灯上随机的一点：点光、聚光是中心，矩形光、圆盘光是面上的点，管状光是线段上的点（软阴影）。 */
fn lightPoint(light: LocalLight) -> vec3f {
  let kind = localLightKind(light);
  let x = light.angle.xyz;
  let a = random() * 2.0 - 1.0;
  let b = random() * 2.0 - 1.0;
  if (kind == 2u) {
    let y = normalize(cross(light.direction.xyz, x)) * light.angle.w;
    return light.position.xyz + x * a + y * b;
  }
  if (kind == 3u) {
    let r = length(x);
    let y = normalize(cross(light.direction.xyz, x)) * r;
    let radius = sqrt(random());
    let phi = random() * 6.2831853;
    return light.position.xyz + (x * cos(phi) + y * sin(phi)) * radius;
  }
  if (kind == 4u) {
    return light.position.xyz + x * a;
  }
  return light.position.xyz;
}

/** 半分辨率：每个线程一个 2×2 块，按帧号轮着挑一个像素。 */
@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) id: vec3u) {
  let blocks = textureDimensions(traced);
  if (any(id.xy >= blocks)) { return; }
  let size = vec2i(lights.view.params.xy);
  let pixel = min(vec2i(id.xy) * 2 + blockOffset(lights.view.params.z), size - 1);
  let z = textureLoad(depth, pixel, 0);
  let world = worldAtPixel(pixel);
  let n = depthNormal(pixel, world);
  if (z <= 0.0 || !(dot(n, n) > 0.5)) {
    textureStore(traced, id.xy, vec4f(0.0));
    return;
  }
  // 种子先散列：坐标的线性组合直接当种子时相邻像素的随机数相关，噪声成块
  seed = hash(u32(pixel.x) + hash(u32(pixel.y) + hash(u32(lights.view.params.z))));
  // 候选：簇里均匀取（没分簇时在所有灯里取）
  let cluster = clusterAt(pixel, world);
  var count = u32(lights.view.eye.w);
  var first = 0u;
  if (cluster >= 0) {
    count = clusters[u32(cluster) + 1u] & 0xffffu;
    first = clusters[u32(cluster)];
  }
  if (count == 0u) {
    textureStore(traced, id.xy, vec4f(0.0));
    return;
  }
  let distance = length(lights.view.eye.xyz - world);
  let origin = world + n * (2e-3 + 4e-4 * distance);
  // RAYS 次独立的抽样（各自做 RIS 挑一盏灯、打一条阴影射线），两个估计取平均
  var shadowed = 0.0;
  var unshadowedSum = 0.0;
  for (var r = 0u; r < ${RAYS}u; r++) {
    var chosen = 0xffffffffu;
    var chosenTarget = 0.0;
    var weightSum = 0.0;
    for (var k = 0u; k < ${CANDIDATES}u; k++) {
      let pick = min(u32(random() * f32(count)), count - 1u);
      let index = select(pick, clusters[first + pick], cluster >= 0);
      let score = targetOf(index, world, n);
      // 候选的概率 1 / count：权重 = p̂ · count
      let w = score * f32(count);
      weightSum += w;
      if (random() * weightSum < w) {
        chosen = index;
        chosenTarget = score;
      }
    }
    if (chosen == 0xffffffffu || chosenTarget <= 0.0) { continue; }
    // 不带遮挡的估计 p̂ · W，W = 权重和 / (M · p̂(y))：就是候选权重的平均
    let unshadowed = weightSum / ${CANDIDATES}.0;
    // 阴影射线：打到灯上随机的一点（起点沿法线挪开一点，到灯前一点停）
    let onLight = lightPoint(localLight(chosen));
    let toLight = onLight - origin;
    let span = length(toLight);
    let visible = select(1.0, 0.0, rtOccluded(origin, toLight / max(span, 1e-6), span - 2e-3));
    shadowed += unshadowed * visible;
    unshadowedSum += unshadowed;
  }
  textureStore(traced, id.xy, vec4f(shadowed / ${RAYS}.0, unshadowedSum / ${RAYS}.0, 0.0, 1.0));
}
`;

/** 局部光的光追阴影的通道（前向渲染器持有，开关同 RayTracedShadows：合成器的 rayTracedShadows）。 */
export class RayTracedLocalLights {
  /** 合成器开着光追阴影时局部光也用光追（关了局部光照旧用阴影图集；调试命令 rtshadow 的 local）。 */
  enabled = true;
  readonly #device: GPUDevice;
  readonly #denoiser: ScreenDenoiser;
  #uniforms: GPUBuffer | undefined;
  readonly #data = new Float32Array(DENOISE_VIEW_FLOATS + 8);
  #traced: GPUTexture | undefined;
  readonly #previous = Matrix.identity();
  #historyValid = false;
  #frame = 0;
  #pipeline: { readonly pipeline: GPUComputePipeline; readonly layout: GPUBindGroupLayout } | Promise<unknown> | undefined;

  constructor(device: GPUDevice) {
    this.#device = device;
    this.#denoiser = new ScreenDenoiser(device, 'Ray traced local lights', FINISH, 'rg16float', { clampHistory: false });
  }

  /** 这一帧能用：光追场景有东西、管线都编好了；没编时在后台开始编。 */
  ready(scene: RayTracingScene): boolean {
    if (!scene.bindGroup) return false;
    if (!this.#pipeline) {
      const creating = this.#createPipeline(scene.bindGroupLayout);
      this.#pipeline = creating;
      creating.then((ready) => (this.#pipeline = ready), (error: unknown) => console.error('Ray traced local lights: creating the pipeline failed', error));
    }
    return this.#denoiser.ready() && !(this.#pipeline instanceof Promise);
  }

  /**
   * 往渲染图里加这几遍（分簇之后、不透明阶段之前），返回 rg 的结果（r：sun 的 r，没有时 1；g：局部光的可见比例）。
   * localLights、clusters 是渲染系统的两个缓冲，lightCount 是局部光的个数。ready 之后调。
   */
  record(frame: EffectFrame, depth: GPUTexture, view: RenderView, scene: RayTracingScene, localLights: GPUBuffer, clusters: GPUBuffer, lightCount: number, sun: GPUTexture | undefined): GPUTexture {
    const device = this.#device;
    const { pipeline, layout } = this.#pipeline as { readonly pipeline: GPUComputePipeline; readonly layout: GPUBindGroupLayout };
    const { width, height } = depth;
    this.#resize(width, height);
    const d = this.#data;
    writeDenoiseView(d, view, this.#previous, width, height, this.#frame++ % 1024, this.#historyValid);
    d[39] = lightCount;
    d.set(clusterParams(view), DENOISE_VIEW_FLOATS);
    const uniforms = (this.#uniforms ??= device.createBuffer({ label: 'RayTracedLocalLights', size: d.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }));
    device.queue.writeBuffer(uniforms, 0, d);
    this.#previous.set(view.viewProjection);
    this.#historyValid = true;

    const traced = this.#traced!;
    frame.pass('Ray traced local lights', (pass) => pass.sideEffect(), () => {
      const timestampWrites = GpuProfiler.of(device)?.passTimestamps('Ray traced local lights');
      const pass = frame.encoder.beginComputePass({ label: 'Ray traced local lights', ...(timestampWrites ? { timestampWrites } : {}) });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, device.createBindGroup({
        label: 'Ray traced local lights',
        layout,
        entries: [
          { binding: 0, resource: { buffer: uniforms } },
          { binding: 1, resource: depth.createView() },
          { binding: 2, resource: traced.createView() },
          { binding: 3, resource: { buffer: localLights } },
          { binding: 4, resource: { buffer: clusters } },
        ],
      }));
      pass.setBindGroup(1, scene.bindGroup!);
      pass.dispatchWorkgroups(Math.ceil(traced.width / 8), Math.ceil(traced.height / 8));
      pass.end();
    });

    return this.#denoiser.record(frame, depth, uniforms, traced, sun);
  }

  reset(): void {
    this.#historyValid = false;
  }

  #resize(width: number, height: number): void {
    const half: [number, number] = [Math.ceil(width / 2), Math.ceil(height / 2)];
    if (this.#traced?.width === half[0] && this.#traced.height === half[1]) return;
    this.#traced?.destroy();
    this.#traced = this.#device.createTexture({ label: `Ray traced local lights traced ${half[0]}x${half[1]}`, size: half, format: 'rg32float', usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING });
    this.#historyValid = false;
  }

  async #createPipeline(sceneLayout: GPUBindGroupLayout): Promise<{ pipeline: GPUComputePipeline; layout: GPUBindGroupLayout }> {
    const device = this.#device;
    const compute = GPUShaderStage.COMPUTE;
    const layout = device.createBindGroupLayout({
      label: 'Ray traced local lights',
      entries: [
        { binding: 0, visibility: compute, buffer: {} },
        { binding: 1, visibility: compute, texture: { sampleType: 'depth' } },
        { binding: 2, visibility: compute, storageTexture: { access: 'write-only', format: 'rg32float' } },
        { binding: 3, visibility: compute, buffer: { type: 'read-only-storage' } },
        { binding: 4, visibility: compute, buffer: { type: 'read-only-storage' } },
      ],
    });
    const module = createCheckedShaderModule(device, 'Ray traced local lights', traceShader());
    const pipeline = await device.createComputePipelineAsync({
      label: 'Ray traced local lights',
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout, sceneLayout] }),
      compute: { module, entryPoint: 'main' },
    });
    return { pipeline, layout };
  }

  destroy(): void {
    this.#uniforms?.destroy();
    this.#traced?.destroy();
    this.#denoiser.destroy();
  }
}
