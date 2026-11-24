/**
 * 大量灯光的光追阴影（ReSTIR，Bitterli 等 2020 的直接光部分，按 Heitz 等 2018 "Combining Analytic Direct Illumination and
 * Stochastic Shadows" 的比值合成）：网格着色器照旧精确地算点光、聚光、面光源（LTC）不带阴影的光，这里每个像素估一个"这些光里
 * 被挡住了多少"的比值乘上去，开销不随灯数涨：
 * 1. 追踪（计算着色器，半分辨率，每个 2×2 块按帧号轮着挑一个像素）：从像素所在的簇里均匀取 8 盏当候选，按不带遮挡的贡献
 *    （颜色的亮度 × 衰减 × N·L，按深度还原的法线）做重要性重抽样（RIS），再和上一帧这个位置的蓄水池合并（时间上的复用，
 *    历史的个数封顶 4 倍），得到一盏灯和它的权重；在这盏灯上随机取一点（面光源取面上的点：软阴影）打一条阴影射线。输出两个
 *    无偏估计：带遮挡的 S = p̂·W·V、不带遮挡的 U = p̂·W（U 的期望是簇里所有灯不带遮挡的贡献之和）。
 * 2. 两个估计一起做时间累积（按累积的帧数平均）和三遍 à-trous，最后一遍算比值 S / U，和太阳的可见度拼成 rg（r 太阳、g 局部光）
 *    当 RenderView.screenShadow。
 * 着色时局部光不再查阴影图集（RenderView.rayTracedLocalLights，视图常量的 decal.z），所有局部光的和乘 g。
 */
import { Matrix } from '../../data/Matrix';
import { GpuProfiler } from '../../graphics/GpuProfiler';
import { createCheckedShaderModule } from '../../graphics/shaderModule';
import { LOCAL_LIGHT_WGSL } from '../lighting/LocalLights';
import { CLUSTER_WGSL, clusterParams } from '../lighting/Clusters';
import type { RenderView } from '../RenderSystem';
import { FullscreenShader, type EffectFrame } from '../postfx/ImageEffect';
import { GRADIENT_NOISE } from '../wgsl';
import { rayTracingWgsl, type RayTracingScene } from './RayTracingScene';

/** r：带遮挡的估计 S，g：不带遮挡的 U，b：累积了几帧（时间累积用）。 */
const FORMAT: GPUTextureFormat = 'rgba16float';
/** 每个像素的候选数。 */
const CANDIDATES = 8;
/**
 * 时间上复用时历史的个数最多是这一帧候选数的几倍（Bitterli 2020 的 M 封顶）。目标函数不带遮挡，复用只让抽样更贴近不带遮挡的
 * 贡献；封得高时一个像素长时间停在同一盏灯上，时间累积反复平均同一盏灯的可见度、成块的噪声不收敛（20 倍时就是这样）。
 */
const HISTORY_CAP = 4;
/** 时间累积最多平均多少帧（按 1 / 帧数混合，相机不动时收敛）。 */
const MAX_HISTORY = 32;

const COMMON = /* wgsl */ `
struct Lights {
  inverseViewProjection: mat4x4f,
  previousViewProjection: mat4x4f,
  // 宽、高、第几帧、上一帧的蓄水池能不能用
  params: vec4f,
  // 相机的位置（渲染坐标）、局部光的个数
  eye: vec4f,
  // 分簇的参数（Clusters.clusterParams）
  cluster: vec4f,
  clusterView: vec4f,
};

fn worldAt(inverseViewProjection: mat4x4f, uv: vec2f, z: f32) -> vec3f {
  let clip = inverseViewProjection * vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, z, 1.0);
  return clip.xyz / clip.w;
}

fn blockOffset() -> vec2i {
  let frame = u32(lights.params.z);
  return vec2i(i32(frame & 1u), i32((frame >> 1u) & 1u));
}
`;

/** 追踪（和 RenderSystem 互相引用，用到时才拼）。 */
const traceShader = () => /* wgsl */ `
${COMMON}
${GRADIENT_NOISE}
${CLUSTER_WGSL}
@group(0) @binding(0) var<uniform> lights: Lights;
@group(0) @binding(1) var depth: texture_depth_2d;
@group(0) @binding(2) var traced: texture_storage_2d<rg32float, write>;
@group(0) @binding(3) var<storage, read> localLightData: array<vec4f>;
@group(0) @binding(4) var<storage, read> clusters: array<u32>;
// 蓄水池（半分辨率每个块一个）：灯的下标、个数 M、权重 W（bitcast）、0；上一帧的读、这一帧的写
@group(0) @binding(5) var<storage, read> previousReservoirs: array<vec4u>;
@group(0) @binding(6) var<storage, read_write> reservoirs: array<vec4u>;
${LOCAL_LIGHT_WGSL}
${rayTracingWgsl(1)}

fn worldAtPixel(pixel: vec2i) -> vec3f {
  let size = vec2i(lights.params.xy);
  let p = clamp(pixel, vec2i(0), size - 1);
  return worldAt(lights.inverseViewProjection, (vec2f(p) + 0.5) / lights.params.xy, textureLoad(depth, p, 0));
}

/** 按深度还原的法线（同 RayTracedShadows 的 depthNormal）；还原不出来时是零向量。 */
fn depthNormal(pixel: vec2i, center: vec3f) -> vec3f {
  let last = vec2i(lights.params.xy) - 1;
  let right = worldAtPixel(pixel + vec2i(1, 0)) - center;
  let left = center - worldAtPixel(pixel - vec2i(1, 0));
  let down = worldAtPixel(pixel + vec2i(0, 1)) - center;
  let up = center - worldAtPixel(pixel - vec2i(0, 1));
  let dx = select(select(left, right, dot(right, right) < dot(left, left)), select(right, left, pixel.x == last.x), pixel.x == 0 || pixel.x == last.x);
  let dy = select(select(up, down, dot(down, down) < dot(up, up)), select(down, up, pixel.y == last.y), pixel.y == 0 || pixel.y == last.y);
  let c = cross(dy, dx);
  if (!(dot(c, c) > 1e-20)) { return vec3f(0.0); }
  var n = normalize(c);
  if (dot(n, lights.eye.xyz - center) < 0.0) { n = -n; }
  return n;
}

/** 像素所在的簇（同网格着色器的 clusterOf）；没分簇时 -1。 */
fn clusterAt(pixel: vec2i, world: vec3f) -> i32 {
  if (lights.cluster.w == 0.0) { return -1; }
  let d = max(dot(world - lights.eye.xyz, lights.clusterView.xyz), 1e-4);
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

fn hash(value: u32) -> u32 {
  let state = value * 747796405u + 2891336453u;
  let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}

var<private> seed: u32;
fn random() -> f32 {
  seed = seed * 747796405u + 2891336453u;
  var word = ((seed >> ((seed >> 28u) + 4u)) ^ seed) * 277803737u;
  word = (word >> 22u) ^ word;
  return f32(word >> 8u) / 16777216.0;
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
  let slot = id.y * blocks.x + id.x;
  let size = vec2i(lights.params.xy);
  let pixel = min(vec2i(id.xy) * 2 + blockOffset(), size - 1);
  let z = textureLoad(depth, pixel, 0);
  let world = worldAtPixel(pixel);
  let n = depthNormal(pixel, world);
  if (z <= 0.0 || !(dot(n, n) > 0.5)) {
    reservoirs[slot] = vec4u(0xffffffffu, 0u, 0u, 0u);
    textureStore(traced, id.xy, vec4f(0.0));
    return;
  }
  // 种子先散列：坐标的线性组合直接当种子时相邻像素的随机数相关，噪声成块
  seed = hash(u32(pixel.x) + hash(u32(pixel.y) + hash(u32(lights.params.z))));
  // 候选：簇里均匀取（没分簇时在所有灯里取）
  let cluster = clusterAt(pixel, world);
  var count = u32(lights.eye.w);
  var first = 0u;
  if (cluster >= 0) {
    count = clusters[u32(cluster) + 1u] & 0xffffu;
    first = clusters[u32(cluster)];
  }
  var chosen = 0xffffffffu;
  var chosenTarget = 0.0;
  var weightSum = 0.0;
  var m = 0.0;
  if (count > 0u) {
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
    m = ${CANDIDATES}.0;
  }
  // 时间上的复用：上一帧这个位置的蓄水池按这一帧的目标函数重新算权重再合并
  if (lights.params.w > 0.5) {
    let previous = lights.previousViewProjection * vec4f(world, 1.0);
    let uv = vec2f(previous.x / previous.w * 0.5 + 0.5, 0.5 - previous.y / previous.w * 0.5);
    if (previous.w > 0.0 && all(uv >= vec2f(0.0)) && all(uv < vec2f(1.0))) {
      let old = previousReservoirs[u32(uv.y * f32(blocks.y)) * blocks.x + u32(uv.x * f32(blocks.x))];
      if (old.x != 0xffffffffu && old.x < u32(lights.eye.w)) {
        let oldM = min(f32(old.y), ${HISTORY_CAP}.0 * max(m, 1.0));
        let score = targetOf(old.x, world, n);
        let w = score * bitcast<f32>(old.z) * oldM;
        weightSum += w;
        m += oldM;
        if (random() * weightSum < w) {
          chosen = old.x;
          chosenTarget = score;
        }
      }
    }
  }
  if (chosen == 0xffffffffu || chosenTarget <= 0.0 || m <= 0.0) {
    reservoirs[slot] = vec4u(0xffffffffu, 0u, 0u, 0u);
    textureStore(traced, id.xy, vec4f(0.0));
    return;
  }
  // 无偏的贡献权重 W = 权重和 / (M · p̂(y))
  let contribution = weightSum / (m * chosenTarget);
  reservoirs[slot] = vec4u(chosen, u32(m), bitcast<u32>(contribution), 0u);
  // 阴影射线：打到灯上随机的一点（起点沿法线挪开一点，到灯前一点停）
  let light = localLight(chosen);
  let onLight = lightPoint(light);
  let distance = length(lights.eye.xyz - world);
  let origin = world + n * (2e-3 + 4e-4 * distance);
  let toLight = onLight - origin;
  let span = length(toLight);
  let visible = select(1.0, 0.0, rtOccluded(origin, toLight / max(span, 1e-6), span - 2e-3));
  let unshadowed = chosenTarget * contribution;
  textureStore(traced, id.xy, vec4f(unshadowed * visible, unshadowed, 0.0, 1.0));
}
`;

/**
 * 时间上累积（全分辨率，两个估计一起）：历史夹在所在块周围 3×3 块的范围里，按累积的帧数 1 / n 混合（最多 MAX_HISTORY 帧），
 * 相机不动时收敛；重投影到画面外、没有历史时从头数。
 */
const TEMPORAL_SHADER = /* wgsl */ `
${COMMON}
@group(0) @binding(0) var<uniform> lights: Lights;
@group(0) @binding(1) var depth: texture_depth_2d;
@group(0) @binding(2) var current: texture_2d<f32>;
@group(0) @binding(3) var history: texture_2d<f32>;
@group(0) @binding(4) var linearClamp: sampler;

@fragment fn fs(in: FullscreenVaryings) -> @location(0) vec4f {
  let pixel = vec2i(in.position.xy);
  let blocks = vec2i(textureDimensions(current));
  let block = min(pixel / 2, blocks - 1);
  let now = textureLoad(current, block, 0).rg;
  let z = textureLoad(depth, pixel, 0);
  if (z <= 0.0) { return vec4f(0.0, 0.0, 0.0, 1.0); }
  var low = now;
  var high = now;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let v = textureLoad(current, clamp(block + vec2i(x, y), vec2i(0), blocks - 1), 0).rg;
      low = min(low, v);
      high = max(high, v);
    }
  }
  let world = worldAt(lights.inverseViewProjection, (vec2f(pixel) + 0.5) / lights.params.xy, z);
  let previous = lights.previousViewProjection * vec4f(world, 1.0);
  let uv = vec2f(previous.x / previous.w * 0.5 + 0.5, 0.5 - previous.y / previous.w * 0.5);
  if (previous.w <= 0.0 || any(uv < vec2f(0.0)) || any(uv > vec2f(1.0)) || lights.params.w < 0.5) {
    return vec4f(now, 1.0, 1.0);
  }
  let past = textureSampleLevel(history, linearClamp, uv, 0.0);
  let frames = min(past.b + 1.0, ${MAX_HISTORY}.0);
  return vec4f(mix(clamp(past.rg, low, high), now, 1.0 / frames), frames, 1.0);
}
`;

/** 空间上一遍 à-trous（步长 step.x，3×3，按视深挡边）；step.y 是 1 时这是最后一遍：输出 (太阳的可见度, S / U)。 */
const BLUR_SHADER = /* wgsl */ `
${COMMON}
@group(0) @binding(0) var<uniform> lights: Lights;
@group(0) @binding(1) var depth: texture_depth_2d;
@group(0) @binding(2) var source: texture_2d<f32>;
@group(0) @binding(3) var<uniform> step: vec4f;
@group(0) @binding(4) var sun: texture_2d<f32>;

fn viewDistance(pixel: vec2i) -> f32 {
  let z = textureLoad(depth, pixel, 0);
  if (z <= 0.0) { return 1e9; }
  return length(lights.eye.xyz - worldAt(lights.inverseViewProjection, (vec2f(pixel) + 0.5) / lights.params.xy, z));
}

@fragment fn fs(in: FullscreenVaryings) -> @location(0) vec4f {
  let pixel = vec2i(in.position.xy);
  let size = vec2i(lights.params.xy);
  let d = viewDistance(pixel);
  var sum = vec2f(0.0);
  var weight = 0.0;
  if (d < 1e9) {
    for (var y = -1; y <= 1; y++) {
      for (var x = -1; x <= 1; x++) {
        let p = clamp(pixel + vec2i(x, y) * i32(step.x), vec2i(0), size - 1);
        let gap = abs(viewDistance(p) - d) / (d * 0.02);
        let w = exp(-gap * gap) * select(select(0.25, 0.5, abs(x) + abs(y) == 1), 1.0, x == 0 && y == 0);
        sum += textureLoad(source, p, 0).rg * w;
        weight += w;
      }
    }
  }
  let filtered = select(vec2f(0.0), sum / max(weight, 1e-6), weight > 0.0);
  if (step.y < 0.5) { return vec4f(filtered, 0.0, 1.0); }
  let sunSize = vec2i(textureDimensions(sun));
  let s = textureLoad(sun, min(pixel, sunSize - 1), 0).r;
  // 不带遮挡的估计接近 0（没有照得到的局部光）时比值没意义：当没被挡
  let ratio = select(1.0, saturate(filtered.x / filtered.y), filtered.y > 1e-6);
  return vec4f(s, ratio, 0.0, 1.0);
}
`;

/** 局部光的光追阴影的通道（前向渲染器持有，开关同 RayTracedShadows：合成器的 rayTracedShadows）。 */
export class RayTracedLocalLights {
  /** 合成器开着光追阴影时局部光也用光追（关了局部光照旧用阴影图集；调试命令 rtshadow 的 local）。 */
  enabled = true;
  readonly #device: GPUDevice;
  readonly #sampler: GPUSampler;
  readonly #temporal: FullscreenShader;
  readonly #blur: FullscreenShader;
  #uniforms: GPUBuffer | undefined;
  readonly #data = new Float32Array(48);
  #blurSteps: [GPUBuffer, GPUBuffer, GPUBuffer] | undefined;
  #history: [GPUTexture, GPUTexture] | undefined;
  #reservoirs: [GPUBuffer, GPUBuffer] | undefined;
  #current = 0;
  #traced: GPUTexture | undefined;
  #result: GPUTexture | undefined;
  /** 没有太阳的可见度时用的白图。 */
  #white: GPUTexture | undefined;
  readonly #previous = Matrix.identity();
  #historyValid = false;
  #frame = 0;
  #pipeline: { readonly pipeline: GPUComputePipeline; readonly layout: GPUBindGroupLayout } | Promise<unknown> | undefined;

  constructor(device: GPUDevice) {
    this.#device = device;
    this.#sampler = device.createSampler({ label: 'RayTracedLocalLights', magFilter: 'linear', minFilter: 'linear' });
    this.#temporal = new FullscreenShader(device, 'Ray traced local lights temporal', TEMPORAL_SHADER);
    this.#blur = new FullscreenShader(device, 'Ray traced local lights blur', BLUR_SHADER);
  }

  /** 这一帧能用：光追场景有东西、管线都编好了；没编时在后台开始编。 */
  ready(scene: RayTracingScene): boolean {
    if (!scene.bindGroup) return false;
    if (!this.#pipeline) {
      const creating = this.#createPipeline(scene.bindGroupLayout);
      this.#pipeline = creating;
      creating.then((ready) => (this.#pipeline = ready), (error: unknown) => console.error('Ray traced local lights: creating the pipeline failed', error));
    }
    const fullscreen = [this.#temporal.warm([FORMAT]), this.#blur.warm([FORMAT])].filter((warming) => warming !== undefined);
    return !(this.#pipeline instanceof Promise) && fullscreen.length === 0;
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
    d.set(view.inverseViewProjection, 0);
    d.set(this.#previous, 16);
    d.set([width, height, this.#frame++ % 1024, this.#historyValid ? 1 : 0], 32);
    d.set([view.eye.x, view.eye.y, view.eye.z, lightCount], 36);
    d.set(clusterParams(view), 40);
    const uniforms = (this.#uniforms ??= device.createBuffer({ label: 'RayTracedLocalLights', size: d.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }));
    device.queue.writeBuffer(uniforms, 0, d);
    this.#previous.set(view.viewProjection);
    this.#historyValid = true;

    const traced = this.#traced!;
    const reservoirs = this.#reservoirs!;
    const previousReservoirs = reservoirs[1 - this.#current]!, nextReservoirs = reservoirs[this.#current]!;
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
          { binding: 5, resource: { buffer: previousReservoirs } },
          { binding: 6, resource: { buffer: nextReservoirs } },
        ],
      }));
      pass.setBindGroup(1, scene.bindGroup!);
      pass.dispatchWorkgroups(Math.ceil(traced.width / 8), Math.ceil(traced.height / 8));
      pass.end();
    });

    const previous = this.#history![1 - this.#current]!, next = this.#history![this.#current]!;
    this.#current = 1 - this.#current;
    const accumulated = frame.graph.import({ label: 'Ray traced local lights history', width, height, format: FORMAT }, next.createView(), { texture: next });
    this.#temporal.draw(frame, accumulated, [{ buffer: uniforms }, depth, traced, previous, this.#sampler]);
    const steps = (this.#blurSteps ??= [[1, 0], [2, 0], [4, 1]].map((step) => {
      const buffer = device.createBuffer({ label: `Ray traced local lights blur ${step[0]}`, size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(buffer, 0, new Float32Array([step[0]!, step[1]!, 0, 0]));
      return buffer;
    }) as [GPUBuffer, GPUBuffer, GPUBuffer]);
    const white = (this.#white ??= this.#createWhite());
    const first = frame.acquire(width, height, FORMAT, 'Ray traced local lights blur 1');
    this.#blur.draw(frame, first, [{ buffer: uniforms }, depth, accumulated, { buffer: steps[0] }, white]);
    const second = frame.acquire(width, height, FORMAT, 'Ray traced local lights blur 2');
    this.#blur.draw(frame, second, [{ buffer: uniforms }, depth, first, { buffer: steps[1] }, white]);
    const result = this.#result!;
    const target = frame.graph.import({ label: 'Ray traced local lights', width, height, format: FORMAT }, result.createView(), { texture: result });
    this.#blur.draw(frame, target, [{ buffer: uniforms }, depth, second, { buffer: steps[2] }, sun ?? white]);
    return result;
  }

  reset(): void {
    this.#historyValid = false;
  }

  #createWhite(): GPUTexture {
    const texture = this.#device.createTexture({ label: 'RayTracedLocalLights white', size: [1, 1], format: 'r8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    this.#device.queue.writeTexture({ texture }, new Uint8Array([255]), {}, [1, 1]);
    return texture;
  }

  #resize(width: number, height: number): void {
    if (this.#result?.width === width && this.#result.height === height) return;
    for (const texture of [...(this.#history ?? []), this.#result, this.#traced]) texture?.destroy();
    for (const buffer of this.#reservoirs ?? []) buffer.destroy();
    const half: [number, number] = [Math.ceil(width / 2), Math.ceil(height / 2)];
    this.#traced = this.#device.createTexture({ label: `Ray traced local lights traced ${half[0]}x${half[1]}`, size: half, format: 'rg32float', usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING });
    const reservoir = () => this.#device.createBuffer({ label: 'Ray traced local lights reservoirs', size: half[0] * half[1] * 16, usage: GPUBufferUsage.STORAGE });
    this.#reservoirs = [reservoir(), reservoir()];
    const create = (label: string) => this.#device.createTexture({ label: `${label} ${width}x${height}`, size: [width, height], format: FORMAT, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
    this.#history = [create('Ray traced local lights history'), create('Ray traced local lights history')];
    this.#result = create('Ray traced local lights');
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
        { binding: 5, visibility: compute, buffer: { type: 'read-only-storage' } },
        { binding: 6, visibility: compute, buffer: { type: 'storage' } },
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
    for (const buffer of [...(this.#blurSteps ?? []), ...(this.#reservoirs ?? [])]) buffer.destroy();
    for (const texture of [...(this.#history ?? []), this.#result, this.#traced, this.#white]) texture?.destroy();
  }
}
