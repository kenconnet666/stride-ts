/**
 * FXAA（Stride 的 FXAAEffect，NVIDIA FXAA 3.11 的 PC Quality 路径，Timothy Lottes），默认设置同 Stride：
 * 低抖动（Dither Low）的第 3 档，即预设 23；subpix 0.75，边缘阈值 0.063，最小阈值 0.0312。
 * 在 HDR 画面上做（Stride 的 Bloom 默认开着 StableConvolution，FXAA 排在最前面），前后各一次范围转换：
 * - 压缩（RangeCompressorShader）：颜色 / (1 + 最大分量)，alpha 写感知亮度 sqrt(Rec.709 亮度)，FXAA 用 alpha 当亮度；
 * - 解压（RangeDecompressorShader）：颜色 / (1 - 最大分量)。
 * 和 Stride 不同：解压不单独画一遍全分辨率，FXAA 输出时当场解压（结果只差中间结果存成 rgba16float 的舍入）。压缩没并进来：
 * 在 FXAA 里每个采样点现算压缩、手动双线性插值时（试过，4K 下）FXAA 从 2.6 ms 涨到 9.6 ms，比单独一遍压缩（1.3 ms）贵得多。
 * 沿边搜索的步长表来自原着色器的各个预设（FXAA_QUALITY__P0..Pn）。原着色器按预设在编译期展开成嵌套的 if，这里也按预设
 * 生成展开的着色器（写成运行时的循环、按下标取步长时，TPP 上 FXAA 这一遍 0.62 ms，展开后 0.52 ms）。
 */
import { FullscreenShader, type RenderTargetPool, type UniformArena } from './ImageEffect';

/** 预设号到沿边搜索的步长（FXAA 3.11 的 FXAA_QUALITY__PRESET 表）。 */
const PRESET_STEPS: Readonly<Record<number, readonly number[]>> = {
  10: [1.5, 3.0, 12.0],
  11: [1.0, 1.5, 3.0, 12.0],
  12: [1.0, 1.5, 2.0, 4.0, 12.0],
  13: [1.0, 1.5, 2.0, 2.0, 4.0, 12.0],
  14: [1.0, 1.5, 2.0, 2.0, 2.0, 4.0, 12.0],
  15: [1.0, 1.5, 2.0, 2.0, 2.0, 2.0, 4.0, 12.0],
  20: [1.5, 2.0, 8.0],
  21: [1.0, 1.5, 2.0, 8.0],
  22: [1.0, 1.5, 2.0, 2.0, 8.0],
  23: [1.0, 1.5, 2.0, 2.0, 2.0, 8.0],
  24: [1.0, 1.5, 2.0, 2.0, 2.0, 3.0, 8.0],
  25: [1.0, 1.5, 2.0, 2.0, 2.0, 2.0, 4.0, 8.0],
  26: [1.0, 1.5, 2.0, 2.0, 2.0, 2.0, 2.0, 4.0, 8.0],
  27: [1.0, 1.5, 2.0, 2.0, 2.0, 2.0, 2.0, 2.0, 4.0, 8.0],
  28: [1.0, 1.5, 2.0, 2.0, 2.0, 2.0, 2.0, 2.0, 2.0, 4.0, 8.0],
  29: [1.0, 1.5, 2.0, 2.0, 2.0, 2.0, 2.0, 2.0, 2.0, 2.0, 4.0, 8.0],
  39: [1.0, 1.0, 1.0, 1.0, 1.0, 1.5, 2.0, 2.0, 2.0, 2.0, 4.0, 8.0],
};

/** Stride 的 FXAAEffect.DitherType：预设号 = 抖动的基数 + quality。 */
const DITHER_BASE = { medium: 10, low: 20, none: 30 } as const;
const QUALITY_RANGE = { medium: [0, 5], low: [0, 9], none: [9, 9] } as const;
export type FxaaDither = keyof typeof DITHER_BASE;

const COMPRESS_SHADER = /* wgsl */ `
@group(0) @binding(0) var source: texture_2d<f32>;

@fragment fn fs(in: FullscreenVaryings) -> @location(0) vec4f {
  var color = textureLoad(source, vec2u(in.position.xy), 0).rgb;
  color = select(vec3f(0.0), min(color, vec3f(32000.0)), color > vec3f(0.0));
  let luma = sqrt(dot(vec3f(0.2126, 0.7152, 0.0722), color));
  return vec4f(color / (1.0 + max(max(color.r, color.g), color.b)), luma);
}`;

/** WGSL 的浮点字面量。 */
const float = (value: number) => (Number.isInteger(value) ? value.toFixed(1) : String(value));

/** 沿边搜索的第 3 步起：两端都还没找到边缘时才做（同原着色器的嵌套 if，一旦停下就不再继续）。 */
const searchSteps = (steps: readonly number[]) => steps.slice(2).map((step) => `
  if (doneNP) {
    if (!doneN) { lumaEndN = tap(posN).a - lumaNN * 0.5; }
    if (!doneP) { lumaEndP = tap(posP).a - lumaNN * 0.5; }
    doneN = abs(lumaEndN) >= gradientScaled;
    doneP = abs(lumaEndP) >= gradientScaled;
    if (!doneN) { posN -= offNP * ${float(step)}; }
    if (!doneP) { posP += offNP * ${float(step)}; }
    doneNP = !doneN || !doneP;
  }`).join('');

const fxaaShader = (steps: readonly number[]) => /* wgsl */ `
// rcpFrame：一个像素的大小；quality：subpix、边缘阈值、最小阈值
struct Fxaa { rcpFrame: vec4f, quality: vec4f };
@group(0) @binding(0) var<uniform> fxaa: Fxaa;
@group(0) @binding(1) var source: texture_2d<f32>;
@group(0) @binding(2) var linearClamp: sampler;

fn tap(p: vec2f) -> vec4f {
  return textureSampleLevel(source, linearClamp, p, 0.0);
}
fn lumaAt(p: vec2f, o: vec2f) -> f32 {
  return tap(p + o * fxaa.rcpFrame.xy).a;
}

// 范围解压（RangeDecompressorShader）：颜色 / (1 - 最大分量)
fn decompressed(color: vec3f) -> vec4f {
  let denominator = 1.0 - max(max(color.r, color.g), color.b);
  return vec4f(select(color, color / denominator, denominator > 0.0), 1.0);
}

@fragment fn fs(in: FullscreenVaryings) -> @location(0) vec4f {
  let rcp = fxaa.rcpFrame.xy;
  var posM = in.uv;
  let rgbyM = tap(posM);
  let lumaM = rgbyM.a;
  var lumaS = lumaAt(posM, vec2f(0.0, 1.0));
  let lumaE = lumaAt(posM, vec2f(1.0, 0.0));
  var lumaN = lumaAt(posM, vec2f(0.0, -1.0));
  let lumaW = lumaAt(posM, vec2f(-1.0, 0.0));

  let rangeMax = max(max(lumaN, lumaW), max(lumaE, max(lumaS, lumaM)));
  let rangeMin = min(min(lumaN, lumaW), min(lumaE, min(lumaS, lumaM)));
  let range = rangeMax - rangeMin;
  if (range < max(fxaa.quality.z, rangeMax * fxaa.quality.y)) {
    return decompressed(rgbyM.rgb);
  }

  let lumaNW = lumaAt(posM, vec2f(-1.0, -1.0));
  let lumaSE = lumaAt(posM, vec2f(1.0, 1.0));
  let lumaNE = lumaAt(posM, vec2f(1.0, -1.0));
  let lumaSW = lumaAt(posM, vec2f(-1.0, 1.0));

  let lumaNS = lumaN + lumaS;
  let lumaWE = lumaW + lumaE;
  let subpixRcpRange = 1.0 / range;
  let subpixNSWE = lumaNS + lumaWE;
  let edgeHorz1 = -2.0 * lumaM + lumaNS;
  let edgeVert1 = -2.0 * lumaM + lumaWE;
  let lumaNESE = lumaNE + lumaSE;
  let lumaNWNE = lumaNW + lumaNE;
  let edgeHorz2 = -2.0 * lumaE + lumaNESE;
  let edgeVert2 = -2.0 * lumaN + lumaNWNE;
  let lumaNWSW = lumaNW + lumaSW;
  let lumaSWSE = lumaSW + lumaSE;
  let edgeHorz4 = abs(edgeHorz1) * 2.0 + abs(edgeHorz2);
  let edgeVert4 = abs(edgeVert1) * 2.0 + abs(edgeVert2);
  let edgeHorz3 = -2.0 * lumaW + lumaNWSW;
  let edgeVert3 = -2.0 * lumaS + lumaSWSE;
  let edgeHorz = abs(edgeHorz3) + edgeHorz4;
  let edgeVert = abs(edgeVert3) + edgeVert4;
  let subpixNWSWNESE = lumaNWSW + lumaNESE;
  var lengthSign = rcp.x;
  let horzSpan = edgeHorz >= edgeVert;
  let subpixA = subpixNSWE * 2.0 + subpixNWSWNESE;
  if (!horzSpan) { lumaN = lumaW; lumaS = lumaE; }
  if (horzSpan) { lengthSign = rcp.y; }
  let subpixB = subpixA * (1.0 / 12.0) - lumaM;
  let gradientN = lumaN - lumaM;
  let gradientS = lumaS - lumaM;
  var lumaNN = lumaN + lumaM;
  let lumaSS = lumaS + lumaM;
  let pairN = abs(gradientN) >= abs(gradientS);
  let gradient = max(abs(gradientN), abs(gradientS));
  if (pairN) { lengthSign = -lengthSign; }
  let subpixC = saturate(abs(subpixB) * subpixRcpRange);

  var posB = posM;
  let offNP = vec2f(select(rcp.x, 0.0, !horzSpan), select(rcp.y, 0.0, horzSpan));
  if (!horzSpan) { posB.x += lengthSign * 0.5; }
  if (horzSpan) { posB.y += lengthSign * 0.5; }
  var posN = posB - offNP * ${float(steps[0]!)};
  var posP = posB + offNP * ${float(steps[0]!)};
  let subpixD = -2.0 * subpixC + 3.0;
  var lumaEndN = tap(posN).a;
  let subpixE = subpixC * subpixC;
  var lumaEndP = tap(posP).a;
  if (!pairN) { lumaNN = lumaSS; }
  let gradientScaled = gradient * 1.0 / 4.0;
  let lumaMM = lumaM - lumaNN * 0.5;
  let subpixF = subpixD * subpixE;
  let lumaMLTZero = lumaMM < 0.0;
  lumaEndN -= lumaNN * 0.5;
  lumaEndP -= lumaNN * 0.5;
  var doneN = abs(lumaEndN) >= gradientScaled;
  var doneP = abs(lumaEndP) >= gradientScaled;
  if (!doneN) { posN -= offNP * ${float(steps[1]!)}; }
  if (!doneP) { posP += offNP * ${float(steps[1]!)}; }
  var doneNP = !doneN || !doneP;${searchSteps(steps)}

  var dstN = posM.x - posN.x;
  var dstP = posP.x - posM.x;
  if (!horzSpan) { dstN = posM.y - posN.y; dstP = posP.y - posM.y; }
  let goodSpanN = (lumaEndN < 0.0) != lumaMLTZero;
  let spanLength = dstP + dstN;
  let goodSpanP = (lumaEndP < 0.0) != lumaMLTZero;
  let spanLengthRcp = 1.0 / spanLength;
  let directionN = dstN < dstP;
  let dst = min(dstN, dstP);
  let goodSpan = select(goodSpanP, goodSpanN, directionN);
  let subpixG = subpixF * subpixF;
  let pixelOffset = dst * -spanLengthRcp + 0.5;
  let subpixH = subpixG * fxaa.quality.x;
  let pixelOffsetGood = select(0.0, pixelOffset, goodSpan);
  let pixelOffsetSubpix = max(pixelOffsetGood, subpixH);
  if (!horzSpan) { posM.x += pixelOffsetSubpix * lengthSign; }
  if (horzSpan) { posM.y += pixelOffsetSubpix * lengthSign; }
  return decompressed(tap(posM).rgb);
}`;

export class Fxaa {
  enabled = true;
  dither: FxaaDither = 'low';
  /** 抖动 medium 时 0..5，low 时 0..9，none 时只能是 9。 */
  quality = 3;
  subpix = 0.75;
  edgeThreshold = 0.063;
  edgeThresholdMin = 0.0312;
  readonly #compress: FullscreenShader;
  /** 按预设号生成的 FXAA 着色器。 */
  readonly #fxaa = new Map<number, FullscreenShader>();
  readonly #device: GPUDevice;
  readonly #sampler: GPUSampler;

  constructor(device: GPUDevice, linearClamp: GPUSampler) {
    this.#device = device;
    this.#compress = new FullscreenShader(device, 'FXAA range compress', COMPRESS_SHADER);
    this.#sampler = linearClamp;
  }

  /** 这些设置对应的 FXAA 预设号（Stride 的 FXAAEffect.UpdateParameters）。 */
  get preset(): number {
    const [min, max] = QUALITY_RANGE[this.dither];
    if (!Number.isInteger(this.quality) || this.quality < min || this.quality > max) {
      throw new RangeError(`FXAA quality must be ${min}..${max} for dither '${this.dither}', got ${this.quality}`);
    }
    return DITHER_BASE[this.dither] + this.quality;
  }

  /** 在 HDR 画面上做 FXAA：input 被改写（结果写回它），中间的压缩画面从池里借。 */
  drawHdr(encoder: GPUCommandEncoder, pool: RenderTargetPool, arena: UniformArena, input: GPUTexture): GPUTexture {
    const preset = this.preset;
    let fxaa = this.#fxaa.get(preset);
    if (!fxaa) {
      const steps = PRESET_STEPS[preset];
      if (!steps) throw new RangeError(`FXAA preset ${preset} does not exist`);
      this.#fxaa.set(preset, (fxaa = new FullscreenShader(this.#device, 'FXAA', fxaaShader(steps))));
    }
    const compressed = pool.acquire(input.width, input.height, input.format, 'FXAA');
    this.#compress.draw(encoder, compressed, [input]);
    const parameters = [1 / input.width, 1 / input.height, 0, 0, this.subpix, this.edgeThreshold, this.edgeThresholdMin, 0];
    fxaa.draw(encoder, input, [arena.push(parameters), compressed, this.#sampler]);
    return input;
  }
}
