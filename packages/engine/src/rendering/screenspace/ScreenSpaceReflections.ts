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
 *    噪声就平均掉了。粗糙的表面按锥角取颜色的 mip（Stachowiak 2015 的做法）：反射的波瓣是一个锥，命中处锥的截面有多大，就
 *    到颜色金字塔（这一帧的 HDR 画面一级级缩小的 mip 链，每级 4 个双线性样本的帐篷滤波）里取那么粗的一级，一个样本就是
 *    那一片的平均，噪声少得多，远处的反射也按距离变糊。
 * 4. 合成：用反射换掉着色时加的环境镜面反射（不透明阶段留下的表面，见 RenderSystem 的 SURFACE_FORMATS）：
 *    颜色 += 把握 · (w · 反射 - E)。和 Stride 不同：Stride 把反射直接加上去，天空盒的镜面反射就算了两遍，开了 SSR 的表面
 *    整体变亮。
 *
 * 只做粗糙度不超过 maxRoughness 的表面（Stride 的 GlossinessThreshold 0.55，即粗糙度 0.45）；更粗糙的反射在屏幕上没多少
 * 可看的，照旧用环境光。
 */
import { Matrix } from '../../data/Matrix';
import { GpuProfiler } from '../../graphics/GpuProfiler';
import { FULLSCREEN_VERTEX } from '../wgsl';
import type { GraphTexture } from '../RenderGraph';
import { fullscreenPipeline, FullscreenShader, UniformArena, warmFullscreenPipeline, type EffectFrame } from '../postfx/ImageEffect';
import type { RenderView } from '../RenderSystem';
import { SSR_COMMON_WGSL, SSR_SAMPLING_WGSL } from './reflectionWgsl';

const HIZ_FORMAT: GPUTextureFormat = 'r32float';
const TRACE_FORMAT: GPUTextureFormat = 'rgba16float';
const REFLECTION_FORMAT: GPUTextureFormat = 'rgba16float';
const HDR_FORMAT: GPUTextureFormat = 'rgba16float';
/** 颜色金字塔（第 0 级是半分辨率）。 */
const PYRAMID_FORMAT: GPUTextureFormat = 'rgba16float';
/** 锥角里去掉的波瓣尾巴（Stachowiak 2015 的 BRDF bias）：尾巴里的光线少，按整个波瓣算截面会糊过头。 */
const CONE_BIAS = 0.7;
/** 运动向量里"这个像素没画"的标记（同 ForwardRenderer）。 */
const NO_VELOCITY = 4;

const COMMON = SSR_COMMON_WGSL;

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
  // 存最近的：反向 Z 下近的深度大，取最大
  var m = max(max(at(p, size), at(p + vec2i(1, 0), size)), max(at(p + vec2i(0, 1), size), at(p + vec2i(1, 1), size)));
  let lastX = (size.x & 1) == 1 && p.x + 3 == size.x;
  let lastY = (size.y & 1) == 1 && p.y + 3 == size.y;
  if (lastX) { m = max(m, max(at(p + vec2i(2, 0), size), at(p + vec2i(2, 1), size))); }
  if (lastY) { m = max(m, max(at(p + vec2i(0, 2), size), at(p + vec2i(1, 2), size))); }
  if (lastX && lastY) { m = max(m, at(p + vec2i(2, 2), size)); }
  return vec4f(m, 0.0, 0.0, 1.0);
}`;

/**
 * 颜色金字塔往下一级：目标像素盖住上一级的 2x2，四个双线性样本取在离中心 0.75 纹素处，合起来是 4x4 的帐篷滤波
 * （每轴权重 1、3、3、1），一级级缩下去比 2x2 的盒子平滑，糊的反射里看不出方块。
 */
const PYRAMID_SHADER = /* wgsl */ `${FULLSCREEN_VERTEX}
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var linearClamp: sampler;
@fragment fn fs(in: FullscreenVaryings) -> @location(0) vec4f {
  let texel = 1.0 / vec2f(textureDimensions(source));
  let uv = in.position.xy * 2.0 * texel;
  let d = 0.75 * texel;
  return 0.25 * (textureSampleLevel(source, linearClamp, uv + vec2f(-d.x, -d.y), 0.0) + textureSampleLevel(source, linearClamp, uv + vec2f(d.x, -d.y), 0.0)
    + textureSampleLevel(source, linearClamp, uv + vec2f(-d.x, d.y), 0.0) + textureSampleLevel(source, linearClamp, uv + vec2f(d.x, d.y), 0.0));
}`;

/** 追踪：输出命中的 uv、把握（0 是没命中）。 */
const TRACE_SHADER = /* wgsl */ `${COMMON}
@group(0) @binding(0) var<uniform> ssr: Ssr;
@group(0) @binding(1) var depth: texture_depth_2d;
@group(0) @binding(2) var hiz: texture_2d<f32>;
@group(0) @binding(3) var surface: texture_2d<f32>;

const FLOAT_MAX = 3.402823466e38;

${SSR_SAMPLING_WGSL}
fn mipResolution(mip: i32) -> vec2f {
  return ssr.size.xy * exp2(-f32(mip));
}

/** 分层步进（FidelityFX SSSR 的 FFX_SSSR_HierarchicalRaymarch，反向 Z 那一支 FFX_SSSR_INVERTED_DEPTH_RANGE：Hi-Z 存最近的、近的深度大）。返回走到的位置和走了几步。 */
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
    // 往远处走的光线（反向 Z：深度变小）才会撞上这一格里最近的那个深度
    bounds.z = select(FLOAT_MAX, bounds.z, direction.z < 0.0);
    let tMin = min(min(bounds.x, bounds.y), bounds.z);
    let above = surfaceZ < position.z;
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
  let r = reflectionDirection(vec2u(pixel), u32(ssr.eye.w), n, v, roughness);
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
  if (distance(sceneWorld, rayWorld) > thickness || sceneZ <= 0.0) {
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
@group(0) @binding(6) var pyramid: texture_2d<f32>;
@group(0) @binding(7) var trilinearClamp: sampler;

/** 单位圆里的 8 个点（泊松盘），每个像素每帧转一个随机角度。 */
const DISK = array<vec2f, 8>(
  vec2f(-0.326, -0.406), vec2f(-0.840, -0.074), vec2f(-0.696, 0.457), vec2f(-0.203, 0.621),
  vec2f(0.962, -0.195), vec2f(0.473, -0.480), vec2f(0.519, 0.767), vec2f(0.185, -0.893),
);

/**
 * 命中处的颜色，mip 是按整个画面算的级数（0 是原画面，k 是金字塔的第 k - 1 级）：0 到 1 之间在原画面和金字塔第 0 级之间
 * 插值，再往上三线性地取金字塔。
 */
fn colorAt(uv: vec2f, mip: f32) -> vec3f {
  if (mip <= 0.0) {
    return textureSampleLevel(color, linearClamp, uv, 0.0).rgb;
  }
  let blurred = textureSampleLevel(pyramid, trilinearClamp, uv, max(mip - 1.0, 0.0)).rgb;
  if (mip >= 1.0) {
    return blurred;
  }
  return mix(textureSampleLevel(color, linearClamp, uv, 0.0).rgb, blurred, mip);
}

/**
 * 反射波瓣的锥角的正切（Stachowiak 2015 的近似，按感知粗糙度和 n·v）：越粗糙、越正对着看锥越宽；掠射角时波瓣被拉长，
 * 截面按 n·v 收窄一些。
 */
fn coneTangent(roughness: f32, nv: f32) -> f32 {
  let tangent = mix(0.0, roughness * (1.0 - ${CONE_BIAS}), nv * sqrt(roughness));
  return tangent * mix(saturate(nv * 2.0), 1.0, sqrt(roughness));
}

/** 太亮的点（太阳的高光）压一下，免得随机方向偶尔碰上它时一闪一闪（Stride 的 ReduceHighlights）；合成时放回去。 */
fn compress(color: vec3f) -> vec3f {
  return color / (1.0 + max(max(color.r, color.g), color.b));
}

/**
 * 一条光线的样本；cone 是这个表面的锥角正切，uv 是这个像素（锥从这里出发，到命中处的屏幕距离定截面多大）。屏幕上没找到（或者
 * 把握不足）的那部分用光追的（同一条光线）。
 */
fn sampleAt(pixel: vec2i, uv: vec2f, cone: f32) -> vec4f {
  let hit = textureLoad(trace, pixel, 0);
  var sum = vec4f(0.0);
  if (hit.z > 0.0) {
    let radius = cone * length((hit.xy - uv) * ssr.size.xy);
    let mip = clamp(log2(max(radius, 1e-4)), 0.0, f32(textureNumLevels(pyramid)));
    sum = vec4f(compress(colorAt(hit.xy, mip)) * hit.z, hit.z);
  }
  return sum;
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
  let cone = coneTangent(here.z, saturate(dot(n, (ssr.eye.xyz - world) / distanceToEye)));
  // 半径：镜面（粗糙度 0）只看自己附近 1 像素，到最大粗糙度时 8 像素
  let radius = mix(1.0, 8.0, saturate(here.z / max(ssr.params.x, 0.0001)));
  let angle = fract(sin(dot(vec2f(pixel), vec2f(12.9898, 78.233)) + ssr.eye.w * 0.618) * 43758.547) * 6.2831853;
  let rotation = mat2x2f(cos(angle), sin(angle), -sin(angle), cos(angle));
  var sum = sampleAt(pixel, uv, cone);
  var weight = 1.0;
  for (var k = 0; k < 8; k++) {
    let p = pixel + vec2i(round(rotation * DISK[k] * radius));
    if (any(p < vec2i(0)) || any(p >= size)) { continue; }
    // 只用同一块表面上的：法线相近、深度相近（按到相机的距离的比例）
    let other = textureLoad(surface, p, 0);
    if (other.w < 0.5 || dot(octahedralDecode(other.xy), n) < 0.9) { continue; }
    let otherWorld = worldPosition(ssr, (vec2f(p) + 0.5) / ssr.size.xy, textureLoad(depth, p, 0));
    if (abs(dot(otherWorld - world, n)) > 0.02 * distanceToEye) { continue; }
    sum += sampleAt(p, uv, cone);
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
  /** 光追的反射；record 时给了光追的输入才用。 */

  readonly #device: GPUDevice;
  readonly #sampler: GPUSampler;
  readonly #trilinear: GPUSampler;
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
    this.#trilinear = device.createSampler({ label: 'SSR trilinear clamp', magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear' });
    this.#arena = new UniformArena(device, 4096);
    this.#trace = new FullscreenShader(device, 'SSR trace', TRACE_SHADER);
    this.#spatial = new FullscreenShader(device, 'SSR spatial', SPATIAL_SHADER);
    this.#temporal = new FullscreenShader(device, 'SSR temporal', TEMPORAL_SHADER);
    this.#combine = new FullscreenShader(device, 'SSR combine', COMBINE_SHADER);
  }

  /**
   * 往这一帧的渲染图里加反射的通道：color 是画好的 HDR 画面，depth 是它的深度，surfaces 是不透明阶段留下的表面
   * （SURFACE_FORMATS 的顺序），velocity 是运动向量（TAA 开着时有）。返回合成了反射的新画面（屏幕上找不到的由反射探针、
   * 天空盒补，在网格着色时的环境镜面反射里）。
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
    const pyramid = this.#recordPyramid(frame, color);
    this.#spatial.draw(frame, spatial, [parameters, trace, color, normalRoughness, depth, this.#sampler, pyramid, this.#trilinear]);
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
      warmFullscreenPipeline(this.#device, 'SSR color pyramid', PYRAMID_SHADER, [PYRAMID_FORMAT]),
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
        const timestampWrites = GpuProfiler.of(this.#device)?.passTimestamps('SSR Hi-Z');
        const pass = frame.encoder.beginRenderPass({
          label: 'SSR Hi-Z',
          ...(timestampWrites ? { timestampWrites } : {}),
          colorAttachments: [{ view: hiz.createView({ baseMipLevel: level, mipLevelCount: 1 }), loadOp: 'clear', storeOp: 'store' }],
        });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, this.#device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: source }] }));
        pass.draw(3);
        pass.end();
      }
    }, warm);
  }

  /**
   * 颜色金字塔：第 0 级是画面的一半大，往下每级再缩一半，到大约 8 像素见方（同 Hi-Z）。临时贴图（渲染图的），每级一次全屏绘制，
   * 读上一级（第 0 级读画面）。
   */
  #recordPyramid(frame: EffectFrame, color: GraphTexture): GraphTexture {
    const width = Math.max(1, color.width >> 1), height = Math.max(1, color.height >> 1);
    const levels = Math.max(1, Math.floor(Math.log2(Math.max(width, height))) - 2);
    const pyramid = frame.graph.texture({ label: 'SSR color pyramid', width, height, format: PYRAMID_FORMAT, mipLevelCount: levels });
    const label = 'SSR color pyramid';
    frame.pass(label, (pass) => {
      pass.read(color);
      pass.write(pyramid);
    }, (real) => {
      const pipeline = fullscreenPipeline(this.#device, label, PYRAMID_SHADER, [PYRAMID_FORMAT]);
      const target = real.texture(pyramid);
      for (let level = 0; level < levels; level++) {
        const source = level === 0 ? real.view(color) : target.createView({ baseMipLevel: level - 1, mipLevelCount: 1 });
        const timestampWrites = GpuProfiler.of(this.#device)?.passTimestamps(label);
        const pass = frame.encoder.beginRenderPass({
          label,
          ...(timestampWrites ? { timestampWrites } : {}),
          colorAttachments: [{ view: target.createView({ baseMipLevel: level, mipLevelCount: 1 }), loadOp: 'clear', storeOp: 'store' }],
        });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, this.#device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: source }, { binding: 1, resource: this.#sampler }] }));
        pass.draw(3);
        pass.end();
      }
    }, () => warmFullscreenPipeline(this.#device, label, PYRAMID_SHADER, [PYRAMID_FORMAT]));
    return pyramid;
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

