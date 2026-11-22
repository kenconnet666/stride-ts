/**
 * 水体的渲染器（RenderSystem.water，W6；组件、资源、占的地方在 Water.ts）。画法参考 WickedEngine 的
 * ocean（屏幕空间的折射、按水深的吸收、岸边泡沫）和 GPU Gems 第 1 章的 Gerstner 波，按我们的规模做成一个自带管线的渲染器
 * （同高斯泼溅）：
 * - 网格：以相机为中心的极坐标网格（近处密、往外按几何级数变疏，铺到 extent），顶点着色器把它放到水面上、叠 6 组 Gerstner 波
 *   （按世界坐标算：相机动了浪不跟着跑），远处的浪渐渐压平。湖的岸线在片元里裁（点在多边形里），比地面低的部分被地形的深度挡住。
 * - 着色：每个像素重算浪的法线，叠几组短的波纹；反射天空（天空的镜面立方体贴图）、太阳的高光（GGX），按菲涅耳混；水下是主画面
 *   不透明的那份拷贝（rendering/screenspace/Refraction.ts，和透射材质共用），按法线偏开、按光在水里走的路程吸收（清澈度），越深越
 *   接近水的颜色；岸边按水深起泡沫，和地面相交的地方按水深淡出（没有硬边）。
 * - 河（文件的 river）：沿样条的一条带子（riverRibbon），水面在样条下面一点，不叠大浪；波纹顺着样条的方向流（Valve 的 flow map：
 *   两个相位错开半个周期地平移、交替淡入淡出，不会越拉越长），越快越碎，带子的两边淡出。
 * - 倒影：水的实体上再挂一个 PlanarReflection（平面在水面上）时，这一帧画的平面反射图（rendering/lighting/PlanarReflections.ts）
 *   就是水面的倒影：按屏幕坐标（u 翻回来）取、按法线偏开；浪陡的地方倒影不准，退回天空的反射（同 WickedEngine）。
 * - 水下（相机低于湖、海的水面，在岸线里）：先画一遍全屏的水下雾（按场景的深度用水的颜色和清澈度盖上，天空也被盖住），水面从
 *   下面看时法线反过来，透过水面看上面（那份拷贝），超过全反射的临界角（水的折射率 1.33）反射水的颜色，水面本身也按距离加雾。
 * - 海浪谱（文件的 waves.spectrum）：浪不用 Gerstner，用 FFT 算的三级平铺的位移图（world/OceanFFT.ts，每帧合成器在主画面之前
 *   simulate）：顶点按网格的疏密取对应的 mip 级叠位移，片元取斜率算法线，位移的雅可比小于阈值（浪尖挤在一起）的地方起白沫。
 * - 下雨（天气的 rain，RenderSystem.surfaceWeather）：水面上一圈圈的雨点涟漪（同地面水洼的 rippleGradient），雨越大越密。
 * - 只画主画面（要那份拷贝），在不透明的之后、透明的之前，读深度、不写。
 */
import { WATER_MAX_OUTLINE } from '../content/formats/waterFormat';
import type { EntityId } from '../data/prop';
import { shaderTime } from '../engine/GameTime';
import { system } from '../engine/system';
import { Transform } from '../engine/transform';
import type { GpuResources } from '../graphics/GpuResources';
import { Skybox } from '../rendering/lighting/Skybox';
import type { Lighting, RenderContext, RenderView } from '../rendering/RenderSystem';
import type { Refraction } from '../rendering/screenspace/Refraction';
import type { PlanarReflections } from '../rendering/lighting/PlanarReflections';
import { RAIN_RIPPLES } from '../rendering/wgsl';
import { OCEAN_CASCADES, OCEAN_SIZE, OceanFFT, oceanPatches, windSeaHeight, type OceanSettings } from './OceanFFT';
import { insidePolygon, RIVER_VERTEX_FLOATS, Water, WaterAsset } from './Water';

/** 极坐标网格：几圈、每圈几段。 */
const RINGS = 160;
const SEGMENTS = 192;
/** 常量的字节数（见着色器的 WaterParams）。 */
const HEADER_FLOATS = 104;
const UNIFORM_FLOATS = HEADER_FLOATS + (WATER_MAX_OUTLINE / 2) * 4;
/** 海浪谱的浪尖白沫：位移的雅可比低于它的地方起沫。 */
const CREST_FOAM = 0.75;

const SHADER = /* wgsl */ `
${RAIN_RIPPLES}
struct WaterParams {
  viewProjection: mat4x4f,
  inverseViewProjection: mat4x4f,
  // 相机（渲染空间）、着色用的时间
  eye: vec4f,
  // 朝太阳的方向、天空的强度（0 是没有天空盒）
  sun: vec4f,
  // 太阳的颜色乘强度、天空镜面贴图的级数
  sunColor: vec4f,
  ambient: vec4f,
  skyRotation: mat4x4f,
  // 水面的原点（渲染空间）、铺多远
  origin: vec4f,
  // 本地 X 轴在世界 xz 里的方向；岸线的点数（0 是海）
  axis: vec4f,
  // 深处的颜色、清澈度（米）
  color: vec4f,
  // 浪：高、最长的波长、方向（弧度，世界的）、快慢
  waves: vec4f,
  // 尖、岸边泡沫多宽
  waves2: vec4f,
  // 渲染原点取模的 xz（浪按世界坐标排，原点换了不跳）
  pattern: vec4f,
  // 1 / 画面宽、1 / 画面高
  screen: vec4f,
  // 平面反射：用不用（1/0，平面在这片水面上）、最粗的 mip 级；雨多大（0..1）
  planar: vec4f,
  // 海浪谱：三级一块的边长（米）、用不用（1/0）；浪尖起沫的雅可比阈值
  ocean: vec4f,
  ocean2: vec4f,
  outline: array<vec4f, ${WATER_MAX_OUTLINE / 2}>,
};
@group(0) @binding(0) var<uniform> water: WaterParams;
@group(0) @binding(1) var scene: texture_2d<f32>;
@group(0) @binding(2) var sceneDepth: texture_depth_2d;
@group(0) @binding(3) var sky: texture_cube<f32>;
@group(0) @binding(4) var linearClamp: sampler;
@group(0) @binding(5) var reflection: texture_2d<f32>;
@group(0) @binding(6) var oceanDisplacement: texture_2d_array<f32>;
@group(0) @binding(7) var oceanDerivatives: texture_2d_array<f32>;
@group(0) @binding(8) var linearRepeat: sampler;

const PI = 3.14159265;
const WAVES = 6u;
// 每组浪：方向相对主方向转多少（弧度）、波长、振幅的比例
const WAVE_TABLE = array<vec3f, 6>(
  vec3f(0.0, 1.0, 1.0), vec3f(0.45, 0.61, 0.6), vec3f(-0.38, 0.43, 0.45),
  vec3f(0.9, 0.29, 0.3), vec3f(-0.8, 0.19, 0.2), vec3f(1.6, 0.13, 0.12));

struct Wave { offset: vec3f, normal: vec3f };

/** p 处（世界的 xz，加了取模的原点）的 Gerstner 浪：位移和法线。fade 把振幅压下去（远处）。 */
fn gerstner(p: vec2f, fade: f32) -> Wave {
  var offset = vec3f(0.0);
  var nx = 0.0;
  var ny = 1.0;
  var nz = 0.0;
  let t = water.eye.w * water.waves.w;
  for (var i = 0u; i < WAVES; i++) {
    let row = WAVE_TABLE[i];
    let angle = water.waves.z + row.x;
    let d = vec2f(cos(angle), sin(angle));
    let length = max(water.waves.y * row.y, 0.05);
    let k = 2.0 * PI / length;
    let a = water.waves.x * 0.5 * row.z * fade;
    let q = select(0.0, min(water.waves2.x / (k * a * f32(WAVES)), 1.0), a > 1e-5);
    let theta = k * dot(d, p) - sqrt(9.81 * k) * t;
    let c = cos(theta);
    let s = sin(theta);
    offset += vec3f(q * a * d.x * c, a * s, q * a * d.y * c);
    nx -= d.x * k * a * c;
    nz -= d.y * k * a * c;
    ny -= q * k * a * s;
  }
  return Wave(offset, normalize(vec3f(nx, ny, nz)));
}

/** p 处海浪谱的位移（三级相加）；spacing 是网格在这里的间距（米），按它挑 mip 级（顶点比格子疏时取平均过的）。 */
fn oceanOffset(p: vec2f, spacing: f32) -> vec3f {
  var offset = vec3f(0.0);
  for (var c = 0u; c < ${OCEAN_CASCADES}u; c++) {
    let tile = water.ocean[c];
    let lod = max(log2(spacing * ${OCEAN_SIZE}.0 / tile), 0.0);
    offset += textureSampleLevel(oceanDisplacement, linearRepeat, p / tile, c, lod).xyz;
  }
  return offset;
}

/** p 处海浪谱的法线（xyz）和浪尖的白沫（w，0..1）；dpx、dpy 是 p 在屏幕上的导数（挑 mip 级）。 */
fn oceanSurface(p: vec2f, dpx: vec2f, dpy: vec2f) -> vec4f {
  var slope = vec2f(0.0);
  var jxx = 1.0;
  var jzz = 1.0;
  var jxz = 0.0;
  for (var c = 0u; c < ${OCEAN_CASCADES}u; c++) {
    let tile = water.ocean[c];
    let uv = p / tile;
    let d = textureSampleGrad(oceanDerivatives, linearRepeat, uv, c, dpx / tile, dpy / tile);
    slope += d.xy;
    jxx += d.z;
    jzz += d.w;
    jxz += textureSampleGrad(oceanDisplacement, linearRepeat, uv, c, dpx / tile, dpy / tile).w;
  }
  // 水平位移把格子挤扁了：斜率按挤的程度放大（法线是位移后的曲面的）
  let n = normalize(vec3f(-slope.x / max(jxx, 0.2), 1.0, -slope.y / max(jzz, 0.2)));
  let jacobian = jxx * jzz - jxz * jxz;
  return vec4f(n, saturate((water.ocean2.x - jacobian) * 2.5));
}

struct Varyings {
  @builtin(position) position: vec4f,
  @location(0) world: vec3f,
  @location(1) plane: vec2f,
  @location(2) fade: f32,
  // 河：流的速度（世界的 xz，米每秒）、横向（−1..1，两边淡出）；湖、海是 0
  @location(3) flow: vec2f,
  @location(4) across: f32,
};

fn ringRadius(ring: u32) -> f32 {
  if (ring == 0u) { return 0.0; }
  let near = 0.4;
  return near * pow(max(water.origin.w, near * 2.0) / near, f32(ring - 1u) / f32(${RINGS - 1}));
}

@vertex fn vs(@builtin(vertex_index) index: u32) -> Varyings {
  let quad = index / 6u;
  let corner = array<vec2u, 6>(vec2u(0u, 0u), vec2u(1u, 0u), vec2u(1u, 1u), vec2u(0u, 0u), vec2u(1u, 1u), vec2u(0u, 1u))[index % 6u];
  let ring = quad / ${SEGMENTS}u + corner.x;
  let angle = f32(quad % ${SEGMENTS}u + corner.y) / f32(${SEGMENTS}) * 2.0 * PI;
  let r = ringRadius(ring);
  let plane = water.eye.xz + vec2f(cos(angle), sin(angle)) * r;
  var out: Varyings;
  var fade: f32;
  var offset: vec3f;
  if (water.ocean.w > 0.5) {
    // 海浪谱：最大一块的十几倍以外压平；网格的间距大约是 r · 2π / SEGMENTS
    fade = saturate(1.0 - r / (water.ocean.x * 15.0));
    offset = oceanOffset(plane + water.pattern.xy, max(r, 0.4) * ${(2 * Math.PI) / SEGMENTS}) * fade;
  } else {
    // 离相机几十个波长以外的浪压平（远处一个像素里好多个浪，只会闪）
    fade = saturate(1.0 - r / (water.waves.y * 40.0));
    offset = gerstner(plane + water.pattern.xy, fade).offset;
  }
  out.world = vec3f(plane.x, water.origin.y, plane.y) + offset;
  out.plane = plane;
  out.fade = fade;
  out.position = water.viewProjection * vec4f(out.world, 1.0);
  out.flow = vec2f(0.0);
  out.across = 0.0;
  return out;
}

/** 河的水面（riverRibbon 的顶点，本地坐标）：按实体的位置和绕 Y 的转角放到世界里，流向跟着转。 */
@vertex fn vsRiver(@location(0) a: vec4f, @location(1) b: vec4f) -> Varyings {
  let axis = water.axis.xy;
  let turn = mat2x2f(axis.x, axis.y, -axis.y, axis.x);
  let xz = water.origin.xz + turn * a.xz;
  var out: Varyings;
  out.world = vec3f(xz.x, water.origin.y + a.y, xz.y);
  out.plane = xz;
  out.fade = 0.0;
  out.flow = turn * b.xy * water.waves2.z;
  out.across = b.z;
  out.position = water.viewProjection * vec4f(out.world, 1.0);
  return out;
}

/** p 处几组短的波纹的法线扰动（xz），strength 是幅度。 */
fn ripples(p: vec2f, strength: f32, t: f32) -> vec2f {
  var slope = vec2f(0.0);
  for (var i = 0u; i < 4u; i++) {
    let angle = f32(i) * 2.4 + 0.5;
    let d = vec2f(cos(angle), sin(angle));
    let k = 2.0 * PI / (0.6 + f32(i) * 0.7);
    let theta = k * dot(d, p) - sqrt(9.81 * k) * t * 0.3;
    slope += d * strength * cos(theta);
  }
  return slope;
}

/** 河的法线：波纹顺着 flow 平移，两个相位错开半个周期、交替淡入淡出（flow map）。 */
fn riverNormal(p: vec2f, flow: vec2f, t: f32) -> vec3f {
  let speed = length(flow);
  let strength = 0.06 + 0.04 * min(speed, 3.0);
  let phase0 = fract(t * 0.3);
  let phase1 = fract(t * 0.3 + 0.5);
  let weight = 1.0 - abs(phase0 * 2.0 - 1.0);
  let s0 = ripples(p - flow * phase0 * 3.3, strength, t);
  let s1 = ripples(p - flow * phase1 * 3.3 + vec2f(3.7, 1.3), strength, t);
  let slope = s0 * weight + s1 * (1.0 - weight);
  return normalize(vec3f(-slope.x, 1.0, -slope.y));
}

/** 本地的点在岸线里（奇偶规则）。 */
fn insideOutline(p: vec2f) -> bool {
  let count = u32(water.axis.w);
  var inside = false;
  var j = count - 1u;
  for (var i = 0u; i < count; i++) {
    let a = select(water.outline[i / 2u].xy, water.outline[i / 2u].zw, (i & 1u) == 1u);
    let b = select(water.outline[j / 2u].xy, water.outline[j / 2u].zw, (j & 1u) == 1u);
    if ((a.y > p.y) != (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
    j = i;
  }
  return inside;
}

fn skyDirection(direction: vec3f) -> vec3f {
  let rotation = mat3x3f(water.skyRotation[0].xyz, water.skyRotation[1].xyz, water.skyRotation[2].xyz);
  let d = direction * rotation;
  return vec3f(d.xy, -d.z);
}

/** 画面上 uv、深度 depth 处的世界位置（渲染空间）。 */
fn scenePosition(uv: vec2f, depth: f32) -> vec3f {
  let clip = water.inverseViewProjection * vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, depth, 1.0);
  return clip.xyz / clip.w;
}

/** 水里散射出来的光照：天光（天空的球谐朝上那一半、环境光）和太阳。 */
fn lightInWater() -> vec3f {
  let skyIntensity = water.sun.w;
  return water.ambient.rgb + select(vec3f(0.0), textureSampleLevel(sky, linearClamp, skyDirection(vec3f(0.0, 1.0, 0.0)), max(water.sunColor.w - 1.0, 0.0)).rgb * skyIntensity, skyIntensity > 0.0)
    + water.sunColor.rgb * max(water.sun.y, 0.0) * 0.25;
}

/** 从水下看水面：法线朝下，透过水面看上面（超过临界角全反射成水的颜色），再按距离加水下的雾。 */
fn underside(in: Varyings, up: vec3f, viewDistance: f32) -> vec4f {
  let n = -up;
  let v = (water.eye.xyz - in.world) / max(viewDistance, 1e-4);
  let cosI = max(dot(n, v), 0.0);
  // 水的折射率 1.33：sin(折射角) = 1.33 · sin(入射角)，超过 1 就出不去
  let sinOut2 = (1.0 - cosI * cosI) * 1.7689;
  let fresnel = select(0.02 + 0.98 * pow(1.0 - sqrt(max(1.0 - sinOut2, 0.0)), 5.0), 1.0, sinOut2 >= 1.0);
  let screen = in.position.xy * water.screen.xy;
  let above = textureSampleLevel(scene, linearClamp, clamp(screen + up.xz * 0.03, vec2f(0.0), vec2f(1.0)), 0.0).rgb;
  let fog = water.color.rgb * lightInWater();
  var color = mix(above, fog, fresnel);
  color = mix(color, fog, 1.0 - exp(-viewDistance / water.color.w));
  return vec4f(color, 1.0);
}

@vertex fn vsFull(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((index << 1u) & 2u), f32(index & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}

/** 相机在水下：整个画面按到场景的距离盖上水的颜色（天空的像素算无穷远）。 */
@fragment fn fsUnderwater(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let size = vec2f(textureDimensions(sceneDepth));
  let pixel = vec2i(clamp(position.xy, vec2f(0.0), size - 1.0));
  let depth = textureLoad(sceneDepth, pixel, 0);
  let distanceTo = select(distance(scenePosition(position.xy * water.screen.xy, depth), water.eye.xyz), 1e6, depth <= 0.0);
  let color = textureLoad(scene, pixel, 0).rgb;
  return vec4f(mix(color, water.color.rgb * lightInWater(), 1.0 - exp(-distanceTo / water.color.w)), 1.0);
}

@fragment fn fs(in: Varyings) -> @location(0) vec4f {
  let river = water.waves2.w > 0.5;
  let p = in.plane + water.pattern.xy;
  // 导数在裁岸线之前取（之后的控制流不一致）
  let dpx = dpdx(p);
  let dpy = dpdy(p);
  if (!river && water.axis.w > 0.0) {
    let d = in.plane - water.origin.xz;
    let local = vec2f(dot(d, water.axis.xy), dot(d, vec2f(-water.axis.y, water.axis.x)));
    if (!insideOutline(local)) {
      discard;
    }
  }
  let toEye = water.eye.xyz - in.world;
  let viewDistance = length(toEye);
  let t = water.eye.w * water.waves.w;
  var n: vec3f;
  var crest = 0.0;
  if (river) {
    n = riverNormal(p, in.flow, water.eye.w);
  } else if (water.ocean.w > 0.5) {
    let ocean = oceanSurface(p, dpx, dpy);
    n = ocean.xyz;
    crest = ocean.w;
  } else {
    n = gerstner(p, in.fade).normal;
    // 近处叠几组短的波纹（风吹的细浪），远处淡掉
    let ripple = saturate(1.0 - viewDistance / 80.0) * 0.12;
    for (var i = 0u; i < 3u; i++) {
      let angle = water.waves.z + f32(i) * 2.1 + 0.7;
      let d = vec2f(cos(angle), sin(angle));
      let k = 2.0 * PI / (0.7 + f32(i) * 0.55);
      let theta = k * dot(d, p) - sqrt(9.81 * k) * t;
      n.x -= d.x * ripple * cos(theta);
      n.z -= d.y * ripple * cos(theta);
    }
    n = normalize(n);
  }
  // 下雨：雨点的涟漪（近处才看得出来）
  let rain = water.planar.z;
  if (rain > 0.0 && viewDistance < 60.0) {
    let g = rippleGradient(p, water.eye.w, rain) * (1.0 - viewDistance / 60.0);
    n = normalize(n + vec3f(-g.x, 0.0, -g.y));
  }
  // 相机在水面下面：从下面看
  if (water.eye.y < in.world.y) {
    return underside(in, n, viewDistance);
  }
  let v = toEye / max(viewDistance, 1e-4);
  let nDotV = max(dot(n, v), 0.001);
  let fresnel = 0.02 + 0.98 * pow(1.0 - nDotV, 5.0);

  // 反射：天空（地平线以下的反射方向抬到地平线上）
  var r = reflect(-v, n);
  r.y = max(r.y, 0.02);
  let skyIntensity = water.sun.w;
  var reflected = select(water.ambient.rgb, textureSampleLevel(sky, linearClamp, skyDirection(normalize(r)), 0.0).rgb * skyIntensity, skyIntensity > 0.0);
  // 倒影（平面反射图：左右翻过的，按屏幕坐标取时 u 翻回来，按法线偏开）；浪越陡越不准，退回天空
  if (water.planar.x > 0.5) {
    let screenUv = in.position.xy * water.screen.xy;
    let mirrored = vec2f(1.0 - screenUv.x, screenUv.y) + vec2f(-n.x, n.z) * 0.06;
    let flatR = reflect(-v, vec3f(0.0, 1.0, 0.0));
    let trust = smoothstep(0.95, 1.0, dot(flatR, normalize(r)));
    let image = textureSampleLevel(reflection, linearClamp, clamp(mirrored, vec2f(0.001), vec2f(0.999)), 0.0).rgb;
    reflected = mix(reflected, image, trust);
  }
  // 太阳的高光（GGX，很光滑）
  let l = water.sun.xyz;
  let h = normalize(l + v);
  let nDotH = max(dot(n, h), 0.0);
  let alpha2 = 0.0036;
  let dTerm = alpha2 / (PI * pow(nDotH * nDotH * (alpha2 - 1.0) + 1.0, 2.0));
  let specular = water.sunColor.rgb * dTerm * fresnel * 0.25 * max(dot(n, l), 0.0) / max(nDotV, 0.2);

  // 水下：主画面那份拷贝。先按没偏的位置量水深，再按水深偏开（浅的地方偏得少）
  let screen = in.position.xy * water.screen.xy;
  let size = vec2f(textureDimensions(sceneDepth));
  let flatDepth = textureLoad(sceneDepth, vec2i(clamp(in.position.xy, vec2f(0.0), size - 1.0)), 0);
  let flatScene = scenePosition(screen, flatDepth);
  let path = max(distance(flatScene, water.eye.xyz) - viewDistance, 0.0);
  var uv = screen + n.xz * 0.04 * saturate(path * 0.5);
  let bentDepth = textureLoad(sceneDepth, vec2i(clamp(uv * size, vec2f(0.0), size - 1.0)), 0);
  let bentScene = scenePosition(uv, bentDepth);
  var through = distance(bentScene, water.eye.xyz) - viewDistance;
  // 偏到了水面前面的东西上：退回没偏的
  if (through < 0.0) {
    uv = screen;
    through = path;
  }
  let below = textureSampleLevel(scene, linearClamp, uv, 0.0).rgb;
  let transmittance = exp(-through / water.color.w);
  // 水里散射出来的光：水的颜色，被天光和太阳照着
  let lightIn = lightInWater();
  let underwater = mix(water.color.rgb * lightIn, below * mix(vec3f(1.0), water.color.rgb * 8.0, 1.0 - transmittance), transmittance);
  var color = mix(underwater, reflected, fresnel) + specular;

  // 岸边的泡沫：按竖直的水深，碎成一块一块
  let depthBelow = in.world.y - flatScene.y;
  let shore = water.waves2.y;
  if (shore > 0.0) {
    let wobble = sin(dot(p, vec2f(1.7, 0.9)) * 2.3 + t * 1.3) * sin(dot(p, vec2f(-0.8, 1.6)) * 3.1 - t) * 0.5 + 0.5;
    let foam = saturate((1.0 - depthBelow / shore) * (0.55 + 0.9 * wobble));
    color = mix(color, lightIn * 0.9, foam * 0.8);
  }
  // 浪尖的白沫（海浪谱）：碎成一块一块
  if (crest > 0.0) {
    let breakup = sin(dot(p, vec2f(2.3, 1.1)) * 1.7 - t * 0.8) * sin(dot(p, vec2f(-1.2, 2.1)) * 2.3 + t * 0.6) * 0.5 + 0.5;
    color = mix(color, lightIn * 0.85, saturate(crest * (0.6 + 0.8 * breakup)));
  }
  // 和地面相交的地方按水深淡出；河的带子两边也淡出
  let edge = saturate(depthBelow / 0.08) * (1.0 - smoothstep(0.8, 1.0, abs(in.across)));
  return vec4f(color, edge);
}
`;

interface WaterPipeline {
  readonly pipeline: GPURenderPipeline;
  readonly river: GPURenderPipeline;
  /** 相机在水下时的全屏的雾。 */
  readonly underwater: GPURenderPipeline;
  readonly layout: GPUBindGroupLayout;
  readonly key: string;
}

interface Instance {
  readonly buffer: GPUBuffer;
  /** 海浪谱的模拟（文件写了 waves.spectrum 时）。 */
  ocean?: OceanFFT;
  /** 河的水面网格（GPU 上的），和它对应的资源。 */
  ribbon?: { readonly asset: WaterAsset; readonly buffer: GPUBuffer; readonly count: number };
  group: GPUBindGroup | undefined;
  /** 建绑定组时用的贴图（换了要重建）。 */
  key: readonly unknown[];
}

/** 水体的渲染器（RenderSystem.water）：合成器每帧 collect，主画面的透明那一遍里 draw。 */
export class WaterRenderer {
  readonly #device: GPUDevice;
  readonly #resources: GpuResources;
  readonly #instances = new Map<EntityId, Instance>();
  readonly #data = new Float32Array(UNIFORM_FLOATS);
  #frame: { id: EntityId; asset: WaterAsset; world: Float32Array }[] = [];
  #pipeline: WaterPipeline | undefined;
  /** 没有海浪谱时绑上的空贴图（1 × 1 × 三层）。 */
  #noOcean: GPUTexture | undefined;

  readonly #collect = system('WaterRenderer.collect', {
    with: { water: Water, transform: Transform },
    update: ({ water, transform, count, entities }) => {
      for (let i = 0; i < count; i++) {
        const asset = WaterAsset.byId(water.water[i]!);
        if (!asset) continue;
        const w = transform.slot[i]! * 16;
        this.#frame.push({ id: entities[i]!, asset, world: transform.renderWorld.slice(w, w + 16) });
      }
    },
  });

  constructor(device: GPUDevice, resources: GpuResources) {
    this.#device = device;
    this.#resources = resources;
  }

  /** 这一帧有没有水要画（合成器按它决定要不要拷主画面）。 */
  get active(): boolean {
    return this.#frame.length > 0;
  }

  /** 这一帧有没有海浪谱要算（合成器按它在主画面之前 simulate）。 */
  get oceans(): boolean {
    return this.#frame.some((item) => item.asset.file.waves?.spectrum !== undefined && !item.asset.river);
  }

  /** 在主画面之前：这一帧要画的海浪谱各算一遍（按游戏时间乘浪的快慢）。 */
  simulate(encoder: GPUCommandEncoder, context: RenderContext, timestampWrites?: GPUComputePassTimestampWrites): void {
    for (const { id, asset, world } of this.#frame) {
      const settings = asset.river ? undefined : oceanSettings(asset, world);
      if (!settings) continue;
      const instance = this.#instanceFor(id, asset);
      instance.ocean ??= new OceanFFT(this.#device);
      instance.ocean.simulate(encoder, settings, context.time.total * (asset.file.waves?.speed ?? 1), timestampWrites);
    }
  }

  /** 合成器每帧开头：这一帧的水体。 */
  collect(context: RenderContext): void {
    this.#frame = [];
    context.game.entities.run(this.#collect, context.time);
    for (const [id, instance] of this.#instances) {
      if (this.#frame.some((item) => item.id === id)) continue;
      instance.buffer.destroy();
      instance.ribbon?.buffer.destroy();
      instance.ocean?.destroy();
      this.#instances.delete(id);
    }
  }

  /**
   * 在主画面透明的那一遍里画（拷贝了不透明的画面之后）。lighting 是这一帧的光照，origin 是渲染原点（浪按世界坐标排）。
   */
  draw(pass: GPURenderPassEncoder, context: RenderContext, view: RenderView, lighting: Lighting, refraction: Refraction, planar: PlanarReflections, rain: number, origin: readonly number[], colorFormat: GPUTextureFormat, depthFormat: GPUTextureFormat): void {
    const scene = refraction.texture, depth = refraction.depthTexture;
    if (this.#frame.length === 0 || !scene || !depth) return;
    const { pipeline, river, underwater, layout } = this.#pipelineFor(colorFormat, depthFormat);
    const skybox = lighting.skybox;
    const sky = !skybox ? this.#resources.blackCube : skybox.skybox instanceof Skybox ? this.#resources.skyboxSpecular(skybox.skybox) : skybox.skybox.specular;
    // 太阳：投阴影的那盏方向光，没有就第一盏
    const sunIndex = lighting.shadowLight >= 0 ? lighting.shadowLight : 0;
    const sun = lighting.directionalCount > 0 ? lighting.directionals[sunIndex] : undefined;
    const data = this.#data;
    data.set(view.viewProjection, 0);
    data.set(view.inverseViewProjection, 16);
    data.set([view.eye.x, view.eye.y, view.eye.z, shaderTime(context.time.total)], 32);
    if (sun) {
      const d = sun.direction, length = Math.hypot(d.x, d.y, d.z) || 1;
      data.set([-d.x / length, -d.y / length, -d.z / length, skybox?.intensity ?? 0], 36);
      data.set([sun.color.r, sun.color.g, sun.color.b, skybox?.skybox.specularLevels ?? 1], 40);
    } else {
      data.set([0, 1, 0, skybox?.intensity ?? 0], 36);
      data.set([0, 0, 0, skybox?.skybox.specularLevels ?? 1], 40);
    }
    data.set([lighting.ambient.r, lighting.ambient.g, lighting.ambient.b, 0], 44);
    data.set(skybox ? skybox.rotation : IDENTITY, 48);
    data.set([origin[0]! % 65536, origin[2]! % 65536, 0, 0], 84);
    data.set([1 / view.width, 1 / view.height, view.width, view.height], 88);
    for (const { id, asset, world } of this.#frame) {
      const file = asset.file;
      const instance = this.#instanceFor(id, asset);
      const settings = asset.river ? undefined : oceanSettings(asset, world);
      const ocean = settings ? instance.ocean : undefined;
      const noOcean = (this.#noOcean ??= this.#device.createTexture({ label: 'Water no ocean', size: [1, 1, OCEAN_CASCADES], format: 'rgba16float', usage: GPUTextureUsage.TEXTURE_BINDING }));
      const displacement = ocean?.displacement ?? noOcean, derivatives = ocean?.derivatives ?? noOcean;
      const key = [scene, depth, sky, layout, planar.texture, displacement];
      if (!instance.group || key.some((item, i) => item !== instance!.key[i])) {
        instance.group = this.#device.createBindGroup({
          label: `Water ${asset.path}`,
          layout,
          entries: [
            { binding: 0, resource: { buffer: instance.buffer } },
            { binding: 1, resource: scene.createView({ mipLevelCount: 1 }) },
            { binding: 2, resource: depth.createView() },
            { binding: 3, resource: sky.createView({ dimension: 'cube' }) },
            { binding: 4, resource: this.#resources.linearClamp },
            { binding: 5, resource: planar.texture.createView() },
            { binding: 6, resource: displacement.createView({ dimension: '2d-array' }) },
            { binding: 7, resource: derivatives.createView({ dimension: '2d-array' }) },
            { binding: 8, resource: this.#resources.linearRepeat },
          ],
        });
        instance.key = key;
      }
      // 水面：实体的位置；本地 X 轴的水平方向（岸线按它转回本地）
      const ax = world[0]!, az = world[2]!, axisLength = Math.hypot(ax, az) || 1;
      const outline = file.outline ?? [];
      // 湖：铺到离相机最远的岸线点为止
      let extent = file.extent ?? 6000;
      if (outline.length > 0) {
        extent = 0;
        for (const [x, z] of outline) {
          const wx = world[12]! + world[0]! * x + world[8]! * z, wz = world[14]! + world[2]! * x + world[10]! * z;
          extent = Math.max(extent, Math.hypot(wx - view.eye.x, wz - view.eye.z));
        }
      }
      data.set([world[12]!, world[13]!, world[14]!, extent], 64);
      data.set([ax / axisLength, az / axisLength, 0, outline.length], 68);
      const color = file.color ?? [0.015, 0.06, 0.07];
      data.set([color[0], color[1], color[2], file.clarity ?? 4], 72);
      const waves = file.waves ?? {};
      // 方向：本地的角度加上实体绕 Y 转的角度
      const yaw = Math.atan2(az, ax);
      data.set([waves.height ?? 0.3, waves.length ?? 12, yaw + ((waves.direction ?? 0) * Math.PI) / 180, waves.speed ?? 1], 76);
      data.set([waves.choppiness ?? 0.5, file.foam?.shore ?? 1, file.river?.speed ?? 1.5, asset.river ? 1 : 0], 80);
      // 平面反射在这片水面上（平面朝上、高度和水面差不到半米）才用它当倒影
      const plane = planar.active && planar.receiver === view ? planar.plane : undefined;
      const mirrored = plane !== undefined && plane.normal[1] > 0.99 && Math.abs(plane.point[1] - world[13]!) < 0.5;
      data.set([mirrored ? 1 : 0, planar.texture.mipLevelCount - 1, rain, 0], 92);
      data.set([...(settings ? oceanPatches(settings.patch) : [1, 1, 1]), ocean ? 1 : 0, CREST_FOAM, 0, 0, 0], 96);
      data.fill(0, HEADER_FLOATS);
      outline.forEach(([x, z], i) => data.set([x, z], HEADER_FLOATS + i * 2));
      this.#device.queue.writeBuffer(instance.buffer, 0, data);
      pass.setBindGroup(0, instance.group);
      // 相机在这片湖、海的水面下面（在岸线里）：先盖一层全屏的水下雾
      if (!asset.river && view.eye.y < world[13]!) {
        const dx = view.eye.x - world[12]!, dz = view.eye.z - world[14]!;
        const local: [number, number] = [dx * (ax / axisLength) + dz * (az / axisLength), -dx * (az / axisLength) + dz * (ax / axisLength)];
        if (outline.length === 0 || insidePolygon(outline, local[0], local[1])) {
          pass.setPipeline(underwater);
          pass.draw(3);
        }
      }
      const ribbon = asset.ribbon;
      if (ribbon) {
        if (instance.ribbon?.asset !== asset) {
          instance.ribbon?.buffer.destroy();
          const buffer = this.#device.createBuffer({ label: `Water ${asset.path} river`, size: Math.max(16, ribbon.byteLength), usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
          this.#device.queue.writeBuffer(buffer, 0, ribbon);
          instance.ribbon = { asset, buffer, count: ribbon.length / RIVER_VERTEX_FLOATS };
        }
        pass.setPipeline(river);
        pass.setVertexBuffer(0, instance.ribbon.buffer);
        pass.draw(instance.ribbon.count);
        continue;
      }
      pass.setPipeline(pipeline);
      pass.draw(RINGS * SEGMENTS * 6);
    }
  }

  destroy(): void {
    for (const instance of this.#instances.values()) {
      instance.buffer.destroy();
      instance.ribbon?.buffer.destroy();
      instance.ocean?.destroy();
    }
    this.#instances.clear();
    this.#noOcean?.destroy();
  }

  #instanceFor(id: EntityId, asset: WaterAsset): Instance {
    let instance = this.#instances.get(id);
    if (!instance) {
      instance = { buffer: this.#device.createBuffer({ label: `Water ${asset.path}`, size: UNIFORM_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }), group: undefined, key: [] };
      this.#instances.set(id, instance);
    }
    return instance;
  }

  #pipelineFor(colorFormat: GPUTextureFormat, depthFormat: GPUTextureFormat): WaterPipeline {
    const key = `${colorFormat}:${depthFormat}`;
    if (this.#pipeline?.key === key) return this.#pipeline;
    const device = this.#device;
    const module = device.createShaderModule({ label: 'Water', code: SHADER });
    const layout = device.createBindGroupLayout({
      label: 'Water',
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: {} },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: 'cube' } },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        { binding: 5, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 6, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d-array' } },
        { binding: 7, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d-array' } },
        { binding: 8, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, sampler: {} },
      ],
    });
    const describe = (entryPoint: 'vs' | 'vsRiver'): GPURenderPipelineDescriptor => ({
      label: entryPoint === 'vs' ? 'Water' : 'Water river',
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      vertex: {
        module, entryPoint,
        buffers: entryPoint === 'vs' ? [] : [{ arrayStride: RIVER_VERTEX_FLOATS * 4, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x4' }, { shaderLocation: 1, offset: 16, format: 'float32x4' }] }],
      },
      fragment: {
        module, entryPoint: 'fs',
        targets: [{ format: colorFormat, blend: { color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } } }],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      // 反向 Z：近 1 远 0；读深度、不写
      depthStencil: { format: depthFormat, depthWriteEnabled: false, depthCompare: 'greater-equal' },
    });
    const underwater = device.createRenderPipeline({
      label: 'Water underwater',
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      vertex: { module, entryPoint: 'vsFull' },
      fragment: { module, entryPoint: 'fsUnderwater', targets: [{ format: colorFormat }] },
      primitive: { topology: 'triangle-list' },
      depthStencil: { format: depthFormat, depthWriteEnabled: false, depthCompare: 'always' },
    });
    this.#pipeline = { pipeline: device.createRenderPipeline(describe('vs')), river: device.createRenderPipeline(describe('vsRiver')), underwater, layout, key };
    return this.#pipeline;
  }
}

/** 水体文件的海浪谱换成模拟的设置（风向加上实体绕 Y 的转角）；没写 spectrum 是 undefined。 */
function oceanSettings(asset: WaterAsset, world: Float32Array): OceanSettings | undefined {
  const waves = asset.file.waves, spectrum = waves?.spectrum;
  if (!waves || !spectrum) return undefined;
  const wind = spectrum.wind ?? 10;
  return {
    patch: spectrum.patch ?? 400,
    wind,
    direction: Math.atan2(world[2]!, world[0]!) + ((waves.direction ?? 0) * Math.PI) / 180,
    height: waves.height ?? windSeaHeight(wind),
    // 文件的 0..1 对到 Tessendorf 的 λ 0..2
    choppiness: (waves.choppiness ?? 0.5) * 2,
    seed: spectrum.seed ?? 0,
  };
}

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
