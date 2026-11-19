// 水波纹效果（Stride 的 Effect.sdsl，继承 SpriteBase、重写 Shading）：以 center 为圆心按距离做正弦波，把采样坐标沿径向推开，
// 波峰稍亮、波谷稍暗，离圆心越远越弱。参数照 Stride 的 CustomEffectRenderer。
// 参数的排布：values[0] = (center.x, center.y, frequency, phase)，values[1] = (spread, amplitude, invAspectRatio, 0)。
import { spriteEffect, type SpriteEffect } from '@stride-ts/engine';

const WAVE_SHADING = /* wgsl */ `
fn spriteEffect(uv: vec2f, color: vec4f) -> vec4f {
  let center = effect.values[0].xy;
  let frequency = effect.values[0].z;
  let phase = effect.values[0].w;
  let spread = effect.values[1].x;
  let amplitude = effect.values[1].y;
  let invAspectRatio = effect.values[1].z;

  let toPixel = (uv - center) * vec2f(1.0, invAspectRatio);
  let dist = length(toPixel);
  let direction = normalize(toPixel);
  let wave = sin(frequency * dist + phase);
  // 距离钳到 0 到 1，越近越强
  let falloff = pow(saturate(1.0 - dist), 1.0 / spread);

  let uv2 = uv + (wave * falloff * amplitude) * direction;
  let lighting = mix(1.0, 1.0 + wave * falloff * 0.2, saturate(amplitude / 0.015));
  let texel = sampleTexture0(uv2);
  return vec4f(texel.rgb * lighting, texel.a);
}`;

export function createWaveEffect(): SpriteEffect {
  return spriteEffect(WAVE_SHADING, { parameters: [0.5, 0.5, 40, 0, 0.5, 0.015, 1, 0], blend: 'nonPremultiplied' });
}

export function setWavePhase(effect: SpriteEffect, phase: number): void {
  effect.parameters[3] = phase;
}

export function setWaveAspectRatio(effect: SpriteEffect, width: number, height: number): void {
  effect.parameters[6] = height / width;
}
