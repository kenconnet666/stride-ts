/**
 * 着色器共用的 WGSL 片段，用到的着色器拼进去：全屏三角形的顶点着色器、BRDF、噪声和哈希、立方体贴图的面。
 */

/**
 * 全屏绘制的顶点着色器（一个盖满屏幕的三角形，draw(3)），给后处理、背景和查找表这类逐像素的通道用。
 * uv 的原点在左上角（同纹理坐标），ndc 是裁剪空间的 xy。深度是 1（远平面）：背景开着深度测试画，就只落在没画到的地方。
 */
export const FULLSCREEN_VERTEX = /* wgsl */ `
struct FullscreenVaryings {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) ndc: vec2f,
};

@vertex fn fullscreenVertex(@builtin(vertex_index) index: u32) -> FullscreenVaryings {
  let ndc = vec2f(f32((index << 1u) & 2u) * 2.0 - 1.0, f32(index & 2u) * 2.0 - 1.0);
  var out: FullscreenVaryings;
  // 深度在远平面上：反向 Z（相机的视图近 1 远 0）是 0，天空、背景按 greater-equal 只画在什么都没画的像素上
  out.position = vec4f(ndc, 0.0, 1.0);
  out.uv = vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
  out.ndc = ndc;
  return out;
}`;

/** BRDF 的几个函数，同 Stride 的 BRDFMicrofacet.sdsl。 */
export const BRDF = /* wgsl */ `
const PI = 3.14159265358979;

fn normalDistributionGGX(alphaR: f32, nDotH: f32) -> f32 {
  let alphaR2 = alphaR * alphaR;
  let d = max(nDotH * nDotH * (alphaR2 - 1.0) + 1.0, 0.0001);
  return alphaR2 / (PI * d * d);
}

fn visibilitySchlickGGX(alphaR: f32, nDotX: f32) -> f32 {
  let k = alphaR * 0.5;
  return nDotX / (nDotX * (1.0 - k) + k);
}

/** Smith-Schlick-GGX，已经除以 N·L · N·V。 */
fn visibilitySmithSchlickGGX(alphaR: f32, nDotL: f32, nDotV: f32) -> f32 {
  return visibilitySchlickGGX(alphaR, nDotL) * visibilitySchlickGGX(alphaR, nDotV) / (nDotL * nDotV);
}`;

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

/**
 * 面上的坐标（-1..1，v 向下）到方向（WebGPU 立方体贴图的面的约定），同 Stride 的 CubemapUtils.ConvertTexcoordsNoFlip。
 * 往立方体的面里画（预滤波、天空的环境光）、从面里读（球谐投影）都按它。
 */
export const CUBE_FACE_DIRECTION = /* wgsl */ `
fn faceDirection(face: u32, p: vec2f) -> vec3f {
  switch face {
    case 0u: { return vec3f(1.0, -p.y, -p.x); }
    case 1u: { return vec3f(-1.0, -p.y, p.x); }
    case 2u: { return vec3f(p.x, 1.0, p.y); }
    case 3u: { return vec3f(p.x, -1.0, -p.y); }
    case 4u: { return vec3f(p.x, -p.y, 1.0); }
    default: { return vec3f(-p.x, -p.y, -1.0); }
  }
}`;
