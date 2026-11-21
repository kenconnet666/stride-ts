/**
 * 这一帧的点光、聚光、矩形光和它们的阴影在 GPU 上的那一份（渲染系统一份，`renderSystem.localLights`）：网格着色、体积雾都读它，
 * 前向渲染器每帧在阴影收集之后、prepare 之前上传一次。个数不设上限，缓冲按 2 的幂变大（换了缓冲，用它的绑定组要重建：看
 * buffer 变没变）。
 *
 * 光和阴影放在一个存储缓冲里（`array<vec4f>`，着色器里叫 localLightData）：片元阶段的存储缓冲默认最多 8 个，分开放要占两个。
 * - 第 0 个 vec4：x 是阴影从第几个 vec4 开始，y 是 LTC 查找表上传了没有（矩形光要它，没上传时先不画矩形光）。
 * - 从第 1 个 vec4 起每盏光 4 个（LocalLight）：位置和 1 / 半径²、颜色乘强度和种类（0 点光、1 聚光、2 矩形光）、照向的方向
 *   （聚光、矩形光）和阴影的下标（没有是 -1）、聚光是角度衰减的 scale、offset，矩形光是半宽的向量和半高。
 *
 * 矩形光的 LTC 查找表（ltcTable.ts，64 KB）是另一个 uniform 缓冲（ltc），场景里第一次有矩形光时才加载那个模块、上传。
 * - 再往后每个阴影 26 个（LocalShadow）：六个矩阵（点光是立方体的六个面，聚光只用第一个），参数（深度偏移、法线偏移比例、点光
 *   深度的两个系数），选项（PCF 核大小、是不是点光）。
 */
import type { Lighting } from '../RenderSystem';

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

/** x：PCF 核大小（0 是一次比较采样），y：1 是点光。 */
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
  // 点光：到光源的方向里最长的那个轴定面（+Z、-Z、+X、-X、+Y、-Y），深度按沿这个轴的距离算
  let delta = unbiased - lightPosition;
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
  let projected = localShadowMatrix(start, face) * vec4f(position, 1.0);
  let depth = params.z + params.w / (abs(axis) - params.x);
  return vec4f(projected.xy / projected.w, depth, select(0.0, 1.0, depth >= 0.0 && depth <= 1.0));
}

/** 光的种类（color.w）：0 点光，1 聚光，2 矩形光。 */
fn localLightKind(light: LocalLight) -> u32 {
  return u32(light.color.w + 0.5);
}

/** 到光源中心的距离在半径（射程）以内平滑地衰减到 0 的窗口（Stride 的 GetDistanceAttenuation 里乘在 1 / d² 上的那部分）。 */
fn localLightWindow(light: LocalLight, d2: f32) -> f32 {
  let falloff = saturate(1.0 - pow(d2 * light.position.w, 2.0));
  return falloff * falloff;
}

fn localLightAt(light: LocalLight, world: vec3f) -> vec4f {
  let toLight = light.position.xyz - world;
  let distance = length(toLight);
  let l = toLight / max(distance, 1e-6);
  let d2 = distance * distance;
  var attenuation = localLightWindow(light, d2) / max(d2, 0.0001);
  let kind = localLightKind(light);
  if (kind == 1u) {
    let angular = saturate(dot(-l, light.direction.xyz) * light.angle.x + light.angle.y);
    attenuation *= angular * angular;
  } else if (kind == 2u) {
    // 矩形光在用这个近似的地方（体积雾）当中心的一个点，只往正面照（亮度乘面积 / π 回到点光的强度）；网格着色用 LTC
    attenuation *= saturate(dot(-l, light.direction.xyz)) * 4.0 * light.angle.w * length(light.angle.xyz) * 0.31830988;
  }
  return vec4f(l, attenuation);
}

/**
 * 矩形光的四个角（逆时针，从正面看；正面朝 direction）：angle.xyz 是半宽的向量（本地 X），半高沿 cross(半宽, direction)（本地 Y），
 * 长度是 angle.w。
 */
fn rectLightCorners(light: LocalLight) -> array<vec3f, 4> {
  let c = light.position.xyz;
  let w = light.angle.xyz;
  let h = normalize(cross(w, light.direction.xyz)) * light.angle.w;
  return array<vec3f, 4>(c + w - h, c - w - h, c - w + h, c + w + h);
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

/**
 * 多边形光（矩形）经 LTC 变换后的积分（Heitz 2016）：mInv 把 GGX 的波瓣变回余弦分布，角投到单位球上按边积分，再按被地平线
 * 截掉的球近似形状因子（Hill 2016）。位置在光的背面时是 0。结果是 0..1（整个半球是 1）。
 */
fn ltcIntegrate(n: vec3f, v: vec3f, p: vec3f, mInv: mat3x3f, corners: array<vec3f, 4>) -> f32 {
  if (dot(cross(corners[1] - corners[0], corners[3] - corners[0]), p - corners[0]) < 0.0) {
    return 0.0;
  }
  // 以法线为轴的正交基（视线在 T1、N 的平面里）
  let t1 = normalize(v - n * dot(v, n));
  let t2 = -cross(n, t1);
  let m = mInv * transpose(mat3x3f(t1, t2, n));
  var c: array<vec3f, 4>;
  for (var i = 0u; i < 4u; i++) {
    c[i] = normalize(m * (corners[i] - p));
  }
  let f = ltcEdge(c[0], c[1]) + ltcEdge(c[1], c[2]) + ltcEdge(c[2], c[3]) + ltcEdge(c[3], c[0]);
  let l = length(f);
  return max((l * l + f.z) / (l + 1.0), 0.0);
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

  constructor(device: GPUDevice) {
    this.#device = device;
    this.buffer = this.#create();
    this.ltc = device.createBuffer({ label: 'LTC table', size: LTC_TABLE_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  }

  /** 上传这一帧的点光、聚光和它们的阴影（前向渲染器在阴影收集之后、prepare 之前调）。 */
  upload(lighting: Lighting): void {
    const { localCount: count, localShadowCount: shadowCount } = lighting;
    const shadowStart = 1 + count * LIGHT_VEC4S;
    const floats = 4 * (shadowStart + shadowCount * SHADOW_VEC4S);
    if (floats > this.#data.length) {
      this.#data = new Float32Array(2 ** Math.ceil(Math.log2(floats)));
      this.buffer.destroy();
      this.buffer = this.#create();
    }
    const data = this.#data;
    data[0] = shadowStart;
    data[1] = this.#ltc === 'ready' ? 1 : 0;
    let rects = false;
    for (let i = 0; i < count; i++) {
      const { position: p, color: c, direction: d, spot, rect, invSquareRadius, angleScale, angleOffset, shadowIndex, halfWidth: w, halfHeight } = lighting.locals[i]!;
      const o = 4 * (1 + i * LIGHT_VEC4S);
      data[o] = p.x; data[o + 1] = p.y; data[o + 2] = p.z; data[o + 3] = invSquareRadius;
      data[o + 4] = c.r; data[o + 5] = c.g; data[o + 6] = c.b; data[o + 7] = rect ? 2 : spot ? 1 : 0;
      data[o + 8] = d.x; data[o + 9] = d.y; data[o + 10] = d.z; data[o + 11] = shadowIndex;
      if (rect) {
        data[o + 12] = w.x; data[o + 13] = w.y; data[o + 14] = w.z; data[o + 15] = halfHeight;
        rects = true;
      } else {
        data[o + 12] = angleScale; data[o + 13] = angleOffset;
      }
    }
    if (rects && this.#ltc === 'empty') this.#loadLtc();
    for (let i = 0; i < shadowCount; i++) {
      const shadow = lighting.localShadows[i]!, o = 4 * (shadowStart + i * SHADOW_VEC4S);
      data.set(shadow.worldToShadow, o);
      data[o + 96] = shadow.depthBias; data[o + 97] = shadow.normalOffsetScale; data[o + 98] = shadow.depthA; data[o + 99] = shadow.depthB;
      data[o + 100] = shadow.filterSize; data[o + 101] = shadow.point ? 1 : 0;
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
