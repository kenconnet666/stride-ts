/** 着色器共用的立方体贴图的面（WGSL 片段）。 */

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
