/**
 * 物理天空的着色器源码（Atmosphere.ts 用；说明见那边的文件头）：大气的参数和共用的函数（ATMOSPHERE_WGSL，体积云也用），
 * 三张查找表的计算着色器（透射率、多次散射、天空视图），天空的环境光（立方体、球谐），画天空的片段着色器（圆盘、月面、
 * 星星和银河），空气透视的体素表和合成。
 */
import { CUBE_FACE_DIRECTION, FULLSCREEN_VERTEX, HASH3 } from '../wgsl';

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

/**
 * 夜空的底光（大气辉光和合起来的星光）：没有月亮的夜里天空和环境光不是纯黑。很暗（有月亮时被月光下的天空盖过去），跟着星星的
 * 亮度走；画面开着自动曝光时地面看得出轮廓，没开时接近全黑，要亮一点把 starsIntensity 调大或者加环境光。
 */
fn nightGlow() -> vec3f {
  return vec3f(0.0018, 0.00225, 0.003) * atmosphere.night.w;
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
export const TRANSMITTANCE_SHADER = /* wgsl */ `
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
export const MULTI_SCATTERING_SHADER = /* wgsl */ `
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
export const SKY_VIEW_SHADER = /* wgsl */ `
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
export const SKY_CUBE_SHADER = /* wgsl */ `
${ATMOSPHERE_WGSL}
@group(0) @binding(1) var output: texture_storage_2d_array<rgba16float, write>;
@group(0) @binding(2) var skyViewLut: texture_2d<f32>;
@group(0) @binding(3) var skySampler: sampler;
// 环境光里的云（rgb 散射，a 透射；没有云时是一张 1x1 的 (0, 0, 0, 1)）
@group(0) @binding(4) var cloudCube: texture_cube<f32>;
${SKY_VIEW_WGSL}

${CUBE_FACE_DIRECTION}

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
      // 夜空的底光只在地平线以上
      sum += textureSampleLevel(skyViewLut, skySampler, skyViewUv(vec3f(c.xy, -c.z)), 0.0).rgb + nightGlow() * smoothstep(-0.1, 0.1, c.y);
    }
  }
  // 云盖在天空上：按这一级纹素的大小取云的立方体里差不多大的那一级
  let center = normalize(faceDirection(id.z, (vec2f(id.xy) + 0.5) / vec2f(size) * 2.0 - 1.0));
  let level = log2(f32(textureDimensions(cloudCube).x) / f32(size.x));
  let cloud = textureSampleLevel(cloudCube, skySampler, center, max(level, 0.0));
  textureStore(output, id.xy, id.z, vec4f(sum / 16.0 * cloud.a + cloud.rgb, 1.0));
}`;

/** 立方体贴图投影成 3 阶球谐，乘 Lambert 余弦核和基函数常数（同资源管线的 st_cubemap_sh_lambert）。一个工作组算完。 */
export const SH_SHADER = /* wgsl */ `
@group(0) @binding(0) var source: texture_2d_array<f32>;
@group(0) @binding(1) var<storage, read_write> result: array<f32, 28>;

const SH_BASE = array<f32, 9>(0.282094792, -0.488602512, 0.488602512, -0.488602512, 1.092548431, -1.092548431, 0.315391565, -1.092548431, 0.546274215);
const SH_COSINE = array<f32, 9>(1.0, 0.6666667, 0.6666667, 0.6666667, 0.25, 0.25, 0.25, 0.25, 0.25);
var<workgroup> partial: array<array<f32, 28>, 64>;

${CUBE_FACE_DIRECTION}

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
${HASH3}

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
  // 尘埃带淡一点、边缘宽一点：对比太强、边缘太硬时是一团团的墨迹
  let dust = smoothstep(0.25, 0.75, fbm(c * 11.0 + 9.0) + abs(latitude) * 2.0);
  return vec3f(0.62, 0.72, 1.0) * (band * (0.25 + clouds) * mix(0.55, 1.0, dust) * 0.008);
}
`;

/** 画天空：视线方向查天空视图表，再加太阳的圆盘（按透射率表变红变暗）、月面、星星和银河。 */
export const SKY_SHADER = /* wgsl */ `
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
  // 近平面上的点（反向 Z：深度 1）定方向：平面反射的镜像视图是斜裁剪的投影（近平面换成了反射平面），远平面上的点可能落到相机
  // 后面、方向翻到地下；近平面上的点总在相机前面。普通的相机两种取法一样
  let near = view.inverseViewProjection * vec4f(in.ndc, 1.0, 1.0);
  let direction = normalize(near.xyz / near.w - view.eye.xyz);
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
    color += nightGlow();
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

export const AERIAL_SHADER = /* wgsl */ `
${ATMOSPHERE_WGSL}
@group(0) @binding(1) var output: texture_storage_3d<rgba16float, write>;
${integrate(false)}
${AERIAL}
@group(0) @binding(5) var<uniform> camera: Camera;

// 每个线程一列：沿视线走一遍，每层接着上一层积分（各层单独从相机积分时采样数不同，层和层之间的误差不连续，画面上是一圈圈的环）
@compute @workgroup_size(8, 8, 1) fn main(@builtin(global_invocation_id) id: vec3u) {
  if (any(vec2f(id.xy) >= vec2f(AERIAL_SIZE))) { return; }
  let uv = (vec2f(id.xy) + 0.5) / AERIAL_SIZE;
  let far = camera.inverseViewProjection * vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 0.0, 1.0);
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
export const AERIAL_COMPOSITE_SHADER = /* wgsl */ `
${FULLSCREEN_VERTEX}
${AERIAL}
@group(0) @binding(0) var aerial: texture_3d<f32>;
@group(0) @binding(1) var depth: texture_depth_2d;
@group(0) @binding(2) var linearClamp: sampler;
@group(0) @binding(3) var<uniform> camera: Camera;

@fragment fn fs(in: FullscreenVaryings) -> @location(0) vec4f {
  let d = textureLoad(depth, vec2i(in.position.xy), 0);
  // 反向 Z：0 是天空（远平面）
  if (d <= 0.0) { discard; }
  let world = camera.inverseViewProjection * vec4f(in.ndc, d, 1.0);
  let distance = length(world.xyz / world.w - camera.eye.xyz) / 1000.0 * camera.eye.w;
  // 层号的反函数：第 i 层的中心在 sqrt(距离 / 总长) - 0.5 / 层数；比第一层还近的按距离淡到 0
  let w = sqrt(distance / (AERIAL_SIZE * AERIAL_KM_PER_SLICE));
  let z = w - 0.5 / AERIAL_SIZE;
  let fade = saturate(w * AERIAL_SIZE);
  let s = textureSampleLevel(aerial, linearClamp, vec3f(in.uv, max(z, 0.5 / AERIAL_SIZE)), 0.0) * fade;
  return vec4f(s.rgb, 1.0 - s.a);
}`;
