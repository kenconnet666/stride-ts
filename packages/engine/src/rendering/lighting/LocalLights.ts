/**
 * 这一帧的点光、聚光在 GPU 上的那一份（渲染系统一份，`renderSystem.localLights`）：网格着色、体积雾都读它，前向渲染器每帧在
 * prepare 之前上传一次。个数不设上限，缓冲按 2 的幂变大（换了缓冲，用它的绑定组要重建：看 buffer 变没变）。
 *
 * 每盏 16 个 float（LocalLight）：位置和 1 / 半径²、颜色乘强度和是不是聚光、聚光的方向和阴影的下标、角度衰减的 scale、offset。
 */
import type { Lighting } from '../RenderSystem';

export const LOCAL_LIGHT_FLOATS = 16;

/**
 * WGSL：LocalLight 结构和衰减（Stride 的 LightUtil.GetDistanceAttenuation、GetAngularAttenuation）。localLightAt 给出从 world 指向
 * 光的单位向量（xyz）和衰减（w）。
 */
export const LOCAL_LIGHT_WGSL = /* wgsl */ `
struct LocalLight { position: vec4f, color: vec4f, direction: vec4f, angle: vec4f };

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
  /** 存储缓冲；没有光时也留一盏的位置（绑定组里的存储缓冲不能缺）。 */
  buffer: GPUBuffer;
  readonly #device: GPUDevice;
  #data = new Float32Array(LOCAL_LIGHT_FLOATS);

  constructor(device: GPUDevice) {
    this.#device = device;
    this.buffer = this.#create();
  }

  /** 上传这一帧的点光、聚光（前向渲染器在 prepare 之前调）。 */
  upload(lighting: Lighting): void {
    const count = lighting.localCount;
    if (count * LOCAL_LIGHT_FLOATS > this.#data.length) {
      this.#data = new Float32Array(2 ** Math.ceil(Math.log2(count)) * LOCAL_LIGHT_FLOATS);
      this.buffer.destroy();
      this.buffer = this.#create();
    }
    const data = this.#data;
    for (let i = 0; i < count; i++) {
      const { position: p, color: c, direction: d, spot, invSquareRadius, angleScale, angleOffset, shadowIndex } = lighting.locals[i]!;
      const o = i * LOCAL_LIGHT_FLOATS;
      data[o] = p.x; data[o + 1] = p.y; data[o + 2] = p.z; data[o + 3] = invSquareRadius;
      data[o + 4] = c.r; data[o + 5] = c.g; data[o + 6] = c.b; data[o + 7] = spot ? 1 : 0;
      data[o + 8] = d.x; data[o + 9] = d.y; data[o + 10] = d.z; data[o + 11] = shadowIndex;
      data[o + 12] = angleScale; data[o + 13] = angleOffset;
    }
    if (count > 0) this.#device.queue.writeBuffer(this.buffer, 0, data, 0, count * LOCAL_LIGHT_FLOATS);
  }

  destroy(): void {
    this.buffer.destroy();
  }

  #create(): GPUBuffer {
    return this.#device.createBuffer({ label: 'Local lights', size: this.#data.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  }
}
