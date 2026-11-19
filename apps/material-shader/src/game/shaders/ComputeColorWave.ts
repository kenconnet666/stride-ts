// MaterialShader 的 ComputeColorWave.sdsl（水面的位移贴图）：按 UV 到中心的距离和时间算正弦波的高度。
import { shaderClass } from '@stride-ts/engine';

export const ComputeColorWave = shaderClass(['Frequency', 'Amplitude', 'Speed'], /* wgsl */ `
fn ComputeColorWave(Frequency: f32, Amplitude: f32, Speed: f32) -> vec4f {
  let phase = length(streams.uv - 0.5);
  return vec4f(sin((phase + streams.time * Speed) * 2.0 * 3.14 * Frequency) * Amplitude);
}
`);
