/**
 * 屏幕空间反射（ScreenSpaceReflections.ts）和光追的反射（raytracing/RayTracedReflections.ts）共用的着色器代码：反射的参数、
 * 深度还原世界位置、投影、八面体解码，每像素每帧的随机数和 GGX 可见法线的取样（两边按同一个随机数取同一个反射方向：屏幕上
 * 没找到的，光追接着找同一条光线）。
 */
export const SSR_COMMON_WGSL = /* wgsl */ `
struct Ssr {
  inverseViewProjection: mat4x4f,
  viewProjection: mat4x4f,
  previousViewProjection: mat4x4f,
  /** xyz：相机位置；w：第几帧（随机数换着用）。 */
  eye: vec4f,
  /** 最大粗糙度、厚度（相对深度）、屏幕边缘渐隐的比例、最多走几步。 */
  params: vec4f,
  /** 宽、高、Hi-Z 的级数、有没有运动向量。 */
  size: vec4f,
};

fn worldPosition(ssr: Ssr, uv: vec2f, depth: f32) -> vec3f {
  let clip = ssr.inverseViewProjection * vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, depth, 1.0);
  return clip.xyz / clip.w;
}

/** 世界空间的点 → 屏幕（uv，深度）。 */
fn project(matrix: mat4x4f, world: vec3f) -> vec3f {
  let clip = matrix * vec4f(world, 1.0);
  let ndc = clip.xyz / clip.w;
  return vec3f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5, ndc.z);
}

fn octahedralDecode(e: vec2f) -> vec3f {
  var n = vec3f(e, 1.0 - abs(e.x) - abs(e.y));
  let t = saturate(-n.z);
  n = vec3f(n.xy + select(vec2f(t), vec2f(-t), n.xy >= vec2f(0.0)), n.z);
  return normalize(n);
}
`;

export const SSR_SAMPLING_WGSL = /* wgsl */ `
/** 每个像素、每帧不同的两个随机数（整数哈希，PCG）。 */
fn random2(pixel: vec2u, frame: u32) -> vec2f {
  var v = vec3u(pixel, frame) * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> vec3u(16u);
  v.x += v.y * v.z; v.y += v.z * v.x;
  return vec2f(v.xy & vec2u(0xffffffu)) / 16777216.0;
}

/** GGX 的可见法线分布里取一个微表面法线（Heitz 2018），v 和返回值都在切线空间（z 是表面法线）。 */
fn sampleGgxVndf(v: vec3f, alpha: f32, u: vec2f) -> vec3f {
  let vh = normalize(vec3f(alpha * v.x, alpha * v.y, v.z));
  let lensq = vh.x * vh.x + vh.y * vh.y;
  let t1 = select(vec3f(1.0, 0.0, 0.0), vec3f(-vh.y, vh.x, 0.0) / sqrt(lensq), lensq > 0.0);
  let t2 = cross(vh, t1);
  let r = sqrt(u.x);
  let phi = 6.28318530718 * u.y;
  let p1 = r * cos(phi);
  let s = 0.5 * (1.0 + vh.z);
  let p2 = (1.0 - s) * sqrt(1.0 - p1 * p1) + s * r * sin(phi);
  let nh = p1 * t1 + p2 * t2 + sqrt(max(0.0, 1.0 - p1 * p1 - p2 * p2)) * vh;
  return normalize(vec3f(alpha * nh.x, alpha * nh.y, max(0.0, nh.z)));
}


/**
 * 像素的反射方向（世界空间）：按 GGX 的可见法线分布随机取（同一像素、同一帧总是同一个方向），取到朝表面里面的（掠射角）换成
 * 镜面方向。
 */
fn reflectionDirection(pixel: vec2u, frame: u32, n: vec3f, v: vec3f, roughness: f32) -> vec3f {
  // 切线空间：z 是法线
  let up = select(vec3f(0.0, 0.0, 1.0), vec3f(1.0, 0.0, 0.0), abs(n.z) > 0.999);
  let tx = normalize(cross(up, n));
  let ty = cross(n, tx);
  let alpha = max(roughness * roughness, 0.001);
  let vt = vec3f(dot(v, tx), dot(v, ty), dot(v, n));
  let h = sampleGgxVndf(vt, alpha, random2(pixel, frame));
  let r = reflect(-v, tx * h.x + ty * h.y + n * h.z);
  return select(r, reflect(-v, n), dot(r, n) <= 0.0);
}
`;
