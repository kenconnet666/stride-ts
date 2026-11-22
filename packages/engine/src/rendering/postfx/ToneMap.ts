/**
 * 色调映射（Stride 的 PostProcessingEffects 里的 ToneMap，默认设置）：把线性的 HDR 画面映射到显示范围，写进
 * 后备缓冲的 sRGB 视图。分两步，同 Stride：measure 在泛光叠加之前量平均亮度（LuminanceEffect），draw 最后映射。
 * - 平均亮度（LuminanceEffect）：HDR 画面按 Rec.601 的亮度取 log2（至少 0.001）写进 S×S 的 R16F 图
 *   （S = min(nextPow2(宽), nextPow2(高)) / 2），再一级级 2x2 平均到 1x1，就是对数平均（几何平均）；
 * - 适应（TemporalAdaptation）：adapted += (平均亮度 - adapted) · (1 - e^(-dt · AdaptationRate))，第一帧直接取当前值。
 *   Stride 在 CPU 上做（要回读平均亮度），这里放在 GPU 上（1x1 的两张纹理轮流读写），没有回读；
 * - 曝光（AutoExposure、AutoKeyValue）：key = 1.03 - 2 / (2 + log10(adapted + 1))，曝光 = key / adapted；
 * - 算子：Hejl2（白点 5）。亮度、对比度是 0 时只剩 max(color, 0.0001)。
 * 泛光等效果的层在映射之前加上（见 AdditiveLayers.ts）。
 * 调色和镜头（路线图 R3，Stride 没有；场景的 postEffects.colorGrading，没写时全是不改变画面的值）：
 * - 镜头畸变（distortion，正的是桶形）、色差（chromaticAberration：红、蓝按到中心的距离往外、往里挪）：按畸变后的位置双线性地取画面；
 * - 白平衡（temperature 是相机的白平衡色温，6500 K 不变；tint 往绿、品红偏）：CPU 上算好的 3×3 矩阵（von Kries，LMS 里按光源
 *   白点和 D65 的比缩放），曝光之前乘；
 * - 对比度（以 18% 灰为中心，在对数空间里拉）、算子（hejl2：Stride 的；agx：Blender 4 的 AgX，高光自然地褪色；aces：Narkowicz 的
 *   ACES 拟合）、饱和度（映射之后按亮度拉开）；
 * - 暗角（vignette：cos⁴ 的衰减按强度混）、颗粒（grain：每帧换的亮度噪声，在显示空间里加）。
 * 和 Stride 不同：输出是 8 位的 sRGB 时加不到一个灰阶的抖动（dither，默认开）。暗的渐变（夜空、雾）量化成 8 位以后相邻的带只差
 * 一个灰阶，是一圈圈看得见的色带；抖动把它打散成看不出来的噪声。图案是固定的（按像素坐标），画面不动时每帧一样。
 */
import { FULLSCREEN_VERTEX, GRADIENT_NOISE } from '../wgsl';
import { GpuProfiler } from '../../graphics/GpuProfiler';
import { createCheckedShaderModule } from '../../graphics/shaderModule';
import { additiveLayerResources, additiveLayersShader, type AdditiveLayer } from './AdditiveLayers';
import { fullscreenPipeline, isGraphTexture, warmFullscreenPipeline, type EffectFrame, type Image, type UniformArena } from './ImageEffect';

const LUMINANCE_SHADER = /* wgsl */ `
${FULLSCREEN_VERTEX}
@group(0) @binding(0) var hdr: texture_2d<f32>;

@fragment fn fs(in: FullscreenVaryings) -> @location(0) vec4f {
  let size = vec2f(textureDimensions(hdr));
  let color = textureLoad(hdr, vec2u(min(in.uv * size, size - 1.0)), 0).rgb;
  let luminance = max(dot(color, vec3f(0.299, 0.587, 0.114)), 0.001);
  return vec4f(log2(luminance), 0.0, 0.0, 1.0);
}`;

/** 2x2 平均：输出纹素中心正好落在 4 个源纹素中间，线性采样一次就是平均。 */
const DOWNSCALE_SHADER = /* wgsl */ `
${FULLSCREEN_VERTEX}
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var linearClamp: sampler;

@fragment fn fs(in: FullscreenVaryings) -> @location(0) vec4f {
  return textureSampleLevel(source, linearClamp, in.uv, 0.0);
}`;

const ADAPT_SHADER = /* wgsl */ `
${FULLSCREEN_VERTEX}
struct Adapt { factor: f32, reset: f32 };
@group(0) @binding(0) var<uniform> adapt: Adapt;
@group(0) @binding(1) var averageLog: texture_2d<f32>;
@group(0) @binding(2) var previous: texture_2d<f32>;

@fragment fn fs(in: FullscreenVaryings) -> @location(0) vec4f {
  let average = exp2(textureLoad(averageLog, vec2u(0u), i32(textureNumLevels(averageLog)) - 1).r);
  let last = select(textureLoad(previous, vec2u(0u), 0).r, average, adapt.reset > 0.5);
  return vec4f(last + (average - last) * adapt.factor, 0.0, 0.0, 1.0);
}`;

/** 直方图的格数：第 0 格是比范围暗的，其余按对数亮度均分范围。 */
const HISTOGRAM_BINS = 128;

/**
 * 按亮度直方图测光（metering = 'histogram'，照 Bevy 的 auto_exposure）：histogram 每个工作组在共享内存里数自己 32×32 个像素（隔一个取一个）
 * 落在哪一格（对数亮度），再加进全局的格子；average 去掉最暗、最亮的一部分（filter）求对数亮度的平均，按每秒几档的速度
 * 往它适应（变亮快、变暗慢，离得近时按指数慢下来），写进适应亮度（和平均测光同一张 1x1，映射那一步不用分），顺手清空格子。
 */
const HISTOGRAM_SHADER = /* wgsl */ `
struct Metering { minLog: f32, logRange: f32, low: f32, high: f32, speedBrighten: f32, speedDarken: f32, transition: f32, elapsed: f32, reset: f32 };
@group(0) @binding(0) var<uniform> metering: Metering;
@group(0) @binding(1) var hdr: texture_2d<f32>;
@group(0) @binding(2) var<storage, read_write> histogram: array<atomic<u32>, ${HISTOGRAM_BINS}>;
@group(0) @binding(3) var previous: texture_2d<f32>;
@group(0) @binding(4) var adapted: texture_storage_2d<r32float, write>;

var<workgroup> bins: array<atomic<u32>, ${HISTOGRAM_BINS}>;

fn binOf(color: vec3f) -> u32 {
  let luminance = dot(color, vec3f(0.2126, 0.7152, 0.0722));
  if (!(luminance > exp2(metering.minLog))) { return 0u; }
  let t = saturate((log2(luminance) - metering.minLog) / metering.logRange);
  return 1u + min(u32(t * ${HISTOGRAM_BINS - 1}.0), ${HISTOGRAM_BINS - 2}u);
}

@compute @workgroup_size(16, 16)
fn histogramMain(@builtin(global_invocation_id) id: vec3u, @builtin(local_invocation_index) index: u32) {
  if (index < ${HISTOGRAM_BINS}u) { atomicStore(&bins[index], 0u); }
  workgroupBarrier();
  // 每 2×2 个像素数一个：直方图是统计量，数四分之一的像素分布一样，4K 下省四分之三
  let pixel = id.xy * 2u;
  if (all(pixel < textureDimensions(hdr))) { atomicAdd(&bins[binOf(textureLoad(hdr, pixel, 0).rgb)], 1u); }
  workgroupBarrier();
  if (index < ${HISTOGRAM_BINS}u) {
    let count = atomicLoad(&bins[index]);
    if (count > 0u) { atomicAdd(&histogram[index], count); }
  }
}

/** 第 i 格的对数亮度（格子中间；第 0 格算范围的下限）。 */
fn binLog(i: u32) -> f32 {
  if (i == 0u) { return metering.minLog; }
  return metering.minLog + (f32(i) - 0.5) / ${HISTOGRAM_BINS - 1}.0 * metering.logRange;
}

@compute @workgroup_size(1)
fn averageMain() {
  var total = 0u;
  var cumulative: array<u32, ${HISTOGRAM_BINS}>;
  for (var i = 0u; i < ${HISTOGRAM_BINS}u; i++) {
    total += atomicLoad(&histogram[i]);
    cumulative[i] = total;
    atomicStore(&histogram[i], 0u);
  }
  // 累积的个数夹在 [first, last] 里：最暗的 low、最亮的 1 - high 那部分不算
  let first = u32(f32(total) * metering.low);
  let last = u32(f32(total) * metering.high);
  var counted = 0u;
  var sum = 0.0;
  var before = first;
  for (var i = 0u; i < ${HISTOGRAM_BINS}u; i++) {
    let upTo = clamp(cumulative[i], first, last);
    sum += f32(upTo - before) * binLog(i);
    counted += upTo - before;
    before = upTo;
  }
  let goal = select(metering.minLog, sum / f32(counted), counted > 0u);
  var current = log2(max(textureLoad(previous, vec2u(0u), 0).r, 1e-6));
  if (metering.reset > 0.5) {
    current = goal;
  } else {
    // 画面变亮（goal 大）按 speedBrighten，变暗按 speedDarken（档/秒）；离目标不到 transition 档时按指数慢下来
    let delta = goal - current;
    let speed = select(metering.speedDarken, metering.speedBrighten, delta > 0.0) * metering.elapsed;
    current += sign(delta) * min(speed, abs(delta) * speed / metering.transition);
  }
  textureStore(adapted, vec2u(0u), vec4f(exp2(current), 0.0, 0.0, 1.0));
}`;

/** 局部曝光的网格：一格管 32×32 个像素，对数亮度分 16 层。 */
const LOCAL_CELL = 32;
const LOCAL_SLICES = 16;
/** 双边网格的模糊半径（格）和大半径的亮度模糊的半径（格）。 */
const LOCAL_GRID_RADIUS = 2;
const LOCAL_WIDE_RADIUS = 8;

/**
 * 局部曝光（照 UE5 的 Local Exposure）的网格：grid 每个工作组管一格，把格子里的像素（隔一个取一个）按对数亮度分进 16 层，
 * 每层存（平均亮度 × 权重，权重），权重是这一层的像素占这一格的比例，各层加起来的那一列另存一张二维的图；blur 在网格上按高斯
 * 模糊（xy 5×5、层 3，一个线程一格一层），wide 把各列按大半径模糊（不分亮度的"大致多亮"）。亮度存成范围里的 0..1
 * （histogramRange）。
 */
const LOCAL_GRID_SHADER = /* wgsl */ `
struct Range { minLog: f32, logRange: f32 };
@group(0) @binding(0) var<uniform> range: Range;
@group(0) @binding(1) var hdr: texture_2d<f32>;
@group(0) @binding(2) var grid: texture_storage_3d<rgba16float, write>;
@group(0) @binding(3) var columns: texture_storage_2d<rgba16float, write>;

var<workgroup> sums: array<atomic<u32>, ${LOCAL_SLICES}>;
var<workgroup> counts: array<atomic<u32>, ${LOCAL_SLICES}>;

@compute @workgroup_size(16, 16)
fn gridMain(@builtin(workgroup_id) cell: vec3u, @builtin(local_invocation_id) local: vec3u, @builtin(local_invocation_index) index: u32) {
  if (index < ${LOCAL_SLICES}u) { atomicStore(&sums[index], 0u); atomicStore(&counts[index], 0u); }
  workgroupBarrier();
  let pixel = cell.xy * ${LOCAL_CELL}u + local.xy * 2u;
  if (all(pixel < textureDimensions(hdr))) {
    let luminance = max(dot(textureLoad(hdr, pixel, 0).rgb, vec3f(0.2126, 0.7152, 0.0722)), 1e-8);
    let t = saturate((log2(luminance) - range.minLog) / range.logRange);
    let slice = min(u32(t * ${LOCAL_SLICES}.0), ${LOCAL_SLICES - 1}u);
    atomicAdd(&sums[slice], u32(t * 65535.0 + 0.5));
    atomicAdd(&counts[slice], 1u);
  }
  workgroupBarrier();
  if (index < ${LOCAL_SLICES}u) {
    let count = f32(atomicLoad(&counts[index]));
    let mean = select(0.0, f32(atomicLoad(&sums[index])) / 65535.0 / count, count > 0.0);
    let weight = count / 256.0;
    textureStore(grid, vec3u(cell.xy, index), vec4f(mean * weight, weight, 0.0, 0.0));
  }
  if (index == 0u) {
    var column = vec2f(0.0);
    for (var i = 0u; i < ${LOCAL_SLICES}u; i++) {
      column += vec2f(f32(atomicLoad(&sums[i])) / 65535.0, f32(atomicLoad(&counts[i]))) / 256.0;
    }
    textureStore(columns, cell.xy, vec4f(column, 0.0, 0.0));
  }
}`;

const LOCAL_BLUR_SHADER = /* wgsl */ `
@group(0) @binding(0) var grid: texture_3d<f32>;
@group(0) @binding(1) var blurred: texture_storage_3d<rgba16float, write>;
@group(0) @binding(2) var columns: texture_2d<f32>;
@group(0) @binding(3) var wide: texture_storage_2d<rgba16float, write>;

fn gaussian(d: f32, radius: f32) -> f32 {
  let sigma = radius * 0.5 + 0.5;
  return exp(-d * d / (2.0 * sigma * sigma));
}

@compute @workgroup_size(4, 4, 4)
fn blurMain(@builtin(global_invocation_id) id: vec3u) {
  let size = vec3i(textureDimensions(grid));
  let cell = vec3i(id);
  if (any(cell >= size)) { return; }
  var sum = vec2f(0.0);
  for (var dz = -1; dz <= 1; dz++) {
    let z = cell.z + dz;
    if (z < 0 || z >= size.z) { continue; }
    for (var dy = -${LOCAL_GRID_RADIUS}; dy <= ${LOCAL_GRID_RADIUS}; dy++) {
      for (var dx = -${LOCAL_GRID_RADIUS}; dx <= ${LOCAL_GRID_RADIUS}; dx++) {
        let p = clamp(cell.xy + vec2i(dx, dy), vec2i(0), size.xy - 1);
        let w = gaussian(length(vec2f(f32(dx), f32(dy))), ${LOCAL_GRID_RADIUS}.0) * gaussian(f32(dz), 1.0);
        sum += textureLoad(grid, vec3i(p, z), 0).xy * w;
      }
    }
  }
  textureStore(blurred, cell, vec4f(sum, 0.0, 0.0));
}

@compute @workgroup_size(8, 8)
fn wideMain(@builtin(global_invocation_id) id: vec3u) {
  let size = vec2i(textureDimensions(columns));
  let center = vec2i(id.xy);
  if (any(center >= size)) { return; }
  var total = vec2f(0.0);
  for (var dy = -${LOCAL_WIDE_RADIUS}; dy <= ${LOCAL_WIDE_RADIUS}; dy++) {
    for (var dx = -${LOCAL_WIDE_RADIUS}; dx <= ${LOCAL_WIDE_RADIUS}; dx++) {
      let p = center + vec2i(dx, dy);
      if (any(p < vec2i(0)) || any(p >= size)) { continue; }
      total += textureLoad(columns, p, 0).xy * gaussian(length(vec2f(f32(dx), f32(dy))), ${LOCAL_WIDE_RADIUS}.0);
    }
  }
  textureStore(wide, center, vec4f(total, 0.0, 0.0));
}`;

const TONEMAP_SHADER = /* wgsl */ `
${FULLSCREEN_VERTEX}
// grade：算子（0 hejl2、1 agx、2 aces）、饱和度、对比度、时间；lens：暗角、颗粒、色差、畸变；
// local：局部曝光的亮处反差、暗处反差、细节、大半径模糊的比例；localRange：网格的对数亮度下限、范围、开没开；
// whiteBalance：线性 sRGB 上的白平衡矩阵
struct Settings { keyValue: f32, exposure: f32, autoKeyValue: f32, autoExposure: f32, whitePoint: f32, enabled: f32, dither: f32, compensation: f32, gate: vec4f, grade: vec4f, lens: vec4f, local: vec4f, localRange: vec4f, whiteBalance: mat3x3f };
@group(0) @binding(0) var<uniform> settings: Settings;
@group(0) @binding(1) var hdr: texture_2d<f32>;
@group(0) @binding(2) var adapted: texture_2d<f32>;
${additiveLayersShader(3)}
@group(0) @binding(8) var localGrid: texture_3d<f32>;
@group(0) @binding(9) var localWide: texture_2d<f32>;

/**
 * 局部曝光：这个像素的"底"（周围同样亮的那些像素的平均亮度，双边网格里按它自己的亮度取；和不分亮度的大半径模糊按比例混）
 * 以全局的平均亮度为界，暗处、亮处各按自己的系数压反差，细节（像素和底的差）按 detail 加回。返回要乘的倍数。
 */
fn localExposure(color: vec3f, uv: vec2f, average: f32) -> f32 {
  let minLog = settings.localRange.x;
  let logRange = settings.localRange.y;
  let l = log2(max(dot(color, vec3f(0.2126, 0.7152, 0.0722)), 1e-8));
  let t = saturate((l - minLog) / logRange);
  let gridUv = uv * vec2f(textureDimensions(hdr)) / (vec2f(textureDimensions(localGrid).xy) * ${LOCAL_CELL}.0);
  let wide = textureSampleLevel(localWide, additiveSampler, gridUv, 0.0).xy;
  let wideBase = select(t, wide.x / wide.y, wide.y > 1e-4);
  let sample = textureSampleLevel(localGrid, additiveSampler, vec3f(gridUv, t), 0.0).xy;
  let gridBase = select(wideBase, sample.x / sample.y, sample.y > 1e-3);
  let base = minLog + mix(gridBase, wideBase, settings.local.w) * logRange;
  let middle = log2(max(average, 1e-8));
  let compressed = middle + (base - middle) * select(settings.local.y, settings.local.x, base > middle);
  return exp2(compressed + (l - base) * settings.local.z - l);
}

fn hejl2(color: vec3f, whitePoint: f32) -> vec3f {
  var w = 1.425 * whitePoint + 0.05;
  w = ((whitePoint * w + 0.004) / (whitePoint * (w + 0.55) + 0.0491)) - 0.0821;
  let va = 1.425 * color + 0.05;
  let vf = ((color * va + 0.004) / (color * (va + 0.55) + 0.0491)) - 0.0821;
  return vf / w;
}

${GRADIENT_NOISE}

// AgX（Troy Sobotka；这里是 Benjamin Wrensch 的最小实现）：进 AgX 的空间、按 EV 范围取对数、六次多项式的对比度曲线、出来再按 2.2 变回线性
fn agx(color: vec3f) -> vec3f {
  let inset = mat3x3f(0.842479062253094, 0.0423282422610123, 0.0423756549057051,
                      0.0784335999999992, 0.878468636469772, 0.0784336,
                      0.0792237451477643, 0.0791661274605434, 0.879142973793104);
  let outset = mat3x3f(1.19687900512017, -0.0528968517574562, -0.0529716355144438,
                       -0.0980208811401368, 1.15190312990417, -0.0980434501171241,
                       -0.0990297440797205, -0.0989611768448433, 1.15107367264116);
  let minEv = -12.47393;
  let maxEv = 4.026069;
  var v = clamp(log2(max(inset * color, vec3f(1e-10))), vec3f(minEv), vec3f(maxEv));
  v = (v - minEv) / (maxEv - minEv);
  let x2 = v * v;
  let x4 = x2 * x2;
  v = 15.5 * x4 * x2 - 40.14 * x4 * v + 31.96 * x4 - 6.868 * x2 * v + 0.4298 * x2 + 0.1191 * v - 0.00232;
  return pow(max(outset * v, vec3f(0.0)), vec3f(2.2));
}

// ACES 的拟合（Krzysztof Narkowicz 2015），先乘 0.6 对上 ACES 的曝光
fn aces(color: vec3f) -> vec3f {
  let x = color * 0.6;
  return saturate((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14));
}

/** 画幅里的位置 uv → 镜头畸变以后取画面的位置（以画面中心、按宽高比算距离）。 */
fn distorted(uv: vec2f, k: f32) -> vec2f {
  let size = vec2f(textureDimensions(hdr));
  let aspect = size.x / size.y;
  let c = (uv - 0.5) * vec2f(aspect, 1.0);
  let r2 = dot(c, c) / (0.25 * (aspect * aspect + 1.0));
  return 0.5 + (uv - 0.5) * (1.0 + k * r2);
}

/**
 * 输出的抖动：在 sRGB 编码后的值上加 ±半个灰阶的噪声（三个通道各用一份，不相关），再换回线性（目标是 sRGB 视图，写进去时
 * GPU 再编码一次）。要在编码后的空间里加：一个灰阶在线性空间里的大小暗处和亮处差几十倍。
 */
fn dither(color: vec3f, pixel: vec2f) -> vec3f {
  let c = saturate(color);
  let encoded = select(1.055 * pow(c, vec3f(1.0 / 2.4)) - 0.055, c * 12.92, c <= vec3f(0.0031308));
  let noise = vec3f(gradientNoise(pixel), gradientNoise(pixel + vec2f(47.0, 17.0)), gradientNoise(pixel + vec2f(101.0, 59.0))) - 0.5;
  let e = saturate(encoded + noise / 255.0);
  return select(pow((e + 0.055) / 1.055, vec3f(2.4)), e / 12.92, e <= vec3f(0.04045));
}

@fragment fn fs(in: FullscreenVaryings) -> @location(0) vec4f {
  // 画幅以外是黑边
  let frameUv = in.position.xy / vec2f(textureDimensions(hdr));
  if (any(frameUv < settings.gate.xy) || any(frameUv > settings.gate.zw)) { return vec4f(0.0, 0.0, 0.0, 1.0); }
  // 镜头畸变、色差：没开时直接按像素取（和 Stride 一样，逐像素比对的截图不变）
  var color: vec3f;
  var layerUv = in.uv;
  if (settings.lens.z != 0.0 || settings.lens.w != 0.0) {
    let uv = distorted(in.uv, settings.lens.w);
    let shift = (uv - 0.5) * settings.lens.z;
    color = vec3f(
      textureSampleLevel(hdr, additiveSampler, uv + shift, 0.0).r,
      textureSampleLevel(hdr, additiveSampler, uv, 0.0).g,
      textureSampleLevel(hdr, additiveSampler, uv - shift, 0.0).b);
    layerUv = uv;
  } else {
    color = textureLoad(hdr, vec2u(in.position.xy), 0).rgb;
  }
  color = max(color + additiveLayers(layerUv), vec3f(0.0001));
  if (settings.enabled != 0.0) {
    let luminance = max(textureLoad(adapted, vec2u(0u), 0).r, 0.0001);
    let keyValue = select(settings.keyValue, 1.03 - 2.0 / (2.0 + log2(luminance + 1.0) / log2(10.0)), settings.autoKeyValue > 0.5);
    let exposure = select(settings.exposure, max(keyValue / luminance, 0.0001), settings.autoExposure > 0.5);
    color = max(settings.whiteBalance * color, vec3f(0.0));
    if (settings.localRange.z != 0.0) { color *= localExposure(color, in.uv, luminance); }
    color *= exposure * settings.compensation;
    // 对比度：以 18% 灰为中心在对数空间里拉
    if (settings.grade.z != 1.0) {
      color = exp2((log2(max(color, vec3f(1e-6))) - log2(0.18)) * settings.grade.z + log2(0.18));
    }
    let curve = u32(settings.grade.x);
    if (curve == 1u) {
      color = agx(color);
    } else if (curve == 2u) {
      color = aces(color);
    } else {
      color = hejl2(color, settings.whitePoint);
    }
    // 饱和度（映射之后，按 Rec.709 的亮度）
    if (settings.grade.y != 1.0) {
      let y = dot(color, vec3f(0.2126, 0.7152, 0.0722));
      color = max(mix(vec3f(y), color, settings.grade.y), vec3f(0.0));
    }
  }
  // 暗角：cos⁴ 的自然衰减（到角上的距离按画面的半对角线归一），按强度混
  if (settings.lens.x > 0.0) {
    let size = vec2f(textureDimensions(hdr));
    let c = (in.uv - 0.5) * vec2f(size.x / size.y, 1.0);
    let r = length(c) / length(vec2f(0.5 * size.x / size.y, 0.5));
    let cosine = 1.0 / sqrt(1.0 + r * r);
    color *= mix(1.0, cosine * cosine * cosine * cosine, settings.lens.x);
  }
  // 颗粒：每帧换的亮度噪声，暗处、中间调更明显（在显示空间里加，乘在亮度上）
  if (settings.lens.y > 0.0) {
    let noise = gradientNoise(in.position.xy + vec2f(fract(settings.grade.w * 7.13) * 173.0, fract(settings.grade.w * 3.71) * 311.0)) - 0.5;
    let y = dot(saturate(color), vec3f(0.2126, 0.7152, 0.0722));
    color *= max(1.0 + noise * settings.lens.y * 0.5 * (1.0 - y * 0.7), 0.0);
  }
  if (settings.dither != 0.0) { color = dither(color, in.position.xy); }
  return vec4f(color, 1.0);
}`;

/** 跟着输入尺寸的资源：对数亮度图（带到 1x1 的 mip 链）和每一级读上一级的绑定组（第 0 级读输入，不在这里）。 */
interface LuminanceTargets {
  readonly width: number;
  readonly height: number;
  readonly luminance: GPUTexture;
  /** 第 1 级起各级读上一级的绑定组；执行时才建（要 downscale 的管线，录制时它可能还在后台编）。 */
  bindGroups: readonly (GPUBindGroup | undefined)[] | undefined;
}

type ToneMapStep = 'luminance' | 'downscale' | 'adapt' | 'tonemap';

interface LocalPipelines {
  readonly grid: GPUComputePipeline;
  readonly blur: GPUComputePipeline;
  readonly wide: GPUComputePipeline;
}

/** 局部曝光跟着画面尺寸的网格：原始的、模糊过的（三维），各列加起来的、大半径模糊的（二维）。 */
interface LocalTextures {
  readonly width: number;
  readonly height: number;
  readonly grid: GPUTexture;
  readonly blurred: GPUTexture;
  readonly columns: GPUTexture;
  readonly wide: GPUTexture;
}

/** 映射时绑的局部曝光的网格（模糊过的三维网格、大半径模糊的图）。 */
interface LocalBinding {
  readonly grid: GPUTexture;
  readonly wide: GPUTexture;
}

interface HistogramPipelines {
  readonly histogram: GPUComputePipeline;
  readonly average: GPUComputePipeline;
}

/** 映射的算子：hejl2（Stride 的）、agx（Blender 4 的 AgX）、aces（Narkowicz 的拟合）。 */
export type ToneMapOperator = 'hejl2' | 'agx' | 'aces';
const OPERATORS: readonly ToneMapOperator[] = ['hejl2', 'agx', 'aces'];
/** 映射的 uniform：8 个标量、画幅、调色、镜头、局部曝光的两组、白平衡矩阵（3 列 vec4）。 */
const SETTINGS_FLOATS = 40;

/**
 * 白平衡矩阵（线性 sRGB → 线性 sRGB，列主序 3×3）：相机设成 temperature（K）、tint 时，把这个色温的光源的白当成白（von Kries：
 * 在 CAT02 的 LMS 里按 D65 和那个白点的比缩放）。色温的色度按普朗克轨迹的近似（Kang 2002），tint 沿轨迹的法线往品红、绿挪。
 */
export function whiteBalanceMatrix(temperature: number, tint: number): number[] {
  if (Math.abs(temperature - 6500) < 1e-3 && Math.abs(tint) < 1e-6) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const t = Math.min(Math.max(temperature, 1667), 25000);
  const x = t <= 4000
    ? -0.2661239e9 / t ** 3 - 0.2343589e6 / t ** 2 + 0.8776956e3 / t + 0.17991
    : -3.0258469e9 / t ** 3 + 2.1070379e6 / t ** 2 + 0.2226347e3 / t + 0.24039;
  const y0 = t <= 2222 ? -1.1063814 * x ** 3 - 1.3481102 * x ** 2 + 2.18555832 * x - 0.20219683
    : t <= 4000 ? -0.9549476 * x ** 3 - 1.37418593 * x ** 2 + 2.09137015 * x - 0.16748867
      : 3.081758 * x ** 3 - 5.8733867 * x ** 2 + 3.75112997 * x - 0.37001483;
  const y = y0 + tint * 0.02;
  const xyz = (cx: number, cy: number) => [cx / cy, 1, (1 - cx - cy) / cy];
  // CAT02 的 XYZ → LMS
  const cat = [[0.7328, 0.4296, -0.1624], [-0.7036, 1.6975, 0.0061], [0.003, 0.0136, 0.9834]];
  const lms = (v: number[]) => cat.map((row) => row[0]! * v[0]! + row[1]! * v[1]! + row[2]! * v[2]!);
  const source = lms(xyz(x, y)), target = lms(xyz(0.31271, 0.32902));
  const scale = source.map((value, i) => target[i]! / value);
  // 线性 sRGB ↔ XYZ（D65）
  const toXyz = [[0.4124564, 0.3575761, 0.1804375], [0.2126729, 0.7151522, 0.072175], [0.0193339, 0.119192, 0.9503041]];
  const fromXyz = [[3.2404542, -1.5371385, -0.4985314], [-0.969266, 1.8760108, 0.041556], [0.0556434, -0.2040259, 1.0572252]];
  const catInverse = invert3(cat);
  const multiply = (a: number[][], b: number[][]) => a.map((row) => [0, 1, 2].map((j) => row[0]! * b[0]![j]! + row[1]! * b[1]![j]! + row[2]! * b[2]![j]!));
  const diagonal = [[scale[0]!, 0, 0], [0, scale[1]!, 0], [0, 0, scale[2]!]];
  const m = multiply(fromXyz, multiply(catInverse, multiply(diagonal, multiply(cat, toXyz))));
  // 列主序
  return [m[0]![0]!, m[1]![0]!, m[2]![0]!, m[0]![1]!, m[1]![1]!, m[2]![1]!, m[0]![2]!, m[1]![2]!, m[2]![2]!];
}

function invert3(m: number[][]): number[][] {
  const [a, b, c] = m[0]!, [d, e, f] = m[1]!, [g, h, i] = m[2]!;
  const A = e! * i! - f! * h!, B = -(d! * i! - f! * g!), C = d! * h! - e! * g!;
  const det = a! * A + b! * B + c! * C;
  return [
    [A / det, -(b! * i! - c! * h!) / det, (b! * f! - c! * e!) / det],
    [B / det, (a! * i! - c! * g!) / det, -(a! * f! - c! * d!) / det],
    [C / det, -(a! * h! - b! * g!) / det, (a! * e! - b! * d!) / det],
  ];
}
/** 各步的着色器和目标格式（映射这一步画进后备缓冲，格式用到时才知道）。 */
const STEPS: Record<ToneMapStep, readonly [label: string, code: string, format: GPUTextureFormat | undefined]> = {
  luminance: ['ToneMap luminance', LUMINANCE_SHADER, 'r16float'],
  downscale: ['ToneMap downscale', DOWNSCALE_SHADER, 'r16float'],
  adapt: ['ToneMap adapt', ADAPT_SHADER, 'r32float'],
  tonemap: ['ToneMap', TONEMAP_SHADER, undefined],
};

export class ToneMap {
  /** 关掉时（Stride 的 ToneMap.Enabled）不量亮度、不曝光也不映射，只加上叠加层。 */
  enabled = true;
  // Stride 的 ToneMap 的默认值
  autoExposure = true;
  autoKeyValue = true;
  /** 不自动算 key 时用它。 */
  keyValue = 0.18;
  /** 不自动曝光时的曝光，单位是档（乘 2^exposure）。 */
  exposure = 0;
  temporalAdaptation = true;
  adaptationRate = 1;
  /** Hejl2 算子的白点。 */
  whitePoint = 5;
  /** 输出是 8 位的 sRGB 时加抖动（见文件头）。和桌面 Stride 的截图逐像素比对时关掉。 */
  dither = true;
  /** 曝光补偿（档，自动曝光之后再乘 2^它）：物理相机的 exposureCompensation。 */
  exposureCompensation = 0;
  /** 画幅在画面里的位置（uv：左、上、右、下），以外画黑边；主画面相机的 aspectRatio 定。 */
  gate: readonly [number, number, number, number] = [0, 0, 1, 1];
  /** 调色和镜头（见文件头；默认值不改变画面，同 Stride）。 */
  operator: ToneMapOperator = 'hejl2';
  /** 相机的白平衡色温（K）：6500 不变，低了画面偏蓝（当作光源更暖、把它校正掉），高了偏暖。 */
  temperature = 6500;
  /** 往绿（负）、品红（正）偏，-1..1。 */
  tint = 0;
  saturation = 1;
  contrast = 1;
  /** 暗角、颗粒的强度（0..1）。 */
  vignette = 0;
  grain = 0;
  /** 色差：画面边上红、蓝分开多少（相对到中心的距离的比例）。 */
  chromaticAberration = 0;
  /** 镜头畸变：正的是桶形（广角），负的是枕形。 */
  distortion = 0;
  /**
   * 测光：average 是 Stride 的（整个画面的对数平均，按 adaptationRate 指数适应）；histogram 按亮度直方图去掉最暗、最亮的一部分
   * 再平均，按每秒几档适应（见 HISTOGRAM_SHADER），大片的天空、黑影、高光不会把曝光拽偏。
   */
  metering: 'average' | 'histogram' = 'average';
  /** 直方图的对数亮度范围（log2，下限以下算一格）。 */
  histogramRange: readonly [min: number, max: number] = [-10, 14];
  /** 直方图里参加平均的那一段（按像素数的比例：最暗的 10%、最亮的 10% 不算）。 */
  histogramFilter: readonly [low: number, high: number] = [0.1, 0.9];
  /** 直方图测光的适应速度（档/秒）：画面变亮时、变暗时。 */
  speedBrighten = 3;
  speedDarken = 1;
  /**
   * 局部曝光（照 UE5 的 Local Exposure，见 LOCAL_GRID_SHADER、localExposure）：以全局的平均亮度为界，亮处、暗处的反差各乘
   * 一个系数（小于 1 压缩：手机的 HDR 那样暗处提亮、亮处压暗而细节还在），detail 是细节的倍数，localBlur 是"底"里大半径
   * 模糊占的比例（剩下的是按亮度分开的双边网格，边缘不出光晕）。都是 1 时不做（默认，同 Stride）。
   */
  localHighlights = 1;
  localShadows = 1;
  localDetail = 1;
  localBlur = 0.6;
  #time = 0;

  readonly #device: GPUDevice;
  readonly #sampler: GPUSampler;
  readonly #settings: GPUBuffer;
  readonly #adaptUniform: GPUBuffer;
  /** 两张 1x1 的适应亮度，轮流读写。 */
  readonly #adapted: [GPUTexture, GPUTexture];
  #current = 0;
  #reset = true;
  #targets: LuminanceTargets | undefined;
  readonly #sourceGroups = new WeakMap<GPUTexture, GPUBindGroup>();
  /** measure 写好的适应亮度，draw 读它。 */
  #measured: GPUTexture | undefined;
  /** 直方图测光的格子和设置（第一次用到时建）、管线（后台编，编好以前照平均测光量）。 */
  #histogram: { readonly bins: GPUBuffer; readonly uniform: GPUBuffer } | undefined;
  #histogramPipelines: HistogramPipelines | Promise<void> | undefined;
  #localPipelines: LocalPipelines | Promise<void> | undefined;
  #local: LocalTextures | undefined;
  #localUniform: GPUBuffer | undefined;
  /** 这一帧映射时绑的网格：开着时是 #local 的，没开时是 1 个纹素的占位（着色器不读）。 */
  #localBound: LocalBinding | undefined;
  #localPlaceholder: LocalBinding | undefined;

  constructor(device: GPUDevice, sampler: GPUSampler) {
    this.#device = device;
    this.#sampler = sampler;
    this.#settings = device.createBuffer({ label: 'ToneMap settings', size: SETTINGS_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.#adaptUniform = device.createBuffer({ label: 'ToneMap adapt', size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    // 平均测光画进去（渲染目标），直方图测光写进去（存储贴图）
    const adapted = () => device.createTexture({ label: 'ToneMap adapted luminance', size: [1, 1], format: 'r32float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.STORAGE_BINDING });
    this.#adapted = [adapted(), adapted()];
  }

  /** 量 input（rgba16float 的 HDR 画面）的平均亮度并做时间上的适应；elapsed 是这一帧的秒数。 */
  measure(frame: EffectFrame, input: Image, elapsed: number): void {
    this.#time += elapsed;
    const settings = new Float32Array(SETTINGS_FLOATS);
    settings.set([this.keyValue, 2 ** this.exposure, this.autoKeyValue ? 1 : 0, this.autoExposure ? 1 : 0, this.whitePoint, this.enabled ? 1 : 0, 0, 2 ** this.exposureCompensation, ...this.gate]);
    settings.set([OPERATORS.indexOf(this.operator), this.saturation, this.contrast, this.#time % 1000], 12);
    settings.set([this.vignette, this.grain, this.chromaticAberration, this.distortion], 16);
    const wantsLocal = this.enabled && (this.localHighlights !== 1 || this.localShadows !== 1 || this.localDetail !== 1);
    const local = wantsLocal ? this.#localPipelinesReady() : undefined;
    const [minLog, maxLog] = this.histogramRange;
    settings.set([this.localHighlights, this.localShadows, this.localDetail, this.localBlur], 20);
    settings.set([minLog, Math.max(maxLog - minLog, 1e-3), local ? 1 : 0, 0], 24);
    const balance = whiteBalanceMatrix(this.temperature, this.tint);
    for (let c = 0; c < 3; c++) settings.set([balance[c * 3]!, balance[c * 3 + 1]!, balance[c * 3 + 2]!, 0], 28 + c * 4);
    this.#device.queue.writeBuffer(this.#settings, 0, settings);
    this.#localBound = local ? this.#buildLocalGrid(frame, input, local, minLog, maxLog) : this.#placeholder();
    // 关掉时 draw 照样绑一张适应亮度（着色器不读它）；重新打开时从当前亮度开始适应
    if (!this.enabled) {
      this.#measured = this.#adapted[this.#current];
      this.#reset = true;
      return;
    }
    const histogram = this.metering === 'histogram' ? this.#histogramPipelinesReady() : undefined;
    // 平均测光的亮度图跟着画面尺寸（尺寸变了要从头适应，所以在读 #reset 之前）
    const targets = histogram ? undefined : this.#targetsFor(input.width, input.height);
    const reset = this.#reset || !this.temporalAdaptation;
    this.#reset = false;
    // 适应：读上一帧的结果，写另一张
    const previous = this.#adapted[this.#current]!;
    const next = this.#adapted[1 - this.#current]!;
    this.#current = 1 - this.#current;
    this.#measured = next;
    if (!targets) {
      this.#measureHistogram(frame, input, previous, next, elapsed, reset, histogram!);
      return;
    }
    const factor = this.temporalAdaptation ? 1 - Math.exp(-elapsed * this.adaptationRate) : 1;
    this.#device.queue.writeBuffer(this.#adaptUniform, 0, new Float32Array([factor, reset ? 1 : 0]));
    const levels = targets.luminance.mipLevelCount;
    // 写的是自己留到下一帧的贴图（亮度的 mip 链、适应后的亮度），渲染图看不见：算副作用
    frame.pass('ToneMap measure', (pass) => {
      if (isGraphTexture(input)) pass.read(input);
      pass.sideEffect();
    }, (real) => {
      const { encoder } = frame;
      const luminance = this.#pipeline('luminance'), downscale = this.#pipeline('downscale'), adapt = this.#pipeline('adapt');
      // 对数亮度和 2x2 平均链；第一级读输入
      const source = this.#sourceGroup(isGraphTexture(input) ? real.texture(input) : input);
      for (let level = 0; level < levels; level++) {
        this.#fullscreen(encoder, level === 0 ? luminance : downscale, level === 0 ? source : this.#levelGroups(targets, downscale)[level]!, targets.luminance.createView({ baseMipLevel: level, mipLevelCount: 1 }));
      }
      this.#fullscreen(encoder, adapt, this.#device.createBindGroup({
        layout: adapt.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.#adaptUniform } },
          { binding: 1, resource: targets.luminance.createView() },
          { binding: 2, resource: previous.createView() },
        ],
      }), next.createView());
    }, () => this.#warm(['luminance', 'downscale', 'adapt']));
  }

  /** 直方图测光：数格子、按格子求平均并适应，写进 next（见 HISTOGRAM_SHADER）。 */
  #measureHistogram(frame: EffectFrame, input: Image, previous: GPUTexture, next: GPUTexture, elapsed: number, reset: boolean, pipelines: HistogramPipelines): void {
    const device = this.#device;
    const { bins, uniform } = this.#histogram ??= {
      bins: device.createBuffer({ label: 'ToneMap histogram', size: HISTOGRAM_BINS * 4, usage: GPUBufferUsage.STORAGE }),
      uniform: device.createBuffer({ label: 'ToneMap metering', size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
    };
    const [min, max] = this.histogramRange;
    // 离目标 1.5 档以内按指数慢下来（Bevy 的 exponential_transition_distance）
    device.queue.writeBuffer(uniform, 0, new Float32Array([min, Math.max(max - min, 1e-3), ...this.histogramFilter, this.speedBrighten, this.speedDarken, 1.5, elapsed, reset ? 1 : 0]));
    frame.pass('ToneMap measure', (pass) => {
      if (isGraphTexture(input)) pass.read(input);
      pass.sideEffect();
    }, (real) => {
      const texture = isGraphTexture(input) ? real.texture(input) : input;
      const timestampWrites = GpuProfiler.of(device)?.passTimestamps('ToneMap histogram');
      const pass = frame.encoder.beginComputePass({ label: 'ToneMap histogram', ...(timestampWrites ? { timestampWrites } : {}) });
      pass.setPipeline(pipelines.histogram);
      pass.setBindGroup(0, device.createBindGroup({
        layout: pipelines.histogram.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: uniform } }, { binding: 1, resource: texture.createView() }, { binding: 2, resource: { buffer: bins } }],
      }));
      pass.dispatchWorkgroups(Math.ceil(texture.width / 32), Math.ceil(texture.height / 32));
      pass.setPipeline(pipelines.average);
      pass.setBindGroup(0, device.createBindGroup({
        layout: pipelines.average.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: uniform } },
          { binding: 2, resource: { buffer: bins } },
          { binding: 3, resource: previous.createView() },
          { binding: 4, resource: next.createView() },
        ],
      }));
      pass.dispatchWorkgroups(1);
      pass.end();
    });
  }

  /** 局部曝光的网格：数格子、模糊（见 LOCAL_GRID_SHADER），返回映射时要绑的。 */
  #buildLocalGrid(frame: EffectFrame, input: Image, pipelines: LocalPipelines, minLog: number, maxLog: number): LocalBinding {
    const device = this.#device;
    const textures = this.#localTexturesFor(input.width, input.height);
    const uniform = this.#localUniform ??= device.createBuffer({ label: 'ToneMap local exposure', size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(uniform, 0, new Float32Array([minLog, Math.max(maxLog - minLog, 1e-3), 0, 0]));
    frame.pass('ToneMap local exposure', (pass) => {
      if (isGraphTexture(input)) pass.read(input);
      pass.sideEffect();
    }, (real) => {
      const texture = isGraphTexture(input) ? real.texture(input) : input;
      const timestampWrites = GpuProfiler.of(device)?.passTimestamps('ToneMap local exposure');
      const pass = frame.encoder.beginComputePass({ label: 'ToneMap local exposure', ...(timestampWrites ? { timestampWrites } : {}) });
      pass.setPipeline(pipelines.grid);
      pass.setBindGroup(0, device.createBindGroup({
        layout: pipelines.grid.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: uniform } },
          { binding: 1, resource: texture.createView() },
          { binding: 2, resource: textures.grid.createView() },
          { binding: 3, resource: textures.columns.createView() },
        ],
      }));
      const { width, height } = textures.grid;
      pass.dispatchWorkgroups(width, height);
      pass.setPipeline(pipelines.blur);
      pass.setBindGroup(0, device.createBindGroup({
        layout: pipelines.blur.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: textures.grid.createView() }, { binding: 1, resource: textures.blurred.createView() }],
      }));
      pass.dispatchWorkgroups(Math.ceil(width / 4), Math.ceil(height / 4), LOCAL_SLICES / 4);
      pass.setPipeline(pipelines.wide);
      pass.setBindGroup(0, device.createBindGroup({
        layout: pipelines.wide.getBindGroupLayout(0),
        entries: [{ binding: 2, resource: textures.columns.createView() }, { binding: 3, resource: textures.wide.createView() }],
      }));
      pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
      pass.end();
    });
    return { grid: textures.blurred, wide: textures.wide };
  }

  #localTexturesFor(width: number, height: number): LocalTextures {
    if (this.#local?.width === width && this.#local.height === height) return this.#local;
    if (this.#local) for (const texture of [this.#local.grid, this.#local.blurred, this.#local.columns, this.#local.wide]) texture.destroy();
    const columns = Math.ceil(width / LOCAL_CELL), rows = Math.ceil(height / LOCAL_CELL);
    const usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING;
    const grid = (label: string) => this.#device.createTexture({ label, size: [columns, rows, LOCAL_SLICES], dimension: '3d', format: 'rgba16float', usage });
    return (this.#local = {
      width, height,
      grid: grid('ToneMap local grid'), blurred: grid('ToneMap local grid blurred'),
      columns: this.#device.createTexture({ label: 'ToneMap local columns', size: [columns, rows], format: 'rgba16float', usage }),
      wide: this.#device.createTexture({ label: 'ToneMap local wide', size: [columns, rows], format: 'rgba16float', usage }),
    });
  }

  #placeholder(): LocalBinding {
    return this.#localPlaceholder ??= {
      grid: this.#device.createTexture({ label: 'ToneMap local placeholder', size: [1, 1, 1], dimension: '3d', format: 'rgba16float', usage: GPUTextureUsage.TEXTURE_BINDING }),
      wide: this.#device.createTexture({ label: 'ToneMap local placeholder', size: [1, 1], format: 'rgba16float', usage: GPUTextureUsage.TEXTURE_BINDING }),
    };
  }

  /** 局部曝光的两条管线，同 #histogramPipelinesReady：编好以前返回 undefined（这几帧不做局部曝光）。 */
  #localPipelinesReady(): LocalPipelines | undefined {
    const state = this.#localPipelines;
    if (state && !(state instanceof Promise)) return state;
    if (!state) {
      const create = (label: string, code: string, entryPoint: string) => this.#device.createComputePipelineAsync({
        label, layout: 'auto', compute: { module: createCheckedShaderModule(this.#device, label, code), entryPoint },
      });
      this.#localPipelines = Promise.all([
        create('ToneMap local grid', LOCAL_GRID_SHADER, 'gridMain'),
        create('ToneMap local blur', LOCAL_BLUR_SHADER, 'blurMain'),
        create('ToneMap local wide', LOCAL_BLUR_SHADER, 'wideMain'),
      ]).then(
        ([grid, blur, wide]) => { this.#localPipelines = { grid, blur, wide }; },
        (error: unknown) => console.warn('ToneMap local exposure: building the pipelines failed', error),
      );
    }
    return undefined;
  }

  /** 直方图测光的两条管线：编好了给出来；第一次问时在后台开始编，编好以前返回 undefined（这几帧照平均测光量）。 */
  #histogramPipelinesReady(): HistogramPipelines | undefined {
    const state = this.#histogramPipelines;
    if (state && !(state instanceof Promise)) return state;
    if (!state) {
      const module = createCheckedShaderModule(this.#device, 'ToneMap histogram', HISTOGRAM_SHADER);
      const create = (entryPoint: string) => this.#device.createComputePipelineAsync({ label: `ToneMap ${entryPoint}`, layout: 'auto', compute: { module, entryPoint } });
      // 编不出来时留着这个 Promise，不再重试（错误在着色器模块的编译信息里报过了）
      this.#histogramPipelines = Promise.all([create('histogramMain'), create('averageMain')]).then(
        ([histogram, average]) => { this.#histogramPipelines = { histogram, average }; },
        (error: unknown) => console.warn('ToneMap histogram: building the pipelines failed', error),
      );
    }
    return undefined;
  }

  /** 按 measure 量出的亮度把 input 加上 layers（已经 prefilterLayers 过）映射后画进 output。 */
  draw(frame: EffectFrame, arena: UniformArena, input: Image, layers: readonly AdditiveLayer[], output: GPUTextureView, outputFormat: GPUTextureFormat): void {
    const adapted = this.#measured;
    if (!adapted) throw new Error("ToneMap.draw: call measure first in the frame");
    const layerResources = additiveLayerResources(arena, layers, input, this.#sampler);
    frame.pass('ToneMap', (pass) => {
      // 输入和叠加的各层可以是这一帧的临时贴图；输出在渲染图外面
      if (isGraphTexture(input)) pass.read(input);
      for (const resource of layerResources) if (isGraphTexture(resource)) pass.read(resource);
      pass.sideEffect();
    }, (real) => {
      const tonemap = this.#pipeline('tonemap', outputFormat);
      // 抖动只对 8 位的 sRGB 输出做（后备缓冲、8 位的渲染目标）；浮点的输出没有量化
      this.#device.queue.writeBuffer(this.#settings, 24, new Float32Array([this.dither && /8unorm-srgb$/.test(outputFormat) ? 1 : 0]));
      const actual = <T extends object>(resource: T) => (isGraphTexture(resource) ? real.texture(resource) : resource);
      this.#fullscreen(frame.encoder, tonemap, this.#device.createBindGroup({
        layout: tonemap.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.#settings } },
          { binding: 1, resource: (actual(input) as GPUTexture).createView() },
          { binding: 2, resource: adapted.createView() },
          ...layerResources.map((resource, i) => {
            const item = actual(resource);
            return { binding: 3 + i, resource: item instanceof GPUTexture ? item.createView() : item as GPUSampler | GPUBufferBinding };
          }),
          { binding: 8, resource: this.#localBound!.grid.createView() },
          { binding: 9, resource: this.#localBound!.wide.createView() },
        ],
      }), output);
    }, () => this.#warm(['tonemap'], outputFormat));
  }

  /** 下一帧重新从当前亮度开始适应（比如切场景）。 */
  resetAdaptation(): void {
    this.#reset = true;
  }

  destroy(): void {
    this.#targets?.luminance.destroy();
    this.#histogram?.bins.destroy();
    if (this.#local) for (const texture of [this.#local.grid, this.#local.blurred, this.#local.columns, this.#local.wide]) texture.destroy();
    if (this.#localPlaceholder) for (const texture of [this.#localPlaceholder.grid, this.#localPlaceholder.wide]) texture.destroy();
    this.#localUniform?.destroy();
    this.#histogram?.uniform.destroy();
    for (const texture of this.#adapted) texture.destroy();
    this.#settings.destroy();
    this.#adaptUniform.destroy();
  }

  #fullscreen(encoder: GPUCommandEncoder, pipeline: GPURenderPipeline, bindGroup: GPUBindGroup, target: GPUTextureView): void {
    const timestampWrites = GpuProfiler.of(this.#device)?.passTimestamps(pipeline.label);
    const pass = encoder.beginRenderPass({ label: pipeline.label, colorAttachments: [{ view: target, loadOp: 'clear', storeOp: 'store' }], ...(timestampWrites ? { timestampWrites } : {}) });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();
  }

  /** 一步的管线（全屏管线按设备共用，见 fullscreenPipeline）；映射这一步画进 outputFormat。 */
  #pipeline(step: ToneMapStep, outputFormat?: GPUTextureFormat): GPURenderPipeline {
    const [label, code, format] = STEPS[step];
    return fullscreenPipeline(this.#device, label, code, [format ?? outputFormat!]);
  }

  #warm(steps: readonly ToneMapStep[], outputFormat?: GPUTextureFormat): Promise<void> | undefined {
    const pending = steps.map((step) => {
      const [label, code, format] = STEPS[step];
      return warmFullscreenPipeline(this.#device, label, code, [format ?? outputFormat!]);
    }).filter((warming) => warming !== undefined);
    return pending.length > 0 ? Promise.all(pending).then(() => undefined) : undefined;
  }

  /** 亮度图和它各级之间的绑定组跟着输入的尺寸（画布尺寸变了）重建。 */
  #targetsFor(width: number, height: number): LuminanceTargets {
    if (this.#targets?.width === width && this.#targets.height === height) return this.#targets;
    this.#targets?.luminance.destroy();
    const nextPow2 = (n: number) => 2 ** Math.ceil(Math.log2(Math.max(1, n)));
    const size = Math.max(1, Math.min(nextPow2(width), nextPow2(height)) / 2);
    const levels = Math.log2(size) + 1;
    const luminance = this.#device.createTexture({ label: 'ToneMap luminance', size: [size, size], format: 'r16float', mipLevelCount: levels, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT });
    this.#reset = true;
    return (this.#targets = { width, height, luminance, bindGroups: undefined });
  }

  /** 各级读上一级的绑定组（第 0 级读输入，绑定组按输入的贴图另存，见 #sourceGroup）。 */
  #levelGroups(targets: LuminanceTargets, downscale: GPURenderPipeline): readonly (GPUBindGroup | undefined)[] {
    if (targets.bindGroups) return targets.bindGroups;
    const bindGroups: (GPUBindGroup | undefined)[] = [undefined];
    for (let level = 1; level < targets.luminance.mipLevelCount; level++) {
      bindGroups.push(this.#device.createBindGroup({
        layout: downscale.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: targets.luminance.createView({ baseMipLevel: level - 1, mipLevelCount: 1 }) },
          { binding: 1, resource: this.#sampler },
        ],
      }));
    }
    return (targets.bindGroups = bindGroups);
  }

  /** 读这张输入贴图的绑定组。输入是池里的贴图，每帧可能不是同一张：按贴图存，贴图销毁后跟着回收。 */
  #sourceGroup(input: GPUTexture): GPUBindGroup {
    let group = this.#sourceGroups.get(input);
    if (!group) {
      group = this.#device.createBindGroup({ layout: this.#pipeline('luminance').getBindGroupLayout(0), entries: [{ binding: 0, resource: input.createView() }] });
      this.#sourceGroups.set(input, group);
    }
    return group;
  }
}
