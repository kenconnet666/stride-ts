/**
 * 这一帧的点光、聚光、面光源（矩形、圆盘、管状）和它们的阴影在 GPU 上的那一份（渲染系统一份，`renderSystem.localLights`）：网格着色、体积雾都读它，
 * 前向渲染器每帧在阴影收集之后、prepare 之前上传一次。个数不设上限，缓冲按 2 的幂变大（换了缓冲，用它的绑定组要重建：看
 * buffer 变没变）。
 *
 * 光和阴影放在一个存储缓冲里（`array<vec4f>`，着色器里叫 localLightData）：片元阶段的存储缓冲默认最多 8 个，分开放要占两个。
 * - 第 0 个 vec4：x 是阴影从第几个 vec4 开始，y 是 LTC 查找表上传了没有（面光源要它，没上传时先不画面光源）。
 * - 从第 1 个 vec4 起每盏光 4 个（LocalLight）：位置和 1 / 半径²、颜色乘强度和种类（0 点光、1 聚光、2 矩形光、3 圆盘光、
 *   4 管状光）、照向的方向（聚光、矩形光、圆盘光）和阴影的下标（没有是 -1）、聚光是角度衰减的 scale、offset，面光源是沿本地 X
 *   的向量（矩形的半宽、圆盘的半径、管子的半长）和矩形的半高（圆盘是半径）。
 *
 * - 点光、聚光有配光曲线（IES）时：angle.z 是它的表从第几个 vec4 开始（0 是没有），angle.w 是本地 +X 轴（IES 的水平 0°）
 *   打包成两个 snorm16 的八面体编码、按位放进 f32。表在阴影之后：一个 vec4 的头（垂直格数、水平格数），再是值，每个 vec4 放 4 个，
 *   同一个配光这一帧只放一份。
 *
 * 面光源的 LTC 查找表（ltcTable.ts，64 KB）是另一个 uniform 缓冲（ltc），场景里第一次有面光源时才加载那个模块、上传。
 * - 再往后每个阴影 26 个（LocalShadow）：六个矩阵（点光是立方体的六个面，聚光只用第一个），参数（深度偏移、法线偏移比例、点光
 *   深度的两个系数），选项（PCF 核大小、是不是点光）。
 */
import type { Vector3 } from '../../data/vectors';
import type { Lighting } from '../RenderSystem';
import type { LightProfile } from './LightProfile';

/** 面光源在着色器里的种类号（color.w）。 */
const AREA_KINDS = { rect: 2, disc: 3, tube: 4 } as const;

/** 一盏光的 vec4 数。 */
const LIGHT_VEC4S = 4;
/** 一个阴影的 vec4 数：六个矩阵加两个 vec4。 */
const SHADOW_VEC4S = 26;

/**
 * WGSL：取光（localLight）和阴影（localShadow）、衰减（localLightAt，Stride 的 LightUtil.GetDistanceAttenuation、
 * GetAngularAttenuation：从 world 指向光的单位向量 xyz 和衰减 w）。用的着色器自己声明
 * `var<storage, read> localLightData: array<vec4f>`（绑定号各自定）。
 */
export const LOCAL_LIGHT_WGSL = /* wgsl */ `
struct LocalLight { position: vec4f, color: vec4f, direction: vec4f, angle: vec4f };
struct LocalShadow { matrices: array<mat4x4f, 6>, params: vec4f, options: vec4f };

fn localLight(index: u32) -> LocalLight {
  let o = 1u + index * ${LIGHT_VEC4S}u;
  return LocalLight(localLightData[o], localLightData[o + 1u], localLightData[o + 2u], localLightData[o + 3u]);
}

/** 第 index 个阴影从第几个 vec4 开始。 */
fn localShadowStart(index: u32) -> u32 {
  return u32(localLightData[0].x) + index * ${SHADOW_VEC4S}u;
}

/** 阴影的第 face 个矩阵（start 是 localShadowStart）。 */
fn localShadowMatrix(start: u32, face: u32) -> mat4x4f {
  let o = start + face * 4u;
  return mat4x4f(localLightData[o], localLightData[o + 1u], localLightData[o + 2u], localLightData[o + 3u]);
}

/** x：深度偏移，y：法线偏移比例，zw：点光的深度 = z + w / 沿这个面的轴到光源的距离。 */
fn localShadowParams(start: u32) -> vec4f {
  return localLightData[start + 24u];
}

/** x：PCF 核大小（0 是一次比较采样），y：1 是点光，z：一块的半边长（图集 UV）。 */
fn localShadowOptions(start: u32) -> vec4f {
  return localLightData[start + 25u];
}

/**
 * 阴影图集里比较的位置（Stride 的 ShadowMapReceiverPointCubeMap、ShadowMapReceiverSpot）：xy 是图集的 uv，z 是比较的深度；
 * w 是 0 时在这个阴影的深度范围外（当作照得到）。start 是 localShadowStart，position 是取阴影的位置（网格着色时沿法线偏移过），
 * unbiased 是没偏移的位置（点光按它到光源的方向选立方体的面、算深度）。
 */
fn localShadowCoord(start: u32, position: vec3f, unbiased: vec3f, lightPosition: vec3f) -> vec4f {
  let params = localShadowParams(start);
  if (localShadowOptions(start).y < 0.5) {
    var s = localShadowMatrix(start, 0u) * vec4f(position, 1.0);
    s.z -= params.x;
    return vec4f(s.xyz / s.w, 1.0);
  }
  let face = localShadowFace(unbiased - lightPosition);
  let projected = localShadowMatrix(start, face.x) * vec4f(position, 1.0);
  let depth = params.z + params.w / (face.y - params.x);
  return vec4f(projected.xy / projected.w, depth, select(0.0, 1.0, depth >= 0.0 && depth <= 1.0));
}

/**
 * 点光的立方体选哪一面：从光源到这里的 delta 里最长的那个轴（+Z、-Z、+X、-X、+Y、-Y），返回面的序号和沿这个轴的距离
 * （bitcast 在 y 里不方便，距离单独用 f32：x 是面、y 是距离）。
 */
struct ShadowFace { x: u32, y: f32 };

fn localShadowFace(delta: vec3f) -> ShadowFace {
  let size = abs(delta);
  var face = 0u;
  var axis = delta.z;
  if (size.x >= size.y && size.x >= size.z) {
    face = 2u;
    axis = delta.x;
  } else if (size.y >= size.z) {
    face = 4u;
    axis = delta.y;
  }
  if (axis < 0.0) {
    face += 1u;
  }
  return ShadowFace(face, abs(axis));
}

/** 光的种类（color.w）：0 点光，1 聚光，2 矩形光，3 圆盘光，4 管状光。 */
fn localLightKind(light: LocalLight) -> u32 {
  return u32(light.color.w + 0.5);
}

/** 到光源中心的距离在半径（射程）以内平滑地衰减到 0 的窗口（Stride 的 GetDistanceAttenuation 里乘在 1 / d² 上的那部分）。 */
fn localLightWindow(light: LocalLight, d2: f32) -> f32 {
  let falloff = saturate(1.0 - pow(d2 * light.position.w, 2.0));
  return falloff * falloff;
}

/** 配光表里第 i 个值（start 是表头的 vec4 下标）。 */
fn lightProfileValue(start: u32, i: u32) -> f32 {
  return localLightData[start + 1u + i / 4u][i % 4u];
}

/**
 * 配光曲线在光往 outward（单位向量，从光源指出去）方向上的倍数（0..1）：垂直角从 direction（本地 -Z）量，水平角从本地 +X
 * 往本地 +Y 量；表上按双线性插值，水平方向一圈首尾相接。
 */
fn lightProfileAt(light: LocalLight, outward: vec3f) -> f32 {
  let start = u32(light.angle.z);
  let size = localLightData[start];
  let vertical = u32(size.x);
  let horizontal = u32(size.y);
  let forward = light.direction.xyz;
  let fv = acos(clamp(dot(outward, forward), -1.0, 1.0)) * 0.31830988 * f32(vertical - 1u);
  let v0 = min(u32(fv), vertical - 2u);
  let tv = fv - f32(v0);
  var h0 = 0u;
  var h1 = 0u;
  var th = 0.0;
  if (horizontal > 1u) {
    let x = octDecodeAxis(bitcast<u32>(light.angle.w));
    let y = cross(-forward, x);
    let phi = atan2(dot(outward, y), dot(outward, x));
    let fh = fract(phi * 0.15915494 + 1.0) * f32(horizontal);
    h0 = min(u32(fh), horizontal - 1u);
    h1 = (h0 + 1u) % horizontal;
    th = fh - f32(h0);
  }
  let a = mix(lightProfileValue(start, h0 * vertical + v0), lightProfileValue(start, h0 * vertical + v0 + 1u), tv);
  let b = mix(lightProfileValue(start, h1 * vertical + v0), lightProfileValue(start, h1 * vertical + v0 + 1u), tv);
  return mix(a, b, th);
}

/** 两个 snorm16 的八面体编码（低 16 位 x、高 16 位 y）还原成单位向量。 */
fn octDecodeAxis(packed: u32) -> vec3f {
  let e = unpack2x16snorm(packed);
  var v = vec3f(e.x, e.y, 1.0 - abs(e.x) - abs(e.y));
  if (v.z < 0.0) {
    v = vec3f((1.0 - abs(v.yx)) * select(vec2f(-1.0), vec2f(1.0), v.xy >= vec2f(0.0)), v.z);
  }
  return normalize(v);
}

fn localLightAt(light: LocalLight, world: vec3f) -> vec4f {
  let toLight = light.position.xyz - world;
  let distance = length(toLight);
  let l = toLight / max(distance, 1e-6);
  let d2 = distance * distance;
  var attenuation = localLightWindow(light, d2) / max(d2, 0.0001);
  let kind = localLightKind(light);
  if (kind <= 1u && light.angle.z > 0.0) {
    attenuation *= lightProfileAt(light, -l);
  }
  if (kind == 1u) {
    let angular = saturate(dot(-l, light.direction.xyz) * light.angle.x + light.angle.y);
    attenuation *= angular * angular;
  } else if (kind == 2u || kind == 3u) {
    // 矩形光、圆盘光在用这个近似的地方（体积雾）当中心的一个点，只往正面照（亮度乘面积 / π 回到点光的强度：矩形 4 · 半宽 · 半高，
    // 圆盘按正 12 边形 3r²）；网格着色用 LTC
    let area = select(3.0, 4.0, kind == 2u) * light.angle.w * length(light.angle.xyz);
    attenuation *= saturate(dot(-l, light.direction.xyz)) * area * 0.31830988;
  } else if (kind == 4u) {
    // 管状光当中心的一个点，往四周照（亮度乘长度 / π）
    attenuation *= 2.0 * length(light.angle.xyz) * 0.31830988;
  }
  return vec4f(l, attenuation);
}

/** 面光源的多边形最多几个角：矩形 4 个，圆盘按正 12 边形。 */
const AREA_CORNERS = 12u;
struct AreaPolygon { corners: array<vec3f, 12>, count: u32 };

/**
 * 矩形光、圆盘光的多边形（顺序同矩形：(+X,-Y)、(-X,-Y)、(-X,+Y)、(+X,+Y) 这样转；正面朝 direction）：angle.xyz 是沿本地 X 的
 * 向量（半宽、半径），本地 Y 沿 cross(它, direction)，长度是 angle.w（半高、半径）。圆盘是内接的正 sides 边形（最多 12；CPU 按
 * 正 12 边形的面积 3r² 算亮度，边少的调用方自己补面积差）。
 */
fn areaLightPolygon(light: LocalLight, kind: u32, sides: u32) -> AreaPolygon {
  let c = light.position.xyz;
  let u = light.angle.xyz;
  let v = normalize(cross(u, light.direction.xyz)) * light.angle.w;
  var polygon: AreaPolygon;
  if (kind == 2u) {
    polygon.corners[0] = c + u - v;
    polygon.corners[1] = c - u - v;
    polygon.corners[2] = c - u + v;
    polygon.corners[3] = c + u + v;
    polygon.count = 4u;
    return polygon;
  }
  for (var k = 0u; k < sides; k++) {
    // 往角度小的方向转，和矩形的绕向一致
    let angle = -f32(k) * (6.28318531 / f32(sides));
    polygon.corners[k] = c + u * cos(angle) + v * sin(angle);
  }
  polygon.count = sides;
  return polygon;
}

/** 一条边对矢量形状因子的贡献（Hill、Heitz 的有理多项式近似 θ / sin θ / 2π），v1、v2 是投到单位球上的两个角。 */
fn ltcEdge(v1: vec3f, v2: vec3f) -> vec3f {
  let x = dot(v1, v2);
  let y = abs(x);
  let a = 0.8543985 + (0.4965155 + 0.0145206 * y) * y;
  let b = 3.4175940 + (4.1616724 + y) * y;
  let v = a / b;
  let thetaSinTheta = select(0.5 * inverseSqrt(max(1.0 - x * x, 1e-7)) - v, v, x > 0.0);
  return cross(v1, v2) * thetaSinTheta;
}

/** 以法线为轴的正交基（视线在 T1、N 的平面里），把世界里的方向转到着色点的本地（N 是 z）。 */
fn ltcFrame(n: vec3f, v: vec3f) -> mat3x3f {
  let t1 = normalize(v - n * dot(v, n));
  let t2 = -cross(n, t1);
  return transpose(mat3x3f(t1, t2, n));
}

/** 按边积分以后的矢量形状因子换成被地平线截掉的球近似的形状因子（Hill 2016），0..1。 */
fn ltcHorizon(f: vec3f) -> f32 {
  let l = length(f);
  return max((l * l + f.z) / (l + 1.0), 0.0);
}

/**
 * 多边形光（圆盘）经 LTC 变换后的积分（Heitz 2016）：m 是 mInv 乘着色点的本地坐标系（AreaShading），把 GGX 的波瓣变回余弦分布，
 * 角投到单位球上按边积分，再按被地平线截掉的球近似形状因子。着色点在光的背面由调用方先排除。结果是 0..1（整个半球是 1）。
 */
fn ltcPolygon(m: mat3x3f, p: vec3f, polygon: AreaPolygon) -> f32 {
  let corners = polygon.corners;
  let last = polygon.count - 1u;
  let first = normalize(m * (corners[0] - p));
  var previous = first;
  var f = vec3f(0.0);
  for (var i = 1u; i <= last; i++) {
    let current = normalize(m * (corners[i] - p));
    f += ltcEdge(previous, current);
    previous = current;
  }
  f += ltcEdge(previous, first);
  return ltcHorizon(f);
}

/**
 * 矩形光的四个角在着色点的本地坐标里（frame 乘过、没归一化），漫反射、镜面共用：漫反射直接积分，镜面每个角再乘 mInv（稀疏，
 * 比从头建角、乘满的矩阵便宜）。toLight 是着色点到灯中心。
 */
struct RectCorners { a: vec3f, b: vec3f, d: vec3f, e: vec3f };

fn rectCorners(frame: mat3x3f, toLight: vec3f, light: LocalLight) -> RectCorners {
  let c = frame * toLight;
  let u = frame * light.angle.xyz;
  let v = frame * (normalize(cross(light.angle.xyz, light.direction.xyz)) * light.angle.w);
  return RectCorners(c + u - v, c - u - v, c - u + v, c + u + v);
}

/** 矩形光的 LTC 积分（同 ltcPolygon，四个角直接算，不经数组和循环，寄存器少）：角已经在余弦分布的空间里（漫反射是 rectCorners，镜面再乘 mInv）。 */
fn ltcRect(q: RectCorners) -> f32 {
  let a = normalize(q.a);
  let b = normalize(q.b);
  let d = normalize(q.d);
  let e = normalize(q.e);
  return ltcHorizon(ltcEdge(a, b) + ltcEdge(b, d) + ltcEdge(d, e) + ltcEdge(e, a));
}

/**
 * 一条线段光在余弦分布下的辐照度（Heitz、Hill 2017，照 Unity HDRP 的 I_diffuse_line）：c 是线段中心、a 是半长方向（不必是单位
 * 向量，线段是 c + h·a，h 在 ±hl 之间），都在着色点的本地（法线是 z）。线段在地平线以下的部分先裁掉。
 */
fn ltcLineIrradiance(c: vec3f, a: vec3f, hl: f32) -> f32 {
  let h = -c.z / a.z;
  let h2 = select(min(hl, h), max(hl, h), a.z >= 0.0);
  let h1 = select(min(-hl, h), max(-hl, h), a.z >= 0.0);
  let lengthA = length(a);
  let t = a / lengthA;
  let tc = dot(t, c);
  let p0 = c - tc * t;
  let ns = dot(p0, p0);
  let nr = inverseSqrt(ns);
  let nz = p0.z * nr;
  let t2 = tc + h2 * lengthA;
  let t1 = tc + h1 * lengthA;
  let s2 = ns + t2 * t2;
  let s1 = ns + t1 * t1;
  let mr = inverseSqrt(s1 * s2);
  let r2 = s1 * mr * mr;
  let r1 = s2 * mr * mr;
  let n = ns * nr;
  let i12 = (nz * t2 - t.z * n) * r2 - (nz * t1 - t.z * n) * r1;
  let i3 = acos(min(1.0, (ns + t1 * t2) * mr)) * nz * nr;
  return max(0.0, i12 + i3) * 0.31830988;
}

/**
 * 管状光（一条线段）经 LTC 变换后的积分（HDRP 的 I_ltc_line）：center、axis（单位向量）、halfLength 在世界里。线段变换以后
 * 宽度方向被拉伸，按 1 / |M⁻ᵀ · 垂直方向| 补回来（HDRP 假定 mInv 是稀疏的，这里按余子式算一般的 3×3）。
 */
fn ltcLine(frame: mat3x3f, mInv: mat3x3f, p: vec3f, center: vec3f, axis: vec3f, halfLength: f32) -> f32 {
  let localCenter = frame * (center - p);
  let localAxis = frame * axis;
  let ortho = cross(localCenter, localAxis);
  let orthoSq = dot(ortho, ortho);
  if (orthoSq <= 1e-12 || localCenter.z + halfLength * abs(localAxis.z) <= 0.0) {
    return 0.0;
  }
  let c = mInv * localCenter;
  let a = mInv * localAxis;
  if (c.z + halfLength * abs(a.z) <= 0.0) {
    return 0.0;
  }
  let cofactor = mat3x3f(cross(mInv[1], mInv[2]), cross(mInv[2], mInv[0]), cross(mInv[0], mInv[1]));
  let determinant = dot(mInv[0], cross(mInv[1], mInv[2]));
  let width = abs(determinant) / max(length(cofactor * (ortho * inverseSqrt(orthoSq))), 1e-6);
  return ltcLineIrradiance(c, a, halfLength) * width;
}
`;

/**
 * WGSL：LTC 查找表（ltcTable.ts，64 × 64，每格一个 vec4u：8 个半精度数）的双线性采样。用的着色器自己声明
 * `var<uniform> ltcTable: array<vec4u, 4096>`。返回 [M⁻¹ 的四个元素, 镜面的缩放和偏移]。
 */
export const LTC_WGSL = /* wgsl */ `
fn ltcTexel(x: u32, y: u32) -> array<vec4f, 2> {
  let u = ltcTable[min(y, 63u) * 64u + min(x, 63u)];
  return array<vec4f, 2>(vec4f(unpack2x16float(u.x), unpack2x16float(u.y)), vec4f(unpack2x16float(u.z), unpack2x16float(u.w)));
}

/** roughness 是感知的粗糙度（sqrt(alpha)），nDotV 是视线和法线的夹角余弦。 */
fn ltcLookup(roughness: f32, nDotV: f32) -> array<vec4f, 2> {
  let p = vec2f(saturate(roughness), sqrt(saturate(1.0 - nDotV))) * 63.0;
  let i = vec2u(floor(p));
  let f = p - floor(p);
  let a = ltcTexel(i.x, i.y);
  let b = ltcTexel(i.x + 1u, i.y);
  let c = ltcTexel(i.x, i.y + 1u);
  let d = ltcTexel(i.x + 1u, i.y + 1u);
  return array<vec4f, 2>(mix(mix(a[0], b[0], f.x), mix(c[0], d[0], f.x), f.y), mix(mix(a[1], b[1], f.x), mix(c[1], d[1], f.x), f.y));
}
`;

/** LTC 查找表的字节数：64 × 64 格，每格一个 vec4u。 */
export const LTC_TABLE_BYTES = 64 * 64 * 16;

export class LocalLightBuffer {
  /** 存储缓冲；没有光时也留着开头的那个 vec4（绑定组里的存储缓冲不能缺）。 */
  buffer: GPUBuffer;
  /** LTC 查找表（uniform，`array<vec4u, 4096>`）：一直绑着，第一次有矩形光时才填。 */
  readonly ltc: GPUBuffer;
  readonly #device: GPUDevice;
  #data = new Float32Array(4 * (1 + LIGHT_VEC4S + SHADOW_VEC4S));
  #ltc: 'empty' | 'loading' | 'ready' = 'empty';
  /** 这一帧每个配光的表放在第几个 vec4。 */
  readonly #profileStarts = new Map<LightProfile, number>();

  constructor(device: GPUDevice) {
    this.#device = device;
    this.buffer = this.#create();
    this.ltc = device.createBuffer({ label: 'LTC table', size: LTC_TABLE_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  }

  /** 上传这一帧的点光、聚光和它们的阴影（前向渲染器在阴影收集之后、prepare 之前调）。 */
  upload(lighting: Lighting): void {
    const { localCount: count, localShadowCount: shadowCount } = lighting;
    const shadowStart = 1 + count * LIGHT_VEC4S;
    // 配光表接在阴影后面，同一个配光只放一份
    const profileStarts = this.#profileStarts;
    profileStarts.clear();
    let next = shadowStart + shadowCount * SHADOW_VEC4S;
    for (let i = 0; i < count; i++) {
      const profile = lighting.locals[i]!.profile;
      if (!profile || profileStarts.has(profile)) continue;
      profileStarts.set(profile, next);
      next += 1 + Math.ceil(profile.values.length / 4);
    }
    const floats = 4 * next;
    if (floats > this.#data.length) {
      this.#data = new Float32Array(2 ** Math.ceil(Math.log2(floats)));
      this.buffer.destroy();
      this.buffer = this.#create();
    }
    const data = this.#data, bits = new Uint32Array(data.buffer);
    data[0] = shadowStart;
    data[1] = this.#ltc === 'ready' ? 1 : 0;
    let areas = false;
    for (let i = 0; i < count; i++) {
      const { position: p, color: c, direction: d, spot, area, invSquareRadius, angleScale, angleOffset, shadowIndex, halfWidth: w, halfHeight } = lighting.locals[i]!;
      const o = 4 * (1 + i * LIGHT_VEC4S);
      data[o] = p.x; data[o + 1] = p.y; data[o + 2] = p.z; data[o + 3] = invSquareRadius;
      data[o + 4] = c.r; data[o + 5] = c.g; data[o + 6] = c.b; data[o + 7] = area ? AREA_KINDS[area] : spot ? 1 : 0;
      data[o + 8] = d.x; data[o + 9] = d.y; data[o + 10] = d.z; data[o + 11] = shadowIndex;
      if (area) {
        data[o + 12] = w.x; data[o + 13] = w.y; data[o + 14] = w.z; data[o + 15] = halfHeight;
        areas = true;
      } else {
        data[o + 12] = angleScale; data[o + 13] = angleOffset;
        const profile = lighting.locals[i]!.profile;
        data[o + 14] = profile ? profileStarts.get(profile)! : 0;
        // 本地 +X 按位放进 f32（着色器 bitcast 回 u32 再解八面体编码）
        bits[o + 15] = profile ? octEncodeAxis(lighting.locals[i]!.axisX) : 0;
      }
    }
    if (areas && this.#ltc === 'empty') this.#loadLtc();
    for (const [profile, start] of profileStarts) {
      data[4 * start] = profile.vertical;
      data[4 * start + 1] = profile.horizontal;
      data.set(profile.values, 4 * (start + 1));
    }
    for (let i = 0; i < shadowCount; i++) {
      const shadow = lighting.localShadows[i]!, o = 4 * (shadowStart + i * SHADOW_VEC4S);
      data.set(shadow.worldToShadow, o);
      data[o + 96] = shadow.depthBias; data[o + 97] = shadow.normalOffsetScale; data[o + 98] = shadow.depthA; data[o + 99] = shadow.depthB;
      data[o + 100] = shadow.filterSize; data[o + 101] = shadow.point ? 1 : 0; data[o + 102] = shadow.tileHalfSize;
    }
    this.#device.queue.writeBuffer(this.buffer, 0, data, 0, floats);
  }

  destroy(): void {
    this.buffer.destroy();
    this.ltc.destroy();
  }

  /** 加载、上传 LTC 查找表（一次）；加载好以前矩形光不画（第 0 个 vec4 的 y）。 */
  #loadLtc(): void {
    this.#ltc = 'loading';
    void import('./ltcTable').then(({ ltcTable }) => {
      this.#device.queue.writeBuffer(this.ltc, 0, ltcTable());
      this.#ltc = 'ready';
    }, (error: unknown) => {
      this.#ltc = 'empty';
      console.error('[stride] loading the LTC table for rect lights failed', error);
    });
  }

  #create(): GPUBuffer {
    return this.#device.createBuffer({ label: 'Local lights', size: this.#data.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  }
}

/** 单位向量的八面体编码，两个 snorm16（低 16 位 x、高 16 位 y），和着色器里的 octDecodeAxis 对应。 */
function octEncodeAxis(v: Vector3): number {
  const sum = Math.abs(v.x) + Math.abs(v.y) + Math.abs(v.z) || 1;
  let x = v.x / sum, y = v.y / sum;
  if (v.z < 0) {
    const ox = x;
    x = (1 - Math.abs(y)) * (ox >= 0 ? 1 : -1);
    y = (1 - Math.abs(ox)) * (y >= 0 ? 1 : -1);
  }
  const snorm = (value: number) => Math.round(Math.max(-1, Math.min(1, value)) * 32767) & 0xffff;
  return (snorm(x) | (snorm(y) << 16)) >>> 0;
}
