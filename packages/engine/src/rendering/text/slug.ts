/**
 * Slug 的覆盖率计算（WGSL），移植自 Eric Lengyel 的参考像素着色器（SlugPixelShader.hlsl，Copyright 2017 Eric Lengyel，
 * MIT 或 Apache-2.0，https://github.com/EricLengyel/Slug；算法见 JCGT 2017，专利 2026 年捐给了公有领域）。
 * 和参考实现的差别：曲线和带放在存储缓冲里（参考实现是两张 4096 宽的纹理），带的头是两个 u32（曲线数、相对字形的偏移），
 * 曲线表里存的是点的下标（相对字形），字形的这些起点从字形表里取。
 *
 * 每个像素向右打一条横的射线、向上打一条竖的射线，数轮廓曲线穿过多少次（按方向带符号），离交点不到半个像素的按距离给部分覆盖
 * （一维的抗锯齿），两条射线的结果按各自离边的距离加权合起来。横带里的曲线按最大 x 从大到小排，曲线整个在像素左边以后就不用
 * 再看了（竖带同理）。用的是非零环绕规则。
 *
 * 描边（slugDistance，我们加的）：采样点到轮廓的距离，看 radius 以内的带里的曲线。横带里没有横的直线（和带平行的不参与
 * 数穿越），所以再到竖带里找它们。每条曲线上最近的点用牛顿法找（从投到弦上的位置起步）：闭式解在接近直线的曲线上
 * 单精度不够用。
 */
/** Slug 的求根判别和横、竖两个方向的求交（纯函数，矢量贴图 rendering/mesh/vectorAtlas.ts 也用）。 */
export const SLUG_CURVE_WGSL = /* wgsl */ `
// 曲线的三个控制点（已经减去采样点）的 y（或 x）的符号决定哪个根有贡献：第 0 位是第一个根，第 8 位是第二个
fn slugRootCode(y1: f32, y2: f32, y3: f32) -> u32 {
  let i1 = bitcast<u32>(y1) >> 31u;
  let i2 = bitcast<u32>(y2) >> 30u;
  let i3 = bitcast<u32>(y3) >> 29u;
  var shift = (i2 & 2u) | (i1 & ~2u);
  shift = (i3 & 4u) | (shift & ~4u);
  return (0x2E74u >> shift) & 0x0101u;
}

// 曲线 C(t) = (1-t)^2 p1 + 2t(1-t) p2 + t^2 p3 穿过 y = 0 的两个 x（判别式小于 0 时取极小值处的重根）
fn slugSolveHorizontal(p12: vec4f, p3: vec2f) -> vec2f {
  let a = p12.xy - p12.zw * 2.0 + p3;
  let b = p12.xy - p12.zw;
  let d = sqrt(max(b.y * b.y - a.y * p12.y, 0.0));
  var t1 = p12.y * 0.5 / b.y;
  var t2 = t1;
  // 接近直线时解一次方程 -2b t + c = 0
  if (abs(a.y) >= 1.0 / 65536.0) {
    t1 = (b.y - d) / a.y;
    t2 = (b.y + d) / a.y;
  }
  return vec2f((a.x * t1 - b.x * 2.0) * t1 + p12.x, (a.x * t2 - b.x * 2.0) * t2 + p12.x);
}

// 穿过 x = 0 的两个 y
fn slugSolveVertical(p12: vec4f, p3: vec2f) -> vec2f {
  let a = p12.xy - p12.zw * 2.0 + p3;
  let b = p12.xy - p12.zw;
  let d = sqrt(max(b.x * b.x - a.x * p12.x, 0.0));
  var t1 = p12.x * 0.5 / b.x;
  var t2 = t1;
  if (abs(a.x) >= 1.0 / 65536.0) {
    t1 = (b.x - d) / a.x;
    t2 = (b.x + d) / a.x;
  }
  return vec2f((a.y * t1 - b.y * 2.0) * t1 + p12.y, (a.y * t2 - b.y * 2.0) * t2 + p12.y);
}
`;

export const SLUG_WGSL = /* wgsl */ `
${SLUG_CURVE_WGSL}
struct GlyphEntry {
  // 竖带、横带的缩放和偏移：em 坐标乘 xy 加 zw 得到带的下标
  bandTransform: vec4f,
  // 点的起点、带的起点、横带条数、竖带条数
  data: vec4u,
};
@group(1) @binding(0) var<storage, read> glyphTable: array<GlyphEntry>;
@group(1) @binding(1) var<storage, read> glyphPoints: array<vec2f>;
@group(1) @binding(2) var<storage, read> glyphBands: array<u32>;

// em 坐标 coord 处的覆盖率（0..1）。emsPerPixel 是 fwidth(coord)，要在均匀的控制流里算好传进来
fn slugCoverage(coord: vec2f, emsPerPixel: vec2f, glyph: u32) -> f32 {
  let entry = glyphTable[glyph];
  let pixelsPerEm = 1.0 / emsPerPixel;
  let pointBase = entry.data.x;
  let bandBase = entry.data.y;
  let bandMax = vec2i(i32(entry.data.w) - 1, i32(entry.data.z) - 1);
  let bandIndex = clamp(vec2i(coord * entry.bandTransform.xy + entry.bandTransform.zw), vec2i(0), bandMax);

  var xcov = 0.0;
  var xwgt = 0.0;
  let hband = bandBase + u32(bandIndex.y) * 2u;
  let hcount = glyphBands[hband];
  let hlist = bandBase + glyphBands[hband + 1u];
  for (var i = 0u; i < hcount; i++) {
    let p = pointBase + glyphBands[hlist + i];
    let p12 = vec4f(glyphPoints[p] - coord, glyphPoints[p + 1u] - coord);
    let p3 = glyphPoints[p + 2u] - coord;
    // 按最大 x 从大到小排：这条已经整个在像素左边，后面的也是
    if (max(max(p12.x, p12.z), p3.x) * pixelsPerEm.x < -0.5) {
      break;
    }
    let code = slugRootCode(p12.y, p12.w, p3.y);
    if (code != 0u) {
      let r = slugSolveHorizontal(p12, p3) * pixelsPerEm.x;
      if ((code & 1u) != 0u) {
        xcov += saturate(r.x + 0.5);
        xwgt = max(xwgt, saturate(1.0 - abs(r.x) * 2.0));
      }
      if (code > 1u) {
        xcov -= saturate(r.y + 0.5);
        xwgt = max(xwgt, saturate(1.0 - abs(r.y) * 2.0));
      }
    }
  }

  var ycov = 0.0;
  var ywgt = 0.0;
  let vband = bandBase + (entry.data.z + u32(bandIndex.x)) * 2u;
  let vcount = glyphBands[vband];
  let vlist = bandBase + glyphBands[vband + 1u];
  for (var i = 0u; i < vcount; i++) {
    let p = pointBase + glyphBands[vlist + i];
    let p12 = vec4f(glyphPoints[p] - coord, glyphPoints[p + 1u] - coord);
    let p3 = glyphPoints[p + 2u] - coord;
    if (max(max(p12.y, p12.w), p3.y) * pixelsPerEm.y < -0.5) {
      break;
    }
    let code = slugRootCode(p12.x, p12.z, p3.x);
    if (code != 0u) {
      let r = slugSolveVertical(p12, p3) * pixelsPerEm.y;
      if ((code & 1u) != 0u) {
        ycov -= saturate(r.x + 0.5);
        ywgt = max(ywgt, saturate(1.0 - abs(r.x) * 2.0));
      }
      if (code > 1u) {
        ycov += saturate(r.y + 0.5);
        ywgt = max(ywgt, saturate(1.0 - abs(r.y) * 2.0));
      }
    }
  }

  // 两条射线按各自离边的距离加权；绝对值让两种环绕方向都能用
  let coverage = max(abs(xcov * xwgt + ycov * ywgt) / max(xwgt + ywgt, 1.0 / 65536.0), min(abs(xcov), abs(ycov)));
  return saturate(coverage);
}

// 原点到曲线 C(t)（三个控制点已经减去采样点）的距离的平方
fn slugCurveDistanceSquared(p1: vec2f, p2: vec2f, p3: vec2f) -> f32 {
  let a = p1 - p2 * 2.0 + p3;
  let b = p2 - p1;
  let chord = p3 - p1;
  var t = saturate(-dot(p1, chord) / max(dot(chord, chord), 1e-12));
  for (var i = 0; i < 4; i++) {
    let point = (a * t + b * 2.0) * t + p1;
    let tangent = (a * t + b) * 2.0;
    let speed = dot(tangent, tangent);
    // 二阶导是负的地方（离曲率中心近）牛顿法会走向最远点，退回只用一阶项
    let curvature = speed + dot(point, a) * 2.0;
    t = saturate(t - dot(point, tangent) / max(select(speed, curvature, curvature > 0.0), 1e-12));
  }
  let point = (a * t + b * 2.0) * t + p1;
  return min(dot(point, point), min(dot(p1, p1), dot(p3, p3)));
}

// em 坐标 coord 处到字形轮廓的距离（em）；radius 以内没有轮廓时返回比 radius 大的数
fn slugDistance(coord: vec2f, radius: f32, glyph: u32) -> f32 {
  let entry = glyphTable[glyph];
  let pointBase = entry.data.x;
  let bandBase = entry.data.y;
  let bandMax = vec2i(i32(entry.data.w) - 1, i32(entry.data.z) - 1);
  let lo = clamp(vec2i((coord - radius) * entry.bandTransform.xy + entry.bandTransform.zw), vec2i(0), bandMax);
  let hi = clamp(vec2i((coord + radius) * entry.bandTransform.xy + entry.bandTransform.zw), vec2i(0), bandMax);
  var best = radius * radius * 4.0;

  for (var band = lo.y; band <= hi.y; band++) {
    let head = bandBase + u32(band) * 2u;
    let count = glyphBands[head];
    let list = bandBase + glyphBands[head + 1u];
    for (var i = 0u; i < count; i++) {
      let p = pointBase + glyphBands[list + i];
      let p1 = glyphPoints[p] - coord;
      let p2 = glyphPoints[p + 1u] - coord;
      let p3 = glyphPoints[p + 2u] - coord;
      let high = max(max(p1, p2), p3);
      // 按最大 x 从大到小排：这条整个在 radius 以外的左边，后面的也是
      if (high.x < -radius) {
        break;
      }
      let low = min(min(p1, p2), p3);
      if (low.x > radius || low.y > radius || high.y < -radius) {
        continue;
      }
      best = min(best, slugCurveDistanceSquared(p1, p2, p3));
    }
  }

  for (var band = lo.x; band <= hi.x; band++) {
    let head = bandBase + (entry.data.z + u32(band)) * 2u;
    let count = glyphBands[head];
    let list = bandBase + glyphBands[head + 1u];
    for (var i = 0u; i < count; i++) {
      let p = pointBase + glyphBands[list + i];
      let p1 = glyphPoints[p] - coord;
      let p2 = glyphPoints[p + 1u] - coord;
      let p3 = glyphPoints[p + 2u] - coord;
      // 按最大 y 从大到小排
      if (max(max(p1.y, p2.y), p3.y) < -radius) {
        break;
      }
      // 只要横的直线，别的曲线横带里看过了
      if (p1.y != p2.y || p2.y != p3.y || abs(p1.y) > radius) {
        continue;
      }
      let x = clamp(0.0, min(p1.x, p3.x), max(p1.x, p3.x));
      best = min(best, x * x + p1.y * p1.y);
    }
  }
  return sqrt(best);
}
`;
