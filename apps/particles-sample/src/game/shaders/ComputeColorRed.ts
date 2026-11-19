// ParticlesSample 的 ComputeColorRed.sdsl：最简单的着色器类，总是红色。
import { shaderClass } from '@stride-ts/engine';

export const ComputeColorRed = shaderClass([], /* wgsl */ `
fn ComputeColorRed() -> vec4f {
  return vec4f(1.0, 0.0, 0.0, 1.0);
}
`);
