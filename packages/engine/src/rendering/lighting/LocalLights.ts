/**
 * 这一帧的点光、聚光和它们的阴影在 GPU 上的那一份（渲染系统一份，`renderSystem.localLights`）：网格着色、体积雾都读它，
 * 前向渲染器每帧在阴影收集之后、prepare 之前上传一次。个数不设上限，缓冲按 2 的幂变大（换了缓冲，用它的绑定组要重建：看
 * buffer 变没变）。
 *
 * 光和阴影放在一个存储缓冲里（`array<vec4f>`，着色器里叫 localLightData）：片元阶段的存储缓冲默认最多 8 个，分开放要占两个。
 * - 第 0 个 vec4：x 是阴影从第几个 vec4 开始。
 * - 从第 1 个 vec4 起每盏光 4 个（LocalLight）：位置和 1 / 半径²、颜色乘强度和是不是聚光、聚光的方向和阴影的下标（没有是 -1）、
 *   角度衰减的 scale、offset。
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

fn localLightAt(light: LocalLight, world: vec3f) -> vec4f {
  let toLight = light.position.xyz - world;
  let distance = length(toLight);
  let l = toLight / max(distance, 1e-6);
  let d2 = distance * distance;
  let falloff = saturate(1.0 - pow(d2 * light.position.w, 2.0));
  var attenuation = falloff * falloff / max(d2, 0.0001);
  if (light.color.w > 0.5) {
    let angular = saturate(dot(-l, light.direction.xyz) * light.angle.x + light.angle.y);
    attenuation *= angular * angular;
  }
  return vec4f(l, attenuation);
}
`;

export class LocalLightBuffer {
  /** 存储缓冲；没有光时也留着开头的那个 vec4（绑定组里的存储缓冲不能缺）。 */
  buffer: GPUBuffer;
  readonly #device: GPUDevice;
  #data = new Float32Array(4 * (1 + LIGHT_VEC4S + SHADOW_VEC4S));

  constructor(device: GPUDevice) {
    this.#device = device;
    this.buffer = this.#create();
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
    for (let i = 0; i < count; i++) {
      const { position: p, color: c, direction: d, spot, invSquareRadius, angleScale, angleOffset, shadowIndex } = lighting.locals[i]!;
      const o = 4 * (1 + i * LIGHT_VEC4S);
      data[o] = p.x; data[o + 1] = p.y; data[o + 2] = p.z; data[o + 3] = invSquareRadius;
      data[o + 4] = c.r; data[o + 5] = c.g; data[o + 6] = c.b; data[o + 7] = spot ? 1 : 0;
      data[o + 8] = d.x; data[o + 9] = d.y; data[o + 10] = d.z; data[o + 11] = shadowIndex;
      data[o + 12] = angleScale; data[o + 13] = angleOffset;
    }
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
  }

  #create(): GPUBuffer {
    return this.#device.createBuffer({ label: 'Local lights', size: this.#data.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  }
}
