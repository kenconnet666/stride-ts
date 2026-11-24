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
 * 同目录的：按亮度直方图测光（HistogramMetering.ts）、局部曝光的网格（LocalExposure.ts，映射时在这里的 localExposure 里取）、
 * 查找表（ColorLut.ts）、白平衡矩阵（whiteBalance.ts）。
 * 和 Stride 不同：输出是 8 位的 sRGB 时加不到一个灰阶的抖动（dither，默认开）。暗的渐变（夜空、雾）量化成 8 位以后相邻的带只差
 * 一个灰阶，是一圈圈看得见的色带；抖动把它打散成看不出来的噪声。图案是固定的（按像素坐标），画面不动时每帧一样。
 */
import { FULLSCREEN_VERTEX, GRADIENT_NOISE } from '../../wgsl';
import { GpuProfiler } from '../../../graphics/GpuProfiler';
import { colorLutTexture, type ColorLut } from './ColorLut';
import { HistogramMetering } from './HistogramMetering';
import { LOCAL_CELL, LocalExposure, type LocalExposureBinding } from './LocalExposure';
import { whiteBalanceMatrix } from './whiteBalance';
import { additiveLayerResources, additiveLayersShader, type AdditiveLayer } from '../AdditiveLayers';
import { fullscreenPipeline, isGraphTexture, warmFullscreenPipeline, type EffectFrame, type Image, type UniformArena } from '../ImageEffect';

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

const TONEMAP_SHADER = /* wgsl */ `
${FULLSCREEN_VERTEX}
// grade：算子（0 hejl2、1 agx、2 aces）、饱和度、对比度、时间；lens：暗角、颗粒、色差、畸变；
// local：局部曝光的亮处反差、暗处反差、细节、大半径模糊的比例；localRange：网格的对数亮度下限、范围、开没开；
// lutLow、lutHigh：查找表的定义域的下限、上限和强度、边长（强度 0 是没有表）；whiteBalance：线性 sRGB 上的白平衡矩阵
struct Settings { keyValue: f32, exposure: f32, autoKeyValue: f32, autoExposure: f32, whitePoint: f32, enabled: f32, dither: f32, compensation: f32, gate: vec4f, grade: vec4f, lens: vec4f, local: vec4f, localRange: vec4f, lutLow: vec4f, lutHigh: vec4f, whiteBalance: mat3x3f };
@group(0) @binding(0) var<uniform> settings: Settings;
@group(0) @binding(1) var hdr: texture_2d<f32>;
@group(0) @binding(2) var adapted: texture_2d<f32>;
${additiveLayersShader(3)}
@group(0) @binding(8) var localGrid: texture_3d<f32>;
@group(0) @binding(9) var localWide: texture_2d<f32>;
@group(0) @binding(10) var colorLut: texture_3d<f32>;

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
fn srgbEncode(c: vec3f) -> vec3f {
  return select(1.055 * pow(c, vec3f(1.0 / 2.4)) - 0.055, c * 12.92, c <= vec3f(0.0031308));
}

fn srgbDecode(e: vec3f) -> vec3f {
  return select(pow((e + 0.055) / 1.055, vec3f(2.4)), e / 12.92, e <= vec3f(0.04045));
}

fn dither(color: vec3f, pixel: vec2f) -> vec3f {
  let noise = vec3f(gradientNoise(pixel), gradientNoise(pixel + vec2f(47.0, 17.0)), gradientNoise(pixel + vec2f(101.0, 59.0))) - 0.5;
  return srgbDecode(saturate(srgbEncode(saturate(color)) + noise / 255.0));
}

/** 查找表（.cube，见 ColorLut.ts）：按显示空间（sRGB 编码后）的颜色查，纹素中心对齐到表的格点，按强度和原色混。 */
fn applyLut(color: vec3f) -> vec3f {
  let c = saturate(color);
  let n = settings.lutHigh.w;
  let t = saturate((srgbEncode(c) - settings.lutLow.xyz) / (settings.lutHigh.xyz - settings.lutLow.xyz));
  let graded = textureSampleLevel(colorLut, additiveSampler, (t * (n - 1.0) + 0.5) / n, 0.0).rgb;
  return mix(c, srgbDecode(saturate(graded)), settings.lutLow.w);
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
    if (settings.lutLow.w > 0.0) { color = applyLut(color); }
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

/** 映射的算子：hejl2（Stride 的）、agx（Blender 4 的 AgX）、aces（Narkowicz 的拟合）。 */
export type ToneMapOperator = 'hejl2' | 'agx' | 'aces';
const OPERATORS: readonly ToneMapOperator[] = ['hejl2', 'agx', 'aces'];
/** 映射的 uniform：8 个标量、画幅、调色、镜头、局部曝光的两组、查找表的两组、白平衡矩阵（3 列 vec4）。 */
const SETTINGS_FLOATS = 48;

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
  /**
   * 这一帧不适应、直接用量到的亮度（不改场景的 temporalAdaptation）：编辑器里（game.editing）由 ForwardRenderer 打开，改了灯
   * 马上是最终的亮度，不慢慢变（docs/realtime.md 的"改了马上看到"）。试玩、游戏里照旧适应。
   */
  instantAdaptation = false;
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
  /** 调色的查找表（.cube，ColorLut.ts）：映射之后按显示空间的颜色查；lutStrength 是和原色混的比例。 */
  lut: ColorLut | undefined;
  lutStrength = 1;
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
  /** 直方图测光（第一次用到时建）、局部曝光的网格。 */
  #histogram: HistogramMetering | undefined;
  #local: LocalExposure | undefined;
  /** 这一帧映射时绑的局部曝光的网格、查找表：没开时是 1 个纹素的占位（着色器不读）。 */
  #localBound: LocalExposureBinding | undefined;
  #lutBound: GPUTexture | undefined;
  #placeholders: (LocalExposureBinding & { readonly lut: GPUTexture }) | undefined;

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
    const local = wantsLocal && (this.#local ??= new LocalExposure(this.#device)).ready() ? this.#local : undefined;
    const [minLog, maxLog] = this.histogramRange;
    settings.set([this.localHighlights, this.localShadows, this.localDetail, this.localBlur], 20);
    settings.set([minLog, Math.max(maxLog - minLog, 1e-3), local ? 1 : 0, 0], 24);
    const balance = whiteBalanceMatrix(this.temperature, this.tint);
    const lut = this.enabled && this.lutStrength > 0 ? this.lut : undefined;
    settings.set([...lut?.domainMin ?? [0, 0, 0], lut ? this.lutStrength : 0, ...lut?.domainMax ?? [1, 1, 1], lut?.size ?? 1], 28);
    for (let c = 0; c < 3; c++) settings.set([balance[c * 3]!, balance[c * 3 + 1]!, balance[c * 3 + 2]!, 0], 36 + c * 4);
    this.#lutBound = lut ? colorLutTexture(this.#device, lut) : this.#placeholder().lut;
    this.#device.queue.writeBuffer(this.#settings, 0, settings);
    this.#localBound = local ? local.record(frame, input, minLog, maxLog) : this.#placeholder();
    // 关掉时 draw 照样绑一张适应亮度（着色器不读它）；重新打开时从当前亮度开始适应
    if (!this.enabled) {
      this.#measured = this.#adapted[this.#current];
      this.#reset = true;
      return;
    }
    const histogram = this.metering === 'histogram' && (this.#histogram ??= new HistogramMetering(this.#device)).ready() ? this.#histogram : undefined;
    // 平均测光的亮度图跟着画面尺寸（尺寸变了要从头适应，所以在读 #reset 之前）
    const targets = histogram ? undefined : this.#targetsFor(input.width, input.height);
    const reset = this.#reset || !this.temporalAdaptation || this.instantAdaptation;
    this.#reset = false;
    // 适应：读上一帧的结果，写另一张
    const previous = this.#adapted[this.#current]!;
    const next = this.#adapted[1 - this.#current]!;
    this.#current = 1 - this.#current;
    this.#measured = next;
    if (!targets) {
      histogram!.record(frame, input, previous, next, {
        range: this.histogramRange, filter: this.histogramFilter, speedBrighten: this.speedBrighten, speedDarken: this.speedDarken, elapsed, reset,
      });
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

  /** 没开局部曝光、没有查找表时绑的 1 个纹素的贴图（着色器不读）。 */
  #placeholder(): LocalExposureBinding & { readonly lut: GPUTexture } {
    const volume = () => this.#device.createTexture({ label: 'ToneMap placeholder', size: [1, 1, 1], dimension: '3d', format: 'rgba16float', usage: GPUTextureUsage.TEXTURE_BINDING });
    return this.#placeholders ??= {
      grid: volume(),
      wide: this.#device.createTexture({ label: 'ToneMap placeholder', size: [1, 1], format: 'rgba16float', usage: GPUTextureUsage.TEXTURE_BINDING }),
      lut: volume(),
    };
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
          { binding: 10, resource: this.#lutBound!.createView() },
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
    this.#histogram?.destroy();
    this.#local?.destroy();
    if (this.#placeholders) for (const texture of [this.#placeholders.grid, this.#placeholders.wide, this.#placeholders.lut]) texture.destroy();
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
