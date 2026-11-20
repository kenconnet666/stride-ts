/**
 * 体积雾和体积光（VolumetricFog 组件；Stride 没有）：Wronski 2014 "Volumetric Fog"（刺客信条 4）和 Hillaire 2015（寒霜）的做法。
 * 不要求有物理天空：照着雾的是场景的主光（投阴影的方向光，没有时是第一盏）、点光、聚光和环境光。
 *
 * - 体素表（128x72x64，跟着主相机：屏幕上一格一格，沿视线 64 层，第 i 层到 ((i + 1) / 64)² · distance，近处层密）。
 * - 第一遍（scatter）：每个体素算那一点的雾（密度按高度指数衰减，可以乘一层被风吹着走的噪声）和照进来的光——主光乘级联阴影
 *   （所以物体的影子在雾里是一道道的光柱）、乘云的影子、乘相函数（朝着光看时亮）；点光、聚光按主视图的簇只看那一点所在
 *   那一簇的（lighting/Clusters.ts，衰减同网格着色），乘相函数，不算阴影；加上各向同性的环境光。每帧把体素在层里的位置抖
 *   一下，和上一帧重投影过来的结果混合：64 层的台阶十几帧里抹平。
 * - 第二遍（integrate）：每一列从近到远累加散射、累乘透射（解析地积分每一段）。
 * - 合成：不透明的画完以后，每个像素按到相机的距离查积分好的表，颜色 = 颜色 · 透射 + 散射。比 distance 远的物体、天空再接
 *   一段解析的指数高度雾（farFog；Quílez 的做法，光学深度沿视线解析积分）：只有主光（不算阴影）和环境光，没有噪声。
 * - 还没做：点光、聚光在雾里的阴影；透明的物体在雾的前面还是后面（现在按它身后不透明物体的距离算）。
 */
import { system } from '../../engine/system';
import type { GpuResources } from '../../graphics/GpuResources';
import { VolumetricFog } from '../components';
import { clusterParams, CLUSTER_WGSL } from '../lighting/Clusters';
import { LOCAL_LIGHT_WGSL } from '../lighting/LocalLights';
import type { Lighting, RenderContext, RenderView } from '../RenderSystem';
import { FULLSCREEN_VERTEX, GRADIENT_NOISE } from '../wgsl';
import { IRRADIANCE_PER_INTENSITY } from './lightUnits';
import type { CloudShadow } from './VolumetricClouds';

/** 体素表的大小：屏幕上横、竖几格，沿视线几层。 */
const FROXELS = [128, 72, 64] as const;
/** 和上一帧混合时这一帧占的比重。 */
const HISTORY_BLEND = 0.08;
const FORMAT: GPUTextureFormat = 'rgba16float';
const UNIFORM_FLOATS = 168;

const FOG_STRUCT = /* wgsl */ `
struct Fog {
  inverseViewProjection: mat4x4f,
  // 上一帧的视图投影和相机位置：找上一帧的结果
  previousViewProjection: mat4x4f,
  // 主光的级联阴影：世界到图集 UV 和深度的矩阵、每个级联在图集里的范围、各级联结束处的深度
  shadowMatrices: array<mat4x4f, 4>,
  shadowRectangles: array<vec4f, 4>,
  shadowSplits: vec4f,
  // xyz 相机的位置，w 这一帧的抖动（0..1）
  eye: vec4f,
  previousEye: vec4f,
  // 世界坐标点乘它（w 是 1）得到裁剪空间的 w：选级联用的深度
  depthRow: vec4f,
  // x 密度（baseHeight 处每米的消光），y 高度衰减（每米），z baseHeight，w 体素表盖多远（米）
  fog: vec4f,
  // rgb 雾的颜色（反照率），w 相函数的 g
  albedo: vec4f,
  // xyz 朝主光的方向，w 级联数（0 是没有阴影）
  light: vec4f,
  // rgb 主光的颜色乘强度，w 这一帧的比重（没有上一帧的结果时是 1）
  lightColor: vec4f,
  // rgb 环境光的亮度，w 阴影的深度偏移
  ambient: vec4f,
  // 云的影子：x 比例，yz 偏移，w 有没有（1 / 0）
  cloud: vec4f,
  // 主视图的分簇（lighting/Clusters.ts 的 clusterParams）：没分簇时 cluster.w 是 0（逐个看所有的点光、聚光）
  cluster: vec4f,
  clusterView: vec4f,
  // x 点光、聚光的个数，y 游戏时间（秒），z 噪声的强度（0 是没有），w 噪声的尺度（米）
  locals: vec4f,
  // xyz 全局风（米每秒，噪声跟着飘），w 远处的高度雾（1 开）
  wind: vec4f,
};

const PI = 3.14159265;

fn henyeyGreenstein(cosTheta: f32, g: f32) -> f32 {
  let g2 = g * g;
  return (1.0 - g2) / (4.0 * PI * pow(max(1.0 + g2 - 2.0 * g * cosTheta, 1e-4), 1.5));
}

const SLICES = ${FROXELS[2]}.0;
/** 第 slice 层（可以带小数）的远端到相机的距离。 */
fn sliceDistance(slice: f32) -> f32 {
  let s = slice / SLICES;
  return s * s * fog.fog.w;
}
`;

/** 每个体素的散射和消光，和上一帧混合。 */
const SCATTER_SHADER = /* wgsl */ `
${FOG_STRUCT}
${CLUSTER_WGSL}
${LOCAL_LIGHT_WGSL}
@group(0) @binding(0) var<uniform> fog: Fog;
@group(0) @binding(1) var output: texture_storage_3d<rgba16float, write>;
@group(0) @binding(2) var history: texture_3d<f32>;
@group(0) @binding(3) var linearClamp: sampler;
@group(0) @binding(4) var shadowAtlas: texture_depth_2d;
@group(0) @binding(5) var shadowComparison: sampler_comparison;
@group(0) @binding(6) var cloudShadowMap: texture_2d<f32>;
@group(0) @binding(7) var linearRepeat: sampler;
// 主视图的簇（lighting/Clusters.ts）和点光、聚光（lighting/LocalLights.ts）
@group(0) @binding(8) var<storage, read> clusters: array<u32>;
@group(0) @binding(9) var<storage, read> localLightData: array<vec4f>;
${GRADIENT_NOISE}

/** 体素所在的主视图的簇的簇头（同网格着色器的 clusterOf，屏幕位置用体素的 uv）；没分簇时是 -1。 */
fn froxelCluster(world: vec3f, uv: vec2f) -> i32 {
  if (fog.cluster.w == 0.0) {
    return -1;
  }
  let depth = max(dot(world - fog.eye.xyz, fog.clusterView.xyz), 1e-4);
  let slice = u32(clamp((log(depth) - fog.clusterView.w) * fog.cluster.z, 0.0, f32(CLUSTER_Z - 1u)));
  let tile = min(vec2u(uv * vec2f(f32(CLUSTER_X), f32(CLUSTER_Y))), vec2u(CLUSTER_X - 1u, CLUSTER_Y - 1u));
  let slot = u32(fog.cluster.w) - 1u;
  return i32(slot * CLUSTER_HEADER_WORDS + 1u + ((slice * CLUSTER_Y + tile.y) * CLUSTER_X + tile.x) * CLUSTER_HEADER);
}

/**
 * 点光、聚光照进这一点的光（乘相函数）。投阴影的光按它的阴影取一次比较样本（不做 PCF：体素本来就糊，还和上一帧混合），
 * 雾里有点光、聚光被东西挡出来的暗影和光柱。
 */
fn localScattering(world: vec3f, uv: vec2f, direction: vec3f) -> vec3f {
  let cluster = froxelCluster(world, uv);
  let clustered = cluster >= 0;
  var count = u32(fog.locals.x);
  var first = 0u;
  if (clustered) {
    count = clusters[u32(cluster) + 1u] & 0xffffu;
    first = clusters[u32(cluster)];
  }
  var sum = vec3f(0.0);
  for (var k = 0u; k < count; k++) {
    let light = localLight(select(k, clusters[first + k], clustered));
    let at = localLightAt(light, world);
    if (at.w <= 0.0) {
      continue;
    }
    var visibility = 1.0;
    if (light.direction.w >= 0.0) {
      let coord = localShadowCoord(localShadowStart(u32(light.direction.w)), world, world, light.position.xyz);
      if (coord.w > 0.0) {
        visibility = textureSampleCompareLevel(shadowAtlas, shadowComparison, coord.xy, coord.z);
      }
    }
    // 强度换成发光强度（同 lightUnits.ts 的 IRRADIANCE_PER_INTENSITY）
    sum += light.color.rgb * PI * at.w * visibility * henyeyGreenstein(dot(direction, at.xyz), fog.albedo.w);
  }
  return sum;
}

/** 整数格点的哈希，0..1。 */
fn latticeHash(p: vec3i) -> f32 {
  var h = bitcast<u32>(p.x) * 374761393u + bitcast<u32>(p.y) * 668265263u + bitcast<u32>(p.z) * 2246822519u;
  h = (h ^ (h >> 13u)) * 1274126177u;
  return f32((h ^ (h >> 16u)) >> 8u) / 16777216.0;
}

/** 三维值噪声，0..1。 */
fn valueNoise3(p: vec3f) -> f32 {
  let i = vec3i(floor(p));
  let f = p - floor(p);
  let u = f * f * (3.0 - 2.0 * f);
  let x00 = mix(latticeHash(i), latticeHash(i + vec3i(1, 0, 0)), u.x);
  let x10 = mix(latticeHash(i + vec3i(0, 1, 0)), latticeHash(i + vec3i(1, 1, 0)), u.x);
  let x01 = mix(latticeHash(i + vec3i(0, 0, 1)), latticeHash(i + vec3i(1, 0, 1)), u.x);
  let x11 = mix(latticeHash(i + vec3i(0, 1, 1)), latticeHash(i + vec3i(1, 1, 1)), u.x);
  return mix(mix(x00, x10, u.y), mix(x01, x11, u.y), u.z);
}

/** 密度乘的噪声（平均约 1）：两层值噪声，跟着风飘；强度 0 时是 1。 */
fn fogNoise(world: vec3f) -> f32 {
  let strength = fog.locals.z;
  if (strength <= 0.0) {
    return 1.0;
  }
  let p = (world - fog.wind.xyz * fog.locals.y) / fog.locals.w;
  let n = valueNoise3(p) * 0.65 + valueNoise3(p * 2.3 + vec3f(17.1, 3.7, 9.2)) * 0.35;
  return mix(1.0, smoothstep(0.3, 0.7, n) * 2.0, strength);
}

/** 主光有没有被挡（1 没挡）：按深度选级联；比最远的级联还远、或者落在级联的范围外面的当作没挡。 */
fn sunShadow(world: vec3f) -> f32 {
  let count = u32(fog.light.w);
  if (count == 0u) { return 1.0; }
  let depth = dot(fog.depthRow, vec4f(world, 1.0));
  var cascade = 0u;
  for (var i = 0u; i + 1u < count; i++) {
    if (depth > fog.shadowSplits[i]) { cascade = i + 1u; }
  }
  if (depth > fog.shadowSplits[count - 1u]) { return 1.0; }
  let p = fog.shadowMatrices[cascade] * vec4f(world, 1.0);
  let s = p.xyz / p.w;
  let rectangle = fog.shadowRectangles[cascade];
  if (any(s.xy < rectangle.xy) || any(s.xy > rectangle.zw) || s.z < 0.0 || s.z > 1.0) { return 1.0; }
  return textureSampleCompareLevel(shadowAtlas, shadowComparison, s.xy, s.z - fog.ambient.w);
}

@compute @workgroup_size(4, 4, 4) fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(output);
  if (any(id >= size)) { return; }
  let uv = (vec2f(id.xy) + 0.5) / vec2f(size.xy);
  let far = fog.inverseViewProjection * vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 1.0, 1.0);
  let direction = normalize(far.xyz / far.w - fog.eye.xyz);
  // 这一帧体素在层里的位置：每一列错开（交错梯度噪声），每帧再挪（黄金分割的步子）
  let jitter = fract(gradientNoise(vec2f(id.xy)) + fog.eye.w);
  let world = fog.eye.xyz + direction * sliceDistance(f32(id.z) + jitter);

  // 雾：越高越稀；比基准高度低的地方封个顶，免得坑里浓成一堵墙
  let extinction = fog.fog.x * exp(clamp(-fog.fog.y * (world.y - fog.fog.z), -20.0, 3.0)) * fogNoise(world);
  let toLight = fog.light.xyz;
  var sun = fog.lightColor.rgb * sunShadow(world);
  if (fog.cloud.w > 0.0) {
    let ground = world.xz - toLight.xz * (world.y / max(toLight.y, 0.05));
    sun *= textureSampleLevel(cloudShadowMap, linearRepeat, ground * fog.cloud.x + fog.cloud.yz, 0.0).r;
  }
  // 朝着光看（视线和朝光的方向一致）是往前散射，最亮；环境光各个方向都有，相函数积分是 1
  let radiance = sun * henyeyGreenstein(dot(direction, toLight), fog.albedo.w) + localScattering(world, uv, direction) + fog.ambient.rgb;
  var current = vec4f(radiance * fog.albedo.rgb * extinction, extinction);

  // 上一帧：体素中心在上一帧的画面上的位置和距离
  let center = fog.eye.xyz + direction * sliceDistance(f32(id.z) + 0.5);
  let clip = fog.previousViewProjection * vec4f(center, 1.0);
  let previousUv = vec2f(clip.x / clip.w * 0.5 + 0.5, 0.5 - clip.y / clip.w * 0.5);
  let previousSlice = sqrt(saturate(length(center - fog.previousEye.xyz) / fog.fog.w));
  if (clip.w > 0.0 && all(previousUv >= vec2f(0.0)) && all(previousUv <= vec2f(1.0)) && previousSlice < 1.0) {
    let old = textureSampleLevel(history, linearClamp, vec3f(previousUv, previousSlice), 0.0);
    current = mix(old, current, fog.lightColor.w);
  }
  textureStore(output, id, current);
}`;

/** 每一列从近到远积分：每层存到这一层远端为止的散射（rgb）和透射（a）。 */
const INTEGRATE_SHADER = /* wgsl */ `
${FOG_STRUCT}
@group(0) @binding(0) var<uniform> fog: Fog;
@group(0) @binding(1) var output: texture_storage_3d<rgba16float, write>;
@group(0) @binding(2) var scatter: texture_3d<f32>;

@compute @workgroup_size(8, 8, 1) fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(output);
  if (any(id.xy >= size.xy)) { return; }
  var scattered = vec3f(0.0);
  var transmittance = 1.0;
  var near = 0.0;
  for (var slice = 0u; slice < size.z; slice++) {
    let far = sliceDistance(f32(slice) + 1.0);
    let s = textureLoad(scatter, vec3u(id.xy, slice), 0);
    let stepTransmittance = exp(-s.a * (far - near));
    // 解析地积分这一段（能量守恒）
    scattered += transmittance * s.rgb * (1.0 - stepTransmittance) / max(s.a, 1e-6);
    transmittance *= stepTransmittance;
    textureStore(output, vec3u(id.xy, slice), vec4f(scattered, transmittance));
    near = far;
  }
}`;

/** 合成：按到相机的距离查积分好的表，颜色 = 颜色 · 透射 + 散射（混合：src + dst · srcAlpha）。 */
const COMPOSITE_SHADER = /* wgsl */ `
${FULLSCREEN_VERTEX}
${FOG_STRUCT}
@group(0) @binding(0) var<uniform> fog: Fog;
@group(0) @binding(1) var integrated: texture_3d<f32>;
@group(0) @binding(2) var depth: texture_depth_2d;
@group(0) @binding(3) var linearClamp: sampler;

/**
 * 表的尽头（distance）以外的那一段：解析的指数高度雾（Quílez，"better fog"）。从 start 到 end 米沿 direction 的光学深度：
 * 密度 · exp(-衰减 · (起点高度 - 基准高度)) · (1 - exp(-衰减 · dy · 长度)) / (衰减 · dy)，dy 是方向的 y；照着它的是主光（不算
 * 阴影）乘相函数加环境光。返回这一段的散射（rgb）和透射（a）。
 */
fn farFog(direction: vec3f, start: f32, end: f32) -> vec4f {
  let span = end - start;
  if (fog.wind.w == 0.0 || span <= 0.0) {
    return vec4f(0.0, 0.0, 0.0, 1.0);
  }
  let b = fog.fog.y;
  // 比基准高度低的地方同体素表一样封个顶
  let height = max(fog.eye.y + direction.y * start - fog.fog.z, select(-3.0 / b, -1e9, b <= 0.0));
  let k = b * direction.y;
  var optical = fog.fog.x * exp(-b * height) * span;
  if (abs(k * span) > 1e-4) {
    optical = fog.fog.x * exp(-b * height) * (1.0 - exp(clamp(-k * span, -80.0, 80.0))) / k;
  }
  let transmittance = exp(-min(optical, 80.0));
  let light = fog.lightColor.rgb * henyeyGreenstein(dot(direction, fog.light.xyz), fog.albedo.w) + fog.ambient.rgb;
  return vec4f(light * fog.albedo.rgb * (1.0 - transmittance), transmittance);
}

@fragment fn fs(in: FullscreenVaryings) -> @location(0) vec4f {
  let d = textureLoad(depth, vec2i(in.position.xy), 0);
  let world = fog.inverseViewProjection * vec4f(in.ndc, d, 1.0);
  let offset = world.xyz / world.w - fog.eye.xyz;
  // 天空的像素当作很远（10 万米）
  let fullDistance = select(length(offset), 1e5, d >= 1.0);
  let direction = normalize(offset);
  // 表里的那一段：天空的像素、比表远的物体按表的尽头算
  let distance = min(fullDistance, fog.fog.w);
  // 层号的反函数：第 i 层的值在它的远端，纹素中心在 (i + 0.5) / 层数；比第一层还近的按距离淡到没有雾
  let w = sqrt(saturate(distance / fog.fog.w));
  let s = textureSampleLevel(integrated, linearClamp, vec3f(in.uv, max(w - 0.5 / SLICES, 0.5 / SLICES)), 0.0);
  let fade = saturate(w * SLICES);
  let nearScattered = s.rgb * fade;
  let nearTransmittance = mix(1.0, s.a, fade);
  // 表以外的那一段在它后面：它的散射被前面那段挡掉一部分
  let far = farFog(direction, fog.fog.w, fullDistance);
  return vec4f(nearScattered + nearTransmittance * far.rgb, nearTransmittance * far.a);
}`;

/** 照着雾的点光、聚光（渲染系统的）：主视图的簇和光源缓冲。 */
export interface FogLights {
  readonly clusters: GPUBuffer;
  readonly localLights: GPUBuffer;
}

/** 按通道的名字给量 GPU 耗时的查询（GpuProfiler.passTimestamps）；没开剖析时返回 undefined。 */
type PassTimestamps = (name: string) => GPURenderPassTimestampWrites | undefined;

/** 雾这一帧的设置（VolumetricFog 组件的值）。 */
export interface FogSettings {
  density: number;
  heightFalloff: number;
  baseHeight: number;
  color: [number, number, number];
  anisotropy: number;
  distance: number;
  ambient: number;
  noise: number;
  noiseScale: number;
  farFog: boolean;
}

/**
 * 场景的体积雾（渲染系统一份）：前向渲染器收集光照之后 apply（找 VolumetricFog），主画面不透明的画完以后 record
 * （算体素表、积分、合成进画面）。
 */
export class Fog {
  /** 这一帧画不画雾（场景里有 VolumetricFog，密度大于 0）。 */
  active = false;
  readonly settings: FogSettings = { density: 0.02, heightFalloff: 0.1, baseHeight: 0, color: [1, 1, 1], anisotropy: 0.6, distance: 120, ambient: 1, noise: 0, noiseScale: 8, farFog: true };
  /** 这一帧的全局风（噪声跟着飘）和游戏时间，apply 时记下。 */
  #wind: readonly [number, number, number] = [0, 0, 0];
  #time = 0;
  readonly #device: GPUDevice;
  readonly #resources: GpuResources;
  #gpu: FogGpu | undefined;
  #found = false;
  #frame = 0;
  /** 上一帧主相机的位置；还没画过时是 undefined（那一帧不和上一帧混合）。 */
  #previousEye: [number, number, number] | undefined;

  readonly #collect = system('Fog.collect', {
    with: { fog: VolumetricFog },
    update: ({ fog, count }) => {
      if (count === 0 || this.#found) return;
      this.#found = true;
      const s = this.settings;
      s.density = fog.density[0]!;
      s.heightFalloff = fog.heightFalloff[0]!;
      s.baseHeight = fog.baseHeight[0]!;
      s.color = [fog.color[0]!, fog.color[1]!, fog.color[2]!];
      s.anisotropy = fog.anisotropy[0]!;
      s.distance = fog.distance[0]!;
      s.ambient = fog.ambient[0]!;
      s.noise = fog.noise[0]!;
      s.noiseScale = fog.noiseScale[0]!;
      s.farFog = fog.farFog[0] !== 0;
    },
  });

  constructor(device: GPUDevice, resources: GpuResources) {
    this.#device = device;
    this.#resources = resources;
  }

  /** 收集光照之后调：enabled 是画质档位给不给。 */
  apply(context: RenderContext, enabled: boolean): void {
    this.#found = false;
    if (enabled) context.game.entities.run(this.#collect, context.time);
    this.active = this.#found && this.settings.density > 0;
    this.#wind = context.game.wind.global.velocity;
    this.#time = context.time.total;
    // 停了一阵再开：上一帧的结果不是上一帧的了
    if (!this.active) this.#previousEye = undefined;
  }

  /**
   * 算这一帧的体素表、积分、合成进 target（主画面，不透明的画完以后）。depth 是主画面的深度；cloud 是云在地面上的影子
   * （落在主光上的才用）；timestamps 按通道的名字（Fog scatter、Fog integrate、Fog composite）给量 GPU 耗时的查询。
   */
  record(encoder: GPUCommandEncoder, view: RenderView, lighting: Lighting, cloud: CloudShadow | undefined, target: GPUTextureView, format: GPUTextureFormat, depth: GPUTexture, lights: FogLights, timestamps?: PassTimestamps): void {
    if (!this.active) return;
    const gpu = (this.#gpu ??= new FogGpu(this.#device, this.#resources));
    const light = lighting.directionals[Math.max(lighting.shadowLight, 0)];
    const lit = lighting.directionalCount > 0 && light !== undefined;
    const shadow = lit && lighting.shadowLight >= 0 ? lighting.shadow : undefined;
    const clouds = lit && cloud?.lightEntity === light.entity ? cloud : undefined;
    gpu.record(encoder, this.#uniforms(view, lighting, lit ? light : undefined, shadow !== undefined, clouds), shadow || lighting.localShadowCount > 0 ? lighting.shadowAtlas : undefined, clouds?.texture, target, format, depth, lights, timestamps);
    this.#previousEye = [view.eye.x, view.eye.y, view.eye.z];
    this.#frame = (this.#frame + 1) % 1024;
  }

  destroy(): void {
    this.#gpu?.destroy();
  }

  #uniforms(view: RenderView, lighting: Lighting, light: Lighting['directionals'][number] | undefined, shadowed: boolean, cloud: CloudShadow | undefined): Float32Array {
    const s = this.settings;
    const data = new Float32Array(UNIFORM_FLOATS);
    const eye = [view.eye.x, view.eye.y, view.eye.z];
    data.set(view.inverseViewProjection, 0);
    data.set(view.previousViewProjection, 16);
    const shadow = shadowed ? lighting.shadow : undefined;
    if (shadow) {
      data.set(shadow.worldToShadow, 32);
      data.set(shadow.rectangles, 96);
      data.set(shadow.splits, 112);
    }
    data.set([...eye, (this.#frame * 0.61803399) % 1], 116);
    data.set([...(this.#previousEye ?? eye), 0], 120);
    // 裁剪空间的 w 是视图投影矩阵的第四行点乘世界坐标（列优先存的：下标 3、7、11、15）
    const vp = view.viewProjection;
    data.set([vp[3]!, vp[7]!, vp[11]!, vp[15]!], 124);
    data.set([s.density, s.heightFalloff, s.baseHeight, s.distance], 128);
    data.set([...s.color, s.anisotropy], 132);
    if (light) {
      const length = Math.hypot(light.direction.x, light.direction.y, light.direction.z) || 1;
      data.set([-light.direction.x / length, -light.direction.y / length, -light.direction.z / length, shadow?.cascadeCount ?? 0], 136);
      // 雾按物理量散射：光的强度换成照度（点光、聚光在着色器里乘同一个数）
      data.set([light.color.r * IRRADIANCE_PER_INTENSITY, light.color.g * IRRADIANCE_PER_INTENSITY, light.color.b * IRRADIANCE_PER_INTENSITY], 140);
    } else {
      data.set([0, 1, 0, 0], 136);
    }
    data[143] = this.#previousEye ? HISTORY_BLEND : 1;
    // 环境光：环境色加天空盒光的球谐的常数项（各个方向的平均）
    const sky = lighting.skybox;
    const sh = sky?.skybox.diffuseSH;
    const intensity = sky?.intensity ?? 0;
    data.set([
      (lighting.ambient.r + (sh?.[0] ?? 0) * intensity) * s.ambient,
      (lighting.ambient.g + (sh?.[1] ?? 0) * intensity) * s.ambient,
      (lighting.ambient.b + (sh?.[2] ?? 0) * intensity) * s.ambient,
      shadow?.depthBias ?? 0,
    ], 144);
    data.set(cloud ? [cloud.scale, cloud.offset[0], cloud.offset[1], 1] : [0, 0, 0, 0], 148);
    data.set(clusterParams(view), 152);
    data.set([lighting.localCount, this.#time, s.noise, s.noiseScale], 160);
    data.set([...this.#wind, s.farFog ? 1 : 0], 164);
    return data;
  }
}

/** 体积雾的 GPU 资源：两张轮着写的散射表（这一帧和上一帧）、积分好的表、三条管线。 */
class FogGpu {
  readonly #device: GPUDevice;
  readonly #resources: GpuResources;
  readonly #uniforms: GPUBuffer;
  readonly #scatter: [GPUTexture, GPUTexture];
  readonly #integrated: GPUTexture;
  readonly #scatterPipeline: GPUComputePipeline;
  readonly #integratePipeline: GPUComputePipeline;
  readonly #compositeModule: GPUShaderModule;
  readonly #compositeLayout: GPUBindGroupLayout;
  readonly #composites = new Map<GPUTextureFormat, GPURenderPipeline>();
  #current = 0;

  constructor(device: GPUDevice, resources: GpuResources) {
    this.#device = device;
    this.#resources = resources;
    this.#uniforms = device.createBuffer({ label: 'Fog', size: UNIFORM_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const volume = (label: string) => device.createTexture({ label, size: [...FROXELS], dimension: '3d', format: FORMAT, usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING });
    this.#scatter = [volume('Fog scatter 0'), volume('Fog scatter 1')];
    this.#integrated = volume('Fog integrated');
    const compute = (label: string, code: string) => device.createComputePipeline({ label, layout: 'auto', compute: { module: device.createShaderModule({ label, code }), entryPoint: 'main' } });
    this.#scatterPipeline = compute('Fog scatter', SCATTER_SHADER);
    this.#integratePipeline = compute('Fog integrate', INTEGRATE_SHADER);
    this.#compositeModule = device.createShaderModule({ label: 'Fog composite', code: COMPOSITE_SHADER });
    this.#compositeLayout = device.createBindGroupLayout({
      label: 'Fog composite',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: '3d' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      ],
    });
  }

  record(encoder: GPUCommandEncoder, uniforms: Float32Array, shadowAtlas: GPUTexture | undefined, cloudShadow: GPUTexture | undefined, target: GPUTextureView, format: GPUTextureFormat, depth: GPUTexture, lights: FogLights, timestamps?: PassTimestamps): void {
    const timed = (label: string) => {
      const timestampWrites = timestamps?.(label);
      return timestampWrites ? { label, timestampWrites } : { label };
    };
    this.#device.queue.writeBuffer(this.#uniforms, 0, uniforms as Float32Array<ArrayBuffer>);
    const previous = this.#scatter[this.#current]!;
    this.#current = 1 - this.#current;
    const scatter = this.#scatter[this.#current]!;
    const uniformBuffer = { buffer: this.#uniforms };
    const lit = encoder.beginComputePass(timed('Fog scatter'));
    lit.setPipeline(this.#scatterPipeline);
    lit.setBindGroup(0, this.#device.createBindGroup({
      layout: this.#scatterPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: uniformBuffer },
        { binding: 1, resource: scatter.createView() },
        { binding: 2, resource: previous.createView() },
        { binding: 3, resource: this.#resources.linearClamp },
        { binding: 4, resource: (shadowAtlas ?? this.#resources.emptyShadowAtlas).createView() },
        { binding: 5, resource: this.#resources.shadowComparison },
        { binding: 6, resource: (cloudShadow ?? this.#resources.white).createView() },
        { binding: 7, resource: this.#resources.linearRepeat },
        { binding: 8, resource: { buffer: lights.clusters } },
        { binding: 9, resource: { buffer: lights.localLights } },
      ],
    }));
    lit.dispatchWorkgroups(FROXELS[0] / 4, FROXELS[1] / 4, FROXELS[2] / 4);
    lit.end();
    const integrate = encoder.beginComputePass(timed('Fog integrate'));
    integrate.setPipeline(this.#integratePipeline);
    integrate.setBindGroup(0, this.#device.createBindGroup({
      layout: this.#integratePipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: uniformBuffer }, { binding: 1, resource: this.#integrated.createView() }, { binding: 2, resource: scatter.createView() }],
    }));
    integrate.dispatchWorkgroups(FROXELS[0] / 8, FROXELS[1] / 8, 1);
    integrate.end();
    const composite = encoder.beginRenderPass({ ...timed('Fog composite'), colorAttachments: [{ view: target, loadOp: 'load', storeOp: 'store' }] });
    composite.setPipeline(this.#compositeFor(format));
    composite.setBindGroup(0, this.#device.createBindGroup({
      layout: this.#compositeLayout,
      entries: [
        { binding: 0, resource: uniformBuffer },
        { binding: 1, resource: this.#integrated.createView() },
        { binding: 2, resource: depth.createView() },
        { binding: 3, resource: this.#resources.linearClamp },
      ],
    }));
    composite.draw(3);
    composite.end();
  }

  destroy(): void {
    for (const texture of [...this.#scatter, this.#integrated]) texture.destroy();
    this.#uniforms.destroy();
  }

  /** 合成的管线：颜色 = 散射 + 颜色 · 透射（alpha）。 */
  #compositeFor(format: GPUTextureFormat): GPURenderPipeline {
    let pipeline = this.#composites.get(format);
    if (!pipeline) {
      pipeline = this.#device.createRenderPipeline({
        label: `Fog composite ${format}`,
        layout: this.#device.createPipelineLayout({ bindGroupLayouts: [this.#compositeLayout] }),
        vertex: { module: this.#compositeModule, entryPoint: 'fullscreenVertex' },
        fragment: {
          module: this.#compositeModule,
          entryPoint: 'fs',
          targets: [{ format, blend: { color: { srcFactor: 'one', dstFactor: 'src-alpha', operation: 'add' }, alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' } } }],
        },
      });
      this.#composites.set(format, pipeline);
    }
    return pipeline;
  }
}
