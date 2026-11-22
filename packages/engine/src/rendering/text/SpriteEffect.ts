/**
 * SpriteBatch 的自定义效果（Stride 的 SpriteBatch.Begin(effect: EffectInstance)：着色器继承 SpriteBase、重写 Shading，比如
 * CustomEffect 的水波纹）。设在 SpriteBatch.effect 上，之后 begin 的这一批贴图都用它画（文字照常画）。
 *
 * code 定义 `fn spriteEffect(uv: vec2f, color: vec4f) -> vec4f`，返回这个像素的颜色；里面可以用：
 * - `sampleTexture0(uv)`：正在画的贴图（同 Stride 的 Texture0），取回贴图里存的值。我们导入的贴图都没有预乘 alpha；Stride 里
 *   PremultiplyAlpha 为 true 的贴图，Texture0 是预乘过的，效果里要自己乘（`vec4f(t.rgb * t.a, t.a)`）；
 * - `effect.values`：4 个 vec4f 的参数（parameters，Stride 的 EffectInstance.Parameters），每次 begin 时上传。
 * color 是画的时候给的颜色（线性、预乘）。
 *
 *   batch.effect = spriteEffect(`fn spriteEffect(uv: vec2f, color: vec4f) -> vec4f { return sampleTexture0(uv.yx); }`);
 */
import type { TextureSampler } from '../../content/formats/format';

/** 参数有几个 float（4 个 vec4f）。 */
export const SPRITE_EFFECT_PARAMETERS = 16;

export interface SpriteEffect {
  readonly isSpriteEffect: true;
  readonly code: string;
  /** 16 个 float，改了下一次 begin 时生效。 */
  readonly parameters: Float32Array;
  /** sampleTexture0 用的采样器，默认线性、钳位。 */
  readonly sampler: TextureSampler;
  /** 混合：premultiplied（Stride 的 BlendStates.AlphaBlend，默认）或 nonPremultiplied（BlendStates.NonPremultiplied）。 */
  readonly blend: 'premultiplied' | 'nonPremultiplied';
}

export function spriteEffect(code: string, { parameters = [], sampler = { addressU: 'clamp', addressV: 'clamp' }, blend = 'premultiplied' }: {
  parameters?: readonly number[];
  sampler?: TextureSampler;
  blend?: SpriteEffect['blend'];
} = {}): SpriteEffect {
  if (parameters.length > SPRITE_EFFECT_PARAMETERS) throw new RangeError(`a sprite effect has at most ${SPRITE_EFFECT_PARAMETERS} parameters, got ${parameters.length}`);
  const values = new Float32Array(SPRITE_EFFECT_PARAMETERS);
  values.set(parameters);
  return { isSpriteEffect: true, code, parameters: values, sampler, blend };
}

/** 效果的片元着色器：参数、sampleTexture0，加上效果的代码（接在 SpriteBatch 的着色器后面）。 */
export function spriteEffectShader(effect: SpriteEffect): string {
  return /* wgsl */ `
struct SpriteEffectParameters { values: array<vec4f, 4> };
@group(2) @binding(0) var<uniform> effect: SpriteEffectParameters;
@group(2) @binding(1) var effectSampler: sampler;

fn sampleTexture0(uv: vec2f) -> vec4f {
  return textureSample(spriteTexture, effectSampler, uv);
}

${effect.code}

@fragment fn fsEffect(in: SpriteVaryings) -> @location(0) vec4f {
  return spriteEffect(in.uv, in.color);
}
`;
}
