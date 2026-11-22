/**
 * 辐照度体（IrradianceVolume 组件，路线图 R2；做法同 NVIDIA RTXGI 的 DDGI 和 WickedEngine 的 DDGI）：盒子里每隔 spacing 摆一个
 * 探针，每帧从探针往四周发射线（RayTracingScene 的 rtTrace，计算着色器里遍历；方向是球面斐波那契点，每帧随机转一下），打到的
 * 表面按材质颜色乘方向光（带阴影射线）和上一轮探针的光（所以是多次反弹）、加自发光；没打到的是天空盒光和环境光。射线的结果
 * 混进每个探针的两张八面体图：
 * - 辐照度（8×8，外加一圈边）：余弦加权的平均入射光，就是辐照度 / π，和网格着色器的环境光同一个约定（直接乘漫反射色）；
 * - 距离（14×14，外加一圈边）：射线长度的均值和平方的均值，着色时按 Chebyshev 不等式估计探针看不看得到着色点（不漏光）。
 * 两张图在同一张 rgba16float 的图集里，一个探针一块 16×26（上面辐照度、下面距离；辐照度的 a 是探针用不用，距离的 b 是更新了
 * 几次）。更新写进另一张、再拷回来（同一张贴图不能一边采样一边写）。网格着色时（meshShader 的 volumeIrradiance）取周围 8 个
 * 探针，按三线性、朝向、可见性加权；盒子外一格以内淡出，回到天空盒光和环境光。
 * - 射线打到单面材质背面的超过四分之一的探针在墙里、物体里，不用（着色时权重是 0）。
 * - 每帧最多追 RAY_BUDGET 条射线：探针多的体按 z 的层轮着更新。
 * - 场景里只用第一个辐照度体。还没算进去的：点光和聚光（射线打到的表面只受方向光）、贴图的颜色（光追场景只有材质的颜色）、
 *   把墙里的探针挪出来。
 */
import { system } from '../../engine/system';
import { createCheckedShaderModule } from '../../graphics/shaderModule';
import { Transform } from '../../engine/transform';
import { IrradianceVolume } from '../components';
import { MAX_DIRECTIONAL_LIGHTS, type Lighting, type RenderContext } from '../RenderSystem';
import { rayTracingWgsl, type RayTracingScene } from './RayTracingScene';

/** 辐照度图、距离图的边长（不含边）。 */
const IRRADIANCE_TEXELS = 8;
const DISTANCE_TEXELS = 14;
/** 图集里一个探针一块：宽是距离图带边的边长，高是两张图带边的边长相加。 */
const TILE_WIDTH = DISTANCE_TEXELS + 2;
const TILE_HEIGHT = IRRADIANCE_TEXELS + 2 + DISTANCE_TEXELS + 2;
/** 一个探针最多几条射线（更新时一个工作组把一个探针的射线全放进共享内存）。 */
const MAX_RAYS = 256;
/** 每帧最多追几条射线（探针多的体按 z 的层轮着更新）。 */
const RAY_BUDGET = 1 << 18;
/** 光照或场景变了以后编辑器的视口接着出帧，让每个探针再更新几轮（hysteresis 0.97 时大约到 95%）。 */
const SETTLE_UPDATES = 100;
/** 没打到的射线记的长度。 */
const MISS_DISTANCE = 1e5;
/**
 * 参数的 uniform：体 3、帧 1、射线的旋转 3、天空的强度 1、环境光 1、天空的球谐 9、天空盒的旋转 3、方向光的方向和颜色各
 * MAX_DIRECTIONAL_LIGHTS 个（vec4）。和 RenderSystem 互相引用，用到时才算（模块加载时它还没定义）。
 */
const paramsFloats = () => (3 + 1 + 3 + 1 + 1 + 9 + 3 + MAX_DIRECTIONAL_LIGHTS * 2) * 4;

/**
 * 网格着色器和探针的射线都用的取辐照度的函数：giSample(图集, 采样器, 体, 位置, 法线, 朝着看的人的方向) 返回
 * (辐照度 / π, 盖住的程度)。体的三个 vec4 是最小角（渲染空间）、间距、各轴的探针数，w 分量各有用处、这里不读。
 */
export const IRRADIANCE_VOLUME_WGSL = /* wgsl */ `
struct GiVolume { min: vec4f, spacing: vec4f, counts: vec4f };

fn giOctEncode(d: vec3f) -> vec2f {
  let n = d / (abs(d.x) + abs(d.y) + abs(d.z));
  let s = select(vec2f(-1.0), vec2f(1.0), n.xy >= vec2f(0.0));
  return select((1.0 - abs(n.yx)) * s, n.xy, n.z >= 0.0);
}

fn giOctDecode(e: vec2f) -> vec3f {
  var n = vec3f(e, 1.0 - abs(e.x) - abs(e.y));
  let t = max(-n.z, 0.0);
  n.x += select(t, -t, n.x >= 0.0);
  n.y += select(t, -t, n.y >= 0.0);
  return normalize(n);
}

/** 探针 c 在图集里那一块的左上角（像素）。 */
fn giTile(c: vec3u, counts: vec3u) -> vec2f {
  return vec2f(f32((c.x + c.y * counts.x) * ${TILE_WIDTH}u), f32(c.z * ${TILE_HEIGHT}u));
}

/** rgb：辐照度 / π；a：盖住的程度（盒子里 1，盒子外一格以内淡出；周围的探针都不能用时 0）。 */
fn giSample(atlas: texture_2d<f32>, atlasSampler: sampler, volume: GiVolume, p: vec3f, n: vec3f, v: vec3f) -> vec4f {
  let counts = vec3u(volume.counts.xyz);
  let spacing = volume.spacing.xyz;
  let lo = volume.min.xyz;
  let hi = lo + spacing * vec3f(counts - 1u);
  let outside = max(max(lo - p, p - hi), vec3f(0.0)) / spacing;
  let coverage = saturate(1.0 - max(outside.x, max(outside.y, outside.z)));
  if (coverage <= 0.0) { return vec4f(0.0); }
  let size = vec2f(textureDimensions(atlas));
  // 着色点往法线和看的人那边挪一点再算可见性：正好在表面上时一半探针被表面自己挡住
  let biased = p + (n * 0.2 + v * 0.8) * (0.25 * min(spacing.x, min(spacing.y, spacing.z)));
  let cell = clamp(floor((biased - lo) / spacing), vec3f(0.0), vec3f(counts) - 2.0);
  let alpha = saturate((biased - (lo + cell * spacing)) / spacing);
  let irradianceUv = (giOctEncode(n) * 0.5 + 0.5) * ${IRRADIANCE_TEXELS}.0 + 1.0;
  var sum = vec3f(0.0);
  var total = 0.0;
  for (var i = 0u; i < 8u; i++) {
    let offset = vec3u(i, i >> 1u, i >> 2u) & vec3u(1u);
    let c = min(vec3u(cell) + offset, counts - 1u);
    let tile = giTile(c, counts);
    // 墙里的探针不用（辐照度的 a 是 0）
    if (textureLoad(atlas, vec2u(tile) + vec2u(1u), 0).a < 0.5) { continue; }
    let probe = lo + vec3f(c) * spacing;
    // 背对的探针权重小（绕一圈的余弦，不到 0：小物件周围的探针可能都在背面）
    let wrap = (dot(normalize(probe - p), n) + 1.0) * 0.5;
    var weight = wrap * wrap + 0.2;
    let fromProbe = biased - probe;
    let distance = length(fromProbe);
    let distanceUv = tile + vec2f(1.0, ${IRRADIANCE_TEXELS + 3}.0) + (giOctEncode(fromProbe / max(distance, 1e-4)) * 0.5 + 0.5) * ${DISTANCE_TEXELS}.0;
    let moments = textureSampleLevel(atlas, atlasSampler, distanceUv / size, 0.0).xy;
    if (distance > moments.x) {
      let variance = abs(moments.x * moments.x - moments.y);
      let d = distance - moments.x;
      let chebyshev = variance / (variance + d * d);
      weight *= max(chebyshev * chebyshev * chebyshev, 0.05);
    }
    weight = max(weight, 1e-6);
    // 很小的权重压得更小（人眼对暗处的一点光很敏感），曲线连续
    if (weight < 0.2) { weight *= weight * weight / 0.04; }
    let t = mix(1.0 - alpha, alpha, vec3f(offset));
    weight *= t.x * t.y * t.z;
    sum += textureSampleLevel(atlas, atlasSampler, (tile + irradianceUv) / size, 0.0).rgb * weight;
    total += weight;
  }
  if (total <= 0.0) { return vec4f(0.0); }
  return vec4f(sum / total, coverage);
}
`;

const common = () => /* wgsl */ `
${IRRADIANCE_VOLUME_WGSL}
struct Params {
  // 体：最小角和射线最远记多长、间距和留下旧值的比例、各轴的探针数和每个探针的射线数
  volume: GiVolume,
  // 这一帧从第几个探针开始、更新几个、方向光几个
  frame: vec4u,
  // 射线方向的随机旋转（三行）
  rotation: array<vec4f, 3>,
  // 天空盒光的强度
  sky: vec4f,
  ambient: vec4f,
  skySH: array<vec4f, 9>,
  skyRotation: array<vec4f, 3>,
  lightDirections: array<vec4f, ${MAX_DIRECTIONAL_LIGHTS}>,
  lightColors: array<vec4f, ${MAX_DIRECTIONAL_LIGHTS}>,
};
@group(0) @binding(0) var<uniform> params: Params;

fn probeCount() -> u32 {
  let counts = vec3u(params.volume.counts.xyz);
  return counts.x * counts.y * counts.z;
}

fn probeCoordinate(index: u32) -> vec3u {
  let counts = vec3u(params.volume.counts.xyz);
  return vec3u(index % counts.x, (index / counts.x) % counts.y, index / (counts.x * counts.y));
}

/** 第 ray 条射线的方向：球面斐波那契点，乘这一帧的随机旋转。 */
fn rayDirection(ray: u32, count: u32) -> vec3f {
  let phi = 6.283185307 * fract(f32(ray) * 0.618033988749);
  let cosTheta = 1.0 - (2.0 * f32(ray) + 1.0) / f32(count);
  let sinTheta = sqrt(saturate(1.0 - cosTheta * cosTheta));
  let d = vec3f(cos(phi) * sinTheta, sin(phi) * sinTheta, cosTheta);
  return vec3f(dot(params.rotation[0].xyz, d), dot(params.rotation[1].xyz, d), dot(params.rotation[2].xyz, d));
}
`;

const traceShader = () => /* wgsl */ `
${common()}
@group(0) @binding(1) var atlas: texture_2d<f32>;
@group(0) @binding(2) var linearClamp: sampler;
@group(0) @binding(3) var<storage, read_write> rays: array<vec4f>;
// 遍历的统计（调试命令 gi 报）：被截断的遍历数（光追场景的数据坏了才有）、一次遍历最多走了几步
@group(0) @binding(4) var<storage, read_write> traversal: array<atomic<u32>, 2>;
${rayTracingWgsl(1)}

/** 天空盒光（球谐，同网格着色器的 evaluateSH 和 skyDirection）加环境光：没打到的射线、盒子外面的表面用。 */
fn skyLight(direction: vec3f) -> vec3f {
  let r = direction * mat3x3f(params.skyRotation[0].xyz, params.skyRotation[1].xyz, params.skyRotation[2].xyz);
  let d = vec3f(r.xy, -r.z);
  var c = params.skySH[0].rgb;
  c += params.skySH[1].rgb * d.y;
  c += params.skySH[2].rgb * d.z;
  c += params.skySH[3].rgb * d.x;
  c += params.skySH[4].rgb * d.y * d.x;
  c += params.skySH[5].rgb * d.y * d.z;
  c += params.skySH[6].rgb * (3.0 * d.z * d.z - 1.0);
  c += params.skySH[7].rgb * d.x * d.z;
  c += params.skySH[8].rgb * (d.x * d.x - d.y * d.y);
  return params.ambient.rgb + max(c, vec3f(0.0)) * params.sky.x;
}

@compute @workgroup_size(64) fn trace(@builtin(global_invocation_id) id: vec3u) {
  let rayCount = u32(params.volume.counts.w);
  if (id.x >= params.frame.y * rayCount) { return; }
  let probe = (params.frame.x + id.x / rayCount) % probeCount();
  let origin = params.volume.min.xyz + vec3f(probeCoordinate(probe)) * params.volume.spacing.xyz;
  let dir = rayDirection(id.x % rayCount, rayCount);
  let hit = rtTrace(origin, dir, ${MISS_DISTANCE});
  if (hit.capped) { atomicAdd(&traversal[0], 1u); }
  atomicMax(&traversal[1], hit.steps);
  if (hit.instance == 0xffffffffu) {
    rays[id.x] = vec4f(skyLight(dir), ${MISS_DISTANCE});
    return;
  }
  // 打到背面：探针多半在墙里；长度记成负的（更新时数背面、距离图按缩短的长度记，着色时看不到墙另一边）
  if (rtBackFace(hit, dir)) {
    rays[id.x] = vec4f(0.0, 0.0, 0.0, -0.2 * hit.t);
    return;
  }
  let n = rtNormal(hit, dir);
  let p = origin + dir * hit.t;
  var light = vec3f(0.0);
  for (var i = 0u; i < params.frame.z; i++) {
    let l = -params.lightDirections[i].xyz;
    let nDotL = dot(n, l);
    if (nDotL <= 0.0) { continue; }
    let shadow = rtTrace(p + n * 1e-3, l, ${MISS_DISTANCE});
    if (shadow.capped) { atomicAdd(&traversal[0], 1u); }
    atomicMax(&traversal[1], shadow.steps);
    if (shadow.instance != 0xffffffffu) { continue; }
    light += params.lightColors[i].rgb * nDotL;
  }
  // 上一轮的探针给的间接光（多次反弹）；盒子外面的表面受天空盒光
  let indirect = giSample(atlas, linearClamp, params.volume, p, n, -dir);
  light += mix(skyLight(n), indirect.rgb, indirect.a);
  rays[id.x] = vec4f(rtAlbedo(hit) * light + rtEmissive(hit), hit.t);
}
`;

const updateShader = () => /* wgsl */ `
${common()}
@group(0) @binding(1) var atlas: texture_2d<f32>;
@group(0) @binding(2) var<storage, read> rays: array<vec4f>;
@group(0) @binding(3) var nextAtlas: texture_storage_2d<rgba16float, write>;

var<workgroup> rayLight: array<vec4f, ${MAX_RAYS}>;
var<workgroup> rayDirections: array<vec4f, ${MAX_RAYS}>;

/** 带边的八面体图上的纹素（0..n+1）对应的里面的纹素（1..n）：边上的抄八面体展开后挨着的那一个，图双线性采样时没有缝。 */
fn interiorTexel(t: vec2i, n: i32) -> vec2i {
  var r = t;
  if (r.x == 0 || r.x == n + 1) { r = vec2i(select(n, 1, r.x == 0), n + 1 - r.y); }
  if (r.y == 0 || r.y == n + 1) { r = vec2i(n + 1 - r.x, select(n, 1, r.y == 0)); }
  return r;
}

fn texelDirection(t: vec2i, n: i32) -> vec3f {
  return giOctDecode((vec2f(interiorTexel(t, n) - 1) + 0.5) / f32(n) * 2.0 - 1.0);
}

/** 一个工作组更新一个探针：16×16 个线程每个算距离图的一个纹素，前 10×10 个还算辐照度图的一个。 */
@compute @workgroup_size(${TILE_WIDTH}, ${TILE_WIDTH}) fn update(@builtin(local_invocation_id) local: vec3u, @builtin(local_invocation_index) index: u32, @builtin(workgroup_id) workgroupId: vec3u) {
  let rayCount = u32(params.volume.counts.w);
  for (var r = index; r < rayCount; r += ${TILE_WIDTH * TILE_WIDTH}u) {
    rayLight[r] = rays[workgroupId.x * rayCount + r];
    rayDirections[r] = vec4f(rayDirection(r, rayCount), 0.0);
  }
  workgroupBarrier();
  let probe = (params.frame.x + workgroupId.x) % probeCount();
  let tile = vec2i(giTile(probeCoordinate(probe), vec3u(params.volume.counts.xyz)));
  let distanceTile = tile + vec2i(0, ${IRRADIANCE_TEXELS + 2});
  // 更新过几次（距离图的 b）：头几次按平均混（新探针很快有值），以后留下 hysteresis 的旧值
  let updates = textureLoad(atlas, distanceTile + vec2i(1), 0).b;
  let hysteresis = min(params.volume.spacing.w, updates / (updates + 1.0));
  let maxDistance = params.volume.min.w;

  let distanceTexel = distanceTile + vec2i(local.xy);
  let toward = texelDirection(vec2i(local.xy), ${DISTANCE_TEXELS});
  var moments = vec2f(0.0);
  var weights = 0.0;
  for (var r = 0u; r < rayCount; r++) {
    let c = dot(toward, rayDirections[r].xyz);
    if (c <= 0.0) { continue; }
    let w = pow(c, 50.0);
    let d = min(abs(rayLight[r].w), maxDistance);
    moments += w * vec2f(d, d * d);
    weights += w;
  }
  let previousMoments = textureLoad(atlas, distanceTexel, 0).xy;
  let newMoments = select(moments / weights, previousMoments, weights <= 0.0);
  textureStore(nextAtlas, distanceTexel, vec4f(mix(newMoments, previousMoments, hysteresis), updates + 1.0, 0.0));

  if (local.x >= ${IRRADIANCE_TEXELS + 2}u || local.y >= ${IRRADIANCE_TEXELS + 2}u) { return; }
  let irradianceTexel = tile + vec2i(local.xy);
  let normal = texelDirection(vec2i(local.xy), ${IRRADIANCE_TEXELS});
  var sum = vec3f(0.0);
  var total = 0.0;
  var backfaces = 0u;
  for (var r = 0u; r < rayCount; r++) {
    let ray = rayLight[r];
    if (ray.w < 0.0) {
      backfaces++;
      continue;
    }
    let w = max(dot(normal, rayDirections[r].xyz), 0.0);
    sum += w * ray.rgb;
    total += w;
  }
  let previous = textureLoad(atlas, irradianceTexel, 0).rgb;
  let irradiance = select(sum / total, vec3f(0.0), total <= 0.0);
  // 一下子变了很多（开关灯、挪走了遮挡）：少留些旧的，跟得快
  let ratio = (max(irradiance.r, max(irradiance.g, irradiance.b)) + 0.01) / (max(previous.r, max(previous.g, previous.b)) + 0.01);
  let h = select(hysteresis, max(hysteresis - 0.15, 0.0), ratio > 2.5 || ratio < 0.4);
  let usable = select(0.0, 1.0, f32(backfaces) < 0.25 * f32(rayCount));
  textureStore(nextAtlas, irradianceTexel, vec4f(mix(irradiance, previous, h), usable));
}
`;

/** 用着的那个体（渲染空间；盒子、间距、射线数变了就从头算）。 */
interface VolumeState {
  readonly key: string;
  readonly min: readonly [number, number, number];
  readonly spacing: readonly [number, number, number];
  readonly counts: readonly [number, number, number];
  readonly rays: number;
  hysteresis: number;
  intensity: number;
}

/** 场景里的辐照度体（RenderSystem.irradianceVolumes）：前向渲染器每帧 begin（找体、分配）、draw（追射线、更新探针）。 */
export class IrradianceVolumes {
  /** 关了就不追射线，网格着色回到天空盒光和环境光（调试命令 gi 开关）。 */
  enabled = true;
  #active = false;
  readonly #device: GPUDevice;
  readonly #linear: GPUSampler;
  #state: VolumeState | undefined;
  #found: VolumeState | undefined;
  #atlas: GPUTexture;
  #scratch: GPUTexture | undefined;
  #rays: GPUBuffer | undefined;
  readonly #params: GPUBuffer;
  /** 遍历的统计：被截断的遍历数（累计）、最多的步数，两个 u32。 */
  readonly #traversal: GPUBuffer;
  readonly #paramData = new Float32Array(paramsFloats());
  #pipelines: { readonly trace: GPUComputePipeline; readonly update: GPUComputePipeline } | undefined;
  #nextProbe = 0;
  #random = 0x2545f491;
  /** 编辑器按需出帧时还要接着出几帧（探针收敛）：新建了体、光照或场景变了以后。 */
  #settling = 0;
  #inputsKey = '';
  /** 图集换了就加一（网格的视图绑定组跟着重建）。 */
  generation = 0;
  /** 这一帧更新了几个探针、追了几条射线（统计）。 */
  readonly stats = { probes: 0, updatedProbes: 0, rays: 0 };

  constructor(device: GPUDevice, linear: GPUSampler) {
    this.#device = device;
    this.#linear = linear;
    this.#atlas = this.#createAtlas(1, 1);
    this.#traversal = device.createBuffer({ label: 'IrradianceVolume traversal stats', size: 8, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    this.#params = device.createBuffer({ label: 'IrradianceVolume params', size: paramsFloats() * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  }

  /** 这一帧在用（开着、设备和画质允许、场景里有体）。 */
  get active(): boolean {
    return this.#active && this.#state !== undefined;
  }

  /** 网格着色用的图集（没有体时是 1×1 的空图）。 */
  get atlas(): GPUTexture {
    return this.#atlas;
  }

  /** 网格着色器的三个 vec4（最小角和用不用、间距和强度、探针数）；没有体时用不用的那一位是 0。 */
  shading(): readonly number[] {
    const state = this.#state;
    if (!state || !this.#active) return [0, 0, 0, 0, 1, 1, 1, 0, 2, 2, 2, 0];
    return [...state.min, 1, ...state.spacing, state.intensity, ...state.counts, 0];
  }

  readonly #collect = system('IrradianceVolumes.collect', {
    with: { volume: IrradianceVolume, transform: Transform },
    update: ({ volume, transform, count }) => {
      if (count === 0 || this.#found) return;
      const w = transform.slot[0]! * 16, world = transform.renderWorld;
      const center = [world[w + 12]!, world[w + 13]!, world[w + 14]!];
      const spacing = Math.max(volume.spacing[0]!, 0.1);
      const size = [0, 1, 2].map((axis) => Math.hypot(world[w + axis * 4]!, world[w + axis * 4 + 1]!, world[w + axis * 4 + 2]!) * volume.size[axis]!);
      const counts = size.map((s) => Math.max(2, Math.round(s / spacing) + 1)) as [number, number, number];
      const step = size.map((s, axis) => s / (counts[axis]! - 1)) as [number, number, number];
      const min = center.map((c, axis) => c - size[axis]! / 2) as [number, number, number];
      const rays = Math.min(MAX_RAYS, Math.max(16, Math.round(volume.rays[0]!)));
      this.#found = { key: [...min, ...step, ...counts, rays].join(), min, spacing: step, counts, rays, hysteresis: volume.hysteresis[0]!, intensity: volume.intensity[0]! };
    },
  });

  /** 找这一帧的体（前向渲染器在写视图的常量之前调，allowed：设备放得下图集的绑定、画质开着全局光照）；用到时更新光追场景。 */
  begin(context: RenderContext, rayTracing: RayTracingScene, allowed: boolean): void {
    this.#found = undefined;
    this.#active = this.enabled && allowed;
    if (this.#active) context.game.entities.run(this.#collect, context.time);
    // 系统在 run 里写 #found（TS 看不出来，按 undefined 收窄了）
    const found = this.#found as VolumeState | undefined;
    if (!found) {
      if (this.#state) this.#release();
      return;
    }
    if (this.#state?.key !== found.key) this.#allocate(found);
    if (!this.#state) return;
    this.#state.hysteresis = found.hysteresis;
    this.#state.intensity = found.intensity;
    rayTracing.update(context.game);
    // 光照或者场景变了：按需出帧的编辑器视口接着出帧，直到探针跟上（大约 SETTLE_UPDATES 轮）
    const lighting = context.game.renderSystem.lighting;
    const lights = lighting.directionals.slice(0, lighting.directionalCount).map((light) => [light.direction.x, light.direction.y, light.direction.z, light.color.r, light.color.g, light.color.b].join());
    const key = [rayTracing.version, lighting.skybox?.intensity, lighting.ambient.r, lighting.ambient.g, lighting.ambient.b, ...lights].join(';');
    if (key !== this.#inputsKey) {
      this.#inputsKey = key;
      const [cx, cy, cz] = this.#state.counts;
      this.#settling = SETTLE_UPDATES * Math.ceil(cz / this.#layersPerFrame(cx * cy, cz, this.#state.rays));
    }
    if (this.#settling > 0) {
      this.#settling--;
      context.game.requestFrames(1);
    }
  }

  #layersPerFrame(layer: number, layers: number, rays: number): number {
    return Math.max(1, Math.min(layers, Math.floor(RAY_BUDGET / (layer * rays))));
  }

  /** 追这一帧的射线、更新探针（录进 encoder；光追场景还没有能遍历的东西时不做）。 */
  draw(encoder: GPUCommandEncoder, lighting: Lighting, rayTracing: RayTracingScene, timestampWrites?: GPUComputePassTimestampWrites): void {
    const state = this.#state;
    const scene = rayTracing.bindGroup;
    if (!state || !scene || !this.#scratch || !this.#rays) return;
    const device = this.#device;
    const pipelines = (this.#pipelines ??= this.#createPipelines(rayTracing.bindGroupLayout));
    const [cx, cy, cz] = state.counts;
    const layer = cx * cy;
    const layers = this.#layersPerFrame(layer, cz, state.rays);
    const firstLayer = this.#nextProbe;
    this.#nextProbe = (firstLayer + layers) % cz;
    const probes = layers * layer;
    this.#writeParams(state, firstLayer * layer, probes, lighting);
    this.stats.updatedProbes = probes;
    this.stats.rays = probes * state.rays;

    const pass = encoder.beginComputePass({ label: 'IrradianceVolume', ...(timestampWrites ? { timestampWrites } : {}) });
    pass.setPipeline(pipelines.trace);
    pass.setBindGroup(0, device.createBindGroup({
      layout: pipelines.trace.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.#params } },
        { binding: 1, resource: this.#atlas.createView() },
        { binding: 2, resource: this.#linear },
        { binding: 3, resource: { buffer: this.#rays } },
        { binding: 4, resource: { buffer: this.#traversal } },
      ],
    }));
    pass.setBindGroup(1, scene);
    pass.dispatchWorkgroups(Math.ceil((probes * state.rays) / 64));
    pass.setPipeline(pipelines.update);
    pass.setBindGroup(0, device.createBindGroup({
      layout: pipelines.update.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.#params } },
        { binding: 1, resource: this.#atlas.createView() },
        { binding: 2, resource: { buffer: this.#rays } },
        { binding: 3, resource: this.#scratch.createView() },
      ],
    }));
    pass.dispatchWorkgroups(probes);
    pass.end();
    // 更新过的那几层（图集里是连着的几行块，绕回开头时分两段）拷回网格采样的那张
    const width = layer * TILE_WIDTH;
    const copy = (from: number, count: number) => encoder.copyTextureToTexture({ texture: this.#scratch!, origin: [0, from * TILE_HEIGHT] }, { texture: this.#atlas, origin: [0, from * TILE_HEIGHT] }, [width, count * TILE_HEIGHT]);
    const first = Math.min(layers, cz - firstLayer);
    copy(firstLayer, first);
    if (first < layers) copy(0, layers - first);
  }

  #writeParams(state: VolumeState, firstProbe: number, probes: number, lighting: Lighting): void {
    const data = this.#paramData, words = new Uint32Array(data.buffer);
    const maxDistance = 1.5 * Math.hypot(...state.spacing);
    data.set([...state.min, maxDistance, ...state.spacing, state.hysteresis, ...state.counts, state.rays], 0);
    words.set([firstProbe, probes, lighting.directionalCount, 0], 12);
    data.set(this.#randomRotation(), 16);
    const skybox = lighting.skybox;
    data.set([skybox?.intensity ?? 0, 0, 0, 0], 28);
    data.set([lighting.ambient.r, lighting.ambient.g, lighting.ambient.b, 0], 32);
    const sh = skybox?.skybox.diffuseSH;
    for (let c = 0; c < 9; c++) data.set(sh ? [sh[c * 3]!, sh[c * 3 + 1]!, sh[c * 3 + 2]!, 0] : [0, 0, 0, 0], 36 + c * 4);
    const rotation = skybox?.rotation;
    for (let r = 0; r < 3; r++) data.set(rotation ? [rotation[r * 4]!, rotation[r * 4 + 1]!, rotation[r * 4 + 2]!, 0] : [r === 0 ? 1 : 0, r === 1 ? 1 : 0, r === 2 ? 1 : 0, 0], 72 + r * 4);
    for (let i = 0; i < MAX_DIRECTIONAL_LIGHTS; i++) {
      const light = lighting.directionals[i]!;
      const { x, y, z } = light.direction;
      const length = Math.hypot(x, y, z) || 1;
      data.set(i < lighting.directionalCount ? [x / length, y / length, z / length, 0] : [0, -1, 0, 0], 84 + i * 4);
      data.set(i < lighting.directionalCount ? [light.color.r, light.color.g, light.color.b, 0] : [0, 0, 0, 0], 84 + MAX_DIRECTIONAL_LIGHTS * 4 + i * 4);
    }
    this.#device.queue.writeBuffer(this.#params, 0, data);
  }

  /** 均匀分布的随机旋转（Shoemake 的随机四元数）的三行；种子固定，同样的帧序列出同样的结果（离线渲染可重复）。 */
  #randomRotation(): number[] {
    const next = () => {
      this.#random ^= this.#random << 13;
      this.#random ^= this.#random >>> 17;
      this.#random ^= this.#random << 5;
      return (this.#random >>> 0) / 4294967296;
    };
    const u1 = next(), u2 = next() * 2 * Math.PI, u3 = next() * 2 * Math.PI;
    const a = Math.sqrt(1 - u1), b = Math.sqrt(u1);
    const x = a * Math.sin(u2), y = a * Math.cos(u2), z = b * Math.sin(u3), w = b * Math.cos(u3);
    return [
      1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w), 0,
      2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w), 0,
      2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y), 0,
    ];
  }

  #allocate(state: VolumeState): void {
    this.#release();
    const [cx, cy, cz] = state.counts;
    const width = cx * cy * TILE_WIDTH, height = cz * TILE_HEIGHT;
    const limit = this.#device.limits.maxTextureDimension2D;
    if (width > limit || height > limit) {
      console.warn(`IrradianceVolume: ${cx}×${cy}×${cz} probes need a ${width}×${height} atlas, over the device limit ${limit}; use a larger spacing`);
      return;
    }
    this.#state = state;
    this.#atlas.destroy();
    this.#atlas = this.#createAtlas(width, height);
    this.#scratch = this.#device.createTexture({ label: 'IrradianceVolume scratch', size: [width, height], format: 'rgba16float', usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC });
    const perFrame = this.#layersPerFrame(cx * cy, cz, state.rays) * cx * cy;
    this.#rays = this.#device.createBuffer({ label: 'IrradianceVolume rays', size: perFrame * state.rays * 16, usage: GPUBufferUsage.STORAGE });
    this.#nextProbe = 0;
    this.stats.probes = cx * cy * cz;
    this.generation++;
  }

  #release(): void {
    if (!this.#state) return;
    this.#state = undefined;
    this.#scratch?.destroy();
    this.#rays?.destroy();
    this.#scratch = this.#rays = undefined;
    this.#atlas.destroy();
    this.#atlas = this.#createAtlas(1, 1);
    this.stats.probes = this.stats.updatedProbes = this.stats.rays = 0;
    this.generation++;
  }

  #createAtlas(width: number, height: number): GPUTexture {
    return this.#device.createTexture({ label: 'IrradianceVolume atlas', size: [width, height], format: 'rgba16float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC });
  }

  #createPipelines(scene: GPUBindGroupLayout): { trace: GPUComputePipeline; update: GPUComputePipeline } {
    const device = this.#device;
    const traceLayout = device.createBindGroupLayout({
      label: 'IrradianceVolume trace',
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: {} },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: {} },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, sampler: {} },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      ],
    });
    const trace = device.createComputePipeline({
      label: 'IrradianceVolume trace',
      layout: device.createPipelineLayout({ bindGroupLayouts: [traceLayout, scene] }),
      compute: { module: createCheckedShaderModule(device, 'IrradianceVolume trace', traceShader()), entryPoint: 'trace' },
    });
    const update = device.createComputePipeline({
      label: 'IrradianceVolume update',
      layout: 'auto',
      compute: { module: createCheckedShaderModule(device, 'IrradianceVolume update', updateShader()), entryPoint: 'update' },
    });
    return { trace, update };
  }

  /**
   * 光追遍历的统计（读回要等 GPU）：到现在为止被截断的遍历有几次（应该是 0；不是 0 说明 BVH 坏了或者遍历有问题）、一次遍历里最多的
   * 一个循环走了几步。
   */
  async traversalStats(): Promise<{ capped: number; maxSteps: number }> {
    const readback = this.#device.createBuffer({ size: 8, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const encoder = this.#device.createCommandEncoder({ label: 'IrradianceVolume traversal stats readback' });
    encoder.copyBufferToBuffer(this.#traversal, 0, readback, 0, 8);
    this.#device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const [capped, maxSteps] = new Uint32Array(readback.getMappedRange());
    readback.destroy();
    return { capped: capped!, maxSteps: maxSteps! };
  }

  destroy(): void {
    this.#release();
    this.#atlas.destroy();
    this.#params.destroy();
    this.#traversal.destroy();
  }
}
