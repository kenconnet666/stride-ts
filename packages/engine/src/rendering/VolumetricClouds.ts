/**
 * 体积云（VolumetricClouds 组件；Stride 没有）：Schneider 2015 "The Real-time Volumetric Cloudscapes of Horizon Zero Dawn"
 * 的做法，对照 PlayCanvas 的 dynamic-sky（MIT，云的部分改自 Godot 的 sky shaders 示例，MIT）。要场景里有物理天空
 * （SkyAtmosphere）：光照、天空的颜色、星球的大小都从大气来。
 *
 * - 云在一层球壳里（云底到云顶，按星球的曲率弯下去，所以远处的云沉到地平线）。密度 = 形状噪声 · 高度上的轮廓，减掉
 *   （1 - 覆盖），边上再用细节噪声啃掉一圈。覆盖在大尺度上按一张天气噪声变，所以天上是一块一块的云，不是均匀的一层。
 * - 噪声是程序生成的（一张 128³ 的三维贴图，第一次用时计算着色器分几帧算完，算完之前不画云）：R 是形状（Perlin-Worley），G 是细节（Worley 的
 *   分形和），B 是天气（低频 Perlin）。三个方向都首尾相接。
 * - 每个像素沿视线在球壳里走几十步，有云的地方再朝主光走几步算透射。主光是太阳、月亮里在云的高度上更亮的那个（云比地面
 *   高，日落以后还被照着）；多次散射用几个倍频近似（Wrenninge 2013）；环境光是天空的球谐朝上、朝下两个方向的值。
 * - 半分辨率算，每帧把起点抖一下，和上一帧的结果按方向重投影后混合（云远、变得慢，十几帧收敛成平滑的结果）；然后合成进
 *   画面：只画在天空的像素上（深度是 1），颜色 = 天空 · 云的透射 + 云的散射。云到相机之间的大气按平均距离淡向天空的颜色。
 * - 还没做：云在地面上的影子、云进环境光和反射探针、相机在云里或者云上面时地面的物体不被云挡（云只盖天空的像素）、
 *   穿过云的光柱（体积光那一项）。
 */
import { system } from '../engine/system';
import type { GameTime } from '../games/GameTime';
import { ATMOSPHERE_WGSL, SKY_VIEW_WGSL, type Atmosphere } from './Atmosphere';
import { VolumetricClouds } from './components';
import { FULLSCREEN_VERTEX } from './fullscreen';
import type { RenderContext, RenderView } from './RenderSystem';

/** 噪声贴图的边长（64 时小块的云看得出一个个纹素），和一帧生成几层（分几帧算完，不在一帧里卡一下）。 */
const NOISE_SIZE = 128;
const NOISE_SLICES_PER_FRAME = 16;
/** 形状噪声重复一次是多少千米（scale 是 1 时）。 */
const SHAPE_PERIOD_KM = 9;
/** 一条视线最多走几步、朝光走几步。 */
const VIEW_STEPS = 64;
const LIGHT_STEPS = 5;
/** 和上一帧混合时这一帧占的比重。 */
const HISTORY_BLEND = 0.1;
/** 云的消光系数（每千米，密度是 1 时；真实的积云在 50 到 120 之间）。 */
const EXTINCTION_PER_KM = 60;
const FORMAT: GPUTextureFormat = 'rgba16float';
const UNIFORM_FLOATS = 68;

/** 噪声贴图：每个纹素算一遍。坐标 0..1，三个方向首尾相接（格子按周期取模）。 */
const NOISE_SHADER = /* wgsl */ `
@group(0) @binding(0) var output: texture_storage_3d<rgba8unorm, write>;
// x：这一次从第几层算起
@group(0) @binding(1) var<uniform> slices: vec4u;

/** 格子到三个 0..1 的随机数（pcg3d，Jarzynski、Olano 2020）。 */
fn hash3(cell: vec3i) -> vec3f {
  var v = bitcast<vec3u>(cell) * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> vec3u(16u);
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return vec3f(v) * (1.0 / 4294967296.0);
}

fn wrap(cell: vec3i, period: i32) -> vec3i {
  return ((cell % period) + period) % period;
}

/** 周期为 period 格的梯度噪声，大约 -1..1。 */
fn perlin(p: vec3f, period: i32) -> f32 {
  let cell = vec3i(floor(p));
  let f = fract(p);
  let u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  var corners: array<f32, 8>;
  for (var k = 0u; k < 8u; k++) {
    let offset = vec3i(vec3u(k & 1u, (k >> 1u) & 1u, k >> 2u));
    let gradient = normalize(hash3(wrap(cell + offset, period)) * 2.0 - 1.0);
    corners[k] = dot(gradient, f - vec3f(offset));
  }
  let x00 = mix(corners[0], corners[1], u.x);
  let x10 = mix(corners[2], corners[3], u.x);
  let x01 = mix(corners[4], corners[5], u.x);
  let x11 = mix(corners[6], corners[7], u.x);
  return mix(mix(x00, x10, u.y), mix(x01, x11, u.y), u.z) * 1.6;
}

/** 周期为 period 格的 Worley 噪声：1 - 到最近的特征点的距离，0..1（特征点上是 1）。 */
fn worley(p: vec3f, period: i32) -> f32 {
  let cell = vec3i(floor(p));
  let f = fract(p);
  var nearest = 1.0;
  for (var z = -1; z <= 1; z++) {
    for (var y = -1; y <= 1; y++) {
      for (var x = -1; x <= 1; x++) {
        let offset = vec3i(x, y, z);
        let d = vec3f(offset) + hash3(wrap(cell + offset, period)) - f;
        nearest = min(nearest, dot(d, d));
      }
    }
  }
  return 1.0 - saturate(sqrt(nearest));
}

fn worleyFbm(p: vec3f, frequency: i32) -> f32 {
  return worley(p * f32(frequency), frequency) * 0.625 + worley(p * f32(frequency * 2), frequency * 2) * 0.25 + worley(p * f32(frequency * 4), frequency * 4) * 0.125;
}

fn perlinFbm(p: vec3f, frequency: i32, octaves: i32) -> f32 {
  var sum = 0.0;
  var amplitude = 0.5;
  var f = frequency;
  for (var i = 0; i < octaves; i++) {
    sum += perlin(p * f32(f), f) * amplitude;
    amplitude *= 0.5;
    f *= 2;
  }
  return sum;
}

fn remap(value: f32, low: f32, high: f32, newLow: f32, newHigh: f32) -> f32 {
  return newLow + (value - low) / (high - low) * (newHigh - newLow);
}

@compute @workgroup_size(4, 4, 4) fn main(@builtin(global_invocation_id) invocation: vec3u) {
  let size = textureDimensions(output);
  let id = vec3u(invocation.xy, invocation.z + slices.x);
  if (any(id >= size)) { return; }
  let p = (vec3f(id) + 0.5) / vec3f(size);
  // 形状（Schneider 的 Perlin-Worley）：Perlin 的分形和取"鼓起来"的形状，被 Worley 垫高，再减掉高频的 Worley
  let billowy = abs(perlinFbm(p, 4, 4)) * 2.0;
  let perlinWorley = remap(saturate(billowy), 0.0, 1.0, worleyFbm(p, 4), 1.0);
  let shape = saturate(remap(perlinWorley, worleyFbm(p, 8) - 1.0, 1.0, 0.0, 1.0));
  // 细节：采样时按更高的频率铺
  let detail = worleyFbm(p, 3);
  // 天气：低频，拉开到占满 0..1
  let weather = saturate(perlinFbm(p, 2, 4) * 1.4 + 0.5);
  textureStore(output, id, vec4f(shape, detail, weather, 1.0));
}`;

const CLOUDS_STRUCT = /* wgsl */ `
struct Clouds {
  inverseViewProjection: mat4x4f,
  // 上一帧的视图投影：按方向找上一帧的结果
  previousViewProjection: mat4x4f,
  // xyz 相机的位置（米），w 这一帧的序号（抖动用）
  eye: vec4f,
  // x 云底、y 云顶（千米，海拔），z 覆盖（0..1），w 消光系数（每千米）
  layer: vec4f,
  // x 形状噪声每千米重复几次，y 细节噪声是形状的几倍频率，z 云的种类（0 层云，0.5 层积云，1 积云），w 视线上走几步
  shape: vec4f,
  // xy 形状的偏移、zw 细节的偏移（千米；风吹着走）
  wind: vec4f,
  // xyz 朝主光的方向，w 朝光走几步
  light: vec4f,
  // rgb 云的高度上主光的照度，w 这一帧的比重（没有上一帧的结果时是 1）
  lightColor: vec4f,
  // 环境光：云顶、云底看到的天空的亮度
  ambientTop: vec4f,
  ambientBottom: vec4f,
  // xy 云缓冲的大小，zw 画面的大小
  size: vec4f,
};`;

/** 步进：每个半分辨率的像素沿视线积分，和上一帧的结果混合，写进这一帧的云缓冲（rgb 云的散射，a 云的透射；2 是没算）。 */
const MARCH_SHADER = /* wgsl */ `
${FULLSCREEN_VERTEX}
${ATMOSPHERE_WGSL}
${CLOUDS_STRUCT}
@group(0) @binding(1) var<uniform> clouds: Clouds;
@group(0) @binding(2) var noise: texture_3d<f32>;
@group(0) @binding(3) var noiseSampler: sampler;
@group(0) @binding(4) var skyViewLut: texture_2d<f32>;
@group(0) @binding(5) var skySampler: sampler;
@group(0) @binding(6) var depth: texture_depth_2d;
@group(0) @binding(7) var history: texture_2d<f32>;
${SKY_VIEW_WGSL}

/** 没算的像素（整块都被物体挡着）的标记。 */
const NOT_MARCHED = 2.0;

/** 沿视线走 t 千米以后的海拔 = c + b·t + a·t²（a 是曲率）；等于 height 的两个 t（小的在前）。没有时 x 大于 y。 */
fn heightCrossings(a: f32, b: f32, eyeHeight: f32, height: f32) -> vec2f {
  let c = eyeHeight - height;
  let discriminant = b * b - 4.0 * a * c;
  if (discriminant < 0.0) { return vec2f(1.0, -1.0); }
  // 不相消的求根：q = -(b + sign(b)·根号) / 2，两个根是 q / a 和 c / q
  let q = -0.5 * (b + select(-1.0, 1.0, b >= 0.0) * sqrt(discriminant));
  let r1 = q / a;
  let r2 = select(c / q, r1, abs(q) < 1e-12);
  return vec2f(min(r1, r2), max(r1, r2));
}

/** 高度上的轮廓（Schneider 的三种云的梯度）：h 是 0（云底）到 1（云顶）。 */
fn heightGradient(h: f32, kind: f32) -> f32 {
  let g = vec4f(0.02, 0.05, 0.09, 0.11) * saturate(1.0 - kind * 2.0)
    + vec4f(0.02, 0.2, 0.48, 0.625) * (1.0 - abs(kind - 0.5) * 2.0)
    + vec4f(0.01, 0.0625, 0.78, 1.0) * saturate(kind - 0.5) * 2.0;
  return smoothstep(g.x, g.y, h) - smoothstep(g.z, g.w, h);
}

/** p 处云的密度（0..1）。p：x、z 是世界里的水平位置，y 是海拔（千米）。detail 为假时不啃边（朝光走的那几步用）。 */
fn cloudDensity(p: vec3f, detail: bool) -> f32 {
  let h = (p.y - clouds.layer.x) / (clouds.layer.y - clouds.layer.x);
  if (h <= 0.0 || h >= 1.0) { return 0.0; }
  let frequency = clouds.shape.x;
  let q = vec3f(p.x + clouds.wind.x, p.y, p.z + clouds.wind.y) * frequency;
  // 这一带有多少云：覆盖越大，天气噪声里够得着的地方越多
  let weather = textureSampleLevel(noise, noiseSampler, vec3f(q.x * 0.11, 0.5, q.z * 0.11), 0.0).b;
  let threshold = mix(0.8, 0.0, clouds.layer.z);
  let cover = smoothstep(threshold, threshold + 0.25, weather);
  if (cover <= 0.0) { return 0.0; }
  let shape = textureSampleLevel(noise, noiseSampler, q, 0.0).r * heightGradient(h, clouds.shape.z);
  var density = saturate((shape - (1.0 - cover)) / cover);
  if (detail && density > 0.0) {
    let d = textureSampleLevel(noise, noiseSampler, q * clouds.shape.y + vec3f(clouds.wind.z, 0.0, clouds.wind.w), 0.0).g;
    // 云底啃成一缕一缕的，往上啃成鼓起来的
    let erosion = mix(d, 1.0 - d, saturate(h * 5.0)) * 0.35;
    density = saturate((density - erosion) / (1.0 - erosion));
  }
  return density;
}

fn henyeyGreenstein(cosTheta: f32, g: f32) -> f32 {
  let g2 = g * g;
  return (1.0 - g2) / (4.0 * PI * pow(max(1.0 + g2 - 2.0 * g * cosTheta, 1e-4), 1.5));
}

fn gradientNoise(pixel: vec2f) -> f32 {
  return fract(52.9829189 * fract(dot(pixel, vec2f(0.06711056, 0.00583715))));
}

struct Marched { scattered: vec3f, transmittance: f32, distance: f32, height: f32 };

fn march(direction: vec3f, jitter: f32) -> Marched {
  var result = Marched(vec3f(0.0), 1.0, 0.0, 0.0);
  let radius = planetRadius();
  let eyeHeight = max(clouds.eye.y / 1000.0, 0.0);
  let a = max((1.0 - direction.y * direction.y) / (2.0 * radius), 1e-7);
  let top = heightCrossings(a, direction.y, eyeHeight, clouds.layer.y);
  if (top.x > top.y || top.y <= 0.0) { return result; }
  let bottom = heightCrossings(a, direction.y, eyeHeight, clouds.layer.x);
  // 视线在云层里的第一段：从上面进来到云底，或者从云底下面钻上去到云顶
  var start = max(top.x, 0.0);
  var end = top.y;
  if (bottom.x <= bottom.y) {
    if (bottom.x > start) { end = bottom.x; } else { start = max(bottom.y, start); }
  }
  // 先碰到地面的看不到云
  let ground = heightCrossings(a, direction.y, eyeHeight, 0.0);
  if (ground.x <= ground.y && ground.x > 0.0) {
    if (ground.x < start) { return result; }
    end = min(end, ground.x);
  }
  end = min(end, start + 40.0);
  if (end <= start) { return result; }

  // 空的地方大步走（不啃边的密度，便宜）；碰到云退回一大步、换成小步细走，连着几步都空了再换回大步
  let steps = clouds.shape.w;
  let coarse = (end - start) / (steps * 0.5);
  let fine = coarse * 0.3;
  let toLight = clouds.light.xyz;
  let cosTheta = dot(direction, toLight);
  let thickness = clouds.layer.y - clouds.layer.x;
  let eye = vec3f(clouds.eye.x / 1000.0, eyeHeight, clouds.eye.z / 1000.0);
  var distanceSum = 0.0;
  var heightSum = 0.0;
  var weightSum = 0.0;
  var t = start + coarse * jitter;
  var inCloud = false;
  var empty = 0;
  // 步数的上限是两倍：稀薄的云里一直是小步，按一倍算会在云里走到一半就没步数了（云上出现透出天空的缝）
  for (var i = 0.0; i < steps * 2.0 && t < end; i += 1.0) {
    let flat = direction * t;
    // 世界里的位置，y 换成海拔（曲率让远处的云沉下去）
    let p = vec3f(eye.x + flat.x, eyeHeight + flat.y + a * t * t, eye.z + flat.z);
    if (!inCloud) {
      if (cloudDensity(p, false) > 0.0) {
        inCloud = true;
        empty = 0;
        t = max(t - coarse + fine, start);
      } else {
        t += coarse;
      }
      continue;
    }
    let dt = fine;
    let density = cloudDensity(p, true);
    if (density <= 0.0) {
      empty++;
      inCloud = empty < 5;
    } else {
      empty = 0;
      // 朝光走几步，步子越来越大：近处的遮挡细，远处的粗
      var depthToLight = 0.0;
      var reach = 0.0;
      for (var j = 0.0; j < clouds.light.w; j += 1.0) {
        let stride = thickness * 0.06 * exp2(j);
        depthToLight += cloudDensity(p + toLight * (reach + stride * 0.5), false) * stride;
        reach += stride;
      }
      depthToLight *= clouds.layer.w;
      // 多次散射的近似（Wrenninge 2013）：每一阶的光衰减得慢、贡献小一点、相函数平一半。云的反照率接近 1，高阶的散射
      // 占大头：衰减、贡献的比例取到厚云受光的一面大约是白色漫反射面的亮度（照度 / π）
      var light = 0.0;
      var attenuation = 1.0;
      var contribution = 1.0;
      var eccentricity = 1.0;
      for (var octave = 0; octave < 6; octave++) {
        let phase = mix(henyeyGreenstein(cosTheta, 0.8 * eccentricity), henyeyGreenstein(cosTheta, -0.3 * eccentricity), 0.3);
        light += contribution * phase * exp(-depthToLight * attenuation);
        attenuation *= 0.45;
        contribution *= 0.85;
        eccentricity *= 0.5;
      }
      let h = saturate((p.y - clouds.layer.x) / thickness);
      // 环境光：云顶看到整个天空；云底看到的是地面反上来的光和从云里漫透下来的阳光（灰白的，不是天空的蓝）
      let underside = 0.5 * (clouds.ambientBottom.rgb + clouds.ambientTop.rgb) + clouds.lightColor.rgb * (0.04 * max(toLight.y, 0.0));
      let ambient = mix(underside, clouds.ambientTop.rgb, h);
      let extinction = density * clouds.layer.w;
      let inscatter = (clouds.lightColor.rgb * light + ambient) * extinction;
      let stepTransmittance = exp(-extinction * dt);
      // 解析地积分这一段（同大气的能量守恒积分）
      let weight = result.transmittance * (1.0 - stepTransmittance);
      result.scattered += inscatter / extinction * weight;
      result.transmittance *= stepTransmittance;
      distanceSum += t * weight;
      heightSum += p.y * weight;
      weightSum += weight;
      if (result.transmittance < 0.01) {
        result.transmittance = 0.0;
        break;
      }
    }
    t += dt;
  }
  if (weightSum > 0.0) {
    result.distance = distanceSum / weightSum;
    result.height = heightSum / weightSum;
  }
  return result;
}

/** 上一帧的云缓冲里 uv 处的值：四个纹素按双线性的权重混合，没算的不参加；可用的权重不到一半时 a 是 NOT_MARCHED。 */
fn sampleHistory(uv: vec2f) -> vec4f {
  let size = vec2f(textureDimensions(history));
  let position = uv * size - 0.5;
  let base = floor(position);
  let f = position - base;
  var sum = vec4f(0.0);
  var weightSum = 0.0;
  for (var k = 0u; k < 4u; k++) {
    let offset = vec2f(f32(k & 1u), f32(k >> 1u));
    let texel = textureLoad(history, vec2i(clamp(base + offset, vec2f(0.0), size - 1.0)), 0);
    let weight = mix(1.0 - f.x, f.x, offset.x) * mix(1.0 - f.y, f.y, offset.y);
    if (texel.a <= 1.0) {
      sum += texel * weight;
      weightSum += weight;
    }
  }
  if (weightSum < 0.5) { return vec4f(0.0, 0.0, 0.0, NOT_MARCHED); }
  return sum / weightSum;
}

@fragment fn fs(in: FullscreenVaryings) -> @location(0) vec4f {
  // 这个像素盖着的 2x2 个画面像素都被物体挡着：不算
  let full = vec2i(clouds.size.zw) - 1;
  let corner = vec2i(in.position.xy) * 2;
  let farthest = max(
    max(textureLoad(depth, min(corner, full), 0), textureLoad(depth, min(corner + vec2i(1, 0), full), 0)),
    max(textureLoad(depth, min(corner + vec2i(0, 1), full), 0), textureLoad(depth, min(corner + vec2i(1, 1), full), 0)));
  if (farthest < 1.0) { return vec4f(0.0, 0.0, 0.0, NOT_MARCHED); }

  let far = clouds.inverseViewProjection * vec4f(in.ndc, 1.0, 1.0);
  let direction = normalize(far.xyz / far.w - clouds.eye.xyz);
  // 每帧换一个抖动（黄金分割的步子），十几帧里把一步的长度铺满
  let jitter = fract(gradientNoise(in.position.xy) + clouds.eye.w * 0.61803399);
  let marched = march(direction, jitter);
  var current = vec4f(marched.scattered, marched.transmittance);
  if (marched.transmittance < 1.0) {
    // 云到相机之间的大气：按平均距离、相机和云之间的平均高度上的消光，淡向这个方向的天空的颜色
    let middle = 0.5 * (max(clouds.eye.y / 1000.0, 0.0) + marched.height);
    let medium = sampleMedium(middle);
    let fade = exp(-medium.extinction * marched.distance);
    let sky = textureSampleLevel(skyViewLut, skySampler, skyViewUv(direction), 0.0).rgb;
    current = vec4f(marched.scattered * fade + sky * (1.0 - fade) * (1.0 - marched.transmittance), marched.transmittance);
  }

  // 上一帧同一个方向上的结果（云远，相机挪动带来的视差不管）
  let previous = clouds.previousViewProjection * vec4f(clouds.eye.xyz + direction * 1e5, 1.0);
  let uv = vec2f(previous.x / previous.w * 0.5 + 0.5, 0.5 - previous.y / previous.w * 0.5);
  if (previous.w <= 0.0 || any(uv < vec2f(0.0)) || any(uv > vec2f(1.0))) { return current; }
  let old = sampleHistory(uv);
  if (old.a > 1.0) { return current; }
  return mix(old, current, clouds.lightColor.w);
}`;

/** 合成：天空的像素上，颜色 = 天空 · 云的透射 + 云的散射（混合：src + dst · srcAlpha）。 */
const COMPOSITE_SHADER = /* wgsl */ `
${FULLSCREEN_VERTEX}
@group(0) @binding(0) var cloudBuffer: texture_2d<f32>;
@group(0) @binding(1) var depth: texture_depth_2d;

@fragment fn fs(in: FullscreenVaryings) -> @location(0) vec4f {
  if (textureLoad(depth, vec2i(in.position.xy), 0) < 1.0) { discard; }
  // 双线性放大，没算的纹素（被物体挡着的那些）不参加：物体的轮廓边上不会混进别的值
  let size = vec2f(textureDimensions(cloudBuffer));
  let position = in.uv * size - 0.5;
  let base = floor(position);
  let f = position - base;
  var sum = vec4f(0.0);
  var weightSum = 0.0;
  for (var k = 0u; k < 4u; k++) {
    let offset = vec2f(f32(k & 1u), f32(k >> 1u));
    let texel = textureLoad(cloudBuffer, vec2i(clamp(base + offset, vec2f(0.0), size - 1.0)), 0);
    let weight = mix(1.0 - f.x, f.x, offset.x) * mix(1.0 - f.y, f.y, offset.y);
    if (texel.a <= 1.0) {
      sum += texel * weight;
      weightSum += weight;
    }
  }
  if (weightSum <= 0.0) { discard; }
  return sum / weightSum;
}`;

/** 云这一帧的设置（VolumetricClouds 组件的值）。 */
export interface CloudSettings {
  coverage: number;
  density: number;
  /** 云底的海拔和云层的厚度（米）。 */
  bottom: number;
  thickness: number;
  cloudType: number;
  scale: number;
  windSpeed: number;
  windDirection: number;
}

/**
 * 场景的体积云（渲染系统一份）：前向渲染器收集光照之后 apply（找 VolumetricClouds、让风吹着走），主画面不透明的画完以后
 * record（步进、和上一帧混合、合成进画面）。
 */
export class Clouds {
  /** 这一帧画不画云（场景里有 VolumetricClouds，也有物理天空）。 */
  active = false;
  readonly settings: CloudSettings = { coverage: 0.5, density: 1, bottom: 1500, thickness: 2500, cloudType: 0.7, scale: 1, windSpeed: 10, windDirection: 0 };
  /** 风吹出来的偏移（千米）：形状的和细节的（细节飘得快一点，云的边在变）。 */
  readonly offset: [number, number, number, number] = [0, 0, 0, 0];
  readonly #device: GPUDevice;
  readonly #atmosphere: Atmosphere;
  #gpu: CloudsGpu | undefined;
  #found = false;
  #frame = 0;

  readonly #collect = system('Clouds.collect', {
    with: { clouds: VolumetricClouds },
    update: ({ clouds, count }) => {
      if (count === 0 || this.#found) return;
      this.#found = true;
      const s = this.settings;
      s.coverage = clouds.coverage[0]!;
      s.density = clouds.density[0]!;
      s.bottom = clouds.bottom[0]!;
      s.thickness = clouds.thickness[0]!;
      s.cloudType = clouds.cloudType[0]!;
      s.scale = clouds.scale[0]!;
      s.windSpeed = clouds.windSpeed[0]!;
      s.windDirection = clouds.windDirection[0]!;
    },
  });

  constructor(device: GPUDevice, atmosphere: Atmosphere) {
    this.#device = device;
    this.#atmosphere = atmosphere;
  }

  /** 大气 apply 之后调：enabled 是画质档位给不给。 */
  apply(context: RenderContext, enabled: boolean): void {
    this.#found = false;
    if (enabled && this.#atmosphere.active) context.game.entities.run(this.#collect, context.time);
    this.active = this.#found && this.settings.coverage > 0 && this.settings.density > 0;
    if (this.active) this.#drift(context.time);
  }

  /** 步进这一帧的云、合成进 target（主画面，不透明的画完以后）。depth 是主画面的深度；timestampWrites 量步进那一遍的 GPU 耗时。 */
  record(encoder: GPUCommandEncoder, view: RenderView, target: GPUTextureView, format: GPUTextureFormat, depth: GPUTexture, timestampWrites?: GPURenderPassTimestampWrites): void {
    const atmosphere = this.#atmosphere.gpu;
    if (!this.active || !atmosphere) return;
    const gpu = (this.#gpu ??= new CloudsGpu(this.#device));
    gpu.record(encoder, atmosphere, this.#uniforms(view, gpu.resize(depth.width, depth.height)), target, format, depth, timestampWrites);
    this.#frame = (this.#frame + 1) % 1024;
  }

  destroy(): void {
    this.#gpu?.destroy();
  }

  /** 风：windDirection 是吹向的方位（度，0 是 +Z，90 是 +X），云的图案往那边挪就是采样的位置往反方向偏。 */
  #drift(time: GameTime): void {
    const angle = (this.settings.windDirection * Math.PI) / 180;
    const distance = (this.settings.windSpeed * time.elapsed) / 1000;
    const x = -Math.sin(angle) * distance, z = -Math.cos(angle) * distance;
    this.offset[0] += x;
    this.offset[1] += z;
    // 噪声是周期的：偏移取模，跑久了不丢精度
    const period = SHAPE_PERIOD_KM * this.settings.scale * 64;
    this.offset[0] %= period;
    this.offset[1] %= period;
    this.offset[2] = (this.offset[2] + x * 0.3) % 1;
    this.offset[3] = (this.offset[3] + z * 0.3) % 1;
  }

  #uniforms(view: RenderView, firstFrame: boolean): Float32Array {
    const s = this.settings;
    const atmosphere = this.#atmosphere;
    const bottom = s.bottom / 1000, top = (s.bottom + s.thickness) / 1000;
    // 主光：太阳、月亮里在云的高度上更亮的那个
    const lights = [atmosphere.sun, atmosphere.moon].map((body) => {
      const transmittance = atmosphere.transmittanceTo(body, (bottom + top) / 2);
      return { direction: body.direction, color: body.illuminance.map((v, c) => v * transmittance[c]!) };
    });
    const luminance = (color: readonly number[]) => 0.2126 * color[0]! + 0.7152 * color[1]! + 0.0722 * color[2]!;
    const light = luminance(lights[0]!.color) >= luminance(lights[1]!.color) ? lights[0]! : lights[1]!;
    const data = new Float32Array(UNIFORM_FLOATS);
    data.set(view.inverseViewProjection, 0);
    data.set(view.previousViewProjection, 16);
    data.set([view.eye.x, view.eye.y, view.eye.z, this.#frame], 32);
    data.set([bottom, top, s.coverage, EXTINCTION_PER_KM * s.density], 36);
    data.set([1 / (SHAPE_PERIOD_KM * s.scale), 7, s.cloudType, VIEW_STEPS], 40);
    data.set(this.offset, 44);
    data.set([...light.direction, LIGHT_STEPS], 48);
    data.set([...light.color, firstFrame ? 1 : HISTORY_BLEND], 52);
    data.set(atmosphere.skyRadiance(true), 56);
    data.set(atmosphere.skyRadiance(false), 60);
    data.set([Math.ceil(view.width / 2), Math.ceil(view.height / 2), view.width, view.height], 64);
    return data;
  }
}

/** 体积云的 GPU 资源：噪声贴图、云缓冲（这一帧和上一帧的，轮着写）、步进和合成的管线。 */
class CloudsGpu {
  readonly #device: GPUDevice;
  readonly #noise: GPUTexture;
  readonly #noiseSampler: GPUSampler;
  readonly #uniforms: GPUBuffer;
  readonly #march: GPURenderPipeline;
  readonly #compositeModule: GPUShaderModule;
  readonly #compositeLayout: GPUBindGroupLayout;
  readonly #composites = new Map<GPUTextureFormat, GPURenderPipeline>();
  #buffers: [GPUTexture, GPUTexture] | undefined;
  #current = 0;
  /** 噪声算到第几层了；到 NOISE_SIZE 就是算完了，生成用的管线和缓冲随即丢掉。 */
  #noiseSlices = 0;
  #noisePipeline: GPUComputePipeline | undefined;
  #noiseUniform: GPUBuffer | undefined;

  constructor(device: GPUDevice) {
    this.#device = device;
    this.#noise = device.createTexture({
      label: 'Clouds noise', size: [NOISE_SIZE, NOISE_SIZE, NOISE_SIZE], dimension: '3d', format: 'rgba8unorm',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.#noiseSampler = device.createSampler({ label: 'Clouds noise', magFilter: 'linear', minFilter: 'linear', addressModeU: 'repeat', addressModeV: 'repeat', addressModeW: 'repeat' });
    this.#uniforms = device.createBuffer({ label: 'Clouds', size: UNIFORM_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const march = device.createShaderModule({ label: 'Clouds march', code: MARCH_SHADER });
    this.#march = device.createRenderPipeline({
      label: 'Clouds march', layout: 'auto',
      vertex: { module: march, entryPoint: 'fullscreenVertex' },
      fragment: { module: march, entryPoint: 'fs', targets: [{ format: FORMAT }] },
    });
    this.#compositeModule = device.createShaderModule({ label: 'Clouds composite', code: COMPOSITE_SHADER });
    this.#compositeLayout = device.createBindGroupLayout({
      label: 'Clouds composite',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth' } },
      ],
    });
  }

  /** 云缓冲跟着画面的大小（一半）；重建了返回真（这一帧没有上一帧的结果可用）。 */
  resize(width: number, height: number): boolean {
    const w = Math.ceil(width / 2), h = Math.ceil(height / 2);
    if (this.#buffers?.[0].width === w && this.#buffers[0].height === h) return false;
    for (const texture of this.#buffers ?? []) texture.destroy();
    const buffer = (index: number) => this.#device.createTexture({ label: `Clouds buffer ${index}`, size: [w, h], format: FORMAT, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
    this.#buffers = [buffer(0), buffer(1)];
    return true;
  }

  record(encoder: GPUCommandEncoder, atmosphere: AtmosphereResources, uniforms: Float32Array, target: GPUTextureView, format: GPUTextureFormat, depth: GPUTexture, timestampWrites?: GPURenderPassTimestampWrites): void {
    this.#device.queue.writeBuffer(this.#uniforms, 0, uniforms as Float32Array<ArrayBuffer>);
    // 噪声还没算完：这一帧接着算几层，不画云
    if (this.#noiseSlices < NOISE_SIZE) {
      this.#generateNoise(encoder);
      return;
    }
    const previous = this.#buffers![this.#current]!;
    this.#current = 1 - this.#current;
    const output = this.#buffers![this.#current]!;
    const depthView = depth.createView();
    const march = encoder.beginRenderPass({ label: 'Clouds march', ...(timestampWrites ? { timestampWrites } : {}), colorAttachments: [{ view: output.createView(), loadOp: 'clear', storeOp: 'store' }] });
    march.setPipeline(this.#march);
    march.setBindGroup(0, this.#device.createBindGroup({
      layout: this.#march.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: atmosphere.uniforms } },
        { binding: 1, resource: { buffer: this.#uniforms } },
        { binding: 2, resource: this.#noise.createView() },
        { binding: 3, resource: this.#noiseSampler },
        { binding: 4, resource: atmosphere.skyView.createView() },
        { binding: 5, resource: atmosphere.skySampler },
        { binding: 6, resource: depthView },
        { binding: 7, resource: previous.createView() },
      ],
    }));
    march.draw(3);
    march.end();
    const composite = encoder.beginRenderPass({ label: 'Clouds composite', colorAttachments: [{ view: target, loadOp: 'load', storeOp: 'store' }] });
    composite.setPipeline(this.#compositeFor(format));
    composite.setBindGroup(0, this.#device.createBindGroup({
      layout: this.#compositeLayout,
      entries: [{ binding: 0, resource: output.createView() }, { binding: 1, resource: depthView }],
    }));
    composite.draw(3);
    composite.end();
  }

  destroy(): void {
    this.#noise.destroy();
    this.#uniforms.destroy();
    this.#noiseUniform?.destroy();
    for (const texture of this.#buffers ?? []) texture.destroy();
  }

  #generateNoise(encoder: GPUCommandEncoder): void {
    this.#noisePipeline ??= this.#device.createComputePipeline({
      label: 'Clouds noise', layout: 'auto',
      compute: { module: this.#device.createShaderModule({ label: 'Clouds noise', code: NOISE_SHADER }), entryPoint: 'main' },
    });
    this.#noiseUniform ??= this.#device.createBuffer({ label: 'Clouds noise slices', size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.#device.queue.writeBuffer(this.#noiseUniform, 0, new Uint32Array([this.#noiseSlices, 0, 0, 0]));
    const pass = encoder.beginComputePass({ label: 'Clouds noise' });
    pass.setPipeline(this.#noisePipeline);
    pass.setBindGroup(0, this.#device.createBindGroup({
      layout: this.#noisePipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: this.#noise.createView() }, { binding: 1, resource: { buffer: this.#noiseUniform } }],
    }));
    pass.dispatchWorkgroups(NOISE_SIZE / 4, NOISE_SIZE / 4, NOISE_SLICES_PER_FRAME / 4);
    pass.end();
    this.#noiseSlices += NOISE_SLICES_PER_FRAME;
    if (this.#noiseSlices >= NOISE_SIZE) {
      this.#noisePipeline = undefined;
      // 这一帧的命令还引用着它：销毁排在提交之后也可以，交给垃圾回收更省事
      this.#noiseUniform = undefined;
    }
  }

  /** 合成的管线：颜色 = 云的散射 + 颜色 · 云的透射（alpha）。 */
  #compositeFor(format: GPUTextureFormat): GPURenderPipeline {
    let pipeline = this.#composites.get(format);
    if (!pipeline) {
      pipeline = this.#device.createRenderPipeline({
        label: `Clouds composite ${format}`,
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

/** 步进要的大气的资源（AtmosphereGpu 的一部分）。 */
interface AtmosphereResources {
  readonly uniforms: GPUBuffer;
  readonly skyView: GPUTexture;
  readonly skySampler: GPUSampler;
}
