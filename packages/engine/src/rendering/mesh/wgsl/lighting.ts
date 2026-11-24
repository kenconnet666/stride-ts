/** 网格着色器的光照函数：着色用的法线、反射探针、天空盒的球谐、方向光和局部光的阴影（PCF、PCSS、级联）、透射、微表面的各项（GGX、Beckmann、光泽、各向异性）、薄玻璃。 */
import { GRADIENT_NOISE, HASH3, RAIN_RIPPLES } from '../../wgsl';

export const MESH_LIGHTING = /* wgsl */ `
/**
 * 着色用的法线：有法线贴图、网格有切线时按切线空间的法线算（Stride 的 MaterialSurfaceNormalMap 加 UpdateNormalFromTangentSpace），
 * 否则是顶点法线。贴图总是采样（没有时绑白图），用 select 挑结果：采样必须在一致的控制流里。
 */
fn surfaceNormal(in: Varyings, coatPass: bool) -> vec3f {
  let n = normalize(in.normal);
  let flags = material.normalFlags;
  var m = vec3f(0.0, 0.0, 1.0);
  if ((flags & 1u) != 0u) {
    m = textureSample(normalTexture, normalSampler, in.uv * material.normalUvTransform.xy + material.normalUvTransform.zw).xyz;
    m.y = select(m.y, 1.0 - m.y, (flags & 4u) != 0u);
    m = select(m, 2.0 * m - 1.0, (flags & 2u) != 0u);
    m.z = select(m.z, sqrt(max(0.0, 1.0 - (m.x * m.x + m.y * m.y))), (flags & 8u) != 0u);
  }
  // 法线树（材质的颜色树，已经换好）优先于法线贴图
  let tree = treeNormal(in);
  m = select(m, tree.xyz, tree.w > 0.5);
  // 材质层的法线按遮罩混进来（没有法线贴图时底下是 (0, 0, 1)）
  let hasBase = (flags & 1u) != 0u || tree.w > 0.5;
  let layered = layerNormal(in, select(vec3f(0.0, 0.0, 1.0), m, hasBase));
  m = select(m, layered.xyz, layered.w > 0.5);
  // 清漆：底下一遍用金属碎片的法线，清漆那一遍用橘皮的法线
  let coat = coatNormal(in, coatPass);
  m = select(m, coat.xyz, coat.w > 0.5);
  let tangentLength = length(in.tangent.xyz);
  // 没有切线的网格（白盒、程序生成的形状）：按位置和 UV 的屏幕空间导数现算切线框架（Schüler 2013，"Normal Mapping Without
  // Precomputed Tangents"），T、B 是位置沿 U、V 的方向。和 Stride 不同：Stride 的法线贴图要求网格带切线。导数在分支外算
  let dp1 = dpdx(in.world);
  let dp2 = dpdy(in.world);
  let duv1 = dpdx(in.uv);
  let duv2 = dpdy(in.uv);
  let dp2perp = cross(dp2, n);
  let dp1perp = cross(n, dp1);
  let ct = dp2perp * duv1.x + dp1perp * duv2.x;
  let cb = dp2perp * duv1.y + dp1perp * duv2.y;
  let frameScale = inverseSqrt(max(max(dot(ct, ct), dot(cb, cb)), 1e-20));
  let hasTangent = tangentLength > 0.0;
  let t = select(ct * frameScale, in.tangent.xyz / max(tangentLength, 1e-8), hasTangent);
  let b = select(cb * frameScale, in.tangent.w * cross(n, t), hasTangent);
  let mapped = normalize(m.x * t + m.y * b + m.z * n);
  return select(n, mapped, hasBase || layered.w > 0.5 || coat.w > 0.5);
}

/**
 * 反射探针的环境镜面反射（ReflectionProbes.ts）：rgb 是各探针按权重加起来的光（已乘强度），a 是探针盖住的比例。探针按盒子从小到大
 * 排，前面的先占：权重是到盒子的面的距离 / 过渡距离（盒子外是 0），乘还没被占的比例。视差校正：反射光线从这里出发打到盒子的
 * 内壁，用拍的位置到那一点的方向取（Lagarde 2012 的 box projection）。粗糙度 i / (级数 - 1) 在第 i 级。
 */
fn probeSpecular(position: vec3f, r: vec3f, roughness: f32, cluster: i32) -> vec4f {
  var sum = vec3f(0.0);
  var weight = 0.0;
  let maxLevel = f32(textureNumLevels(probeCubes) - 1u);
  // 分了簇时只看这一簇的探针（在这一簇的光、贴花后面，下标从小到大：小的盒子先占）
  let clustered = cluster >= 0;
  var count = u32(view.locals.w);
  var first = 0u;
  if (clustered) {
    let counts = clusterCounts(cluster);
    count = clusters[u32(cluster) + 2u];
    first = clusters[u32(cluster)] + counts.x + counts.y;
  }
  for (var k = 0u; k < count; k++) {
    let i = select(k, clusters[first + k], clustered);
    let p = probes[i];
    let inside = min(position - p.boxMin.xyz, p.boxMax.xyz - position);
    let distance = min(min(inside.x, inside.y), inside.z);
    if (distance <= 0.0) {
      continue;
    }
    let w = select(1.0, saturate(distance / p.boxMin.w), p.boxMin.w > 0.0) * (1.0 - weight);
    var direction = r;
    if (p.options.x > 0.5) {
      let far = max((p.boxMax.xyz - position) / r, (p.boxMin.xyz - position) / r);
      direction = position + r * min(min(far.x, far.y), far.z) - p.center.xyz;
    }
    sum += w * p.boxMax.w * textureSampleLevel(probeCubes, linearClamp, direction, i32(p.center.w), roughness * maxLevel).rgb;
    weight += w;
    if (weight >= 0.999) {
      break;
    }
  }
  return vec4f(sum, weight);
}

/** 世界方向转到天空盒的立方体贴图里：按天空盒的旋转转回去（行向量乘矩阵 = 乘转置），z 取反。 */
fn skyDirection(direction: vec3f) -> vec3f {
  let rotation = mat3x3f(view.skyRotation[0].xyz, view.skyRotation[1].xyz, view.skyRotation[2].xyz);
  let d = direction * rotation;
  return vec3f(d.xy, -d.z);
}

/** 3 阶球谐求值，同 Stride 的 EvaluateSphericalHarmonics（系数已乘过基函数常数）。 */
fn evaluateSH(d: vec3f) -> vec3f {
  var color = view.skySH[0].rgb;
  color += view.skySH[1].rgb * d.y;
  color += view.skySH[2].rgb * d.z;
  color += view.skySH[3].rgb * d.x;
  color += view.skySH[4].rgb * d.y * d.x;
  color += view.skySH[5].rgb * d.y * d.z;
  color += view.skySH[6].rgb * (3.0 * d.z * d.z - 1.0);
  color += view.skySH[7].rgb * d.x * d.z;
  color += view.skySH[8].rgb * (d.x * d.x - d.y * d.y);
  return color;
}

/** 图集里一次双线性的比较采样，乘权重；offset 以像素为单位，相对 PCF 的基准像素。 */
fn pcfTap(base: vec2f, offset: vec2f, weight: f32, depth: f32) -> f32 {
  return weight * textureSampleCompareLevel(shadowAtlas, shadowComparison, base + offset * view.shadowAtlas.x, depth);
}

// PCF 的一行：x 方向的偏移和权重按分量写开（不用动态下标，编译器才能把采样都放在寄存器里）
fn pcfRow2(base: vec2f, ox: vec2f, wx: vec2f, oy: f32, wy: f32, depth: f32) -> f32 {
  return wy * (pcfTap(base, vec2f(ox.x, oy), wx.x, depth) + pcfTap(base, vec2f(ox.y, oy), wx.y, depth));
}
fn pcfRow3(base: vec2f, ox: vec3f, wx: vec3f, oy: f32, wy: f32, depth: f32) -> f32 {
  return wy * (pcfTap(base, vec2f(ox.x, oy), wx.x, depth) + pcfTap(base, vec2f(ox.y, oy), wx.y, depth) + pcfTap(base, vec2f(ox.z, oy), wx.z, depth));
}
fn pcfRow4(base: vec2f, ox: vec4f, wx: vec4f, oy: f32, wy: f32, depth: f32) -> f32 {
  return wy * (pcfTap(base, vec2f(ox.x, oy), wx.x, depth) + pcfTap(base, vec2f(ox.y, oy), wx.y, depth)
    + pcfTap(base, vec2f(ox.z, oy), wx.z, depth) + pcfTap(base, vec2f(ox.w, oy), wx.w, depth));
}

// Stride 的 ShadowMapFilterPcf：3x3、5x5、7x7 的核分别用 2x2、3x3、4x4 次双线性比较采样，权重的和是 16、144、2704。
// Stride 的核大小是编译期常量、循环 [unroll]；这里按核大小分三个函数全部展开（运行时的动态循环加动态下标，
// TPP 的不透明通道慢了约 1.9 ms）
fn pcf3(base: vec2f, st: vec2f, depth: f32) -> f32 {
  let w0 = 3.0 - 2.0 * st;
  let w1 = 1.0 + 2.0 * st;
  let o0 = (2.0 - st) / w0 - 1.0;
  let o1 = st / w1 + 1.0;
  let ox = vec2f(o0.x, o1.x);
  let wx = vec2f(w0.x, w1.x);
  return (pcfRow2(base, ox, wx, o0.y, w0.y, depth) + pcfRow2(base, ox, wx, o1.y, w1.y, depth)) / 16.0;
}

fn pcf5(base: vec2f, st: vec2f, depth: f32) -> f32 {
  let w0 = 4.0 - 3.0 * st;
  let w1 = vec2f(7.0);
  let w2 = 1.0 + 3.0 * st;
  let o0 = (3.0 - 2.0 * st) / w0 - 2.0;
  let o1 = (3.0 + st) / w1;
  let o2 = st / w2 + 2.0;
  let ox = vec3f(o0.x, o1.x, o2.x);
  let wx = vec3f(w0.x, w1.x, w2.x);
  return (pcfRow3(base, ox, wx, o0.y, w0.y, depth) + pcfRow3(base, ox, wx, o1.y, w1.y, depth) + pcfRow3(base, ox, wx, o2.y, w2.y, depth)) / 144.0;
}

fn pcf7(base: vec2f, st: vec2f, depth: f32) -> f32 {
  let w0 = 5.0 * st - 6.0;
  let w1 = 11.0 * st - 28.0;
  let w2 = -(11.0 * st + 17.0);
  let w3 = -(5.0 * st + 1.0);
  let o0 = (4.0 * st - 5.0) / w0 - 3.0;
  let o1 = (4.0 * st - 16.0) / w1 - 1.0;
  let o2 = -(7.0 * st + 5.0) / w2 + 1.0;
  let o3 = -st / w3 + 3.0;
  let ox = vec4f(o0.x, o1.x, o2.x, o3.x);
  let wx = vec4f(w0.x, w1.x, w2.x, w3.x);
  return (pcfRow4(base, ox, wx, o0.y, w0.y, depth) + pcfRow4(base, ox, wx, o1.y, w1.y, depth)
    + pcfRow4(base, ox, wx, o2.y, w2.y, depth) + pcfRow4(base, ox, wx, o3.y, w3.y, depth)) / 2704.0;
}

/** 图集里 position 处的阴影（1 是亮）：一次双线性的比较采样，或者 PCF（Stride 的 CalculatePCFKernelParameters）。 */
fn filterShadow(position: vec2f, depth: f32, size: u32) -> f32 {
  if (size == 0u) {
    return textureSampleCompareLevel(shadowAtlas, shadowComparison, position, depth);
  }
  let uv = position * view.shadowAtlas.y;
  let rounded = floor(uv + 0.5);
  let st = uv + 0.5 - rounded;
  let base = (rounded - 0.5) * view.shadowAtlas.x;
  if (size == 3u) {
    return pcf3(base, st, depth);
  }
  if (size == 5u) {
    return pcf5(base, st, depth);
  }
  return pcf7(base, st, depth);
}

fn shadowFromCascade(position: vec3f, cascade: u32, pixel: vec2f) -> f32 {
  let m = view.shadowMatrices[cascade];
  var p = m * vec4f(position, 1.0);
  p.z -= view.shadow.y;
  let s = p.xyz / p.w;
  let filterKind = u32(view.shadow.w);
  if (filterKind == 1u) {
    return pcssShadow(s, cascadeScale(m), view.lightDirections[u32(view.sky.w)].w, pixel);
  }
  return filterShadow(s.xy, s.z, filterKind);
}

/** 级联的矩阵（正交投影）把一个世界单位换成多少图集 UV（x）、多少深度（y）：前三列里那一行的长度。 */
fn cascadeScale(m: mat4x4f) -> vec2f {
  return vec2f(length(vec3f(m[0].x, m[1].x, m[2].x)), length(vec3f(m[0].z, m[1].z, m[2].z)));
}

/** Vogel 圆盘上 count 个点的第 i 个（单位圆里均匀铺开），整体转 angle。 */
fn vogelDisk(i: u32, count: u32, angle: f32) -> vec2f {
  let r = sqrt((f32(i) + 0.5) / f32(count));
  let theta = f32(i) * 2.39996323 + angle;
  return r * vec2f(cos(theta), sin(theta));
}

${GRADIENT_NOISE}
${HASH3}
${RAIN_RIPPLES}

const PCSS_BLOCKER_TAPS = 16u;
const PCSS_FILTER_TAPS = 16u;
/** 半影最大多少个图集像素（搜遮挡物的范围也到这里为止）。 */
const PCSS_MAX_TEXELS = 24.0;

/**
 * 接触硬化的软阴影（PCSS，Fernando 2005）：方向光有角大小，半影的半径 = 遮挡物到这里的距离 × tan(角半径)，所以影子在
 * 接触处硬、离得越远越软。s 是这个像素在图集里的位置和深度，scale 是 cascadeScale，tangent 是角半径的正切。
 * 1. 按遮挡物最远可能在的地方（级联的近平面）定搜的范围，找比这里离光近的深度，取平均；没有遮挡物就是亮的；
 * 2. 按平均的距离算半影，在这么大的圆盘里做比较采样（至少 1.5 个像素，接触处也不出锯齿）。
 * 和 Babylon 不同：方向光的半影直接按深度差和角大小算（不除深度、没有经验系数）。采样点按像素的噪声转，噪声留给 TAA 和画面的模糊。
 */
fn pcssShadow(s: vec3f, scale: vec2f, tangent: f32, pixel: vec2f) -> f32 {
  let texel = view.shadowAtlas.x;
  let angle = gradientNoise(pixel) * 6.28318531;
  let toUv = tangent * scale.x / scale.y;
  let searchRadius = clamp(s.z * toUv, texel, PCSS_MAX_TEXELS * texel);
  var blockers = 0.0;
  var blockerDepth = 0.0;
  let last = vec2i(i32(view.shadowAtlas.y) - 1);
  for (var i = 0u; i < PCSS_BLOCKER_TAPS; i++) {
    let uv = s.xy + vogelDisk(i, PCSS_BLOCKER_TAPS, angle) * searchRadius;
    let d = textureLoad(shadowAtlas, clamp(vec2i(uv * view.shadowAtlas.y), vec2i(0), last), 0);
    if (d < s.z) {
      blockers += 1.0;
      blockerDepth += d;
    }
  }
  if (blockers == 0.0) {
    return 1.0;
  }
  let penumbra = clamp((s.z - blockerDepth / blockers) * toUv, 1.5 * texel, PCSS_MAX_TEXELS * texel);
  var lit = 0.0;
  for (var i = 0u; i < PCSS_FILTER_TAPS; i++) {
    lit += textureSampleCompareLevel(shadowAtlas, shadowComparison, s.xy + vogelDisk(i, PCSS_FILTER_TAPS, angle) * penumbra, s.z);
  }
  return lit / f32(PCSS_FILTER_TAPS);
}

/**
 * 点光、聚光的阴影（Stride 的 ShadowMapReceiverPointCubeMap、ShadowMapReceiverSpot 的 ComputeShadow）。index 是阴影的下标
 * （光的 direction.w），lightPosition 是光源的位置。
 */
fn computeLocalShadow(index: u32, position: vec3f, normal: vec3f, nDotL: f32, lightPosition: vec3f) -> f32 {
  let start = localShadowStart(index);
  // 法线偏移：按图集的像素大小和 1 - N·L 沿法线推出去（点光选面、算深度用没偏移过的位置）
  let p = position + 2.0 * SHADOW_OFFSET_TEXEL * localShadowParams(start).y * saturate(1.0 - nDotL) * normal;
  let coord = localShadowCoord(start, p, position, lightPosition);
  if (coord.w == 0.0) {
    return 1.0;
  }
  return filterShadow(coord.xy, coord.z, u32(localShadowOptions(start).x));
}

/** 面光源的软阴影：搜遮挡物、滤波各几个采样点。 */
const AREA_BLOCKER_TAPS = 8u;
const AREA_FILTER_TAPS = 24u;
/** 搜遮挡物时假定它们离灯不近于接收点距离的这个比例（搜的范围是发光面的 1 / 比例 − 1 倍）。 */
const AREA_SEARCH_NEAR = 0.4;
const CUBE_AXES = array<vec3f, 6>(vec3f(0.0, 0.0, 1.0), vec3f(0.0, 0.0, -1.0), vec3f(1.0, 0.0, 0.0), vec3f(-1.0, 0.0, 0.0), vec3f(0.0, 1.0, 0.0), vec3f(0.0, -1.0, 0.0));

/** 接收点 q（投影过、没除 w）沿发光面的两条半轴各挪 o.x、o.y 倍（d1、d2 是两条半轴投影过的）在图集上的位置。 */
fn areaShadowUv(q: vec4f, d1: vec4f, d2: vec4f, o: vec2f) -> vec2f {
  let p = q + d1 * o.x + d2 * o.y;
  return p.xy / p.w;
}

/**
 * 面光源（矩形、圆盘、管子）的软阴影：阴影图是光源中心的立方体（同点光，缓存着），半影按发光面的大小算（PCSS，Fernando 2005）。
 * 发光面上的点 a（两条半轴的组合）被离灯 zb 远的遮挡物挡住时，遮挡物在图上的位置相当于接收点沿 a 挪 (zr − zb) / zb 倍——
 * 采样点铺在发光面的形状上（长条灯管的半影沿管子长），经这一面的矩阵准确投到图上（各面、透视都对）。
 * 1. 搜遮挡物：遮挡物不近于接收距离的 AREA_SEARCH_NEAR 倍，范围是发光面的 1 / 比例 − 1 倍；比这里离灯近的取平均距离；
 * 2. 按平均距离的倍数铺采样点做比较采样，至少 1.5 个图集像素（接触处不出锯齿）。
 * 采样点固定、不随帧转（确定的着色，不靠降噪，docs/realtime.md），都限在这一面的块里。
 */
fn computeAreaShadow(index: u32, position: vec3f, normal: vec3f, light: LocalLight, kind: u32) -> f32 {
  let start = localShadowStart(index);
  let params = localShadowParams(start);
  let lightPosition = light.position.xyz;
  let nDotL = max(dot(normal, normalize(lightPosition - position)), 0.0001);
  let p = position + 2.0 * SHADOW_OFFSET_TEXEL * params.y * saturate(1.0 - nDotL) * normal;
  let face = localShadowFace(position - lightPosition);
  let receiverDepth = params.z + params.w / (face.y - params.x);
  if (receiverDepth < 0.0 || receiverDepth > 1.0) {
    return 1.0;
  }
  let m = localShadowMatrix(start, face.x);
  // 发光面的两条半轴：矩形的半宽、半高，圆盘两条都是半径，管子只有半长
  let a1 = light.angle.xyz;
  let a2 = select(normalize(cross(light.direction.xyz, a1)) * light.angle.w, vec3f(0.0), kind == 4u);
  let q = m * vec4f(p, 1.0);
  let d1 = m * vec4f(a1, 0.0);
  let d2 = m * vec4f(a2, 0.0);
  let texel = view.shadowAtlas.x;
  // 这一面的块：中心是光源沿这一面的轴的投影，半边长在选项里
  let c = m * vec4f(lightPosition + CUBE_AXES[face.x], 1.0);
  let half = vec2f(localShadowOptions(start).z - texel);
  let lo = c.xy / c.w - half;
  let hi = c.xy / c.w + half;
  let last = vec2i(i32(view.shadowAtlas.y) - 1);
  var blockers = 0.0;
  var blockerDistance = 0.0;
  for (var i = 0u; i < AREA_BLOCKER_TAPS; i++) {
    let uv = clamp(areaShadowUv(q, d1, d2, vogelDisk(i, AREA_BLOCKER_TAPS, 0.0) * (1.0 / AREA_SEARCH_NEAR - 1.0)), lo, hi);
    let d = textureLoad(shadowAtlas, clamp(vec2i(uv * view.shadowAtlas.y), vec2i(0), last), 0);
    if (d < receiverDepth) {
      blockers += 1.0;
      blockerDistance += params.w / max(d - params.z, 1e-6);
    }
  }
  if (blockers == 0.0) {
    return 1.0;
  }
  let zb = blockerDistance / blockers;
  let k = max(face.y - zb, 0.0) / max(zb, 1e-3);
  var lit = 0.0;
  for (var i = 0u; i < AREA_FILTER_TAPS; i++) {
    let o = vogelDisk(i, AREA_FILTER_TAPS, 0.0);
    let uv = clamp(areaShadowUv(q, d1, d2, o * k) + o * (1.5 * texel), lo, hi);
    lit += textureSampleCompareLevel(shadowAtlas, shadowComparison, uv, receiverDepth);
  }
  return lit / f32(AREA_FILTER_TAPS);
}

const CASCADE_INDICES = vec4u(0u, 1u, 2u, 3u);

/**
 * v 的第 i 个分量。不写 v[i]：动态下标取 uniform 里 vec4 的分量时，DXC 先把整行存进局部数组再按下标读
 * （DXIL 里的 alloca），像素着色器里很慢。
 */
fn component(v: vec4f, i: u32) -> f32 {
  return dot(v, select(vec4f(0.0), vec4f(1.0), CASCADE_INDICES == vec4u(i)));
}

/** 深度 depth 处用哪个级联：前 count - 1 个分界里深度超过了几个（分界递增，同 Stride 逐个比较取最后一个超过的）。 */
fn shadowCascade(depth: f32, count: u32) -> u32 {
  let passed = select(vec4f(0.0), vec4f(1.0), (vec4f(depth) > view.shadowSplits) & (CASCADE_INDICES + 1u < vec4u(count)));
  return u32(dot(passed, vec4f(1.0)));
}


// 阴影的法线偏移、厚度那几处按世界单位挪的量，用的"图集一个像素"是 Stride 固定的 4096² 图集的（它的
// ShadowMapTextureTexelSize 是整个图集的）：我们的图集按用到的大小建（1024² 到 4096²），按实际的算的话图集小了偏移就大了，
// 物体自己身上的影子变淡（CSharpBeginner 的茶壶）。采样时挪的步子还是按实际的图集算。
const SHADOW_OFFSET_TEXEL = 1.0 / 4096.0;

/** 方向光的阴影（Stride 的 ShadowMapReceiverDirectional.ComputeShadow）。 */
fn computeShadow(position: vec3f, normal: vec3f, nDotL: f32, depth: f32, pixel: vec2f) -> f32 {
  let count = u32(view.shadow.x);
  if (count == 0u) {
    return 1.0;
  }
  let splits = view.shadowSplits;
  let cascade = shadowCascade(depth, count);
  // 法线偏移：按图集的像素大小和 1 - N·L 沿法线推出去
  let p = position + 2.0 * SHADOW_OFFSET_TEXEL * view.shadow.z * saturate(1.0 - nDotL) * normal;
  var shadow = shadowFromCascade(p, cascade, pixel);
  let nextSplit = component(splits, cascade);
  var splitSize = nextSplit;
  if (cascade > 0u) {
    splitSize = nextSplit - component(splits, cascade - 1u);
  }
  let splitDistance = (nextSplit - depth) / splitSize;
  if (splitDistance < 0.2) {
    let amount = smoothstep(0.0, 0.2, splitDistance);
    if (cascade == count - 1u) {
      // 最后一个级联的末尾：手动深度范围时淡出，自动时不淡出
      if (view.shadowAtlas.w == 0.0) {
        shadow = mix(1.0, shadow, amount);
      }
    } else if (view.shadowAtlas.z != 0.0) {
      shadow = mix(shadowFromCascade(p, cascade + 1u, pixel), shadow, amount);
    }
  }
  return shadow;
}

/** 图集里 uv 处存的深度，四个像素双线性（深度图不能用普通的采样器过滤）。 */
fn shadowDepthAt(uv: vec2f) -> f32 {
  let texel = uv * view.shadowAtlas.y - 0.5;
  let base = vec2i(floor(texel));
  let w = fract(texel);
  let last = vec2i(i32(view.shadowAtlas.y) - 1);
  let d00 = textureLoad(shadowAtlas, clamp(base, vec2i(0), last), 0);
  let d10 = textureLoad(shadowAtlas, clamp(base + vec2i(1, 0), vec2i(0), last), 0);
  let d01 = textureLoad(shadowAtlas, clamp(base + vec2i(0, 1), vec2i(0), last), 0);
  let d11 = textureLoad(shadowAtlas, clamp(base + vec2i(1, 1), vec2i(0), last), 0);
  return mix(mix(d00, d10, w.x), mix(d01, d11, w.x), w.y);
}

/**
 * 方向光穿过这个像素所在物体的厚度（世界单位；Stride 的 ShadowMapFilterBase.SampleThickness）：阴影图里离光最近的表面到这里的
 * 距离。先往表面里缩 1.5 个阴影图像素的对角线，避开表面自己（同 Stride 的 CalculateAdjustedShadowSpacePixelPosition）。
 */
fn shadowThickness(position: vec3f, normal: vec3f, depth: f32) -> f32 {
  let m = view.shadowMatrices[shadowCascade(depth, u32(view.shadow.x))];
  let scale = cascadeScale(m);
  let uvPerUnit = scale.x;
  let depthPerUnit = scale.y;
  // 1.5 · √2 个像素
  let p = position - normal * (2.1213 * SHADOW_OFFSET_TEXEL / uvPerUnit);
  let s = m * vec4f(p, 1.0);
  let q = s.xyz / s.w;
  return max(q.z - shadowDepthAt(q.xy), 0.0) / depthPerUnit;
}

/** 皮肤的透射轮廓（Stride 的 MaterialSubsurfaceScatteringScatteringProfileSkin，取自 Jimenez 的 separable-sss）；dd 是 -d²。 */
fn skinTransmittanceProfile(dd: f32) -> vec3f {
  return vec3f(0.233, 0.455, 0.649) * exp(dd / 0.0064) + vec3f(0.1, 0.336, 0.344) * exp(dd / 0.0484)
    + vec3f(0.118, 0.198, 0.0) * exp(dd / 0.187) + vec3f(0.113, 0.007, 0.007) * exp(dd / 0.567)
    + vec3f(0.358, 0.004, 0.0) * exp(dd / 1.99) + vec3f(0.078, 0.0, 0.0) * exp(dd / 7.41);
}

/**
 * 次表面散射材质的透射（Stride 的 MaterialSurfaceSubsurfaceScatteringShading.CalculateTransmittance）：光从背面穿过薄的地方
 * （耳朵、鼻翼、手指）透出来。thickness 是 shadowThickness 算的厚度，lightColor 不乘阴影（挡住光的正是物体自己）。
 * 加进直射光的漫反射，和它一起被乘 π、被屏幕空间的散射模糊。
 */
fn transmittance(thickness: f32, n: vec3f, l: vec3f, lightColor: vec3f, albedo: vec3f) -> vec3f {
  let scale = 8.25 * (1.0 - material.subsurface.y) / max(material.subsurface.z, 0.0001);
  let d = scale * thickness;
  return skinTransmittanceProfile(-d * d) * saturate(0.3 + dot(l, -n)) * lightColor * albedo;
}

/**
 * 一个像素上着色要用的表面属性。光泽：颜色（全 0 是没有）、alpha、底下那层剩下的比例（直射光、环境光都乘）；各向异性：强度
 * （0 是没有）、切线和副切线（世界，已经按材质转过）。
 */
struct Surface {
  n: vec3f, v: vec3f, diffuse: vec3f, specular: vec3f, hasSpecular: bool, glass: bool, alphaR: f32, nDotV: f32,
  sheenColor: vec3f, sheenAlpha: f32, sheenScaling: f32, anisotropy: f32, t: vec3f, b: vec3f, microfacet: u32,
  // 清漆层（材质的 coat，或者湿的时候的水膜）：比例（0 是没有）、粗糙度的平方
  coat: f32, coatAlpha: f32,
};

/**
 * 微表面模型的分布项（Stride 的 MaterialSpecularMicrofacetNormalDistribution*，公式同 BRDFMicrofacet.sdsl）：
 * kind 0 GGX、1 Beckmann、2 Blinn-Phong。
 */
fn microfacetDistribution(kind: u32, alphaR: f32, nDotH: f32) -> f32 {
  if (kind == 0u) {
    return normalDistributionGGX(alphaR, nDotH);
  }
  // Beckmann、Blinn-Phong 的 alpha² 有下限，免得指数太大
  let alphaR2 = max(alphaR * alphaR, 0.1);
  if (kind == 1u) {
    let nDotH2 = max(nDotH * nDotH, 0.0001);
    return exp((nDotH2 - 1.0) / (alphaR2 * nDotH2)) / (PI * alphaR2 * nDotH2 * nDotH2);
  }
  return pow(max(nDotH, 0.00001), 2.0 / alphaR2 - 2.0) / (PI * alphaR2);
}

/** Smith-Beckmann 的单向项（Walter 2007 的有理近似）。和 Stride 不同：Stride 的分母写成了 2577·c²（应为 2.577·c²）。 */
fn visibilityBeckmann(alphaR: f32, nDotX: f32) -> f32 {
  let c = nDotX / (alphaR * sqrt(max(1.0 - nDotX * nDotX, 1e-8)));
  return select(1.0, (3.535 * c + 2.181 * c * c) / (1.0 + 2.276 * c + 2.577 * c * c), c < 1.6);
}

fn visibilityGGXCorrelated(alphaR: f32, nDotX: f32) -> f32 {
  let nDotX2 = nDotX * nDotX;
  return sqrt(1.0 + alphaR * alphaR * (1.0 - nDotX2) / nDotX2);
}

fn visibilitySchlickBeckmann(alphaR: f32, nDotX: f32) -> f32 {
  let k = alphaR * sqrt(2.0 / PI);
  return nDotX / (nDotX * (1.0 - k) + k);
}

/**
 * 微表面模型的可见性项 V = G / (N·L · N·V)（Stride 的 MaterialSpecularMicrofacetVisibility*）：kind 0 Smith-Schlick-GGX、
 * 1 隐式、2 Neumann、3 Cook-Torrance、4 Kelemen、5 Smith-Beckmann、6 相关的 Smith-GGX、7 Smith-Schlick-Beckmann。
 * V·H 有下限（和 Stride 不同：Stride 在 V·H 是 0 时除出无穷大）。
 */
fn microfacetVisibility(kind: u32, alphaR: f32, nDotL: f32, nDotV: f32, nDotH: f32, vDotH: f32) -> f32 {
  let vh = max(vDotH, 0.0001);
  switch (kind) {
    case 1u: { return 1.0; }
    case 2u: { return 1.0 / max(nDotL, nDotV); }
    case 3u: { return min(1.0, min(2.0 * nDotH * nDotV / vh, 2.0 * nDotH * nDotL / vh)) / (nDotL * nDotV); }
    case 4u: { return 1.0 / (vh * vh); }
    case 5u: { return visibilityBeckmann(alphaR, nDotL) * visibilityBeckmann(alphaR, nDotV) / (nDotL * nDotV); }
    case 6u: { return 2.0 / (visibilityGGXCorrelated(alphaR, nDotL) + visibilityGGXCorrelated(alphaR, nDotV)) / (nDotL * nDotV); }
    case 7u: { return visibilitySchlickBeckmann(alphaR, nDotL) * visibilitySchlickBeckmann(alphaR, nDotV) / (nDotL * nDotV); }
    default: { return visibilitySmithSchlickGGX(alphaR, nDotL, nDotV); }
  }
}

/** 环境光镜面系数的多项式近似（Stride 的 MaterialSpecularMicrofacetEnvironmentGGXPolynomial，Lazarov 2013 的拟合）。 */
fn environmentDfgPolynomial(specularColor: vec3f, alphaR: f32, nDotV: f32) -> vec3f {
  let x = 1.0 - alphaR;
  let y = nDotV;
  var bias = saturate(min(-0.1688 * x + 1.895 * x * x, 0.9903 - 4.853 * y + 8.404 * y * y - 5.069 * y * y * y));
  let delta = saturate(0.6045 + 1.699 * x - 0.5228 * y - 3.603 * x * x + 1.404 * x * y + 0.1939 * y * y + 2.661 * x * x * x);
  let scale = delta - bias;
  bias *= saturate(50.0 * specularColor.y);
  return specularColor * scale + bias;
}

/** 光泽的分布（Estevez、Kulla 2017 的 Charlie，Filament 的 D_Charlie）：alpha 是光泽粗糙度的平方。 */
fn distributionCharlie(alpha: f32, nDotH: f32) -> f32 {
  let invAlpha = 1.0 / alpha;
  let sin2h = max(1.0 - nDotH * nDotH, 0.0078125);
  return (2.0 + invAlpha) * pow(sin2h, invAlpha * 0.5) / (2.0 * PI);
}

/** 光泽的可见性（Neubelt、Pettineo 2013，Filament 的 V_Neubelt）：已经除以 4 · N·L · N·V。 */
fn visibilityNeubelt(nDotV: f32, nDotL: f32) -> f32 {
  return saturate(1.0 / (4.0 * (nDotL + nDotV - nDotL * nDotV)));
}

/** 各向异性的 GGX 分布（Filament 的 D_GGX_Anisotropic）：at、ab 是切线、副切线方向的 alpha。 */
fn distributionGGXAnisotropic(at: f32, ab: f32, tDotH: f32, bDotH: f32, nDotH: f32) -> f32 {
  let a2 = at * ab;
  let d = vec3f(ab * tDotH, at * bDotH, a2 * nDotH);
  let b2 = a2 / dot(d, d);
  return a2 * b2 * b2 / PI;
}

/** 各向异性的相关 Smith 可见性（Heitz 2014，Filament 的 V_SmithGGXCorrelated_Anisotropic）：已经除以 4 · N·L · N·V。 */
fn visibilityGGXAnisotropic(at: f32, ab: f32, tDotV: f32, bDotV: f32, tDotL: f32, bDotL: f32, nDotV: f32, nDotL: f32) -> f32 {
  let lambdaV = nDotL * length(vec3f(at * tDotV, ab * bDotV, nDotV));
  let lambdaL = nDotV * length(vec3f(at * tDotL, ab * bDotL, nDotL));
  return saturate(0.5 / (lambdaV + lambdaL));
}

/**
 * 没有顶点切线的网格的切线（Schüler 2006 的余切框架）：按世界坐标和贴图坐标在屏幕上的导数算 u 增大的方向。导数要在一致的
 * 控制流里取（调用的地方只按材质的常量分支）。
 */
fn derivativeTangent(world: vec3f, uv: vec2f, n: vec3f) -> vec3f {
  let dp1 = dpdx(world);
  let dp2 = dpdy(world);
  let duv1 = dpdx(uv);
  let duv2 = dpdy(uv);
  return cross(dp2, n) * duv1.x + cross(n, dp1) * duv2.x;
}

/** 薄玻璃（Stride 的 MaterialTransmittanceReflectanceStream）：按折射率、视角和玻璃的颜色算光透过去的比例和反射的比例。 */
struct Glass { transmittance: vec3f, reflectance: vec3f };
fn thinGlass(color: vec3f, cosTheta: f32, refractiveIndex: f32) -> Glass {
  let eta = max(refractiveIndex, 1.0001);
  let cosRefracted = sqrt(1.0 - (1.0 - cosTheta * cosTheta) / (eta * eta));
  let r0 = (eta * cosRefracted - cosTheta) / (eta * cosRefracted + cosTheta);
  let r1 = (eta * cosTheta - cosRefracted) / (eta * cosTheta + cosRefracted);
  // 进入界面时的菲涅耳反射率，剩下的透进去
  let r = 0.5 * saturate(r0 * r0 + r1 * r1);
  let t = 1.0 - r;
  // 玻璃里的吸收：颜色按光在里面走的路程（1 / cos）取幂
  let k = pow(max(color, vec3f(0.001)), vec3f(1.0 / cosRefracted));
  let rk = r * k;
  let transmittance = saturate(t * t * k / (1.0 - rk * rk));
  return Glass(transmittance, saturate(rk * transmittance + r));
}
`;
