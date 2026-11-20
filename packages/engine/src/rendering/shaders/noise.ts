/** 着色器共用的噪声和哈希（WGSL 片段，用到的着色器拼进去）。 */

/**
 * 交错梯度噪声（Jimenez 2014）：按屏幕像素的 0..1 噪声，相邻像素的值错开、没有成片的低频，模糊或者时间累积以后不留规则的纹理。
 * 步进的起点、采样盘的转角、输出的抖动都用它；要每帧换一个值时给像素坐标加一个随帧变的偏移。
 */
export const GRADIENT_NOISE = /* wgsl */ `
fn gradientNoise(pixel: vec2f) -> f32 {
  return fract(52.9829189 * fract(dot(pixel, vec2f(0.06711056, 0.00583715))));
}`;

/** 整数格子到三个 0..1 的随机数（pcg3d，Jarzynski、Olano 2020）：程序生成的噪声、星星的位置用。 */
export const HASH3 = /* wgsl */ `
fn hash3(cell: vec3i) -> vec3f {
  var v = bitcast<vec3u>(cell) * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> vec3u(16u);
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return vec3f(v) * (1.0 / 4294967296.0);
}`;
