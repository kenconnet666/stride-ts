// MaterialShader 的 ComputeColorWaveNormal.sdsl（水面的法线贴图）：同一个波的导数换成切线空间的法线，存成 0..1（材质的
// ScaleAndBias 再换回 -1..1）。
import { shaderClass } from '@stride-ts/engine';

export const ComputeColorWaveNormal = shaderClass(['Frequency', 'Amplitude', 'Speed'], /* wgsl */ `
/** (x, 1) / sqrt(1 + x²)：atan(x) 的正弦和余弦。 */
fn waveSincosOfAtan(x: f32) -> vec2f {
  return vec2f(x, 1.0) / sqrt(1.0 + x * x);
}

fn ComputeColorWaveNormal(Frequency: f32, Amplitude: f32, Speed: f32) -> vec4f {
  let offset = streams.uv - 0.5;
  let phase = length(offset);
  let derivative = cos((phase + streams.time * Speed) * 2.0 * 3.14 * Frequency) * Amplitude;
  let xz = waveSincosOfAtan(offset.y / offset.x);
  let xy = waveSincosOfAtan(derivative);
  var normal: vec3f;
  normal = vec3f((xz.yx * sign(offset.x) * -xy.x) * 0.5 + 0.5, xy.y);
  return vec4f(normal, 1.0);
}
`);
