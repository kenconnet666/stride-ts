/**
 * 光追打到的表面怎么受光（探针的射线 IrradianceVolume.ts、光追的反射 RayTracedReflections.ts、路径追踪共用）：这一帧的方向光、
 * 点光聚光（面光源当中心的一个点，同体积雾）都带阴影射线（点光聚光多的时候按贡献抽一盏），加天空盒光的球谐和环境光。前向渲染器在用到光追的帧收集完光照以后 write 一次，
 * 着色器里 rayTracedLightingWgsl 声明的 rtDirectLight、rtSkyLight、rtSkyDirection。
 */
import { LOCAL_LIGHT_WGSL } from '../lighting/LocalLights';
import { MAX_DIRECTIONAL_LIGHTS, type Lighting } from '../RenderSystem';

/** 一份光照几个 float：个数 1、天空的强度 1、环境光 1、天空的球谐 9、天空盒的旋转 3、方向光的方向和颜色各 MAX_DIRECTIONAL_LIGHTS 个（vec4）。和 RenderSystem 互相引用，用到时才算。 */
const lightingFloats = () => (1 + 1 + 1 + 9 + 3 + MAX_DIRECTIONAL_LIGHTS * 2) * 4;
/** 阴影射线最远多长（方向光）。 */
const SHADOW_DISTANCE = 1e5;
/**
 * 照得到的点光聚光不超过这么多盏时每盏都打阴影射线；多了按贡献抽一盏（见 rtDirectLight）。阴影射线要在整个场景的 BVH 里走，
 * 一个超市的顶有几十盏面光源，每盏一条时光追反射从 4 毫秒涨到 12 毫秒。
 */
const EXACT_LOCAL_LIGHTS = 4;

/**
 * 着色器代码：lighting 是光照的 uniform 的绑定，locals 是点光聚光（LocalLightBuffer）的存储缓冲的绑定，都在 group 里。要在同一个
 * 模块里另外声明光追场景（rayTracingWgsl：阴影射线用 rtTrace）。
 */
export function rayTracedLightingWgsl(group: number, lighting: number, locals: number): string {
  return /* wgsl */ `
struct RtLighting {
  // 方向光几个、点光聚光几个、第几帧（抽灯的随机数每帧换）
  counts: vec4u,
  // 天空盒光的强度
  sky: vec4f,
  ambient: vec4f,
  skySH: array<vec4f, 9>,
  skyRotation: array<vec4f, 3>,
  lightDirections: array<vec4f, ${MAX_DIRECTIONAL_LIGHTS}>,
  lightColors: array<vec4f, ${MAX_DIRECTIONAL_LIGHTS}>,
};
@group(${group}) @binding(${lighting}) var<uniform> rtLighting: RtLighting;
// 点光、聚光（同网格着色器、体积雾的那一份，lighting/LocalLights.ts）
@group(${group}) @binding(${locals}) var<storage, read> localLightData: array<vec4f>;
${LOCAL_LIGHT_WGSL}

/** 世界方向转到天空盒的立方体贴图里（同网格着色器的 skyDirection）。 */
fn rtSkyDirection(direction: vec3f) -> vec3f {
  let r = direction * mat3x3f(rtLighting.skyRotation[0].xyz, rtLighting.skyRotation[1].xyz, rtLighting.skyRotation[2].xyz);
  return vec3f(r.xy, -r.z);
}

/** 天空盒光（球谐，同网格着色器的 evaluateSH）加环境光：辐照度 / π，按法线方向取；没打到的探针射线也用它当这个方向的光。 */
fn rtSkyLight(direction: vec3f) -> vec3f {
  let d = rtSkyDirection(direction);
  var c = rtLighting.skySH[0].rgb;
  c += rtLighting.skySH[1].rgb * d.y;
  c += rtLighting.skySH[2].rgb * d.z;
  c += rtLighting.skySH[3].rgb * d.x;
  c += rtLighting.skySH[4].rgb * d.y * d.x;
  c += rtLighting.skySH[5].rgb * d.y * d.z;
  c += rtLighting.skySH[6].rgb * (3.0 * d.z * d.z - 1.0);
  c += rtLighting.skySH[7].rgb * d.x * d.z;
  c += rtLighting.skySH[8].rgb * (d.x * d.x - d.y * d.y);
  return rtLighting.ambient.rgb + max(c, vec3f(0.0)) * rtLighting.sky.x;
}

/** 按位置和帧号的 0..1 随机数（PCG 的混合）：抽灯用，同一点每帧不同。 */
fn rtRandom(p: vec3f) -> f32 {
  var h = bitcast<vec3u>(p) * vec3u(1664525u, 1013904223u, 2654435761u) + vec3u(rtLighting.counts.z * 747796405u);
  h.x += h.y * h.z; h.y += h.z * h.x; h.z += h.x * h.y;
  h ^= h >> vec3u(16u);
  h.x += h.y * h.z;
  return f32(h.x >> 8u) / 16777216.0;
}

/**
 * 世界位置 p、法线 n 的漫反射表面受的直射光（辐照度 / π，乘反照率就是出射的）：方向光每盏一条阴影射线；点光聚光照得到的
 * 不超过 ${EXACT_LOCAL_LIGHTS} 盏时也每盏一条，多了按不算遮挡时的贡献加权抽一盏（蓄水池抽样，一个随机数一路缩放着用）、只给它
 * 打阴影射线，结果乘"总权重 / 它的权重"——期望不变，噪声交给调用方的时间累积。
 */
fn rtDirectLight(p: vec3f, n: vec3f) -> vec3f {
  let origin = p + n * 1e-3;
  var light = vec3f(0.0);
  for (var i = 0u; i < rtLighting.counts.x; i++) {
    let l = -rtLighting.lightDirections[i].xyz;
    let nDotL = dot(n, l);
    if (nDotL <= 0.0) { continue; }
    if (rtTrace(origin, l, ${SHADOW_DISTANCE}).instance != 0xffffffffu) { continue; }
    light += rtLighting.lightColors[i].rgb * nDotL;
  }
  // 射程里、朝着表面的：先数有几盏
  var lit = 0u;
  for (var i = 0u; i < rtLighting.counts.y; i++) {
    let local = localLight(i);
    let at = localLightAt(local, p);
    if (at.w > 0.0 && dot(n, at.xyz) > 0.0) { lit++; }
  }
  if (lit <= ${EXACT_LOCAL_LIGHTS}u) {
    for (var i = 0u; i < rtLighting.counts.y; i++) {
      let local = localLight(i);
      let at = localLightAt(local, p);
      let nDotL = dot(n, at.xyz);
      if (at.w <= 0.0 || nDotL <= 0.0) { continue; }
      if (rtTrace(origin, at.xyz, distance(local.position.xyz, p) - 1e-3).instance != 0xffffffffu) { continue; }
      light += local.color.rgb * nDotL * at.w;
    }
    return light;
  }
  var u = rtRandom(p);
  var total = 0.0;
  var chosen = 0u;
  var chosenWeight = 0.0;
  var chosenLight = vec3f(0.0);
  for (var i = 0u; i < rtLighting.counts.y; i++) {
    let local = localLight(i);
    let at = localLightAt(local, p);
    let nDotL = dot(n, at.xyz);
    if (at.w <= 0.0 || nDotL <= 0.0) { continue; }
    let c = local.color.rgb * nDotL * at.w;
    let w = max(dot(c, vec3f(0.2126, 0.7152, 0.0722)), 1e-8);
    total += w;
    // 以 w / total 的概率换成这一盏；用掉的那段随机数缩放回 0..1 接着用
    let keep = w / total;
    if (u < keep) {
      chosen = i;
      chosenWeight = w;
      chosenLight = c;
      u = u / keep;
    } else {
      u = (u - keep) / (1.0 - keep);
    }
  }
  if (chosenWeight > 0.0) {
    let local = localLight(chosen);
    let at = localLightAt(local, p);
    if (rtTrace(origin, at.xyz, distance(local.position.xyz, p) - 1e-3).instance == 0xffffffffu) {
      light += chosenLight * (total / chosenWeight);
    }
  }
  return light;
}
`;
}

/** 光追用的这一帧的光照（RayTracingScene.lighting）：uniform 缓冲，write 从渲染系统的光照填。 */
export class RayTracedLighting {
  readonly #device: GPUDevice;
  #data: Float32Array<ArrayBuffer> | undefined;
  #buffer: GPUBuffer | undefined;
  /** 第几帧：抽灯的随机数每帧换。 */
  #frame = 0;

  constructor(device: GPUDevice) {
    this.#device = device;
  }

  /** 光照的 uniform（第一次用到光追时才建）。 */
  get buffer(): GPUBuffer {
    this.#data ??= new Float32Array(lightingFloats());
    return (this.#buffer ??= this.#device.createBuffer({ label: 'RayTracedLighting', size: this.#data.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }));
  }

  /** 这一帧的光照（前向渲染器收集完、用到光追时调一次）。 */
  write(lighting: Lighting): void {
    const buffer = this.buffer;
    const data = this.#data!, words = new Uint32Array(data.buffer);
    words.set([lighting.directionalCount, lighting.localCount, this.#frame++ % 65536, 0], 0);
    const skybox = lighting.skybox;
    data.set([skybox?.intensity ?? 0, 0, 0, 0], 4);
    data.set([lighting.ambient.r, lighting.ambient.g, lighting.ambient.b, 0], 8);
    const sh = skybox?.skybox.diffuseSH;
    for (let c = 0; c < 9; c++) data.set(sh ? [sh[c * 3]!, sh[c * 3 + 1]!, sh[c * 3 + 2]!, 0] : [0, 0, 0, 0], 12 + c * 4);
    const rotation = skybox?.rotation;
    for (let r = 0; r < 3; r++) data.set(rotation ? [rotation[r * 4]!, rotation[r * 4 + 1]!, rotation[r * 4 + 2]!, 0] : [r === 0 ? 1 : 0, r === 1 ? 1 : 0, r === 2 ? 1 : 0, 0], 48 + r * 4);
    for (let i = 0; i < MAX_DIRECTIONAL_LIGHTS; i++) {
      const light = lighting.directionals[i]!;
      const { x, y, z } = light.direction;
      const length = Math.hypot(x, y, z) || 1;
      data.set(i < lighting.directionalCount ? [x / length, y / length, z / length, 0] : [0, -1, 0, 0], 60 + i * 4);
      data.set(i < lighting.directionalCount ? [light.color.r, light.color.g, light.color.b, 0] : [0, 0, 0, 0], 60 + MAX_DIRECTIONAL_LIGHTS * 4 + i * 4);
    }
    this.#device.queue.writeBuffer(buffer, 0, data);
  }

  destroy(): void {
    this.#buffer?.destroy();
  }
}
