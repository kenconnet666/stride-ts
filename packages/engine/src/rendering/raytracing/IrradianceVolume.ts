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
 * - 每帧追多少条射线按测出来的 GPU 时间调（组件的 budget 毫秒；设备没有时间戳查询时固定 DEFAULT_RAYS 条）：探针多的体按 z 的层
 *   轮着更新；悬在空中（附近没有几何）和埋在东西里的探针隔
 *   FAR_UPDATE_INTERVAL 轮才更新一次（大世界里跟着相机走的体上半截悬空、下半截在地下，它们几乎不被着色点取到）。
 * - 打到的表面的颜色是烘好的材质平均色（SurfaceColors），受方向光、点光、聚光（面光源当一个点）照，都带阴影射线。
 * - followCamera 的体跟着主相机走（大世界）：盒子按间距对齐到相机周围，探针在图集里按世界的格号取模放，相机挪了只有新进盒子的
 *   那几层探针清掉重来（RESET_SHADER），别的接着用。
 * - 场景里只用第一个辐照度体。还没做的：把墙里的探针挪出来、几级不同间距的体（近密远疏）。
 */
import { system } from '../../engine/system';
import { createCheckedShaderModule } from '../../graphics/shaderModule';
import { Transform } from '../../engine/transform';
import { IrradianceVolume } from '../components';
import type { RenderContext } from '../RenderSystem';
import { rayTracingWgsl, type RayTracingScene } from './RayTracingScene';
import { rayTracedLightingWgsl } from './RayTracedLighting';

/** 辐照度图、距离图的边长（不含边）。 */
const IRRADIANCE_TEXELS = 8;
const DISTANCE_TEXELS = 14;
/** 图集里一个探针一块：宽是距离图带边的边长，高是两张图带边的边长相加。 */
const TILE_WIDTH = DISTANCE_TEXELS + 2;
const TILE_HEIGHT = IRRADIANCE_TEXELS + 2 + DISTANCE_TEXELS + 2;
/** 一个探针最多几条射线（更新时一个工作组把一个探针的射线全放进共享内存）。 */
const MAX_RAYS = 256;
/** 悬在空中、埋在东西里的探针隔几轮更新一次。 */
const FAR_UPDATE_INTERVAL = 8;
/** 每帧追几条射线的起点（测出 GPU 时间以前，或者设备没有时间戳查询时）和上下限。 */
const DEFAULT_RAYS = 1 << 18;
const MIN_RAYS = 1 << 13;
const MAX_RAYS_PER_FRAME = 1 << 21;
/** 光照或场景变了以后编辑器的视口接着出帧，让每个探针再更新几轮（hysteresis 0.97 时大约到 95%）。 */
const SETTLE_UPDATES = 100;
/** 没打到的射线记的长度。 */
const MISS_DISTANCE = 1e5;
/** 参数的 uniform：体 4、帧 1、射线的旋转 3（vec4）。光照在 RayTracingScene.lighting 里。 */
const PARAMS_FLOATS = (4 + 1 + 3) * 4;

/**
 * 网格着色器和探针的射线都用的取辐照度的函数：giSample(图集, 采样器, 体, 位置, 法线, 朝着看的人的方向) 返回
 * (辐照度 / π, 盖住的程度)。体的四个 vec4 是最小角（渲染空间）、间距、各轴的探针数、卷动（跟着相机走的体：探针在图集里按世界的
 * 格号对各轴的探针数取模放，xyz 是最小角那个探针放在哪一格），w 分量各有用处、这里不读。
 */
export const IRRADIANCE_VOLUME_WGSL = /* wgsl */ `
struct GiVolume { min: vec4f, spacing: vec4f, counts: vec4f, scroll: vec4f };

/** 体里第 c 个探针（按位置数）在图集里的格（卷动过的）。 */
fn giStored(c: vec3u, volume: GiVolume) -> vec3u {
  let counts = vec3u(volume.counts.xyz);
  return (c + vec3u(volume.scroll.xyz)) % counts;
}

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
    let tile = giTile(giStored(c, volume), counts);
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
  // 体：最小角和射线最远记多长、间距和留下旧值的比例、各轴的探针数和每个探针的射线数、卷动
  volume: GiVolume,
  // 这一帧从第几个探针开始、更新几个
  frame: vec4u,
  // 射线方向的随机旋转（三行）
  rotation: array<vec4f, 3>,
};
@group(0) @binding(0) var<uniform> params: Params;

fn probeCount() -> u32 {
  let counts = vec3u(params.volume.counts.xyz);
  return counts.x * counts.y * counts.z;
}

/** 图集里第 index 格（按格数）的格坐标。 */
fn probeCoordinate(index: u32) -> vec3u {
  let counts = vec3u(params.volume.counts.xyz);
  return vec3u(index % counts.x, (index / counts.x) % counts.y, index / (counts.x * counts.y));
}

/** 图集的格坐标对应的探针的位置（渲染空间；跟着相机走的体卷动过）。 */
fn probePosition(stored: vec3u) -> vec3f {
  let counts = vec3u(params.volume.counts.xyz);
  let c = (stored + counts - vec3u(params.volume.scroll.xyz)) % counts;
  return params.volume.min.xyz + vec3f(c) * params.volume.spacing.xyz;
}

/**
 * 用不上的探针只每 ${FAR_UPDATE_INTERVAL} 轮更新一次：悬在空中的（上次更新时没有一条射线在 maxDistance 以内打到东西，距离图的 a 是 1）
 * 和埋在东西里的（更新过、打到背面的太多，辐照度的 a 是 0；大世界里跟着相机走的体下半截在地下）。这一轮不更新时 true（追射线、
 * 更新都跳过，图集里留着旧值）。轮数在 volume.scroll.w。
 */
fn probeSkipped(probe: u32) -> bool {
  let tile = vec2i(giTile(probeCoordinate(probe), vec3u(params.volume.counts.xyz)));
  let distance = textureLoad(atlas, tile + vec2i(1, ${IRRADIANCE_TEXELS + 3}), 0);
  let far = distance.a > 0.5;
  let buried = distance.b > 0.0 && textureLoad(atlas, tile + vec2i(1), 0).a < 0.5;
  return (far || buried) && (probe + u32(params.volume.scroll.w)) % ${FAR_UPDATE_INTERVAL}u != 0u;
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
${rayTracedLightingWgsl(0, 6, 5)}

@compute @workgroup_size(64) fn trace(@builtin(global_invocation_id) id: vec3u) {
  let rayCount = u32(params.volume.counts.w);
  if (id.x >= params.frame.y * rayCount) { return; }
  let probe = (params.frame.x + id.x / rayCount) % probeCount();
  if (probeSkipped(probe)) { return; }
  let origin = probePosition(probeCoordinate(probe));
  let dir = rayDirection(id.x % rayCount, rayCount);
  let hit = rtTrace(origin, dir, ${MISS_DISTANCE});
  if (hit.capped) { atomicAdd(&traversal[0], 1u); }
  atomicMax(&traversal[1], hit.steps);
  if (hit.instance == 0xffffffffu) {
    rays[id.x] = vec4f(rtSkyLight(dir), ${MISS_DISTANCE});
    return;
  }
  // 打到背面：探针多半在墙里；长度记成负的（更新时数背面、距离图按缩短的长度记，着色时看不到墙另一边）
  if (rtBackFace(hit, dir)) {
    rays[id.x] = vec4f(0.0, 0.0, 0.0, -0.2 * hit.t);
    return;
  }
  let n = rtNormal(hit, dir);
  let p = origin + dir * hit.t;
  var light = rtDirectLight(p, n);
  // 上一轮的探针给的间接光（多次反弹）；盒子外面的表面受天空盒光
  let indirect = giSample(atlas, linearClamp, params.volume, p, n, -dir);
  light += mix(rtSkyLight(n), indirect.rgb, indirect.a);
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
  // 这一轮不更新的（悬在空中的）：照抄旧值（只拷更新了的那几行块，这一块也在里面）
  if (probeSkipped(probe)) {
    let texel = distanceTile + vec2i(local.xy);
    textureStore(nextAtlas, texel, textureLoad(atlas, texel, 0));
    if (local.x < ${IRRADIANCE_TEXELS + 2}u && local.y < ${IRRADIANCE_TEXELS + 2}u) {
      textureStore(nextAtlas, tile + vec2i(local.xy), textureLoad(atlas, tile + vec2i(local.xy), 0));
    }
    return;
  }
  // 更新过几次（距离图的 b）：头几次按平均混（新探针很快有值），以后留下 hysteresis 的旧值
  let updates = textureLoad(atlas, distanceTile + vec2i(1), 0).b;
  let hysteresis = min(params.volume.spacing.w, updates / (updates + 1.0));
  let maxDistance = params.volume.min.w;

  let distanceTexel = distanceTile + vec2i(local.xy);
  let toward = texelDirection(vec2i(local.xy), ${DISTANCE_TEXELS});
  var moments = vec2f(0.0);
  var weights = 0.0;
  // 附近有没有几何（背面也算：探针在东西里面）
  var near = false;
  for (var r = 0u; r < rayCount; r++) {
    near = near || rayLight[r].w < maxDistance;
    let c = dot(toward, rayDirections[r].xyz);
    if (c <= 0.0) { continue; }
    let w = pow(c, 50.0);
    let d = min(abs(rayLight[r].w), maxDistance);
    moments += w * vec2f(d, d * d);
    weights += w;
  }
  let previousMoments = textureLoad(atlas, distanceTexel, 0).xy;
  let newMoments = select(moments / weights, previousMoments, weights <= 0.0);
  textureStore(nextAtlas, distanceTexel, vec4f(mix(newMoments, previousMoments, hysteresis), updates + 1.0, select(1.0, 0.0, near)));

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

/**
 * 跟着相机走的体挪了以后清掉新进盒子的探针（写零：辐照度的 a 是 0 = 不用、更新次数 0 = 下次直接取新值）。一个工作组一个探针，
 * 16 × 13 个线程每个清两个纹素（一块 16 × 26）。shift 是各轴挪了几格，w 不是 0 时全清。
 */
const RESET_SHADER = /* wgsl */ `
struct Reset { counts: vec4u, scroll: vec4u, shift: vec4i };
@group(0) @binding(0) var<uniform> reset: Reset;
@group(0) @binding(1) var atlas: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(${TILE_WIDTH}, ${TILE_HEIGHT / 2}) fn clear(@builtin(local_invocation_id) local: vec3u, @builtin(workgroup_id) workgroupId: vec3u) {
  let counts = reset.counts.xyz;
  let probe = workgroupId.x;
  let stored = vec3u(probe % counts.x, (probe / counts.x) % counts.y, probe / (counts.x * counts.y));
  let c = vec3i((stored + counts - reset.scroll.xyz) % counts);
  let n = vec3i(counts);
  let s = reset.shift.xyz;
  // 往正方向挪了 s 格：位置数在最后 s 个的是新进来的；往负方向挪：前 -s 个
  let entered = ((s > vec3i(0)) & (c >= n - s)) | ((s < vec3i(0)) & (c < -s));
  if (reset.shift.w == 0 && !any(entered)) { return; }
  let tile = vec2u((stored.x + stored.y * counts.x) * ${TILE_WIDTH}u, stored.z * ${TILE_HEIGHT}u);
  textureStore(atlas, tile + local.xy, vec4f(0.0));
  textureStore(atlas, tile + local.xy + vec2u(0u, ${TILE_HEIGHT / 2}u), vec4f(0.0));
}
`;

/** 用着的那个体（渲染空间；盒子、间距、射线数变了就从头算）。 */
interface VolumeState {
  readonly key: string;
  min: [number, number, number];
  readonly spacing: readonly [number, number, number];
  readonly counts: readonly [number, number, number];
  readonly rays: number;
  hysteresis: number;
  intensity: number;
  /** 这一遍每帧的 GPU 时间预算（毫秒）。 */
  budget: number;
  /** 跟着主相机走。 */
  readonly follow: boolean;
  /** 跟着相机走的体：最小角那个探针的世界格号；还没定时 undefined。 */
  cell: [number, number, number] | undefined;
  /** 卷动：cell 对各轴的探针数取模。 */
  scroll: [number, number, number];
  /** 相机挪了以后要清掉的：各轴挪了几格（还没清的），'all' 是全部。 */
  reset: [number, number, number] | 'all' | undefined;
}

/** 参数、清探针的参数、遍历的统计（u32 两个）。 */
interface VolumeBuffers {
  readonly params: GPUBuffer;
  readonly reset: GPUBuffer;
  readonly traversal: GPUBuffer;
}

/** 追射线、更新探针、清探针的三条计算管线。 */
interface Pipelines {
  readonly trace: GPUComputePipeline;
  readonly update: GPUComputePipeline;
  readonly reset: GPUComputePipeline;
}

/** 量一遍的 GPU 时间用的东西（timestamp-query）：查询集、解析的缓冲、读回的缓冲（还在 mapAsync 时不再写）。 */
interface Timing {
  readonly querySet: GPUQuerySet;
  readonly resolve: GPUBuffer;
  readonly readback: GPUBuffer;
  busy: boolean;
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
  /** 参数、清探针的参数、遍历的统计：第一次有体时才建（没有体的场景不占）。 */
  #buffers: VolumeBuffers | undefined;
  /** 遍历的统计：被截断的遍历数（累计）、最多的步数，两个 u32。 */
  readonly #paramData = new Float32Array(PARAMS_FLOATS);
  /** 三条计算管线：后台编（不卡顿），编好以前不追射线。 */
  #pipelines: Pipelines | Promise<Pipelines> | undefined;
  /** 清探针的参数（Reset）。 */
  #nextProbe = 0;
  /** 整个体轮过几遍（悬在空中的探针按它隔几轮更新）。 */
  #cycle = 0;
  #random = 0x2545f491;
  /** 编辑器按需出帧时还要接着出几帧（探针收敛）：新建了体、光照或场景变了以后。 */
  #settling = 0;
  #inputsKey = '';
  /** 图集换了就加一（网格的视图绑定组跟着重建）。 */
  generation = 0;
  /** 这一帧更新了几个探针、追了几条射线（统计）。 */
  readonly stats = { probes: 0, updatedProbes: 0, rays: 0, raysPerFrame: DEFAULT_RAYS, gpuMs: 0 };
  /** 这一帧打算追几条射线（按测出的 GPU 时间往 budget 调）。 */
  #raysPerFrame = DEFAULT_RAYS;
  /** 自己量这一遍的 GPU 时间（timestamp-query）：查询集、解析的缓冲、读回的缓冲（还在 mapAsync 时不再写）。 */
  #timing: Timing | undefined;

  constructor(device: GPUDevice, linear: GPUSampler) {
    this.#device = device;
    this.#linear = linear;
    this.#atlas = this.#createAtlas(1, 1);
  }

  #buffersFor(): VolumeBuffers {
    const device = this.#device;
    return (this.#buffers ??= {
      params: device.createBuffer({ label: 'IrradianceVolume params', size: PARAMS_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
      reset: device.createBuffer({ label: 'IrradianceVolume reset params', size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
      traversal: device.createBuffer({ label: 'IrradianceVolume traversal stats', size: 8, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC }),
    });
  }

  /** 这一帧在用（开着、设备和画质允许、场景里有体）。 */
  get active(): boolean {
    return this.#active && this.#state !== undefined;
  }

  /** 网格着色用的图集（没有体时是 1×1 的空图）。 */
  get atlas(): GPUTexture {
    return this.#atlas;
  }

  /** 网格着色器的四个 vec4（最小角和用不用、间距和强度、探针数、卷动）；没有体时用不用的那一位是 0。 */
  shading(): readonly number[] {
    const state = this.#state;
    if (!state || !this.#active) return [0, 0, 0, 0, 1, 1, 1, 0, 2, 2, 2, 0, 0, 0, 0, 0];
    return [...state.min, 1, ...state.spacing, state.intensity, ...state.counts, 0, ...state.scroll, 0];
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
      const follow = volume.followCamera[0] !== 0;
      // 跟着相机走的体间距不按盒子拉伸（世界的格要对齐），位置每帧按相机定
      const spacingOf: [number, number, number] = follow ? [spacing, spacing, spacing] : step;
      this.#found = { key: [follow, ...(follow ? [] : min), ...spacingOf, ...counts, rays].join(), min, spacing: spacingOf, counts, rays, hysteresis: volume.hysteresis[0]!, intensity: volume.intensity[0]!, budget: volume.budget[0]!, follow, scroll: [0, 0, 0], cell: undefined, reset: undefined };
    },
  });

  /**
   * 找这一帧的体（前向渲染器在写视图的常量之前调，allowed：设备放得下图集的绑定、画质开着全局光照；eye 是主相机在渲染空间里的
   * 位置，跟着相机走的体按它摆）；用到时更新光追场景。
   */
  begin(context: RenderContext, rayTracing: RayTracingScene, allowed: boolean, eye: { readonly x: number; readonly y: number; readonly z: number }): void {
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
    this.#state.budget = found.budget;
    if (this.#state.follow) this.#follow(this.#state, [eye.x, eye.y, eye.z], context.game.renderOrigin);
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

  /** 跟着相机走：最小角按间距对齐到相机周围（世界的格，渲染原点换了也不跳），挪了的格数记下来要清。 */
  #follow(state: VolumeState, eye: readonly number[], origin: readonly number[]): void {
    const cell = [0, 1, 2].map((a) => Math.floor((eye[a]! + origin[a]!) / state.spacing[a]!) - Math.floor(state.counts[a]! / 2)) as [number, number, number];
    const previous = state.cell;
    if (previous && cell.some((c, a) => c !== previous[a])) {
      const shift = cell.map((c, a) => c - previous[a]!) as [number, number, number];
      // 上次的还没清（那一帧没追射线）又挪了：全清
      state.reset = state.reset === undefined ? shift : 'all';
      this.#settling = Math.max(this.#settling, 10);
    }
    state.cell = cell;
    state.min = cell.map((c, a) => c * state.spacing[a]! - origin[a]!) as [number, number, number];
    state.scroll = cell.map((c, a) => ((c % state.counts[a]!) + state.counts[a]!) % state.counts[a]!) as [number, number, number];
  }

  #layersPerFrame(layer: number, layers: number, rays: number): number {
    return Math.max(1, Math.min(layers, Math.floor(this.#raysPerFrame / (layer * rays))));
  }

  /** 追这一帧的射线、更新探针（录进 encoder；光追场景还没有能遍历的东西时不做）。 */
  draw(encoder: GPUCommandEncoder, localLights: GPUBuffer, rayTracing: RayTracingScene, timestampWrites?: GPUComputePassTimestampWrites): void {
    const state = this.#state;
    const scene = rayTracing.bindGroup;
    if (!state || !scene || !this.#scratch || !this.#rays) return;
    const device = this.#device;
    // 管线在后台编：编好以前这一帧不追
    if (!this.#pipelines) {
      const creating = this.#createPipelines(rayTracing.bindGroupLayout);
      this.#pipelines = creating;
      creating.then((ready) => (this.#pipelines = ready), (error: unknown) => console.error('IrradianceVolume: creating the pipelines failed', error));
    }
    if (this.#pipelines instanceof Promise) return;
    const pipelines = this.#pipelines;
    const buffers = this.#buffersFor();
    const [cx, cy, cz] = state.counts;
    const layer = cx * cy;
    const layers = this.#layersPerFrame(layer, cz, state.rays);
    const firstLayer = this.#nextProbe;
    this.#nextProbe = (firstLayer + layers) % cz;
    // 轮完一遍：悬在空中的探针按轮数挑这一轮更新哪些
    if (firstLayer + layers >= cz) this.#cycle++;
    const probes = layers * layer;
    this.#writeParams(state, firstLayer * layer, probes);
    this.stats.updatedProbes = probes;
    this.stats.rays = probes * state.rays;

    // 开发时的剖析器要这一遍的时间戳就给它（这一帧不调预算），不然自己量
    const timing = timestampWrites ? undefined : this.#timingFor();
    const ownTimestamps = timing && !timing.busy ? { querySet: timing.querySet, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 } : undefined;
    const writes = timestampWrites ?? ownTimestamps;
    const pass = encoder.beginComputePass({ label: 'IrradianceVolume', ...(writes ? { timestampWrites: writes } : {}) });
    if (state.reset) {
      // 跟着相机走的体挪了：先清新进盒子的探针（直接写图集，下面追射线、更新时读到的就是清过的）
      const all = state.reset === 'all' || state.reset.some((shift, axis) => Math.abs(shift) >= state.counts[axis]!);
      const shift = state.reset === 'all' ? [0, 0, 0] : state.reset;
      const data = new Int32Array(12);
      data.set([...state.counts, 0, ...state.scroll, 0, ...shift, all ? 1 : 0]);
      device.queue.writeBuffer(buffers.reset, 0, data);
      state.reset = undefined;
      pass.setPipeline(pipelines.reset);
      pass.setBindGroup(0, device.createBindGroup({
        layout: pipelines.reset.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: buffers.reset } }, { binding: 1, resource: this.#atlas.createView() }],
      }));
      pass.dispatchWorkgroups(cx * cy * cz);
    }
    pass.setPipeline(pipelines.trace);
    pass.setBindGroup(0, device.createBindGroup({
      layout: pipelines.trace.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: buffers.params } },
        { binding: 1, resource: this.#atlas.createView() },
        { binding: 2, resource: this.#linear },
        { binding: 3, resource: { buffer: this.#rays } },
        { binding: 4, resource: { buffer: buffers.traversal } },
        { binding: 5, resource: { buffer: localLights } },
        { binding: 6, resource: { buffer: rayTracing.lighting.buffer } },
      ],
    }));
    pass.setBindGroup(1, scene);
    pass.dispatchWorkgroups(Math.ceil((probes * state.rays) / 64));
    pass.setPipeline(pipelines.update);
    pass.setBindGroup(0, device.createBindGroup({
      layout: pipelines.update.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: buffers.params } },
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
    if (timing && ownTimestamps) this.#measure(encoder, timing, state.budget);
  }

  /** 时间戳查询的东西（设备不支持时 undefined）。 */
  #timingFor(): Timing | undefined {
    if (this.#timing || !this.#device.features.has('timestamp-query')) return this.#timing;
    const device = this.#device;
    return (this.#timing = {
      querySet: device.createQuerySet({ label: 'IrradianceVolume timing', type: 'timestamp', count: 2 }),
      resolve: device.createBuffer({ label: 'IrradianceVolume timing resolve', size: 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC }),
      readback: device.createBuffer({ label: 'IrradianceVolume timing readback', size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }),
      busy: false,
    });
  }

  /** 读回这一遍的 GPU 时间，按它把下一帧的射线数往预算（毫秒）调：每次最多变 30%，免得来回晃。 */
  #measure(encoder: GPUCommandEncoder, timing: Timing, budget: number): void {
    encoder.resolveQuerySet(timing.querySet, 0, 2, timing.resolve, 0);
    encoder.copyBufferToBuffer(timing.resolve, 0, timing.readback, 0, 16);
    timing.busy = true;
    // 编码器提交以后才能映射：等这一帧交给队列（同 GpuCulling 的读回）
    queueMicrotask(() => {
      timing.readback.mapAsync(GPUMapMode.READ).then(() => {
        const [begin, end] = new BigUint64Array(timing.readback.getMappedRange());
        timing.readback.unmap();
        timing.busy = false;
        const ms = Number(end! - begin!) / 1e6;
        if (!(ms > 0) || ms > 1000) return;
        this.stats.gpuMs = ms;
        const ratio = Math.min(1.3, Math.max(0.7, budget / ms));
        this.#raysPerFrame = Math.round(Math.min(MAX_RAYS_PER_FRAME, Math.max(MIN_RAYS, this.#raysPerFrame * ratio)));
        this.stats.raysPerFrame = this.#raysPerFrame;
      }, () => {
        timing.busy = false;
      });
    });
  }

  #writeParams(state: VolumeState, firstProbe: number, probes: number): void {
    const data = this.#paramData, words = new Uint32Array(data.buffer);
    const maxDistance = 1.5 * Math.hypot(...state.spacing);
    data.set([...state.min, maxDistance, ...state.spacing, state.hysteresis, ...state.counts, state.rays, ...state.scroll, this.#cycle % 65536], 0);
    words.set([firstProbe, probes, 0, 0], 16);
    data.set(this.#randomRotation(), 20);
    this.#device.queue.writeBuffer(this.#buffersFor().params, 0, data);
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
    // 射线缓冲按预算的上限（或整个体，取小的）开，预算调大时不用换
    const perFrame = Math.max(1, Math.min(cz, Math.floor(MAX_RAYS_PER_FRAME / (cx * cy * state.rays)))) * cx * cy;
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
    return this.#device.createTexture({ label: 'IrradianceVolume atlas', size: [width, height], format: 'rgba16float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC });
  }

  async #createPipelines(scene: GPUBindGroupLayout): Promise<Pipelines> {
    const device = this.#device;
    const traceLayout = device.createBindGroupLayout({
      label: 'IrradianceVolume trace',
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: {} },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: {} },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, sampler: {} },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: {} },
      ],
    });
    const [trace, update, reset] = await Promise.all([device.createComputePipelineAsync({
      label: 'IrradianceVolume trace',
      layout: device.createPipelineLayout({ bindGroupLayouts: [traceLayout, scene] }),
      compute: { module: createCheckedShaderModule(device, 'IrradianceVolume trace', traceShader()), entryPoint: 'trace' },
    }), device.createComputePipelineAsync({
      label: 'IrradianceVolume update',
      layout: 'auto',
      compute: { module: createCheckedShaderModule(device, 'IrradianceVolume update', updateShader()), entryPoint: 'update' },
    }), device.createComputePipelineAsync({
      label: 'IrradianceVolume reset',
      layout: 'auto',
      compute: { module: createCheckedShaderModule(device, 'IrradianceVolume reset', RESET_SHADER), entryPoint: 'clear' },
    })]);
    return { trace, update, reset };
  }

  /**
   * 光追遍历的统计（读回要等 GPU）：到现在为止被截断的遍历有几次（应该是 0；不是 0 说明 BVH 坏了或者遍历有问题）、一次遍历里最多的
   * 一个循环走了几步。
   */
  async traversalStats(): Promise<{ capped: number; maxSteps: number }> {
    const readback = this.#device.createBuffer({ size: 8, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const encoder = this.#device.createCommandEncoder({ label: 'IrradianceVolume traversal stats readback' });
    encoder.copyBufferToBuffer(this.#buffersFor().traversal, 0, readback, 0, 8);
    this.#device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const [capped, maxSteps] = new Uint32Array(readback.getMappedRange());
    readback.destroy();
    return { capped: capped!, maxSteps: maxSteps! };
  }

  destroy(): void {
    this.#release();
    this.#atlas.destroy();
    for (const buffer of Object.values(this.#buffers ?? {})) buffer.destroy();
    this.#timing?.querySet.destroy();
    this.#timing?.resolve.destroy();
    this.#timing?.readback.destroy();
  }
}
