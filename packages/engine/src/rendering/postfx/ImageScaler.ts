/**
 * 缩放和拷贝（Stride 的 ImageScaler 和 ImageMultiScaler）：
 * - 线性：一次双线性采样；
 * - Expanded（Stride 的 SpriteSuperSampler，用 supersample 构造的效果都用它）：以输入的像素为单位在 9 个点上采样，
 *   中心权重 3、对角 2、两格外 1，缩小时不会闪；
 * 结果乘 color，可以叠加（混合方式由调用方给）。multiScale 一级级减半到目标尺寸，每级都用 Expanded。
 */
import { FullscreenShader, type EffectFrame, type Image, type UniformArena } from './ImageEffect';

/** 线性或 Expanded 的一次采样。 */
const SCALED_SAMPLE = /* wgsl */ `
const JITTERS = array<vec2f, 9>(vec2f(-2.0, 0.0), vec2f(0.0, 0.0), vec2f(2.0, 0.0), vec2f(-1.0, 1.0), vec2f(1.0, 1.0), vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(0.0, 2.0), vec2f(0.0, -2.0));

fn scaledSample(source: texture_2d<f32>, linearClamp: sampler, uv: vec2f, texelSize: vec2f, expanded: bool) -> vec4f {
  if (!expanded) {
    return textureSampleLevel(source, linearClamp, uv, 0.0);
  }
  var color = vec4f(0.0);
  var weights = 0.0;
  for (var j = 0u; j < 9u; j++) {
    let jitter = JITTERS[j];
    let weight = 3.0 - max(abs(jitter.x), abs(jitter.y));
    color += weight * textureSampleLevel(source, linearClamp, uv + jitter * texelSize, 0.0);
    weights += weight;
  }
  return color / weights;
}`;

const SCALER_SHADER = /* wgsl */ `
struct Scaler { color: vec4f, texelSize: vec2f, expanded: f32 };
@group(0) @binding(0) var<uniform> scaler: Scaler;
@group(0) @binding(1) var source: texture_2d<f32>;
@group(0) @binding(2) var linearClamp: sampler;
${SCALED_SAMPLE}

@fragment fn fs(in: FullscreenVaryings) -> @location(0) vec4f {
  return scaledSample(source, linearClamp, in.uv, scaler.texelSize, scaler.expanded != 0.0) * scaler.color;
}`;

export interface ScaleOptions {
  readonly expanded: boolean;
  /** 结果乘的颜色，默认白色。 */
  readonly color?: readonly [number, number, number, number];
  readonly blend?: GPUBlendState;
  /** 保留输出原来的内容（叠加时）。 */
  readonly load?: boolean;
}

export class ImageScaler {
  readonly #shader: FullscreenShader;
  readonly #sampler: GPUSampler;

  constructor(device: GPUDevice, linearClamp: GPUSampler) {
    this.#shader = new FullscreenShader(device, 'ImageScaler', SCALER_SHADER);
    this.#sampler = linearClamp;
  }

  draw(frame: EffectFrame, arena: UniformArena, input: Image, output: Image, { expanded, color = [1, 1, 1, 1], blend, load = false }: ScaleOptions): void {
    const parameters = arena.push([...color, 1 / input.width, 1 / input.height, expanded ? 1 : 0, 0]);
    this.#shader.draw(frame, output, [parameters, input, this.#sampler], { ...(blend ? { blend } : {}), load });
  }

  /** 原样拷贝到同样大小的纹理视图（比如后备缓冲）：像素中心一对一采样；目标是 sRGB 或 8 位时由硬件编码、截断。 */
  copy(encoder: GPUCommandEncoder, arena: UniformArena, input: GPUTexture, output: GPUTextureView, format: GPUTextureFormat): void {
    const parameters = arena.push([1, 1, 1, 1, 1 / input.width, 1 / input.height, 0, 0]);
    this.#shader.drawNow(encoder, output, [parameters, input, this.#sampler], { format });
  }

  /** 一级级减半（Expanded）直到输出的尺寸（Stride 的 ImageMultiScaler 往下缩），中间各级从池里借。 */
  multiScale(frame: EffectFrame, arena: UniformArena, input: Image, output: Image): void {
    let previous = input;
    for (;;) {
      const width = Math.max(1, previous.width >> 1), height = Math.max(1, previous.height >> 1);
      const last = width <= output.width && height <= output.height;
      const target = last ? output : frame.acquire(width, height, output.format, 'ImageMultiScaler level');
      this.draw(frame, arena, previous, target, { expanded: true });
      if (last) return;
      previous = target;
    }
  }
}
