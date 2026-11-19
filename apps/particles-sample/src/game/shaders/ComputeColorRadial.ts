// ParticlesSample 的 ComputeColorRadial.sdsl：从中心（UV 的 0.5, 0.5）到边上，颜色从 ColorCenter 过渡到 ColorEdge；强度可以超过 1，
// alpha 限制到 1，再预乘 alpha（整条管线用预乘 alpha）。
import { shaderClass } from '@stride-ts/engine';

export const ComputeColorRadial = shaderClass(['ColorCenter', 'ColorEdge'], /* wgsl */ `
fn ComputeColorRadial(ColorCenter: vec4f, ColorEdge: vec4f) -> vec4f {
  let radialDistance = length(streams.uv - vec2f(0.5, 0.5)) * 2.0;
  let unclamped = mix(ColorCenter, ColorEdge, radialDistance);
  let clamped = clamp(unclamped, vec4f(0.0), vec4f(1000.0, 1000.0, 1000.0, 1.0));
  return vec4f(clamped.rgb * clamped.a, clamped.a);
}
`);
