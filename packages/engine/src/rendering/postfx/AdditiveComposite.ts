/**
 * 把泛光、光芒、镜头光晕的结果一次加回画面。Stride 是每个效果各自用 BlendStates.Additive 画一遍全屏（源乘源的 alpha），
 * 这里在一个通道里把各层的 rgb · alpha 加起来再加到画面上，结果相同（只差 rgba16float 中间舍入），
 * 省掉两遍全分辨率的读写（docs/architecture.md 的"后处理的开销"）。
 */
import { ADD_BLEND, FullscreenShader, type ImageEffectContext } from './ImageEffect';
import { SCALED_SAMPLE } from './ImageScaler';

/** 一层：texture 乘 color，按 ImageScaler 的规则采样（expanded 时 9 点），再按 Additive 加上去。 */
export interface AdditiveLayer {
  readonly texture: GPUTexture;
  readonly expanded: boolean;
  /** 默认白色。 */
  readonly color?: readonly [number, number, number, number];
}

const MAX_LAYERS = 3;

const COMPOSITE_SHADER = /* wgsl */ `
struct Layer { color: vec4f, texelSize: vec2f, expanded: f32, enabled: f32 };
@group(0) @binding(0) var<uniform> layers: array<Layer, ${MAX_LAYERS}>;
@group(0) @binding(1) var layer0: texture_2d<f32>;
@group(0) @binding(2) var layer1: texture_2d<f32>;
@group(0) @binding(3) var layer2: texture_2d<f32>;
@group(0) @binding(4) var linearClamp: sampler;
${SCALED_SAMPLE}

// BlendStates.Additive 的源项：rgb · a 加到颜色上，a · a 加到 alpha 上
fn additive(source: texture_2d<f32>, layer: Layer, uv: vec2f) -> vec4f {
  if (layer.enabled == 0.0) {
    return vec4f(0.0);
  }
  let color = scaledSample(source, linearClamp, uv, layer.texelSize, layer.expanded != 0.0) * layer.color;
  return vec4f(color.rgb * color.a, color.a * color.a);
}

@fragment fn fs(in: FullscreenVaryings) -> @location(0) vec4f {
  return additive(layer0, layers[0], in.uv) + additive(layer1, layers[1], in.uv) + additive(layer2, layers[2], in.uv);
}`;

export class AdditiveComposite {
  readonly #shader: FullscreenShader;
  readonly #sampler: GPUSampler;

  constructor(device: GPUDevice, linearClamp: GPUSampler) {
    this.#shader = new FullscreenShader(device, 'AdditiveComposite', COMPOSITE_SHADER);
    this.#sampler = linearClamp;
  }

  /** 各层加到 output 上；没有层时什么都不画。 */
  draw({ encoder, arena }: ImageEffectContext, layers: readonly AdditiveLayer[], output: GPUTexture): void {
    if (layers.length === 0) return;
    if (layers.length > MAX_LAYERS) throw new RangeError(`AdditiveComposite supports up to ${MAX_LAYERS} layers, got ${layers.length}`);
    const parameters = new Float32Array(MAX_LAYERS * 8);
    layers.forEach(({ texture, expanded, color = [1, 1, 1, 1] }, i) => parameters.set([...color, 1 / texture.width, 1 / texture.height, expanded ? 1 : 0, 1], i * 8));
    // 空着的槽位绑第一层的纹理（enabled 是 0，不会采样）
    const textures = Array.from({ length: MAX_LAYERS }, (_, i) => (layers[i] ?? layers[0]!).texture);
    this.#shader.draw(encoder, output, [arena.push(parameters), ...textures, this.#sampler], { blend: ADD_BLEND, load: true });
  }
}
