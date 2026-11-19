// ParticlesSample 的 ComputeColorTextureScroll.sdsl（激光的网格材质用）：让之后采样的贴图沿 V 按时间滚动（改的是共用的 UV），
// 颜色按本地 Y 离中间的距离淡出（只适合程序生成的圆柱，半高 0.5：|y| 到 0.4 以外 0.1 之内从 1 降到 0）。
import { shaderClass } from '@stride-ts/engine';

export const ComputeColorTextureScroll = shaderClass(['UvSpeed', 'colorIntensity'], /* wgsl */ `
fn ComputeColorTextureScroll(UvSpeed: f32, colorIntensity: f32) -> vec4f {
  streams.uv.y += streams.time * UvSpeed;
  let alpha = 1.0 - 10.0 * (abs(streams.position.y) - 0.4);
  return vec4f(alpha * colorIntensity, alpha * colorIntensity, alpha * colorIntensity, alpha);
}
`);
