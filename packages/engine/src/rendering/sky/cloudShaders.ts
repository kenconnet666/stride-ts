/**
 * 体积云的着色器源码（VolumetricClouds.ts 用；说明见那边的文件头）：生成噪声贴图的计算着色器，步进（和上一帧混合），合成。
 */
import { FULLSCREEN_VERTEX, GRADIENT_NOISE, HASH3 } from '../wgsl';
import { ATMOSPHERE_WGSL, SKY_VIEW_WGSL } from './atmosphereShaders';

/** 噪声贴图：每个纹素算一遍。坐标 0..1，三个方向首尾相接（格子按周期取模）。 */
export const NOISE_SHADER = /* wgsl */ `
@group(0) @binding(0) var output: texture_storage_3d<rgba8unorm, write>;
// x：这一次从第几层算起
@group(0) @binding(1) var<uniform> slices: vec4u;

${HASH3}

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
export const MARCH_SHADER = /* wgsl */ `
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

${GRADIENT_NOISE}

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
export const COMPOSITE_SHADER = /* wgsl */ `
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
