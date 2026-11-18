/**
 * 亮部提取（Stride 的 BrightFilter）：按亮度的平方根平滑地截掉暗部，Bloom、光芒、镜头光晕都从它的结果出发。
 * 颜色先限制到 half 能安全表示的范围（NaN 变 0），亮度用 Rec.601（至少 0.0001）：
 *   结果 = 颜色 · smoothstep(0, 1, saturate(sqrt(亮度) / (steepness + 1) - threshold)) · color
 */
import { FullscreenShader, type UniformArena } from './ImageEffect';

const BRIGHT_SHADER = /* wgsl */ `
struct Bright { color: vec4f, steepness: f32, threshold: f32 };
@group(0) @binding(0) var<uniform> bright: Bright;
@group(0) @binding(1) var source: texture_2d<f32>;

@fragment fn fs(in: FullscreenVaryings) -> @location(0) vec4f {
  var color = textureLoad(source, vec2u(in.position.xy), 0).rgb;
  color = select(vec3f(0.0), min(color, vec3f(32000.0)), color > vec3f(0.0));
  let luminance = max(dot(color, vec3f(0.299, 0.587, 0.114)), 0.0001);
  color *= smoothstep(0.0, 1.0, saturate(sqrt(luminance) / (bright.steepness + 1.0) - bright.threshold));
  return vec4f(color * bright.color.rgb, 1.0);
}`;

export class BrightFilter {
  enabled = true;
  threshold = 0.2;
  steepness = 1;
  /** 线性颜色。 */
  color: [number, number, number] = [1, 1, 1];
  readonly #shader: FullscreenShader;

  constructor(device: GPUDevice) {
    this.#shader = new FullscreenShader(device, 'BrightFilter', BRIGHT_SHADER);
  }

  /** input 和 output 一样大。 */
  draw(encoder: GPUCommandEncoder, arena: UniformArena, input: GPUTexture, output: GPUTexture): void {
    const parameters = arena.push([...this.color, 1, this.steepness, this.threshold]);
    this.#shader.draw(encoder, output, [parameters, input]);
  }
}
