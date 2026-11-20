/**
 * 屏幕空间反射（Stride 的 LocalReflections，合成器的 PostEffects 里开），做法照随机屏幕空间反射（Stachowiak, "Stochastic
 * Screen-Space Reflections", SIGGRAPH 2015）和 AMD FidelityFX SSSR 的分层步进：
 *
 * 1. Hi-Z：深度缓冲建一条"最近深度"的 mip 链（r32float）。
 * 2. 追踪：每个像素按 GGX 的可见法线分布（Heitz 2018）随机取一个反射方向，在屏幕空间里沿 Hi-Z 分层步进——前面是空的就跳到
 *    更粗的一级、一次跨过一大片，碰到东西再退回细的一级——比 Stride 的定步长（默认 60 步）走得远、步数少，薄的东西也不容易
 *    穿过去。命中以后按深度差、离屏幕边缘多近、粗糙度定"把握"（0 到 1）。
 * 3. 解析：先在空间上复用周围像素的光线（同一块表面上的，半径按粗糙度），命中处取这一帧画好的 HDR 颜色（反射里的反射晚
 *    一帧，同 Stride）；再和上一帧的结果在时间上累积（按运动向量或深度重投影，夹在空间解析结果的邻域范围里），随机方向的
 *    噪声就平均掉了。
 * 4. 合成：用反射换掉着色时加的环境镜面反射（不透明阶段留下的表面，见 RenderSystem 的 SURFACE_FORMATS）：
 *    颜色 += 把握 · (w · 反射 - E)。和 Stride 不同：Stride 把反射直接加上去，天空盒的镜面反射就算了两遍，开了 SSR 的表面
 *    整体变亮。
 *
 * 只做粗糙度不超过 maxRoughness 的表面（Stride 的 GlossinessThreshold 0.55，即粗糙度 0.45）；更粗糙的反射在屏幕上没多少
 * 可看的，照旧用环境光。
 */
import { Matrix } from '../../data/Matrix';
import { FULLSCREEN_VERTEX } from '../wgsl';
import type { GraphTexture } from '../RenderGraph';
import { fullscreenPipeline, FullscreenShader, UniformArena, warmFullscreenPipeline, type EffectFrame } from '../postfx/ImageEffect';
import type { RenderView } from '../RenderSystem';

const HIZ_FORMAT: GPUTextureFormat = 'r32float';
const TRACE_FORMAT: GPUTextureFormat = 'rgba16float';
const REFLECTION_FORMAT: GPUTextureFormat = 'rgba16float';
const HDR_FORMAT: GPUTextureFormat = 'rgba16float';
/** 运动向量里"这个像素没画"的标记（同 ForwardRenderer）。 */
const NO_VELOCITY = 4;

const COMMON = /* wgsl */ `
struct Ssr {
  inverseViewProjection: mat4x4f,
  viewProjection: mat4x4f,
  previousViewProjection: mat4x4f,
  /** xyz：相机位置；w：第几帧（随机数换着用）。 */
  eye: vec4f,
  /** 最大粗糙度、厚度（相对深度）、屏幕边缘渐隐的比例、最多走几步。 */
  params: vec4f,
  /** 宽、高、Hi-Z 的级数、有没有运动向量。 */
  size: vec4f,
};

fn worldPosition(ssr: Ssr, uv: vec2f, depth: f32) -> vec3f {
  let clip = ssr.inverseViewProjection * vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, depth, 1.0);
  return clip.xyz / clip.w;
}

/** 世界空间的点 → 屏幕（uv，深度）。 */
fn project(matrix: mat4x4f, world: vec3f) -> vec3f {
  let clip = matrix * vec4f(world, 1.0);
  let ndc = clip.xyz / clip.w;
  return vec3f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5, ndc.z);
}

fn octahedralDecode(e: vec2f) -> vec3f {
  var n = vec3f(e, 1.0 - abs(e.x) - abs(e.y));
  let t = saturate(-n.z);
  n = vec3f(n.xy + select(vec2f(t), vec2f(-t), n.xy >= vec2f(0.0)), n.z);
  return normalize(n);
}
`;

/** 第 0 级：深度缓冲原样拷进 r32float。 */
const HIZ_COPY_SHADER = /* wgsl */ `${FULLSCREEN_VERTEX}
@group(0) @binding(0) var depth: texture_depth_2d;
@fragment fn fs(in: FullscreenVaryings) -> @location(0) vec4f {
  return vec4f(textureLoad(depth, vec2i(in.position.xy), 0), 0.0, 0.0, 1.0);
}`;

/** 往下一级：2x2 里最近的（深度最小的）；上一级是奇数时最后一行、一列多看一格，不漏掉东西。 */
const HIZ_DOWNSAMPLE_SHADER = /* wgsl */ `${FULLSCREEN_VERTEX}
@group(0) @binding(0) var previous: texture_2d<f32>;
fn at(p: vec2i, size: vec2i) -> f32 {
  return textureLoad(previous, min(p, size - 1), 0).r;
}
@fragment fn fs(in: FullscreenVaryings) -> @location(0) vec4f {
  let size = vec2i(textureDimensions(previous));
  let p = vec2i(in.position.xy) * 2;
  var m = min(min(at(p, size), at(p + vec2i(1, 0), size)), min(at(p + vec2i(0, 1), size), at(p + vec2i(1, 1), size)));
  let lastX = (size.x & 1) == 1 && p.x + 3 == size.x;
  let lastY = (size.y & 1) == 1 && p.y + 3 == size.y;
  if (lastX) { m = min(m, min(at(p + vec2i(2, 0), size), at(p + vec2i(2, 1), size))); }
  if (lastY) { m = min(m, min(at(p + vec2i(0, 2), size), at(p + vec2i(1, 2), size))); }
  if (lastX && lastY) { m = min(m, at(p + vec2i(2, 2), size)); }
  return vec4f(m, 0.0, 0.0, 1.0);
}`;

/** 追踪：输出命中的 uv、把握（0 是没命中）。 */
const TRACE_SHADER = /* wgsl */ `${COMMON}
@group(0) @binding(0) var<uniform> ssr: Ssr;
@group(0) @binding(1) var depth: texture_depth_2d;
@group(0) @binding(2) var hiz: texture_2d<f32>;
@group(0) @binding(3) var surface: texture_2d<f32>;

const FLOAT_MAX = 3.402823466e38;

/** 每个像素、每帧不同的两个随机数（整数哈希，PCG）。 */
fn random2(pixel: vec2u, frame: u32) -> vec2f {
  var v = vec3u(pixel, frame) * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> vec3u(16u);
  v.x += v.y * v.z; v.y += v.z * v.x;
  return vec2f(v.xy & vec2u(0xffffffu)) / 16777216.0;
}

/** GGX 的可见法线分布里取一个微表面法线（Heitz 2018），v 和返回值都在切线空间（z 是表面法线）。 */
fn sampleGgxVndf(v: vec3f, alpha: f32, u: vec2f) -> vec3f {
  let vh = normalize(vec3f(alpha * v.x, alpha * v.y, v.z));
  let lensq = vh.x * vh.x + vh.y * vh.y;
  let t1 = select(vec3f(1.0, 0.0, 0.0), vec3f(-vh.y, vh.x, 0.0) / sqrt(lensq), lensq > 0.0);
  let t2 = cross(vh, t1);
  let r = sqrt(u.x);
  let phi = 6.28318530718 * u.y;
  let p1 = r * cos(phi);
  let s = 0.5 * (1.0 + vh.z);
  let p2 = (1.0 - s) * sqrt(1.0 - p1 * p1) + s * r * sin(phi);
  let nh = p1 * t1 + p2 * t2 + sqrt(max(0.0, 1.0 - p1 * p1 - p2 * p2)) * vh;
  return normalize(vec3f(alpha * nh.x, alpha * nh.y, max(0.0, nh.z)));
}

fn mipResolution(mip: i32) -> vec2f {
  return ssr.size.xy * exp2(-f32(mip));
}

/** 分层步进（FidelityFX SSSR 的 FFX_SSSR_HierarchicalRaymarch，深度不反转、Hi-Z 存最近的）。返回走到的位置和走了几步。 */
fn hierarchicalMarch(origin: vec3f, direction: vec3f) -> vec4f {
  let inverse = select(vec3f(FLOAT_MAX), 1.0 / direction, direction != vec3f(0.0));
  let maxMip = i32(ssr.size.z) - 1;
  var mip = 0;
  var resolution = mipResolution(mip);
  var uvOffset = 0.005 / ssr.size.xy;
  uvOffset = select(uvOffset, -uvOffset, direction.xy < vec2f(0.0));
  let floorOffset = select(vec2f(1.0), vec2f(0.0), direction.xy < vec2f(0.0));
  // 先走到第一个格子的边上（离开起点所在的像素）
  var plane = (floor(resolution * origin.xy) + floorOffset) / resolution + uvOffset;
  let first = (plane - origin.xy) * inverse.xy;
  var t = min(first.x, first.y);
  var position = origin + t * direction;
  var i = 0;
  let maxSteps = i32(ssr.params.w);
  while (i < maxSteps && mip >= 0) {
    let cell = resolution * position.xy;
    if (any(position.xy < vec2f(0.0)) || any(position.xy > vec2f(1.0))) {
      break;
    }
    let surfaceZ = textureLoad(hiz, vec2i(cell), mip).r;
    plane = (floor(cell) + floorOffset) / resolution + uvOffset;
    var bounds = (vec3f(plane, surfaceZ) - origin) * inverse;
    // 往远处走的光线才会撞上这一格里最近的那个深度
    bounds.z = select(FLOAT_MAX, bounds.z, direction.z > 0.0);
    let tMin = min(min(bounds.x, bounds.y), bounds.z);
    let above = surfaceZ > position.z;
    let skipped = tMin != bounds.z && above;
    t = select(t, tMin, above);
    position = origin + t * direction;
    // 跨过了一整格（前面是空的）：换粗一级走得更快；撞上了：换细一级看清楚
    if (skipped) {
      mip = min(mip + 1, maxMip);
    } else {
      mip -= 1;
    }
    resolution = mipResolution(mip);
    i += 1;
  }
  return vec4f(position, select(-1.0, f32(i), mip < 0));
}

@fragment fn fs(in: FullscreenVaryings) -> @location(0) vec4f {
  let pixel = vec2i(in.position.xy);
  let surfaceData = textureLoad(surface, pixel, 0);
  let roughness = surfaceData.z;
  let maxRoughness = ssr.params.x;
  // 没有表面（背景）、太粗糙的不做
  if (surfaceData.w < 0.5 || roughness > maxRoughness) {
    return vec4f(0.0);
  }
  let z = textureLoad(depth, pixel, 0);
  let uv = (vec2f(pixel) + 0.5) / ssr.size.xy;
  let world = worldPosition(ssr, uv, z);
  let n = octahedralDecode(surfaceData.xy);
  let v = normalize(ssr.eye.xyz - world);
  // 切线空间：z 是法线
  let up = select(vec3f(0.0, 0.0, 1.0), vec3f(1.0, 0.0, 0.0), abs(n.z) > 0.999);
  let tx = normalize(cross(up, n));
  let ty = cross(n, tx);
  let alpha = max(roughness * roughness, 0.001);
  let vt = vec3f(dot(v, tx), dot(v, ty), dot(v, n));
  let h = sampleGgxVndf(vt, alpha, random2(vec2u(pixel), u32(ssr.eye.w)));
  var r = reflect(-v, tx * h.x + ty * h.y + n * h.z);
  // 取到朝表面里面的方向（掠射角）：换成镜面方向
  if (dot(r, n) <= 0.0) {
    r = reflect(-v, n);
  }
  // 屏幕空间的方向：起点加上一段反射方向再投影（终点在相机后面时缩短到近处）
  let origin = vec3f(uv, z);
  let viewDistance = length(ssr.eye.xyz - world);
  let ahead = project(ssr.viewProjection, world + r * viewDistance);
  let towards = (ssr.viewProjection * vec4f(world + r * viewDistance, 1.0)).w;
  let end = select(project(ssr.viewProjection, world + r * viewDistance * 0.1), ahead, towards > 0.0);
  let direction = end - origin;
  let hit = hierarchicalMarch(origin, direction);
  if (hit.w < 0.0 || any(hit.xy < vec2f(0.0)) || any(hit.xy > vec2f(1.0))) {
    return vec4f(0.0);
  }
  // 命中处的深度和走到的深度差得太多（从东西后面穿过去了）就不算
  let hitPixel = min(vec2i(hit.xy * ssr.size.xy), vec2i(ssr.size.xy) - 1);
  let sceneZ = textureLoad(depth, hitPixel, 0);
  let sceneWorld = worldPosition(ssr, hit.xy, sceneZ);
  let rayWorld = worldPosition(ssr, hit.xy, hit.z);
  let thickness = ssr.params.y * length(ssr.eye.xyz - sceneWorld);
  if (distance(sceneWorld, rayWorld) > thickness || sceneZ >= 1.0) {
    return vec4f(0.0);
  }
  // 把握：靠近屏幕边缘、接近最大粗糙度时渐隐
  let edge = ssr.params.z;
  let border = min(min(hit.x, 1.0 - hit.x), min(hit.y, 1.0 - hit.y));
  let edgeFade = saturate(border / max(edge, 0.0001));
  let roughnessFade = saturate((maxRoughness - roughness) / max(maxRoughness * 0.2, 0.0001));
  return vec4f(hit.xy, edgeFade * roughnessFade, 1.0);
}`;

/**
 * 空间上的解析：自己和周围几个像素的光线都用上（随机 SSR 的光线复用，Stachowiak 2015）——周围的表面差不多（深度、法线相近）
 * 时，它命中的东西也是这里的反射的一个样本。半径按粗糙度：越粗糙反射越模糊，取得越开。输出 rgb 是乘过把握的反射（亮度压过），
 * a 是把握。
 */
const SPATIAL_SHADER = /* wgsl */ `${COMMON}
@group(0) @binding(0) var<uniform> ssr: Ssr;
@group(0) @binding(1) var trace: texture_2d<f32>;
@group(0) @binding(2) var color: texture_2d<f32>;
@group(0) @binding(3) var surface: texture_2d<f32>;
@group(0) @binding(4) var depth: texture_depth_2d;
@group(0) @binding(5) var linearClamp: sampler;

/** 单位圆里的 8 个点（泊松盘），每个像素每帧转一个随机角度。 */
const DISK = array<vec2f, 8>(
  vec2f(-0.326, -0.406), vec2f(-0.840, -0.074), vec2f(-0.696, 0.457), vec2f(-0.203, 0.621),
  vec2f(0.962, -0.195), vec2f(0.473, -0.480), vec2f(0.519, 0.767), vec2f(0.185, -0.893),
);

fn sampleAt(pixel: vec2i) -> vec4f {
  let hit = textureLoad(trace, pixel, 0);
  if (hit.z <= 0.0) {
    return vec4f(0.0);
  }
  let reflected = textureSampleLevel(color, linearClamp, hit.xy, 0.0).rgb;
  // 太亮的点（太阳的高光）压一下，免得随机方向偶尔碰上它时一闪一闪（Stride 的 ReduceHighlights）
  let compressed = reflected / (1.0 + max(max(reflected.r, reflected.g), reflected.b));
  return vec4f(compressed * hit.z, hit.z);
}

@fragment fn fs(in: FullscreenVaryings) -> @location(0) vec4f {
  let pixel = vec2i(in.position.xy);
  let size = vec2i(ssr.size.xy);
  let here = textureLoad(surface, pixel, 0);
  if (here.w < 0.5 || here.z > ssr.params.x) {
    return vec4f(0.0);
  }
  let n = octahedralDecode(here.xy);
  let z = textureLoad(depth, pixel, 0);
  let uv = (vec2f(pixel) + 0.5) / ssr.size.xy;
  let world = worldPosition(ssr, uv, z);
  let distanceToEye = length(ssr.eye.xyz - world);
  // 半径：镜面（粗糙度 0）只看自己附近 1 像素，到最大粗糙度时 8 像素
  let radius = mix(1.0, 8.0, saturate(here.z / max(ssr.params.x, 0.0001)));
  let angle = fract(sin(dot(vec2f(pixel), vec2f(12.9898, 78.233)) + ssr.eye.w * 0.618) * 43758.547) * 6.2831853;
  let rotation = mat2x2f(cos(angle), sin(angle), -sin(angle), cos(angle));
  var sum = sampleAt(pixel);
  var weight = 1.0;
  for (var k = 0; k < 8; k++) {
    let p = pixel + vec2i(round(rotation * DISK[k] * radius));
    if (any(p < vec2i(0)) || any(p >= size)) { continue; }
    // 只用同一块表面上的：法线相近、深度相近（按到相机的距离的比例）
    let other = textureLoad(surface, p, 0);
    if (other.w < 0.5 || dot(octahedralDecode(other.xy), n) < 0.9) { continue; }
    let otherWorld = worldPosition(ssr, (vec2f(p) + 0.5) / ssr.size.xy, textureLoad(depth, p, 0));
    if (abs(dot(otherWorld - world, n)) > 0.02 * distanceToEye) { continue; }
    sum += sampleAt(p);
    weight += 1.0;
  }
  return sum / weight;
}`;

/** 时间上的解析：和上一帧的结果累积，上一帧的夹在这一帧空间解析结果的 3x3 邻域范围里（场景变了、遮挡变了时不拖影）。 */
const TEMPORAL_SHADER = /* wgsl */ `${COMMON}
@group(0) @binding(0) var<uniform> ssr: Ssr;
@group(0) @binding(1) var spatial: texture_2d<f32>;
@group(0) @binding(2) var history: texture_2d<f32>;
@group(0) @binding(3) var velocity: texture_2d<f32>;
@group(0) @binding(4) var depth: texture_depth_2d;
@group(0) @binding(5) var linearClamp: sampler;

@fragment fn fs(in: FullscreenVaryings) -> @location(0) vec4f {
  let pixel = vec2i(in.position.xy);
  let size = vec2i(ssr.size.xy);
  let now = textureLoad(spatial, pixel, 0);
  var low = now;
  var high = now;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      if (x == 0 && y == 0) { continue; }
      let neighbor = textureLoad(spatial, clamp(pixel + vec2i(x, y), vec2i(0), size - 1), 0);
      low = min(low, neighbor);
      high = max(high, neighbor);
    }
  }
  // 上一帧在哪：有运动向量用它，没有（或者这个像素没画）按深度和上一帧的视图投影算
  let uv = (vec2f(pixel) + 0.5) / ssr.size.xy;
  var previousUv = uv;
  var motion = vec2f(${NO_VELOCITY}.0);
  if (ssr.size.w > 0.5) {
    motion = textureLoad(velocity, pixel, 0).xy;
  }
  if (motion.x < ${NO_VELOCITY / 2}.0) {
    previousUv = uv + motion;
  } else {
    let world = worldPosition(ssr, uv, textureLoad(depth, pixel, 0));
    previousUv = project(ssr.previousViewProjection, world).xy;
  }
  var result = now;
  if (all(previousUv >= vec2f(0.0)) && all(previousUv <= vec2f(1.0)) && ssr.eye.w > 0.0) {
    let previous = clamp(textureSampleLevel(history, linearClamp, previousUv, 0.0), low, high);
    result = mix(now, previous, 0.9);
  }
  return result;
}`;

/** 合成：颜色 += 把握 · (w · 反射 - E)；解析时压过的亮度放回去。 */
const COMBINE_SHADER = /* wgsl */ `
@group(0) @binding(0) var color: texture_2d<f32>;
@group(0) @binding(1) var reflection: texture_2d<f32>;
@group(0) @binding(2) var specularWeight: texture_2d<f32>;
@group(0) @binding(3) var environment: texture_2d<f32>;
@group(0) @binding(4) var trace: texture_2d<f32>;
/** x：调试视图（0 关，1 命中的把握和这一帧的追踪，2 累积后的反射）。 */
@group(0) @binding(5) var<uniform> debug: vec4f;

@fragment fn fs(in: FullscreenVaryings) -> @location(0) vec4f {
  let pixel = vec2i(in.position.xy);
  let base = textureLoad(color, pixel, 0);
  let r = textureLoad(reflection, pixel, 0);
  if (debug.x == 1.0) {
    let hit = textureLoad(trace, pixel, 0);
    return vec4f(hit.z, r.a, 0.0, 1.0);
  }
  if (debug.x == 2.0) {
    return vec4f(select(vec3f(0.0), r.rgb / max(r.a, 0.0001), r.a > 0.0) * 4.0, 1.0);
  }
  // a 不小于 1 的是次表面散射的像素，rgb 存的不是环境镜面反射（SubsurfaceScattering），不做反射
  let e = textureLoad(environment, pixel, 0);
  if (r.a <= 0.0 || e.a >= 1.0) {
    return base;
  }
  let compressed = r.rgb / r.a;
  let reflected = compressed / max(1.0 - max(max(compressed.r, compressed.g), compressed.b), 0.0001);
  let w = textureLoad(specularWeight, pixel, 0).rgb;
  return vec4f(base.rgb + r.a * (w * reflected - e.rgb), base.a);
}`;

/** 各个参数（默认值同 Stride 的 LocalReflections）。 */
export class ScreenSpaceReflections {
  enabled = false;
  /** 比这粗糙的表面不做（Stride 的 GlossinessThreshold 0.55）。 */
  maxRoughness = 0.45;
  /** 命中处的深度和光线的深度差多少以内算撞上（按到相机的距离的比例）。 */
  thickness = 0.03;
  /** 离屏幕边缘多近开始渐隐（屏幕的比例，Stride 的 EdgeFadeFactor）。 */
  edgeFade = 0.1;
  /** 分层步进最多走几步。 */
  maxSteps = 64;
  /** 调试视图：画面换成命中的把握（红：这一帧的追踪，绿：累积后）或者反射本身。 */
  debug: 'off' | 'hits' | 'reflection' = 'off';

  readonly #device: GPUDevice;
  readonly #sampler: GPUSampler;
  readonly #arena: UniformArena;
  readonly #trace: FullscreenShader;
  readonly #spatial: FullscreenShader;
  readonly #temporal: FullscreenShader;
  readonly #combine: FullscreenShader;
  readonly #uniforms = new Float32Array(60);
  #hiz: GPUTexture | undefined;
  /** 解析的结果两张轮着用：这一帧写一张，读上一帧的另一张。 */
  #history: [GPUTexture, GPUTexture] | undefined;
  #current = 0;
  #frame = 0;
  readonly #previousViewProjection = Matrix.identity();
  #hasPrevious = false;

  constructor(device: GPUDevice, linearClamp: GPUSampler) {
    this.#device = device;
    this.#sampler = linearClamp;
    this.#arena = new UniformArena(device, 4096);
    this.#trace = new FullscreenShader(device, 'SSR trace', TRACE_SHADER);
    this.#spatial = new FullscreenShader(device, 'SSR spatial', SPATIAL_SHADER);
    this.#temporal = new FullscreenShader(device, 'SSR temporal', TEMPORAL_SHADER);
    this.#combine = new FullscreenShader(device, 'SSR combine', COMBINE_SHADER);
  }

  /**
   * 往这一帧的渲染图里加反射的通道：color 是画好的 HDR 画面，depth 是它的深度，surfaces 是不透明阶段留下的表面
   * （SURFACE_FORMATS 的顺序），velocity 是运动向量（TAA 开着时有）。返回合成了反射的新画面。
   */
  record(frame: EffectFrame, color: GraphTexture, depth: GPUTexture, surfaces: readonly GraphTexture[], view: RenderView, velocity: GraphTexture | undefined): GraphTexture {
    this.#arena.reset();
    const { width, height } = color;
    const hiz = this.#hizFor(width, height);
    const history = this.#historyFor(width, height);
    const previous = history[1 - this.#current]!, next = history[this.#current]!;
    this.#current = 1 - this.#current;

    const u = this.#uniforms;
    u.set(view.inverseViewProjection, 0);
    u.set(view.viewProjection, 16);
    u.set(this.#hasPrevious ? this.#previousViewProjection : view.viewProjection, 32);
    u.set([view.eye.x, view.eye.y, view.eye.z, this.#hasPrevious ? ++this.#frame : 0], 48);
    u.set([this.maxRoughness, this.thickness, this.edgeFade, this.maxSteps], 52);
    u.set([width, height, hiz.mipLevelCount, velocity ? 1 : 0], 56);
    const parameters = this.#arena.push(u);
    this.#previousViewProjection.set(view.viewProjection);
    this.#hasPrevious = true;

    this.#recordHiz(frame, depth, hiz);
    const [normalRoughness, specularWeight, environment] = surfaces as [GraphTexture, GraphTexture, GraphTexture];
    const trace = frame.acquire(width, height, TRACE_FORMAT, 'SSR trace');
    this.#trace.draw(frame, trace, [parameters, depth, hiz, normalRoughness]);
    const spatial = frame.acquire(width, height, REFLECTION_FORMAT, 'SSR spatial');
    this.#spatial.draw(frame, spatial, [parameters, trace, color, normalRoughness, depth, this.#sampler]);
    // 时间上的解析写进自己留到下一帧的贴图（图外面的）：算副作用
    const resolved = frame.graph.import({ label: 'SSR history', width, height, format: REFLECTION_FORMAT }, next.createView(), { texture: next });
    this.#temporal.draw(frame, resolved, [parameters, spatial, previous, velocity ?? previous, depth, this.#sampler]);
    const combined = frame.acquire(width, height, HDR_FORMAT, 'SSR combined');
    const debug = this.#arena.push([{ off: 0, hits: 1, reflection: 2 }[this.debug], 0, 0, 0]);
    this.#combine.draw(frame, combined, [color, resolved, specularWeight, environment, trace, debug]);
    return combined;
  }

  /** 这一帧录的通道执行完以后调。 */
  flush(): void {
    this.#arena.flush();
  }

  /** 相机切走了（换场景）：下一帧不和上一帧的结果累积。 */
  reset(): void {
    this.#hasPrevious = false;
  }

  /** 在后台编各步的管线（加载开着 SSR 的场景时，见 ForwardRenderer.warmPostEffects）；目标格式是固定的。 */
  warm(): Promise<void> {
    return Promise.all([
      this.#trace.warm([TRACE_FORMAT]), this.#spatial.warm([REFLECTION_FORMAT]), this.#temporal.warm([REFLECTION_FORMAT]), this.#combine.warm([HDR_FORMAT]),
      warmFullscreenPipeline(this.#device, 'SSR Hi-Z copy', HIZ_COPY_SHADER, [HIZ_FORMAT]),
      warmFullscreenPipeline(this.#device, 'SSR Hi-Z', HIZ_DOWNSAMPLE_SHADER, [HIZ_FORMAT]),
    ]).then(() => undefined);
  }

  destroy(): void {
    this.#hiz?.destroy();
    for (const texture of this.#history ?? []) texture.destroy();
    this.#arena.destroy();
  }

  /** Hi-Z 的各级：第 0 级拷深度，往下每级取 2x2 里最近的。写的是自己的贴图（图外面的）：算副作用。 */
  #recordHiz(frame: EffectFrame, depth: GPUTexture, hiz: GPUTexture): void {
    const warm = () => {
      const copy = warmFullscreenPipeline(this.#device, 'SSR Hi-Z copy', HIZ_COPY_SHADER, [HIZ_FORMAT]);
      const down = warmFullscreenPipeline(this.#device, 'SSR Hi-Z', HIZ_DOWNSAMPLE_SHADER, [HIZ_FORMAT]);
      return copy || down ? Promise.all([copy, down]).then(() => undefined) : undefined;
    };
    frame.pass('SSR Hi-Z', (pass) => pass.sideEffect(), () => {
      const copy = fullscreenPipeline(this.#device, 'SSR Hi-Z copy', HIZ_COPY_SHADER, [HIZ_FORMAT]);
      const down = fullscreenPipeline(this.#device, 'SSR Hi-Z', HIZ_DOWNSAMPLE_SHADER, [HIZ_FORMAT]);
      for (let level = 0; level < hiz.mipLevelCount; level++) {
        const pipeline = level === 0 ? copy : down;
        const source = level === 0 ? depth.createView() : hiz.createView({ baseMipLevel: level - 1, mipLevelCount: 1 });
        const pass = frame.encoder.beginRenderPass({
          label: 'SSR Hi-Z',
          colorAttachments: [{ view: hiz.createView({ baseMipLevel: level, mipLevelCount: 1 }), loadOp: 'clear', storeOp: 'store' }],
        });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, this.#device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: source }] }));
        pass.draw(3);
        pass.end();
      }
    }, warm);
  }

  #hizFor(width: number, height: number): GPUTexture {
    if (this.#hiz?.width === width && this.#hiz.height === height) return this.#hiz;
    this.#hiz?.destroy();
    // 一直缩到 1x1 太多了：最粗的一级大约 8 像素见方就够跳过大片的空处
    const levels = Math.max(1, Math.floor(Math.log2(Math.max(width, height))) - 2);
    this.#hiz = this.#device.createTexture({
      label: `SSR Hi-Z ${width}x${height}`, size: [width, height], format: HIZ_FORMAT, mipLevelCount: levels,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    return this.#hiz;
  }

  #historyFor(width: number, height: number): [GPUTexture, GPUTexture] {
    if (this.#history?.[0].width === width && this.#history[0].height === height) return this.#history;
    for (const texture of this.#history ?? []) texture.destroy();
    const create = () => this.#device.createTexture({
      label: `SSR history ${width}x${height}`, size: [width, height], format: REFLECTION_FORMAT, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.#history = [create(), create()];
    this.#hasPrevious = false;
    return this.#history;
  }
}

