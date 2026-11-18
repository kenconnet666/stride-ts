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
  out.position = vec4f(ndc, 1.0, 1.0);
  out.uv = vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
  out.ndc = ndc;
  return out;
}`;
