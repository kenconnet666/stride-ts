/**
 * 物理天空（SkyAtmosphere 组件；Stride 没有）：Hillaire 2020 "A Scalable and Production Ready Sky and Atmosphere Rendering
 * Technique" 的做法，参照 Babylon.js 的 atmosphere 插件（MIT，部分来自 sebh/UnrealEngineSkyAtmosphere，MIT）。
 *
 * - 大气是包着星球的一层（默认地球：半径 6360 km、厚 100 km），瑞利散射、米氏散射和臭氧吸收按高度指数衰减。场景的世界原点在
 *   星球表面（北极），Y 向上，世界单位是米，大气的计算用千米。
 * - 太阳和月亮是两盏方向光（SkyAtmosphere.sun、moon；太阳没设时是要投阴影的那盏，没有时是第一盏），颜色 · 强度是大气层顶的
 *   照度（月亮的是满月时的，再乘月相：被太阳照亮的那部分的比例）。地面上的颜色 = 它 · 相机处朝它的透射率（CPU 上积分，
 *   sunTransmittance），所以落山时直射光自己变红变暗，圆盘沉到地平线以下就是黑的（前向渲染器把黑的光丢掉，阴影轮到下一盏）。
 * - 查找表（计算着色器）：透射率（256x64，大气参数变了才算）、多次散射（32x32，同上）、天空视图（192x108，太阳、月亮的方向或
 *   相机高度变了才算；两盏光各积分一遍加起来）。天空画在网格没画到的地方（AtmosphereRenderFeature），圆盘按光源的角直径
 *   （Light.shadowLightAngle）。
 * - 夜空：月面是一个被太阳照着的球（月相是几何算出来的，月海是噪声），星星和银河是程序生成的，跟着 SkyAtmosphere 所在实体的
 *   旋转转（DayNightCycle 按时刻转它）；天空亮的时候暗的星星先被盖过去。
 * - 环境光：天空变了以后把天空视图画进一张 128² 的立方体贴图（不含圆盘和星星），镜面用 CubemapPrefilter 预滤波，
 *   漫反射在 GPU 上投影成 3 阶球谐（同资源管线的 st_cubemap_sh_lambert），读回来晚一两帧用上。当作天空盒光
 *   （SkyboxLight，见 DynamicSky），场景里原来的天空盒光被它代替。
 * - 空气透视：屏幕上 32x32 格、32 层的体素表，不透明的画完以后按深度合成。
 * - 还没做：云。
 */
import type { EntityId } from '../data/prop';
import { system } from '../engine/system';
import { Transform } from '../engine/transform';
import { SkyAtmosphere } from './components';
import { FULLSCREEN_VERTEX } from './fullscreen';
import type { GpuResources } from './GpuResources';
import type { DirectionalLight, Lighting, RenderContext, RenderView, SkyboxLight } from './RenderSystem';

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
export const ATMOSPHERE_WGSL = /* wgsl */ `
const PI = 3.14159265;
struct Body {
  // xyz 朝它的方向（世界），w 圆盘角半径的余弦（没有这个天体时大于 1）
  direction: vec4f,
  // rgb 大气层顶的照度乘天空亮度（月亮的乘了月相；落到地平线以下很多时是 0，不再算它的散射），w 圆盘的亮度上限（照度的倍数）
  illuminance: vec4f,
};
struct Atmosphere {
  // xyz 瑞利散射（每千米），w 星球半径
  rayleigh: vec4f,
  // x 米氏散射，y 米氏消光，z 米氏的 g，w 大气层顶的半径
  mie: vec4f,
  // xyz 臭氧吸收，w 大气厚度
  ozone: vec4f,
  // xyz 地面反照率，w 相机到星球中心的距离（千米）
  ground: vec4f,
  // 0 太阳，1 月亮
  bodies: array<Body, 2>,
  // rgb 月面被照亮的地方的亮度，w 星星的亮度（0 不画）
  night: vec4f,
  // 世界到天球坐标的旋转（三行）：星空跟着 SkyAtmosphere 的实体转
  celestial: array<vec4f, 3>,
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
${ATMOSPHERE_WGSL}
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
${ATMOSPHERE_WGSL}
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
 * （0.5 是地平线，靠近地平线的分辨率高）；u：世界里的方位角，绕 Y 一整圈（同 Unreal；Hillaire 的示例和 Babylon 按和太阳的
 * 夹角存半圈，那样只能有一盏光）。
 */
const SKY_VIEW_SHADER = /* wgsl */ `
${ATMOSPHERE_WGSL}
@group(0) @binding(1) var output: texture_storage_2d<rgba16float, write>;
${integrate(false)}

@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) id: vec3u) {
  if (any(vec2f(id.xy) >= SKY_VIEW_SIZE)) { return; }
  let v = f32(id.y) / (SKY_VIEW_SIZE.y - 1.0);
  let radius = atmosphere.ground.w;
  let cosHorizon = -sqrt(max(0.0, 1.0 - min(1.0, planetRadius() / radius) * min(1.0, planetRadius() / radius)));
  var cosViewZenith: f32;
  if (v < 0.5) {
    let coord = 2.0 * v;
    cosViewZenith = mix(-1.0, cosHorizon, coord * coord);
  } else {
    let coord = 2.0 * v - 1.0;
    cosViewZenith = mix(cosHorizon, 1.0, coord * coord);
  }
  // 方位角上首尾相接（采样时 repeat），纹素中心不落在接缝上
  let azimuth = (f32(id.x) + 0.5) / SKY_VIEW_SIZE.x * 2.0 * PI;
  let sinViewZenith = sqrt(max(0.0, 1.0 - cosViewZenith * cosViewZenith));
  let direction = vec3f(sinViewZenith * cos(azimuth), cosViewZenith, sinViewZenith * sin(azimuth));
  var radiance = vec3f(0.0);
  for (var b = 0u; b < 2u; b++) {
    let body = atmosphere.bodies[b];
    if (all(body.illuminance.rgb <= vec3f(0.0))) { continue; }
    radiance += integrate(vec3f(0.0, radius, 0.0), direction, body.direction.xyz, 30.0, 1e9, false).radiance * body.illuminance.rgb;
  }
  textureStore(output, id.xy, vec4f(radiance, 1.0));
}`;

/** 按世界的视线方向查天空视图表（圆盘、星星另加）。采样器在 u 上要 repeat（AtmosphereGpu 的 skySampler）。 */
export const SKY_VIEW_WGSL = /* wgsl */ `
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
  // 正上、正下方的方位角没有意义（那一行纹素都一样）
  let flat = direction.xz;
  let azimuth = select(0.0, atan2(flat.y, flat.x), dot(flat, flat) > 1e-12);
  return vec2f(azimuth / (2.0 * PI), v * (SKY_VIEW_SIZE.y - 1.0) / SKY_VIEW_SIZE.y + 0.5 / SKY_VIEW_SIZE.y);
}
`;

/** 环境光用的天空立方体贴图（Stride 的立方体贴图约定：方向 z 取反，同 MeshRenderFeature 的 skyDirection）：每级 mip 直接按方向查。 */
const SKY_CUBE_SHADER = /* wgsl */ `
${ATMOSPHERE_WGSL}
@group(0) @binding(1) var output: texture_storage_2d_array<rgba16float, write>;
@group(0) @binding(2) var skyViewLut: texture_2d<f32>;
@group(0) @binding(3) var skySampler: sampler;
${SKY_VIEW_WGSL}

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
      sum += textureSampleLevel(skyViewLut, skySampler, skyViewUv(vec3f(c.xy, -c.z)), 0.0).rgb;
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

/** 夜空：星星、银河、月面的噪声。方向都是天球坐标（跟着 SkyAtmosphere 的实体转）。 */
const NIGHT = /* wgsl */ `
/** 格子到三个 0..1 的随机数（pcg3d，Jarzynski、Olano 2020）。 */
fn hash3(cell: vec3i) -> vec3f {
  var v = bitcast<vec3u>(cell) * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> vec3u(16u);
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return vec3f(v) * (1.0 / 4294967296.0);
}

fn valueNoise(p: vec3f) -> f32 {
  let cell = vec3i(floor(p));
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let x00 = mix(hash3(cell).x, hash3(cell + vec3i(1, 0, 0)).x, u.x);
  let x10 = mix(hash3(cell + vec3i(0, 1, 0)).x, hash3(cell + vec3i(1, 1, 0)).x, u.x);
  let x01 = mix(hash3(cell + vec3i(0, 0, 1)).x, hash3(cell + vec3i(1, 0, 1)).x, u.x);
  let x11 = mix(hash3(cell + vec3i(0, 1, 1)).x, hash3(cell + vec3i(1, 1, 1)).x, u.x);
  return mix(mix(x00, x10, u.y), mix(x01, x11, u.y), u.z);
}

/** 三个倍频的噪声，0..1。 */
fn fbm(p: vec3f) -> f32 {
  return (valueNoise(p) * 4.0 + valueNoise(p * 2.03 + 17.0) * 2.0 + valueNoise(p * 4.11 + 31.0)) / 7.0;
}

// 星星：把方向放大成格子，每格一颗候选的星星（位置随机），只留离球面近的那些（投到球面上以后，还在像素要查的 2x2x2 格里）
const STAR_CELLS = 48.0;
const STAR_SHELL = 0.25;
// 留下的比例：全天约六千颗（肉眼能看到的数量级）
const STAR_DENSITY = 0.42;
// 最暗的那档星星的光量（亮度 · 立体角）
const STAR_FLUX = 7e-8;

/** 方向 c 处星星的亮度。pixel 是一个像素的张角（弧度）：星星画成一个像素大小的高斯，总光量和分辨率无关。 */
fn stars(c: vec3f, pixel: f32) -> vec3f {
  let p = c * STAR_CELLS;
  let base = vec3i(floor(p - 0.5));
  // 上限：三倍标准差要落在查的格子里
  let sigma = clamp(pixel * 0.7, 2e-4, STAR_SHELL / (3.0 * STAR_CELLS));
  var sum = vec3f(0.0);
  for (var k = 0u; k < 8u; k++) {
    let cell = base + vec3i(vec3u(k & 1u, (k >> 1u) & 1u, k >> 2u));
    let q = vec3f(cell) + hash3(cell);
    let distance = length(q);
    let random = hash3(cell + vec3i(131, 71, 37));
    if (abs(distance - STAR_CELLS) > STAR_SHELL || random.x > STAR_DENSITY) { continue; }
    let d = c - q / distance;
    // 亮度的分布：比某个亮度亮的星星的数量 ∝ 亮度^-1.1（每暗一个星等多 2.8 倍）
    let flux = min(pow(max(random.y, 1e-4), -0.9), 600.0);
    // 颜色：偏红的到偏蓝的
    let tint = mix(vec3f(1.0, 0.78, 0.6), vec3f(0.72, 0.84, 1.0), random.z);
    sum += tint * flux * exp(-dot(d, d) / (2.0 * sigma * sigma));
  }
  return sum * STAR_FLUX / (2.0 * PI * sigma * sigma);
}

/** 银河：斜着的一条带子，带暗的尘埃带。 */
fn milkyWay(c: vec3f) -> vec3f {
  let latitude = dot(c, vec3f(0.4558, 0.4695, -0.7562));
  let band = exp(-latitude * latitude / 0.03);
  if (band < 0.01) { return vec3f(0.0); }
  let clouds = fbm(c * 5.0 + 3.0);
  let dust = smoothstep(0.35, 0.6, fbm(c * 11.0 + 9.0) + abs(latitude) * 2.0);
  return vec3f(0.62, 0.72, 1.0) * (band * (0.25 + clouds) * mix(0.25, 1.0, dust) * 0.012);
}
`;

/** 画天空：视线方向查天空视图表，再加太阳的圆盘（按透射率表变红变暗）、月面、星星和银河。 */
const SKY_SHADER = /* wgsl */ `
${FULLSCREEN_VERTEX}
${ATMOSPHERE_WGSL}
struct View { inverseViewProjection: mat4x4f, eye: vec4f };
@group(1) @binding(0) var<uniform> view: View;
@group(0) @binding(1) var skyViewLut: texture_2d<f32>;
@group(0) @binding(2) var transmittanceLut: texture_2d<f32>;
@group(0) @binding(3) var linearClamp: sampler;
@group(0) @binding(4) var skySampler: sampler;
${SKY_VIEW_WGSL}
${NIGHT}

const LUMINANCE = vec3f(0.2126, 0.7152, 0.0722);

@fragment fn fs(in: FullscreenVaryings) -> @location(0) vec4f {
  let far = view.inverseViewProjection * vec4f(in.ndc, 1.0, 1.0);
  let direction = normalize(far.xyz / far.w - view.eye.xyz);
  // 一个像素的张角：导数要在分支之外取
  let pixel = max(length(dpdx(direction)), length(dpdy(direction)));
  var color = textureSampleLevel(skyViewLut, skySampler, skyViewUv(direction), 0.0).rgb;
  let position = vec3f(0.0, atmosphere.ground.w, 0.0);
  // 朝着地面的视线上没有天体
  if (raySphere(position, direction, planetRadius()) >= 0.0) { return vec4f(color, 1.0); }
  let transmittance = textureSampleLevel(transmittanceLut, linearClamp, transmittanceUv(atmosphere.ground.w, direction.y), 0.0).rgb;

  let sun = atmosphere.bodies[0];
  let cosToSun = dot(direction, sun.direction.xyz);
  if (cosToSun > sun.direction.w) {
    // 圆盘的亮度 = 照度 / 立体角，限个上限免得泛光炸开；边缘按距离中心淡一点（临边昏暗的近似）
    let solidAngle = 2.0 * PI * (1.0 - sun.direction.w);
    let limb = sqrt(saturate((cosToSun - sun.direction.w) / max(1.0 - sun.direction.w, 1e-6)));
    color += transmittance * sun.illuminance.rgb * min(1.0 / solidAngle, sun.illuminance.w) * mix(0.6, 1.0, limb);
  }

  // 月面：一个球，被太阳照着（太阳远，照月亮的方向就是照我们的方向），所以月相、亮的那一边朝哪都是对的
  let moon = atmosphere.bodies[1];
  var moonCoverage = 0.0;
  if (moon.direction.w < 1.0) {
    let m = moon.direction.xyz;
    let moonRadius = acos(moon.direction.w);
    // 边缘按一个像素淡出
    moonCoverage = saturate((moonRadius - length(direction - m)) / max(pixel, 1e-7) + 0.5);
    if (moonCoverage > 0.0) {
      let offset = (direction - m * dot(direction, m)) / sin(moonRadius);
      let r2 = min(dot(offset, offset), 1.0);
      let z = sqrt(1.0 - r2);
      let normal = offset - m * z;
      // Lommel-Seeliger：满月是平的一片亮，不像 Lambert 的球那样边上暗
      let nl = saturate(dot(normal, sun.direction.xyz));
      let lit = min(2.0 * nl / max(nl + z, 1e-3), 1.5);
      let axis = select(vec3f(0.0, 1.0, 0.0), vec3f(1.0, 0.0, 0.0), abs(m.y) > 0.99);
      let x = normalize(cross(axis, m));
      let surface = vec3f(dot(offset, x), dot(offset, cross(m, x)), z);
      let albedo = mix(0.4, 1.0, smoothstep(0.38, 0.58, fbm(surface * 2.6 + 7.0)));
      // 背着太阳的那部分是地球反照：月亮越靠近太阳（蛾眉月），从月亮上看地球越圆，反照越亮
      let towardSun = 0.5 + 0.5 * dot(sun.direction.xyz, m);
      color += transmittance * atmosphere.night.rgb * (lit * albedo + 0.01 * towardSun * towardSun) * moonCoverage;
    }
  }

  if (atmosphere.night.w > 0.0) {
    let c = vec3f(dot(atmosphere.celestial[0].xyz, direction), dot(atmosphere.celestial[1].xyz, direction), dot(atmosphere.celestial[2].xyz, direction));
    let night = (stars(c, pixel) + milkyWay(c)) * atmosphere.night.w * transmittance * (1.0 - moonCoverage);
    // 比天空暗得多的星星被盖过去：黄昏时亮的先出来，有月亮的夜里暗的看不见
    let own = dot(night, LUMINANCE);
    color += night * own / max(own + 4.0 * dot(color, LUMINANCE), 1e-9);
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
${ATMOSPHERE_WGSL}
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
  var phaseRayleigh: array<f32, 2>;
  var phaseMie: array<f32, 2>;
  for (var b = 0u; b < 2u; b++) {
    let cosTheta = dot(direction, atmosphere.bodies[b].direction.xyz);
    phaseRayleigh[b] = rayleighPhase(cosTheta);
    phaseMie[b] = miePhase(cosTheta);
  }
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
      var inscatter = vec3f(0.0);
      for (var b = 0u; b < 2u; b++) {
        let body = atmosphere.bodies[b];
        if (all(body.illuminance.rgb <= vec3f(0.0))) { continue; }
        let toBody = body.direction.xyz;
        let multi = textureSampleLevel(multiScatteringLut, linearClamp, multiScatteringUv(length(p), dot(normalize(p), toBody)), 0.0).rgb;
        inscatter += body.illuminance.rgb * (transmittanceToSun(p, toBody) * (medium.scatteringRayleigh * phaseRayleigh[b] + medium.scatteringMie * phaseMie[b])
          + multi * (medium.scatteringRayleigh + medium.scatteringMie));
      }
      let extinction = max(medium.extinction, vec3f(1e-7));
      let stepTransmittance = exp(-medium.extinction * dt);
      radiance += transmittance * (inscatter - inscatter * stepTransmittance) / extinction;
      transmittance *= stepTransmittance;
    }
    t = end;
    textureStore(output, vec3u(id.xy, slice), vec4f(radiance, 1.0 - dot(transmittance, vec3f(1.0 / 3.0))));
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

/** uniform Atmosphere 的大小（12 个 vec4）。 */
const ATMOSPHERE_FLOATS = 48;
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

/** 天上的一盏光（太阳或者月亮）这一帧的状态。 */
export interface CelestialBody {
  /** 场景里有没有它（对应的方向光在这一帧的光照里）。 */
  present: boolean;
  /** 朝它的方向（世界，单位向量）。 */
  readonly direction: [number, number, number];
  /** 大气层顶的照度（光的颜色 · 强度；月亮的乘了月相）。 */
  readonly illuminance: [number, number, number];
  /** 圆盘的角半径（弧度）。 */
  angularRadius: number;
}

function celestialBody(): CelestialBody {
  return { present: false, direction: [0, 1, 0], illuminance: [0, 0, 0], angularRadius: 0.00465 };
}

/** 落到地平线以下这么多（sin 高度角）以后不再算它的散射：天文昏影（-18°）已经结束，贡献是 0。 */
const NO_SCATTERING_BELOW = -0.35;

/**
 * 场景的大气（渲染系统一份）：前向渲染器收集光照时 apply（找 SkyAtmosphere、调太阳和月亮的颜色、换天空光），网格之前
 * AtmosphereRenderFeature 的 prepare 里 update（该重算的查找表和天空光录进自己的编码器提交），画天空时 draw。
 */
export class Atmosphere {
  /** 这一帧有没有大气（场景里有 SkyAtmosphere，也有太阳或者月亮）。 */
  active = false;
  readonly settings: AtmosphereSettings = structuredClone(EARTH_ATMOSPHERE) as AtmosphereSettings;
  readonly sun = celestialBody();
  readonly moon = celestialBody();
  /** 月相：月面被太阳照亮的比例（0 新月，1 满月）。 */
  moonPhase = 1;
  /** 相机离地面的高度（千米）。 */
  cameraHeight = 0;
  /** 空气透视的距离倍数（SkyAtmosphere.aerialPerspectiveScale）；0 是不做。 */
  aerialPerspectiveScale = 1;
  /** 星星的亮度（SkyAtmosphere.starsIntensity，白天淡到 0）。 */
  starsIntensity = 0;
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
  // SkyAtmosphere 这一帧的值
  #sunEntity = -1 as EntityId;
  #moonEntity = -1 as EntityId;
  #moonDiskIntensity = 0;
  #stars = 0;
  /** 月面被照亮的地方的亮度（满月的照度 · moonDiskIntensity）。 */
  readonly #moonDisk: [number, number, number] = [0, 0, 0];
  /** 世界到天球坐标的旋转（三行，每行补一个 0）：SkyAtmosphere 所在实体的三个轴。 */
  readonly #celestial = new Float32Array(12);

  readonly #collect = system('Atmosphere.collect', {
    with: { atmosphere: SkyAtmosphere, transform: Transform },
    update: ({ atmosphere, transform, count }) => {
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
      this.#sunEntity = atmosphere.sun[0]! as EntityId;
      this.#moonEntity = atmosphere.moon[0]! as EntityId;
      this.#moonDiskIntensity = atmosphere.moonDiskIntensity[0]!;
      this.#stars = atmosphere.starsIntensity[0]!;
      // 世界矩阵的三列（实体的三个轴，归一化掉缩放）就是世界到天球坐标的旋转的三行
      const w = transform.slot[0]! * 16;
      for (let axis = 0; axis < 3; axis++) {
        const x = transform.world[w + axis * 4]!, y = transform.world[w + axis * 4 + 1]!, z = transform.world[w + axis * 4 + 2]!;
        const length = Math.hypot(x, y, z) || 1;
        this.#celestial.set([x / length, y / length, z / length], axis * 4);
      }
    },
  });

  constructor(device: GPUDevice, resources: GpuResources) {
    this.#device = device;
    this.#resources = resources;
  }

  /**
   * 收集光照之后（前向渲染器调）：场景里有 SkyAtmosphere 时，太阳和月亮的颜色乘相机处的透射率（月亮的再乘月相；沉到地平线
   * 以下是黑的），天空盒光换成大气的。eye 是主相机的位置（米）。
   */
  apply(context: RenderContext, lighting: Lighting, eye: { readonly x: number; readonly y: number; readonly z: number }): void {
    this.active = false;
    context.game.entities.run(this.#collect, context.time);
    if (!this.active) return;
    const lights = lighting.directionals.slice(0, lighting.directionalCount);
    const moonLight = this.#moonEntity < 0 ? undefined : lights.find((light) => light.entity === this.#moonEntity);
    const sunLight = this.#sunEntity < 0
      ? lights.find((light) => light !== moonLight && light.shadow) ?? lights.find((light) => light !== moonLight)
      : lights.find((light) => light.entity === this.#sunEntity);
    if (!sunLight && !moonLight) {
      this.active = false;
      return;
    }
    this.cameraHeight = Math.max(eye.y / 1000, 0.001);
    place(this.sun, sunLight);
    place(this.moon, moonLight);
    // 月相：月亮在太阳对面是满月，挨着太阳是新月。没有太阳的场景当满月
    const [sun, moon] = [this.sun.direction, this.moon.direction];
    this.moonPhase = sunLight ? (1 - (sun[0] * moon[0] + sun[1] * moon[1] + sun[2] * moon[2])) / 2 : 1;
    for (let c = 0; c < 3; c++) {
      this.#moonDisk[c] = this.moon.illuminance[c]! * this.#moonDiskIntensity;
      this.moon.illuminance[c]! *= this.moonPhase;
    }
    for (const [body, light] of [[this.sun, sunLight], [this.moon, moonLight]] as const) {
      if (!light) continue;
      const [r, g, b] = this.transmittanceTo(body, this.cameraHeight);
      light.color.set(body.illuminance[0] * r, body.illuminance[1] * g, body.illuminance[2] * b, 1);
    }
    // 星星：太阳在地平线上下 6° 之间淡入淡出（再往后天空亮的地方由着色器按对比度盖掉），白天不画
    const day = sunLight && this.sun.illuminance.some((v) => v > 0) ? smoothstep(-0.1, 0.1, sun[1]) : 0;
    this.starsIntensity = this.#stars * (1 - day);
    this.#sky ??= new DynamicSky(this.#device);
    // 天空盒的约定是乘实体的旋转；大气的天空光已经在世界坐标里。强度已经乘进天空的亮度里
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
    // 看得见的天空：太阳、月亮的方向变化约 0.05° 以内、相机高度变化 1 m 以内、亮度不变时不重算。环境光（立方体、球谐、预滤波，
    // 约 1 ms）粗一档：动了约 0.5°、亮度变了 2% 才重算，日夜循环时不每帧都算
    const sky = [lutKey, Math.round(this.cameraHeight * 1000), s.skyIntensity];
    const bodies = [this.sun, this.moon].map((body) => ({ direction: body.direction, illuminance: this.#scattering(body) }));
    const skyKey = JSON.stringify([...sky, bodies.map((body) => [body.direction.map((v) => Math.round(v * 1000)), body.illuminance])]);
    const lightingKey = JSON.stringify([...sky, bodies.map((body) => [body.direction.map((v) => Math.round(v * 100)), body.illuminance.map((v) => Math.round(Math.log(Math.max(v, 1e-6)) * 50))])]);
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

  /**
   * 天空朝上（或者朝下）的半球的平均亮度（环境光的球谐在正上、正下方的值；云的环境光用）。球谐还没读回来时是 0。
   * 第四个数是 0（凑成 vec4）。
   */
  skyRadiance(up: boolean): [number, number, number, number] {
    const sh = this.#sky?.diffuseSH;
    if (!sh) return [0, 0, 0, 0];
    // evaluateSH 在 (0, ±1, 0)：c0 ± c1 - c6 - c8
    const value = (c: number) => Math.max(sh[c]! + (up ? 1 : -1) * sh[3 + c]! - sh[18 + c]! - sh[24 + c]!, 0);
    return [value(0), value(1), value(2), 0];
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

  /**
   * 海拔 height（千米）处朝 body 的透射率，乘圆盘露在地平线上面的比例（圆盘沉下去的那一两分钟里平滑地暗掉，不是圆心一过
   * 地平线就黑）。圆心已经在地平线下面时按贴着地平线的方向算。越高地平线越低：云在地面天黑以后还被照着。
   */
  transmittanceTo(body: CelestialBody, height: number): [number, number, number] {
    const radius = this.settings.planetRadius + height;
    const horizon = -Math.acos(Math.min(this.settings.planetRadius / radius, 1));
    const [x, y, z] = body.direction;
    const elevation = Math.asin(Math.min(Math.max(y, -1), 1));
    const visible = smoothstep(horizon - body.angularRadius, horizon + body.angularRadius, elevation);
    if (visible <= 0) return [0, 0, 0];
    const lifted = Math.max(elevation, horizon + 1e-4);
    const flat = Math.hypot(x, z);
    const direction: [number, number, number] = flat > 1e-6 ? [(x / flat) * Math.cos(lifted), Math.sin(lifted), (z / flat) * Math.cos(lifted)] : [0, 1, 0];
    const [r, g, b] = sunTransmittance(this.settings, [0, radius, 0], direction);
    return [r * visible, g * visible, b * visible];
  }

  /** body 照进大气散射的照度（乘了天空的亮度）：没有它、或者落到地平线以下很多时是 0，着色器就不算它。 */
  #scattering(body: CelestialBody): number[] {
    const lit = body.present && body.direction[1] > NO_SCATTERING_BELOW;
    return body.illuminance.map((v) => (lit ? v * this.settings.skyIntensity : 0));
  }

  #uniforms(): Float32Array {
    const s = this.settings;
    // 没有这个天体时角半径的余弦给 2：视线和它的夹角的余弦永远到不了，不画圆盘
    const cosDisk = (body: CelestialBody) => (body.present ? Math.cos(body.angularRadius) : 2);
    return new Float32Array([
      ...s.rayleighScattering, s.planetRadius,
      s.mieScattering, s.mieScattering + s.mieAbsorption, s.miePhaseG, s.planetRadius + s.atmosphereHeight,
      ...s.ozoneAbsorption, s.atmosphereHeight,
      ...s.groundAlbedo, s.planetRadius + this.cameraHeight,
      ...this.sun.direction, cosDisk(this.sun),
      ...this.#scattering(this.sun), 1e4,
      ...this.moon.direction, cosDisk(this.moon),
      ...this.#scattering(this.moon), 0,
      ...this.#moonDisk, this.starsIntensity,
      ...this.#celestial,
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

/** 把这一帧的方向光记成天体：朝它的方向、大气层顶的照度、角半径。没有这盏光时照度是 0，方向留着上一帧的。 */
function place(body: CelestialBody, light: DirectionalLight | undefined): void {
  body.present = light !== undefined;
  if (!light) {
    body.illuminance.fill(0);
    return;
  }
  const length = Math.hypot(light.direction.x, light.direction.y, light.direction.z) || 1;
  body.direction.splice(0, 3, -light.direction.x / length, -light.direction.y / length, -light.direction.z / length);
  body.illuminance.splice(0, 3, light.color.r, light.color.g, light.color.b);
  body.angularRadius = Math.max((light.angle / 2) * (Math.PI / 180), 1e-4);
}

function smoothstep(low: number, high: number, value: number): number {
  const t = Math.min(Math.max((value - low) / (high - low), 0), 1);
  return t * t * (3 - 2 * t);
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
  /** 查天空视图表用：u 是方位角，首尾相接。 */
  readonly skySampler: GPUSampler;
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
    this.skySampler = device.createSampler({ label: 'Atmosphere sky view', magFilter: 'linear', minFilter: 'linear', addressModeU: 'repeat', addressModeV: 'clamp-to-edge' });
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
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
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
        { binding: 4, resource: this.skySampler },
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
    for (let level = 0; level < this.skyCube.mipLevelCount; level++) {
      const size = Math.max(1, SKY_CUBE_SIZE >> level);
      this.#dispatch(encoder, 'skyCube', [
        { binding: 0, resource: { buffer: this.uniforms } },
        { binding: 1, resource: this.skyCube.createView({ dimension: '2d-array', baseMipLevel: level, mipLevelCount: 1 }) },
        { binding: 2, resource: this.skyView.createView() },
        { binding: 3, resource: this.skySampler },
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
