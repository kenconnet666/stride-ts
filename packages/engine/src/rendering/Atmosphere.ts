/**
 * 物理天空（SkyAtmosphere 组件；Stride 没有）：Hillaire 2020 "A Scalable and Production Ready Sky and Atmosphere Rendering
 * Technique" 的做法，参照 Babylon.js 的 atmosphere 插件（MIT，部分来自 sebh/UnrealEngineSkyAtmosphere，MIT）。
 *
 * - 大气是包着星球的一层（默认地球：半径 6360 km、厚 100 km），瑞利散射、米氏散射和臭氧吸收按高度指数衰减。场景的世界原点在
 *   星球表面（北极），Y 向上，世界单位是米，大气的计算用千米。
 * - 太阳：投阴影的那盏方向光（没有时是第一盏），它的颜色 · 强度是大气层顶的照度。地面上的颜色 = 它 · 相机处朝太阳方向的透射率
 *   （CPU 上积分，sunTransmittance），所以太阳落山时直射光自己变红变暗。
 * - 查找表（计算着色器）：透射率（256x64，大气参数变了才算）、多次散射（32x32，同上）、天空视图（192x108，太阳方向或相机高度
 *   变了才算）。天空画在网格没画到的地方（AtmosphereRenderFeature），太阳圆盘按光源的角直径（Light.shadowLightAngle）。
 * - 环境光：天空变了以后把天空视图画进一张 64² 的立方体贴图（不含太阳圆盘，太阳是直射光），镜面用 CubemapPrefilter 预滤波，
 *   漫反射在 GPU 上投影成 3 阶球谐（同资源管线的 st_cubemap_sh_lambert），读回来晚一两帧用上。当作天空盒光
 *   （SkyboxLight，见 DynamicSky），场景里原来的天空盒光被它代替。
 * - 还没做：空气透视（远处物体的雾化，Hillaire 的体素查找表）、夜空（月亮、星星）、云。
 */
import { system } from '../engine/system';
import { Transform } from '../engine/transform';
import { SkyAtmosphere } from './components';
import { FULLSCREEN_VERTEX } from './fullscreen';
import type { GpuResources } from './GpuResources';
import type { Lighting, RenderContext, RenderView, SkyboxLight } from './RenderSystem';

/** 大气的物理参数（SkyAtmosphere 组件的列；距离是千米，系数是每千米）。 */
export interface AtmosphereSettings {
  planetRadius: number;
  atmosphereHeight: number;
  rayleighScattering: [number, number, number];
  mieScattering: number;
  mieAbsorption: number;
  miePhaseG: number;
  ozoneAbsorption: [number, number, number];
  groundAlbedo: [number, number, number];
  /** 天空和环境光的亮度倍数（不影响太阳的直射光）。 */
  skyIntensity: number;
}

/** 地球的默认值（Hillaire 2020 / Babylon 的 DefaultPeak*）。 */
export const EARTH_ATMOSPHERE: Readonly<AtmosphereSettings> = {
  planetRadius: 6360,
  atmosphereHeight: 100,
  rayleighScattering: [0.005802, 0.013558, 0.0331],
  mieScattering: 0.003996,
  mieAbsorption: 0.000444,
  miePhaseG: 0.8,
  ozoneAbsorption: [0.00065, 0.001881, 0.000085],
  groundAlbedo: [0.3, 0.3, 0.3],
  skyIntensity: 1,
};

/** 介质在高度 h（千米，离地面）处的密度：瑞利、米氏、臭氧（Babylon 的 sampleMediumRGB，按 100 km 厚归一化的写法换成千米）。 */
export function mediumDensity(height: number, atmosphereHeight: number): [number, number, number] {
  const normalized = Math.min(Math.max(height / atmosphereHeight, 0), 1);
  const ozone = normalized < 0.25
    ? 0.135 + 0.865 * Math.max(0, normalized - 0.15) / 0.1
    : Math.max(0, 1 - (normalized - 0.25) / 0.35) ** 2;
  return [Math.exp(-12.5 * normalized), Math.exp(-83.333 * normalized), ozone];
}

/**
 * 从 position（千米，星球中心为原点）朝 directionToSun 到大气层顶的透射率（被地面挡住时是 0）。CPU 上积分，太阳的直射光每帧用一次。
 */
export function sunTransmittance(settings: AtmosphereSettings, position: readonly [number, number, number], directionToSun: readonly [number, number, number], samples = 40): [number, number, number] {
  const top = settings.planetRadius + settings.atmosphereHeight;
  if (rayHitsSphere(position, directionToSun, settings.planetRadius) > 0) return [0, 0, 0];
  const length = rayHitsSphere(position, directionToSun, top);
  if (length <= 0) return [1, 1, 1];
  const mieExtinction = settings.mieScattering + settings.mieAbsorption;
  const depth = [0, 0, 0];
  const dt = length / samples;
  for (let i = 0; i < samples; i++) {
    const t = (i + 0.5) * dt;
    const p = [position[0] + directionToSun[0] * t, position[1] + directionToSun[1] * t, position[2] + directionToSun[2] * t];
    const [rayleigh, mie, ozone] = mediumDensity(Math.hypot(p[0]!, p[1]!, p[2]!) - settings.planetRadius, settings.atmosphereHeight);
    for (let c = 0; c < 3; c++) depth[c]! += (rayleigh * settings.rayleighScattering[c]! + mie * mieExtinction + ozone * settings.ozoneAbsorption[c]!) * dt;
  }
  return [Math.exp(-depth[0]!), Math.exp(-depth[1]!), Math.exp(-depth[2]!)];
}

/** 射线到球面（中心在原点）的最远交点的距离；从球里出发时是出去的那一点，碰不到时是 -1。 */
function rayHitsSphere(origin: readonly number[], direction: readonly number[], radius: number): number {
  const b = origin[0]! * direction[0]! + origin[1]! * direction[1]! + origin[2]! * direction[2]!;
  const c = origin[0]! ** 2 + origin[1]! ** 2 + origin[2]! ** 2 - radius * radius;
  const discriminant = b * b - c;
  if (discriminant < 0) return -1;
  const root = Math.sqrt(discriminant);
  // 球外出发且朝外：碰不到
  if (c > 0 && b > 0) return -1;
  return c > 0 ? -b - root : -b + root;
}

/** 着色器共用的大气参数和函数（Hillaire 2020；Babylon 的 atmosphereFunctions 的移植）。 */
const COMMON = /* wgsl */ `
const PI = 3.14159265;
struct Atmosphere {
  // xyz 瑞利散射（每千米），w 星球半径
  rayleigh: vec4f,
  // x 米氏散射，y 米氏消光，z 米氏的 g，w 大气层顶的半径
  mie: vec4f,
  // xyz 臭氧吸收，w 大气厚度
  ozone: vec4f,
  // xyz 地面反照率，w 相机到星球中心的距离（千米）
  ground: vec4f,
  // xyz 朝太阳的方向（世界），w 太阳圆盘角半径的余弦
  sun: vec4f,
  // rgb 大气层顶的太阳照度乘天空亮度，w 太阳圆盘的亮度上限（照度的倍数）
  sunIlluminance: vec4f,
};
@group(0) @binding(0) var<uniform> atmosphere: Atmosphere;

const TRANSMITTANCE_SIZE = vec2f(256.0, 64.0);
const MULTI_SCATTERING_SIZE = vec2f(32.0, 32.0);
const SKY_VIEW_SIZE = vec2f(192.0, 108.0);

fn planetRadius() -> f32 { return atmosphere.rayleigh.w; }
fn topRadius() -> f32 { return atmosphere.mie.w; }

/** 射线和球面（中心在原点）最近的、在前面的交点的距离；没有时 -1。 */
fn raySphere(origin: vec3f, direction: vec3f, radius: f32) -> f32 {
  let b = dot(origin, direction);
  let c = dot(origin, origin) - radius * radius;
  let discriminant = b * b - c;
  if (discriminant < 0.0) { return -1.0; }
  let root = sqrt(discriminant);
  let near = -b - root;
  let far = -b + root;
  if (near >= 0.0) { return near; }
  return select(-1.0, far, far >= 0.0);
}

struct Medium { scatteringRayleigh: vec3f, scatteringMie: vec3f, extinction: vec3f };
fn sampleMedium(height: f32) -> Medium {
  let h = saturate(height / atmosphere.ozone.w);
  let rayleigh = exp(-12.5 * h);
  let mie = exp(-83.333 * h);
  let ozone = select(max(0.0, 1.0 - (h - 0.25) / 0.35) * max(0.0, 1.0 - (h - 0.25) / 0.35), 0.135 + 0.865 * max(0.0, h - 0.15) / 0.1, h < 0.25);
  let scatteringRayleigh = rayleigh * atmosphere.rayleigh.xyz;
  let scatteringMie = vec3f(mie * atmosphere.mie.x);
  return Medium(scatteringRayleigh, scatteringMie, scatteringRayleigh + vec3f(mie * atmosphere.mie.y) + ozone * atmosphere.ozone.xyz);
}

fn rayleighPhase(cosTheta: f32) -> f32 { return 3.0 / (16.0 * PI) * (1.0 + cosTheta * cosTheta); }
/** Cornette-Shanks 的米氏相函数。 */
fn miePhase(cosTheta: f32) -> f32 {
  let g = atmosphere.mie.z;
  let g2 = g * g;
  return 3.0 / (8.0 * PI) * (1.0 - g2) * (1.0 + cosTheta * cosTheta) / ((2.0 + g2) * pow(1.0 + g2 - 2.0 * g * cosTheta, 1.5));
}

/** 透射率查找表的坐标（Bruneton 的参数化：u 是到大气层顶的距离，v 是到地平线的距离）。 */
fn transmittanceUv(radius: f32, cosZenith: f32) -> vec2f {
  let r2 = radius * radius;
  let bottom2 = planetRadius() * planetRadius();
  let top2 = topRadius() * topRadius();
  let H = sqrt(max(0.0, top2 - bottom2));
  let rho = sqrt(max(0.0, r2 - bottom2));
  let discriminant = r2 * (cosZenith * cosZenith - 1.0) + top2;
  let d = max(0.0, -radius * cosZenith + sqrt(max(0.0, discriminant)));
  let dMin = topRadius() - radius;
  let dMax = rho + H;
  let unit = vec2f((d - dMin) / max(dMax - dMin, 1e-6), rho / max(H, 1e-6));
  return unit * (TRANSMITTANCE_SIZE - 1.0) / TRANSMITTANCE_SIZE + 0.5 / TRANSMITTANCE_SIZE;
}
`;

/** 透射率表：每个纹素是（高度，天顶角）到大气层顶的透射率。 */
const TRANSMITTANCE_SHADER = /* wgsl */ `
${COMMON}
@group(0) @binding(1) var output: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) id: vec3u) {
  if (any(vec2f(id.xy) >= TRANSMITTANCE_SIZE)) { return; }
  let unit = (vec2f(id.xy) + 0.5 - 0.5) / (TRANSMITTANCE_SIZE - 1.0);
  let bottom2 = planetRadius() * planetRadius();
  let H = sqrt(topRadius() * topRadius() - bottom2);
  let rho = unit.y * H;
  let radius = sqrt(rho * rho + bottom2);
  let dMin = topRadius() - radius;
  let dMax = rho + H;
  let d = dMin + unit.x * (dMax - dMin);
  let cosZenith = clamp(select((H * H - rho * rho - d * d) / (2.0 * radius * d), 1.0, d <= 0.0), -1.0, 1.0);
  let direction = vec3f(sqrt(max(0.0, 1.0 - cosZenith * cosZenith)), cosZenith, 0.0);
  var depth = vec3f(0.0);
  const STEPS = 40.0;
  let dt = d / STEPS;
  for (var i = 0.0; i < STEPS; i += 1.0) {
    let p = vec3f(0.0, radius, 0.0) + direction * (i + 0.5) * dt;
    depth += sampleMedium(length(p) - planetRadius()).extinction * dt;
  }
  textureStore(output, id.xy, vec4f(exp(-depth), 1.0));
}`;

/**
 * 沿射线积分散射的光（Hillaire 2020 的 IntegrateScatteredLuminance）。uniformPhase 为真时是算多次散射表的那个版本：各向同性的
 * 相函数、加地面反射、另算 multi，不采样多次散射表（它正在被写）。
 */
const integrate = (uniformPhase: boolean) => /* wgsl */ `
@group(0) @binding(2) var transmittanceLut: texture_2d<f32>;
@group(0) @binding(3) var linearClamp: sampler;

fn transmittanceToSun(position: vec3f, directionToSun: vec3f) -> vec3f {
  let radius = length(position);
  let cosZenith = dot(position / radius, directionToSun);
  // 太阳落到地平线以下时淡出（Babylon 的 TransmittanceHorizonRange）
  let uv = transmittanceUv(radius, cosZenith);
  let horizon = 1.0 / TRANSMITTANCE_SIZE.x;
  let weight = smoothstep(1.0 + horizon, 1.0 - horizon, uv.x);
  return weight * textureSampleLevel(transmittanceLut, linearClamp, uv, 0.0).rgb;
}

struct Scattered { radiance: vec3f, transmittance: vec3f, multi: vec3f };

${uniformPhase ? '' : /* wgsl */ `@group(0) @binding(4) var multiScatteringLut: texture_2d<f32>;`}

/**
 * 从 origin 沿 direction 积分到大气层顶或地面，最远 limit 千米。ignoreGround 时不管地面（空气透视：视线停在场景里的物体上，
 * 物体自己就是"地面"）。
 */
fn integrate(origin: vec3f, direction: vec3f, directionToSun: vec3f, steps: f32, limit: f32, ignoreGround: bool) -> Scattered {
  var result = Scattered(vec3f(0.0), vec3f(1.0), vec3f(0.0));
  let tBottom = select(raySphere(origin, direction, planetRadius()), -1.0, ignoreGround);
  let tTop = raySphere(origin, direction, topRadius());
  var tMax = tTop;
  if (tBottom > 0.0) { tMax = select(tBottom, min(tBottom, tTop), tTop > 0.0); }
  tMax = min(tMax, limit);
  if (tMax <= 0.0) { return result; }
  let cosTheta = dot(direction, directionToSun);
  let phaseRayleigh = rayleighPhase(cosTheta);
  let phaseMie = miePhase(cosTheta);
  var t = 0.0;
  for (var s = 0.0; s < steps; s += 1.0) {
    let next = tMax * (s + 0.3) / steps;
    let dt = next - t;
    t = next;
    let p = origin + direction * t;
    let medium = sampleMedium(length(p) - planetRadius());
    let toSun = transmittanceToSun(p, directionToSun);
    let scattering = medium.scatteringRayleigh + medium.scatteringMie;
    ${uniformPhase
      ? 'let inscatter = toSun * scattering / (4.0 * PI);'
      : 'let multi = textureSampleLevel(multiScatteringLut, linearClamp, multiScatteringUv(length(p), dot(normalize(p), directionToSun)), 0.0).rgb;\n    let inscatter = toSun * (medium.scatteringRayleigh * phaseRayleigh + medium.scatteringMie * phaseMie) + multi * scattering;'}
    let extinction = max(medium.extinction, vec3f(1e-7));
    let stepTransmittance = exp(-medium.extinction * dt);
    // 解析地积分这一段（Hillaire 2015 的能量守恒积分）
    result.radiance += result.transmittance * (inscatter - inscatter * stepTransmittance) / extinction;
    result.multi += result.transmittance * (scattering - scattering * stepTransmittance) / extinction;
    result.transmittance *= stepTransmittance;
  }
  // 打到地面的视线加上被太阳照亮的地面（Lambert，反照率 groundAlbedo；多次散射表里是地面反射回大气的光，同 Babylon 的 USE_GROUND_ALBEDO）
  if (tBottom > 0.0 && tMax == tBottom) {
    let p = origin + direction * tBottom;
    let n = normalize(p);
    result.radiance += transmittanceToSun(p, directionToSun) * result.transmittance * atmosphere.ground.xyz * saturate(dot(n, directionToSun)) / PI;
  }
  return result;
}

fn multiScatteringUv(radius: f32, cosSunZenith: f32) -> vec2f {
  let unit = vec2f(0.5 + 0.5 * cosSunZenith, (radius - planetRadius()) / atmosphere.ozone.w);
  return saturate(unit) * (MULTI_SCATTERING_SIZE - 1.0) / MULTI_SCATTERING_SIZE + 0.5 / MULTI_SCATTERING_SIZE;
}
`;

/** 多次散射表（Hillaire 2020 第 5.5 节）：每个（太阳天顶角，高度）的二阶以上散射，按无穷级数 1 / (1 - f) 求和。 */
const MULTI_SCATTERING_SHADER = /* wgsl */ `
${COMMON}
@group(0) @binding(1) var output: texture_storage_2d<rgba16float, write>;
${integrate(true)}

@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) id: vec3u) {
  if (any(vec2f(id.xy) >= MULTI_SCATTERING_SIZE)) { return; }
  let unit = (vec2f(id.xy) + 0.5 - 0.5) / (MULTI_SCATTERING_SIZE - 1.0);
  let cosSunZenith = 2.0 * unit.x - 1.0;
  let directionToSun = vec3f(sqrt(max(0.0, 1.0 - cosSunZenith * cosSunZenith)), cosSunZenith, 0.0);
  let origin = vec3f(0.0, planetRadius() + max(unit.y, 0.001) * atmosphere.ozone.w, 0.0);
  var inscattered = vec3f(0.0);
  var total = vec3f(0.0);
  const AZIMUTHS = 16.0;
  const INCLINATIONS = 8.0;
  let step = (2.0 * PI / AZIMUTHS) * (PI / INCLINATIONS);
  for (var i = 0.5; i < AZIMUTHS; i += 1.0) {
    for (var j = 0.5; j < INCLINATIONS; j += 1.0) {
      let azimuth = 2.0 * PI / AZIMUTHS * i;
      let inclination = PI / INCLINATIONS * j;
      let direction = vec3f(sin(inclination) * sin(azimuth), cos(inclination), sin(inclination) * cos(azimuth));
      let scattered = integrate(origin, direction, directionToSun, 20.0, 1e9, false);
      let weight = abs(sin(inclination)) * step / (4.0 * PI);
      total += scattered.multi * weight;
      inscattered += scattered.radiance * weight;
    }
  }
  textureStore(output, id.xy, vec4f(inscattered / max(vec3f(1e-6), 1.0 - total), 1.0));
}`;

/**
 * 天空视图表（Hillaire 2020 第 5.3 节）：从相机所在的高度往各个方向看到的天空的光。v：下半是地面（0 是正下方），上半是天空
 * （0.5 是地平线，靠近地平线的分辨率高）；u：和太阳的方位角（0 是朝着太阳）。
 */
const SKY_VIEW_SHADER = /* wgsl */ `
${COMMON}
@group(0) @binding(1) var output: texture_storage_2d<rgba16float, write>;
${integrate(false)}

@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) id: vec3u) {
  if (any(vec2f(id.xy) >= SKY_VIEW_SIZE)) { return; }
  let unit = (vec2f(id.xy) + 0.5 - 0.5) / (SKY_VIEW_SIZE - 1.0);
  let radius = atmosphere.ground.w;
  let cosHorizon = -sqrt(max(0.0, 1.0 - min(1.0, planetRadius() / radius) * min(1.0, planetRadius() / radius)));
  var cosViewZenith: f32;
  if (unit.y < 0.5) {
    let coord = 2.0 * unit.y;
    cosViewZenith = mix(-1.0, cosHorizon, coord * coord);
  } else {
    let coord = 2.0 * unit.y - 1.0;
    cosViewZenith = mix(cosHorizon, 1.0, coord * coord);
  }
  let cosViewSun = 1.0 - 2.0 * unit.x;
  let sinViewZenith = sqrt(max(0.0, 1.0 - cosViewZenith * cosViewZenith));
  let direction = vec3f(sinViewZenith * cosViewSun, cosViewZenith, sinViewZenith * sqrt(max(0.0, 1.0 - cosViewSun * cosViewSun)));
  // 太阳在 xy 平面里（相机在北极，天顶是 +y）
  let up = vec3f(0.0, 1.0, 0.0);
  let cosSunZenith = dot(atmosphere.sun.xyz, up);
  let directionToSun = vec3f(sqrt(max(0.0, 1.0 - cosSunZenith * cosSunZenith)), cosSunZenith, 0.0);
  let scattered = integrate(vec3f(0.0, radius, 0.0), direction, directionToSun, 30.0, 1e9, false);
  textureStore(output, id.xy, vec4f(scattered.radiance * atmosphere.sunIlluminance.rgb, 1.0));
}`;

/** 按世界的视线方向查天空视图表（太阳圆盘另加）。 */
const SAMPLE_SKY = /* wgsl */ `
fn skyViewUv(direction: vec3f) -> vec2f {
  let radius = atmosphere.ground.w;
  let up = vec3f(0.0, 1.0, 0.0);
  let cosHorizon = -sqrt(max(0.0, 1.0 - min(1.0, planetRadius() / radius) * min(1.0, planetRadius() / radius)));
  let cosViewZenith = dot(direction, up);
  var v: f32;
  if (cosViewZenith < cosHorizon) {
    v = 0.5 * sqrt(saturate((cosViewZenith + 1.0) / (cosHorizon + 1.0)));
  } else {
    v = 0.5 + 0.5 * sqrt(saturate((cosViewZenith - cosHorizon) / (1.0 - cosHorizon)));
  }
  // 视线和太阳在水平面上的夹角
  let flatView = vec2f(direction.x, direction.z);
  let flatSun = vec2f(atmosphere.sun.x, atmosphere.sun.z);
  var cosViewSun = 1.0;
  if (dot(flatView, flatView) > 1e-8 && dot(flatSun, flatSun) > 1e-8) {
    cosViewSun = dot(normalize(flatView), normalize(flatSun));
  }
  let unit = vec2f(0.5 - 0.5 * cosViewSun, v);
  return unit * (SKY_VIEW_SIZE - 1.0) / SKY_VIEW_SIZE + 0.5 / SKY_VIEW_SIZE;
}
`;

/** 环境光用的天空立方体贴图（Stride 的立方体贴图约定：方向 z 取反，同 MeshRenderFeature 的 skyDirection）：每级 mip 直接按方向查。 */
const SKY_CUBE_SHADER = /* wgsl */ `
${COMMON}
@group(0) @binding(1) var output: texture_storage_2d_array<rgba16float, write>;
@group(0) @binding(2) var skyViewLut: texture_2d<f32>;
@group(0) @binding(3) var linearClamp: sampler;
${SAMPLE_SKY}

fn faceDirection(face: u32, p: vec2f) -> vec3f {
  switch face {
    case 0u: { return vec3f(1.0, -p.y, -p.x); }
    case 1u: { return vec3f(-1.0, -p.y, p.x); }
    case 2u: { return vec3f(p.x, 1.0, p.y); }
    case 3u: { return vec3f(p.x, -1.0, -p.y); }
    case 4u: { return vec3f(p.x, -p.y, 1.0); }
    default: { return vec3f(-p.x, -p.y, -1.0); }
  }
}

@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(output);
  if (any(id.xy >= size)) { return; }
  // 纹素覆盖的范围里取 4x4 个点求平均：每级 mip 都是区域的平均（预滤波按立体角从 mip 里取，逐点求值的 mip 会让地平线那条
  // 硬边在反射里变成一圈圈的环）
  var sum = vec3f(0.0);
  for (var j = 0u; j < 4u; j++) {
    for (var i = 0u; i < 4u; i++) {
      let p = (vec2f(id.xy) + (vec2f(f32(i), f32(j)) + 0.5) / 4.0) / vec2f(size) * 2.0 - 1.0;
      let c = normalize(faceDirection(id.z, p));
      sum += textureSampleLevel(skyViewLut, linearClamp, skyViewUv(vec3f(c.xy, -c.z)), 0.0).rgb;
    }
  }
  textureStore(output, id.xy, id.z, vec4f(sum / 16.0, 1.0));
}`;

/** 立方体贴图投影成 3 阶球谐，乘 Lambert 余弦核和基函数常数（同资源管线的 st_cubemap_sh_lambert）。一个工作组算完。 */
const SH_SHADER = /* wgsl */ `
@group(0) @binding(0) var source: texture_2d_array<f32>;
@group(0) @binding(1) var<storage, read_write> result: array<f32, 28>;

const SH_BASE = array<f32, 9>(0.282094792, -0.488602512, 0.488602512, -0.488602512, 1.092548431, -1.092548431, 0.315391565, -1.092548431, 0.546274215);
const SH_COSINE = array<f32, 9>(1.0, 0.6666667, 0.6666667, 0.6666667, 0.25, 0.25, 0.25, 0.25, 0.25);
var<workgroup> partial: array<array<f32, 28>, 64>;

fn faceDirection(face: u32, p: vec2f) -> vec3f {
  switch face {
    case 0u: { return vec3f(1.0, -p.y, -p.x); }
    case 1u: { return vec3f(-1.0, -p.y, p.x); }
    case 2u: { return vec3f(p.x, 1.0, p.y); }
    case 3u: { return vec3f(p.x, -1.0, -p.y); }
    case 4u: { return vec3f(p.x, -p.y, 1.0); }
    default: { return vec3f(-p.x, -p.y, -1.0); }
  }
}

@compute @workgroup_size(64) fn main(@builtin(local_invocation_index) thread: u32) {
  let size = textureDimensions(source).x;
  var sums: array<f32, 28>;
  for (var i = thread; i < size * size; i += 64u) {
    let x = i % size;
    let y = i / size;
    let uv = (vec2f(f32(x), f32(y)) + 0.5) / f32(size) * 2.0 - 1.0;
    let dist = 1.0 + dot(uv, uv);
    let weight = 4.0 / (sqrt(dist) * dist);
    sums[27] += 6.0 * weight;
    for (var face = 0u; face < 6u; face++) {
      let d = normalize(faceDirection(face, uv));
      let texel = textureLoad(source, vec2u(x, y), face, 0).rgb * weight;
      let basis = array<f32, 9>(1.0, d.y, d.z, d.x, d.y * d.x, d.y * d.z, 3.0 * d.z * d.z - 1.0, d.x * d.z, d.x * d.x - d.y * d.y);
      for (var c = 0u; c < 9u; c++) {
        let k = SH_COSINE[c] * SH_BASE[c] * basis[c];
        sums[c * 3u] += k * texel.r;
        sums[c * 3u + 1u] += k * texel.g;
        sums[c * 3u + 2u] += k * texel.b;
      }
    }
  }
  partial[thread] = sums;
  workgroupBarrier();
  if (thread != 0u) { return; }
  var total: array<f32, 28>;
  for (var t = 0u; t < 64u; t++) {
    for (var k = 0u; k < 28u; k++) { total[k] += partial[t][k]; }
  }
  for (var k = 0u; k < 27u; k++) { result[k] = 4.0 * PI_ / total[27] * total[k] * SH_BASE[k / 3u]; }
  result[27] = 1.0;
}
const PI_ = 3.14159265;`;

/** 画天空：视线方向查天空视图表，再加太阳圆盘（按透射率表变红变暗）。 */
const SKY_SHADER = /* wgsl */ `
${FULLSCREEN_VERTEX}
${COMMON}
struct View { inverseViewProjection: mat4x4f, eye: vec4f };
@group(1) @binding(0) var<uniform> view: View;
@group(0) @binding(1) var skyViewLut: texture_2d<f32>;
@group(0) @binding(2) var transmittanceLut: texture_2d<f32>;
@group(0) @binding(3) var linearClamp: sampler;
${SAMPLE_SKY}

@fragment fn fs(in: FullscreenVaryings) -> @location(0) vec4f {
  let far = view.inverseViewProjection * vec4f(in.ndc, 1.0, 1.0);
  let direction = normalize(far.xyz / far.w - view.eye.xyz);
  var color = textureSampleLevel(skyViewLut, linearClamp, skyViewUv(direction), 0.0).rgb;
  let cosToSun = dot(direction, atmosphere.sun.xyz);
  let position = vec3f(0.0, atmosphere.ground.w, 0.0);
  if (cosToSun > atmosphere.sun.w && raySphere(position, direction, planetRadius()) < 0.0) {
    // 圆盘的亮度 = 照度 / 立体角，限个上限免得泛光炸开；边缘按距离中心淡一点（临边昏暗的近似）
    let solidAngle = 2.0 * PI * (1.0 - atmosphere.sun.w);
    let limb = sqrt(saturate((cosToSun - atmosphere.sun.w) / max(1.0 - atmosphere.sun.w, 1e-6)));
    let transmittance = textureSampleLevel(transmittanceLut, linearClamp, transmittanceUv(atmosphere.ground.w, direction.y), 0.0).rgb;
    color += transmittance * atmosphere.sunIlluminance.rgb * min(1.0 / solidAngle, atmosphere.sunIlluminance.w) * mix(0.6, 1.0, limb);
  }
  return vec4f(color, 1.0);
}`;

/** 空气透视的体素表：屏幕上 32x32 格，32 层距离（第 i 层到 ((i + 1) / 32)² · 32 · 4 km，近处层密）。 */
const AERIAL = /* wgsl */ `
const AERIAL_SIZE = 32.0;
const AERIAL_KM_PER_SLICE = 4.0;
// 相机：视图投影的逆（屏幕 → 世界）、位置（米）、w 是距离的倍数（小场景放大效果）
struct Camera { inverseViewProjection: mat4x4f, eye: vec4f };
`;

const AERIAL_SHADER = /* wgsl */ `
${COMMON}
@group(0) @binding(1) var output: texture_storage_3d<rgba16float, write>;
${integrate(false)}
${AERIAL}
@group(0) @binding(5) var<uniform> camera: Camera;

// 每个线程一列：沿视线走一遍，每层接着上一层积分（各层单独从相机积分时采样数不同，层和层之间的误差不连续，画面上是一圈圈的环）
@compute @workgroup_size(8, 8, 1) fn main(@builtin(global_invocation_id) id: vec3u) {
  if (any(vec2f(id.xy) >= vec2f(AERIAL_SIZE))) { return; }
  let uv = (vec2f(id.xy) + 0.5) / AERIAL_SIZE;
  let far = camera.inverseViewProjection * vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 1.0, 1.0);
  let direction = normalize(far.xyz / far.w - camera.eye.xyz);
  let origin = vec3f(0.0, atmosphere.ground.w, 0.0);
  let toSun = atmosphere.sun.xyz;
  let cosTheta = dot(direction, toSun);
  let phaseRayleigh = rayleighPhase(cosTheta);
  let phaseMie = miePhase(cosTheta);
  var radiance = vec3f(0.0);
  var transmittance = vec3f(1.0);
  var t = 0.0;
  const SUBSTEPS = 4.0;
  for (var slice = 0u; slice < u32(AERIAL_SIZE); slice++) {
    let layer = (f32(slice) + 1.0) / AERIAL_SIZE;
    let end = layer * layer * AERIAL_SIZE * AERIAL_KM_PER_SLICE;
    let dt = (end - t) / SUBSTEPS;
    for (var k = 0.0; k < SUBSTEPS; k += 1.0) {
      let p = origin + direction * (t + (k + 0.5) * dt);
      let medium = sampleMedium(length(p) - planetRadius());
      let multi = textureSampleLevel(multiScatteringLut, linearClamp, multiScatteringUv(length(p), dot(normalize(p), toSun)), 0.0).rgb;
      let inscatter = transmittanceToSun(p, toSun) * (medium.scatteringRayleigh * phaseRayleigh + medium.scatteringMie * phaseMie)
        + multi * (medium.scatteringRayleigh + medium.scatteringMie);
      let extinction = max(medium.extinction, vec3f(1e-7));
      let stepTransmittance = exp(-medium.extinction * dt);
      radiance += transmittance * (inscatter - inscatter * stepTransmittance) / extinction;
      transmittance *= stepTransmittance;
    }
    t = end;
    textureStore(output, vec3u(id.xy, slice), vec4f(radiance * atmosphere.sunIlluminance.rgb, 1.0 - dot(transmittance, vec3f(1.0 / 3.0))));
  }
}`;

/**
 * 空气透视合成：按深度查体素表，颜色 = 颜色 · 透射 + 散射（混合：src + dst · srcAlpha，alpha 是平均透射率，各通道的透射率差别
 * 只在很远处明显，先不用双源混合）。天空（深度 1）不动，它自己带着大气。
 */
const AERIAL_COMPOSITE_SHADER = /* wgsl */ `
${FULLSCREEN_VERTEX}
${AERIAL}
@group(0) @binding(0) var aerial: texture_3d<f32>;
@group(0) @binding(1) var depth: texture_depth_2d;
@group(0) @binding(2) var linearClamp: sampler;
@group(0) @binding(3) var<uniform> camera: Camera;

@fragment fn fs(in: FullscreenVaryings) -> @location(0) vec4f {
  let d = textureLoad(depth, vec2i(in.position.xy), 0);
  if (d >= 1.0) { discard; }
  let world = camera.inverseViewProjection * vec4f(in.ndc, d, 1.0);
  let distance = length(world.xyz / world.w - camera.eye.xyz) / 1000.0 * camera.eye.w;
  // 层号的反函数：第 i 层的中心在 sqrt(距离 / 总长) - 0.5 / 层数；比第一层还近的按距离淡到 0
  let w = sqrt(distance / (AERIAL_SIZE * AERIAL_KM_PER_SLICE));
  let z = w - 0.5 / AERIAL_SIZE;
  let fade = saturate(w * AERIAL_SIZE);
  let s = textureSampleLevel(aerial, linearClamp, vec3f(in.uv, max(z, 0.5 / AERIAL_SIZE)), 0.0) * fade;
  return vec4f(s.rgb, 1.0 - s.a);
}`;

/** uniform Atmosphere 的大小（6 个 vec4）。 */
const ATMOSPHERE_FLOATS = 24;
/**
 * 天空立方体和镜面贴图的边长。64 不够：粗糙度 0.5 的表面落在第 3、4 级（每面 8²、4²），双线性插值的折线在地面的反射里成了
 * 一圈圈的环。
 */
const SKY_CUBE_SIZE = 128;
const SPECULAR_SIZE = 128;
/** 球谐用的那一级（32²）。 */
const SH_LEVEL = 2;
/** 预滤波每级的采样数（第 0 级只重采样）：粗糙度低的级别纹素多、波瓣窄，少采；粗糙的级别纹素少，多采。 */
const PREFILTER_SAMPLES = [1, 32, 64, 128, 256];
const FORMAT: GPUTextureFormat = 'rgba16float';

/** 大气算出来的天空光（代替场景的天空盒光，见 SkyboxLight.skybox）：镜面立方体贴图和漫反射的球谐。 */
export class DynamicSky {
  readonly name = 'SkyAtmosphere';
  /** 9 个 RGB 系数，约定同 Skybox.diffuseSH；GPU 算好读回来之前是 0。 */
  readonly diffuseSH = new Float32Array(27);
  readonly specularLevels = Math.log2(SPECULAR_SIZE) + 1;
  readonly specular: GPUTexture;

  constructor(device: GPUDevice) {
    this.specular = device.createTexture({ label: 'SkyAtmosphere specular', size: [SPECULAR_SIZE, SPECULAR_SIZE, 6], format: FORMAT, mipLevelCount: this.specularLevels, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT });
  }
}

/**
 * 场景的大气（渲染系统一份）：前向渲染器收集光照时 apply（找 SkyAtmosphere、调太阳的颜色、换天空光），网格之前 AtmosphereRenderFeature
 * 的 prepare 里 update（该重算的查找表和天空光录进自己的编码器提交），画天空时 draw。
 */
export class Atmosphere {
  /** 这一帧有没有大气（场景里有 SkyAtmosphere）。 */
  active = false;
  readonly settings: AtmosphereSettings = structuredClone(EARTH_ATMOSPHERE) as AtmosphereSettings;
  /** 朝太阳的方向（世界）和大气层顶的照度。 */
  readonly directionToSun: [number, number, number] = [0, 1, 0];
  readonly sunIlluminance: [number, number, number] = [0, 0, 0];
  /** 太阳圆盘的角半径（弧度）。 */
  sunAngularRadius = 0.00465;
  /** 相机离地面的高度（千米）。 */
  cameraHeight = 0;
  /** 空气透视的距离倍数（SkyAtmosphere.aerialPerspectiveScale）；0 是不做。 */
  aerialPerspectiveScale = 1;
  readonly #device: GPUDevice;
  readonly #resources: GpuResources;
  #gpu: AtmosphereGpu | undefined;
  #sky: DynamicSky | undefined;
  #skyLight: SkyboxLight | undefined;
  /** 上次算查找表、天空视图、环境光时的键；没变就不算。 */
  #lutKey = '';
  #skyKey = '';
  #lightingKey = '';
  #reading = false;

  readonly #collect = system('Atmosphere.collect', {
    with: { atmosphere: SkyAtmosphere, transform: Transform },
    update: ({ atmosphere, count }) => {
      if (count === 0 || this.active) return;
      this.active = true;
      const s = this.settings;
      s.planetRadius = atmosphere.planetRadius[0]!;
      s.atmosphereHeight = atmosphere.atmosphereHeight[0]!;
      s.rayleighScattering = [atmosphere.rayleighScattering[0]!, atmosphere.rayleighScattering[1]!, atmosphere.rayleighScattering[2]!];
      s.mieScattering = atmosphere.mieScattering[0]!;
      s.mieAbsorption = atmosphere.mieAbsorption[0]!;
      s.miePhaseG = atmosphere.miePhaseG[0]!;
      s.ozoneAbsorption = [atmosphere.ozoneAbsorption[0]!, atmosphere.ozoneAbsorption[1]!, atmosphere.ozoneAbsorption[2]!];
      s.groundAlbedo = [atmosphere.groundAlbedo[0]!, atmosphere.groundAlbedo[1]!, atmosphere.groundAlbedo[2]!];
      s.skyIntensity = atmosphere.skyIntensity[0]!;
      this.aerialPerspectiveScale = atmosphere.aerialPerspectiveScale[0]!;
    },
  });

  constructor(device: GPUDevice, resources: GpuResources) {
    this.#device = device;
    this.#resources = resources;
  }

  /**
   * 收集光照之后（前向渲染器调）：场景里有 SkyAtmosphere 时，太阳（投阴影的方向光，没有时是第一盏）的颜色乘相机处的透射率，
   * 天空盒光换成大气的。eye 是主相机的位置（米）。
   */
  apply(context: RenderContext, lighting: Lighting, eye: { readonly x: number; readonly y: number; readonly z: number }, sunAngleDegrees: number): void {
    this.active = false;
    context.game.entities.run(this.#collect, context.time);
    if (!this.active || lighting.directionalCount === 0) {
      this.active = false;
      return;
    }
    const sun = lighting.directionals[Math.max(lighting.shadowLight, 0)]!;
    const length = Math.hypot(sun.direction.x, sun.direction.y, sun.direction.z) || 1;
    this.directionToSun.splice(0, 3, -sun.direction.x / length, -sun.direction.y / length, -sun.direction.z / length);
    this.sunIlluminance.splice(0, 3, sun.color.r, sun.color.g, sun.color.b);
    this.sunAngularRadius = Math.max((sunAngleDegrees / 2) * (Math.PI / 180), 1e-4);
    this.cameraHeight = Math.max(eye.y / 1000, 0.001);
    const position: [number, number, number] = [0, this.settings.planetRadius + this.cameraHeight, 0];
    const [r, g, b] = sunTransmittance(this.settings, position, this.directionToSun);
    sun.color.set(sun.color.r * r, sun.color.g * g, sun.color.b * b, 1);
    this.#sky ??= new DynamicSky(this.#device);
    // 天空盒的约定是乘实体的旋转；大气没有旋转。强度已经乘进天空的亮度里
    this.#skyLight ??= { skybox: this.#sky, intensity: 1, rotation: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) };
    lighting.skybox = this.#skyLight;
  }

  /** 该重算的查找表、天空光录进一个编码器提交（在这一帧的画面之前执行）。 */
  update(): void {
    if (!this.active) return;
    const gpu = (this.#gpu ??= new AtmosphereGpu(this.#device, this.#resources));
    gpu.writeUniforms(this.#uniforms());
    const s = this.settings;
    const lutKey = JSON.stringify([s.planetRadius, s.atmosphereHeight, s.rayleighScattering, s.mieScattering, s.mieAbsorption, s.miePhaseG, s.ozoneAbsorption, s.groundAlbedo]);
    // 看得见的天空：太阳方向变化约 0.05° 以内、相机高度变化 1 m 以内、亮度不变时不重算。环境光（立方体、球谐、预滤波，
    // 约 1 ms）粗一档：太阳动了约 0.5°、亮度变了 2% 才重算，日夜循环时不每帧都算
    const sky = [lutKey, Math.round(this.cameraHeight * 1000), s.skyIntensity];
    const skyKey = JSON.stringify([...sky, this.directionToSun.map((v) => Math.round(v * 1000)), this.sunIlluminance]);
    const lightingKey = JSON.stringify([...sky, this.directionToSun.map((v) => Math.round(v * 100)), this.sunIlluminance.map((v) => Math.round(Math.log(Math.max(v, 1e-4)) * 50))]);
    if (lutKey === this.#lutKey && skyKey === this.#skyKey) return;
    const encoder = this.#device.createCommandEncoder({ label: 'Atmosphere' });
    if (lutKey !== this.#lutKey) gpu.recordLuts(encoder);
    gpu.recordSkyView(encoder);
    const lighting = lightingKey !== this.#lightingKey;
    if (lighting) gpu.recordLighting(encoder, this.#sky!);
    this.#device.queue.submit([encoder.finish()]);
    this.#lutKey = lutKey;
    this.#skyKey = skyKey;
    this.#lightingKey = lightingKey;
    if (lighting) this.#readSphericalHarmonics(gpu);
  }

  /** 这一帧做不做空气透视（前向渲染器据此留着深度缓冲、在不透明的之后合成）。 */
  get aerialPerspective(): boolean {
    return this.active && this.aerialPerspectiveScale > 0 && this.#gpu !== undefined;
  }

  /** 画天空用的（AtmosphereRenderFeature）。 */
  get gpu(): AtmosphereGpu | undefined {
    return this.active ? this.#gpu : undefined;
  }

  destroy(): void {
    this.#gpu?.destroy();
    this.#sky?.specular.destroy();
  }

  #uniforms(): Float32Array {
    const s = this.settings;
    const cosDisk = Math.cos(this.sunAngularRadius);
    return new Float32Array([
      ...s.rayleighScattering, s.planetRadius,
      s.mieScattering, s.mieScattering + s.mieAbsorption, s.miePhaseG, s.planetRadius + s.atmosphereHeight,
      ...s.ozoneAbsorption, s.atmosphereHeight,
      ...s.groundAlbedo, s.planetRadius + this.cameraHeight,
      ...this.directionToSun, cosDisk,
      ...this.sunIlluminance.map((v) => v * s.skyIntensity), 1e4,
    ]);
  }

  /** 球谐在 GPU 上算好后读回来（上一次还没读完时这次不读，晚一两帧用上）。 */
  #readSphericalHarmonics(gpu: AtmosphereGpu): void {
    if (this.#reading) return;
    this.#reading = true;
    const encoder = this.#device.createCommandEncoder({ label: 'Atmosphere SH readback' });
    encoder.copyBufferToBuffer(gpu.shResult, 0, gpu.shReadback, 0, 28 * 4);
    this.#device.queue.submit([encoder.finish()]);
    gpu.shReadback.mapAsync(GPUMapMode.READ).then(() => {
      const values = new Float32Array(gpu.shReadback.getMappedRange().slice(0, 27 * 4));
      gpu.shReadback.unmap();
      if (values.every(Number.isFinite)) this.#sky?.diffuseSH.set(values);
    }, () => {}).finally(() => {
      this.#reading = false;
    });
  }
}

type ComputeName = 'transmittance' | 'multiScattering' | 'skyView' | 'skyCube' | 'sh' | 'aerial';

/** 大气的 GPU 资源：查找表、计算管线、画天空的管线。 */
export class AtmosphereGpu {
  readonly uniforms: GPUBuffer;
  readonly transmittance: GPUTexture;
  readonly multiScattering: GPUTexture;
  readonly skyView: GPUTexture;
  readonly skyCube: GPUTexture;
  readonly shResult: GPUBuffer;
  readonly shReadback: GPUBuffer;
  readonly skyModule: GPUShaderModule;
  readonly skyLayout: GPUBindGroupLayout;
  readonly viewLayout: GPUBindGroupLayout;
  readonly skyBindGroup: GPUBindGroup;
  readonly #device: GPUDevice;
  readonly #resources: GpuResources;
  readonly #pipelines: Record<ComputeName, GPUComputePipeline>;
  /** 空气透视的体素表和这一帧的相机。 */
  readonly aerial: GPUTexture;
  readonly camera: GPUBuffer;
  readonly #compositeModule: GPUShaderModule;
  readonly #compositeLayout: GPUBindGroupLayout;
  readonly #composites = new Map<GPUTextureFormat, GPURenderPipeline>();

  constructor(device: GPUDevice, resources: GpuResources) {
    this.#device = device;
    this.#resources = resources;
    const storage = GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING;
    this.uniforms = device.createBuffer({ label: 'Atmosphere', size: ATMOSPHERE_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.transmittance = device.createTexture({ label: 'Atmosphere transmittance', size: [256, 64], format: FORMAT, usage: storage });
    this.multiScattering = device.createTexture({ label: 'Atmosphere multiple scattering', size: [32, 32], format: FORMAT, usage: storage });
    this.skyView = device.createTexture({ label: 'Atmosphere sky view', size: [192, 108], format: FORMAT, usage: storage });
    this.skyCube = device.createTexture({ label: 'Atmosphere sky cube', size: [SKY_CUBE_SIZE, SKY_CUBE_SIZE, 6], format: FORMAT, mipLevelCount: Math.log2(SKY_CUBE_SIZE) + 1, usage: storage });
    this.shResult = device.createBuffer({ label: 'Atmosphere SH', size: 28 * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    this.shReadback = device.createBuffer({ label: 'Atmosphere SH readback', size: 28 * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const compute = (label: string, code: string) => device.createComputePipeline({ label: `Atmosphere ${label}`, layout: 'auto', compute: { module: device.createShaderModule({ label: `Atmosphere ${label}`, code }), entryPoint: 'main' } });
    this.#pipelines = {
      transmittance: compute('transmittance', TRANSMITTANCE_SHADER),
      multiScattering: compute('multiple scattering', MULTI_SCATTERING_SHADER),
      skyView: compute('sky view', SKY_VIEW_SHADER),
      skyCube: compute('sky cube', SKY_CUBE_SHADER),
      sh: compute('spherical harmonics', SH_SHADER),
      aerial: compute('aerial perspective', AERIAL_SHADER),
    };
    this.aerial = device.createTexture({ label: 'Atmosphere aerial perspective', size: [32, 32, 32], dimension: '3d', format: FORMAT, usage: storage });
    this.camera = device.createBuffer({ label: 'Atmosphere camera', size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.#compositeModule = device.createShaderModule({ label: 'Atmosphere aerial perspective composite', code: AERIAL_COMPOSITE_SHADER });
    this.#compositeLayout = device.createBindGroupLayout({
      label: 'Atmosphere aerial perspective composite',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: '3d' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      ],
    });
    this.skyModule = device.createShaderModule({ label: 'Atmosphere sky', code: SKY_SHADER });
    this.skyLayout = device.createBindGroupLayout({
      label: 'Atmosphere sky',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      ],
    });
    this.viewLayout = device.createBindGroupLayout({ label: 'Atmosphere view', entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform', hasDynamicOffset: true } }] });
    this.skyBindGroup = device.createBindGroup({
      layout: this.skyLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniforms } },
        { binding: 1, resource: this.skyView.createView() },
        { binding: 2, resource: this.transmittance.createView() },
        { binding: 3, resource: resources.linearClamp },
      ],
    });
  }

  writeUniforms(data: Float32Array): void {
    this.#device.queue.writeBuffer(this.uniforms, 0, data);
  }

  /** 透射率表，然后多次散射表（它要透射率表）。 */
  recordLuts(encoder: GPUCommandEncoder): void {
    const linear = this.#resources.linearClamp;
    this.#dispatch(encoder, 'transmittance', [{ binding: 0, resource: { buffer: this.uniforms } }, { binding: 1, resource: this.transmittance.createView() }], [32, 8, 1]);
    this.#dispatch(encoder, 'multiScattering', [
      { binding: 0, resource: { buffer: this.uniforms } },
      { binding: 1, resource: this.multiScattering.createView() },
      { binding: 2, resource: this.transmittance.createView() },
      { binding: 3, resource: linear },
    ], [4, 4, 1]);
  }

  /** 天空视图表（画天空用，也是环境光的来源）。 */
  recordSkyView(encoder: GPUCommandEncoder): void {
    this.#dispatch(encoder, 'skyView', [
      { binding: 0, resource: { buffer: this.uniforms } },
      { binding: 1, resource: this.skyView.createView() },
      { binding: 2, resource: this.transmittance.createView() },
      { binding: 3, resource: this.#resources.linearClamp },
      { binding: 4, resource: this.multiScattering.createView() },
    ], [24, 14, 1]);
  }

  /** 环境光：天空立方体（每级 mip），球谐，镜面预滤波。天空视图表要先算好。 */
  recordLighting(encoder: GPUCommandEncoder, sky: DynamicSky): void {
    const linear = this.#resources.linearClamp;
    for (let level = 0; level < this.skyCube.mipLevelCount; level++) {
      const size = Math.max(1, SKY_CUBE_SIZE >> level);
      this.#dispatch(encoder, 'skyCube', [
        { binding: 0, resource: { buffer: this.uniforms } },
        { binding: 1, resource: this.skyCube.createView({ dimension: '2d-array', baseMipLevel: level, mipLevelCount: 1 }) },
        { binding: 2, resource: this.skyView.createView() },
        { binding: 3, resource: linear },
      ], [Math.ceil(size / 8), Math.ceil(size / 8), 6]);
    }
    this.#dispatch(encoder, 'sh', [
      { binding: 0, resource: this.skyCube.createView({ dimension: '2d-array', baseMipLevel: SH_LEVEL, mipLevelCount: 1 }) },
      { binding: 1, resource: { buffer: this.shResult } },
    ], [1, 1, 1]);
    this.#resources.prefilter.record(encoder, this.skyCube, sky.specular, 0, PREFILTER_SAMPLES);
  }

  /**
   * 空气透视（录进这一帧的编码器）：按 view 的相机算体素表，再按 depth 合成进 target（不透明的画完之后）。scale 是距离的倍数。
   */
  recordAerialPerspective(encoder: GPUCommandEncoder, view: RenderView, scale: number, target: GPUTextureView, format: GPUTextureFormat, depth: GPUTexture): void {
    this.#device.queue.writeBuffer(this.camera, 0, new Float32Array([...view.inverseViewProjection, view.eye.x, view.eye.y, view.eye.z, scale]));
    this.#dispatch(encoder, 'aerial', [
      { binding: 0, resource: { buffer: this.uniforms } },
      { binding: 1, resource: this.aerial.createView() },
      { binding: 2, resource: this.transmittance.createView() },
      { binding: 3, resource: this.#resources.linearClamp },
      { binding: 4, resource: this.multiScattering.createView() },
      { binding: 5, resource: { buffer: this.camera } },
    ], [4, 4, 1]);
    const pass = encoder.beginRenderPass({ label: 'Atmosphere aerial perspective', colorAttachments: [{ view: target, loadOp: 'load', storeOp: 'store' }] });
    pass.setPipeline(this.#compositeFor(format));
    pass.setBindGroup(0, this.#device.createBindGroup({
      layout: this.#compositeLayout,
      entries: [
        { binding: 0, resource: this.aerial.createView() },
        { binding: 1, resource: depth.createView() },
        { binding: 2, resource: this.#resources.linearClamp },
        { binding: 3, resource: { buffer: this.camera } },
      ],
    }));
    pass.draw(3);
    pass.end();
  }

  destroy(): void {
    for (const texture of [this.transmittance, this.multiScattering, this.skyView, this.skyCube, this.aerial]) texture.destroy();
    for (const buffer of [this.uniforms, this.shResult, this.shReadback, this.camera]) buffer.destroy();
  }

  /** 合成的管线：颜色 = 散射 + 颜色 · 透射（alpha）。 */
  #compositeFor(format: GPUTextureFormat): GPURenderPipeline {
    let pipeline = this.#composites.get(format);
    if (!pipeline) {
      pipeline = this.#device.createRenderPipeline({
        label: `Atmosphere aerial perspective ${format}`,
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

  #dispatch(encoder: GPUCommandEncoder, name: ComputeName, entries: GPUBindGroupEntry[], groups: [number, number, number]): void {
    const pipeline = this.#pipelines[name];
    const pass = encoder.beginComputePass({ label: `Atmosphere ${name}` });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, this.#device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries }));
    pass.dispatchWorkgroups(...groups);
    pass.end();
  }
}
