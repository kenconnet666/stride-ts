/**
 * 物理天空（SkyAtmosphere 组件；Stride 没有）：Hillaire 2020 "A Scalable and Production Ready Sky and Atmosphere Rendering
 * Technique" 的做法，参照 Babylon.js 的 atmosphere 插件（MIT，部分来自 sebh/UnrealEngineSkyAtmosphere，MIT）。
 *
 * - 大气是包着星球的一层（默认地球：半径 6360 km、厚 100 km），瑞利散射、米氏散射和臭氧吸收按高度指数衰减。场景的世界原点在
 *   星球表面（北极），Y 向上，世界单位是米，大气的计算用千米。
 * - 太阳和月亮是两盏方向光（SkyAtmosphere.sun、moon；太阳没设时是要投阴影的那盏，没有时是第一盏），颜色 · 强度是大气层顶的
 *   照度（月亮的是满月时的，再乘月相：被太阳照亮的那部分的比例）。地面上的颜色 = 它 · 相机处朝它的透射率（CPU 上积分，
 *   sunTransmittance），所以落山时直射光自己变红变暗，圆盘沉到地平线以下就是黑的（前向渲染器把黑的光丢掉，阴影轮到下一盏）。
 * - 查找表（计算着色器）：透射率（256x64，大气参数变了才算）、多次散射（32x32，同上）、天空视图（192x108，太阳、月亮的方向或
 *   相机高度变了才算；两盏光各积分一遍加起来）。天空画在网格没画到的地方（AtmosphereRenderFeature），圆盘按光源的角直径
 *   （Light.shadowLightAngle）。
 * - 夜空：月面是一个被太阳照着的球（月相是几何算出来的，月海是噪声），星星和银河是程序生成的，跟着 SkyAtmosphere 所在实体的
 *   旋转转（DayNightCycle 按时刻转它）；天空亮的时候暗的星星先被盖过去。
 * - 环境光：天空变了以后把天空视图画进一张 128² 的立方体贴图（不含圆盘和星星），镜面用 CubemapPrefilter 预滤波，
 *   漫反射在 GPU 上投影成 3 阶球谐（同资源管线的 st_cubemap_sh_lambert），读回来晚一两帧用上。当作天空盒光
 *   （SkyboxLight，见 DynamicSky），场景里原来的天空盒光被它代替。
 * - 空气透视：屏幕上 32x32 格、32 层的体素表，不透明的画完以后按深度合成。
 * - 还没做：云。
 */
import type { EntityId } from '../../data/prop';
import { system } from '../../engine/system';
import { Transform } from '../../engine/transform';
import { SkyAtmosphere } from '../components';
import { AERIAL_COMPOSITE_SHADER, AERIAL_SHADER, MULTI_SCATTERING_SHADER, SH_SHADER, SKY_CUBE_SHADER, SKY_SHADER, SKY_VIEW_SHADER, TRANSMITTANCE_SHADER } from './atmosphereShaders';
import type { GpuResources } from '../../graphics/GpuResources';
import type { DirectionalLight, Lighting, RenderContext, RenderView, SkyboxLight } from '../RenderSystem';

/** 大气的物理参数（SkyAtmosphere 组件的列；距离是千米，系数是每千米）。 */
export interface AtmosphereSettings {
  planetRadius: number;
  atmosphereHeight: number;
  rayleighScattering: [number, number, number];
  mieScattering: number;
  mieAbsorption: number;
  miePhaseG: number;
  ozoneAbsorption: [number, number, number];
  groundAlbedo: [number, number, number];
  /** 天空和环境光的亮度倍数（不影响太阳的直射光）。 */
  skyIntensity: number;
}

/** 地球的默认值（Hillaire 2020 / Babylon 的 DefaultPeak*）。 */
export const EARTH_ATMOSPHERE: Readonly<AtmosphereSettings> = {
  planetRadius: 6360,
  atmosphereHeight: 100,
  rayleighScattering: [0.005802, 0.013558, 0.0331],
  mieScattering: 0.003996,
  mieAbsorption: 0.000444,
  miePhaseG: 0.8,
  ozoneAbsorption: [0.00065, 0.001881, 0.000085],
  groundAlbedo: [0.3, 0.3, 0.3],
  skyIntensity: 1,
};

/** 介质在高度 h（千米，离地面）处的密度：瑞利、米氏、臭氧（Babylon 的 sampleMediumRGB，按 100 km 厚归一化的写法换成千米）。 */
export function mediumDensity(height: number, atmosphereHeight: number): [number, number, number] {
  const normalized = Math.min(Math.max(height / atmosphereHeight, 0), 1);
  const ozone = normalized < 0.25
    ? 0.135 + 0.865 * Math.max(0, normalized - 0.15) / 0.1
    : Math.max(0, 1 - (normalized - 0.25) / 0.35) ** 2;
  return [Math.exp(-12.5 * normalized), Math.exp(-83.333 * normalized), ozone];
}

/**
 * 从 position（千米，星球中心为原点）朝 directionToSun 到大气层顶的透射率（被地面挡住时是 0）。CPU 上积分，太阳的直射光每帧用一次。
 */
export function sunTransmittance(settings: AtmosphereSettings, position: readonly [number, number, number], directionToSun: readonly [number, number, number], samples = 40): [number, number, number] {
  const top = settings.planetRadius + settings.atmosphereHeight;
  if (rayHitsSphere(position, directionToSun, settings.planetRadius) > 0) return [0, 0, 0];
  const length = rayHitsSphere(position, directionToSun, top);
  if (length <= 0) return [1, 1, 1];
  const mieExtinction = settings.mieScattering + settings.mieAbsorption;
  const depth = [0, 0, 0];
  const dt = length / samples;
  for (let i = 0; i < samples; i++) {
    const t = (i + 0.5) * dt;
    const p = [position[0] + directionToSun[0] * t, position[1] + directionToSun[1] * t, position[2] + directionToSun[2] * t];
    const [rayleigh, mie, ozone] = mediumDensity(Math.hypot(p[0]!, p[1]!, p[2]!) - settings.planetRadius, settings.atmosphereHeight);
    for (let c = 0; c < 3; c++) depth[c]! += (rayleigh * settings.rayleighScattering[c]! + mie * mieExtinction + ozone * settings.ozoneAbsorption[c]!) * dt;
  }
  return [Math.exp(-depth[0]!), Math.exp(-depth[1]!), Math.exp(-depth[2]!)];
}

/** 射线到球面（中心在原点）的最远交点的距离；从球里出发时是出去的那一点，碰不到时是 -1。 */
function rayHitsSphere(origin: readonly number[], direction: readonly number[], radius: number): number {
  const b = origin[0]! * direction[0]! + origin[1]! * direction[1]! + origin[2]! * direction[2]!;
  const c = origin[0]! ** 2 + origin[1]! ** 2 + origin[2]! ** 2 - radius * radius;
  const discriminant = b * b - c;
  if (discriminant < 0) return -1;
  const root = Math.sqrt(discriminant);
  // 球外出发且朝外：碰不到
  if (c > 0 && b > 0) return -1;
  return c > 0 ? -b - root : -b + root;
}

/** uniform Atmosphere 的大小（12 个 vec4）。 */
const ATMOSPHERE_FLOATS = 48;
/**
 * 天空立方体和镜面贴图的边长。64 不够：粗糙度 0.5 的表面落在第 3、4 级（每面 8²、4²），双线性插值的折线在地面的反射里成了
 * 一圈圈的环。
 */
const SKY_CUBE_SIZE = 128;
const SPECULAR_SIZE = 128;
/** 球谐用的那一级（32²）。 */
const SH_LEVEL = 2;
/** 预滤波每级的采样数（第 0 级只重采样）：粗糙度低的级别纹素多、波瓣窄，少采；粗糙的级别纹素少，多采。 */
const PREFILTER_SAMPLES = [1, 32, 64, 128, 256];
const FORMAT: GPUTextureFormat = 'rgba16float';

/** 大气算出来的天空光（代替场景的天空盒光，见 SkyboxLight.skybox）：镜面立方体贴图和漫反射的球谐。 */
export class DynamicSky {
  readonly name = 'SkyAtmosphere';
  /** 9 个 RGB 系数，约定同 Skybox.diffuseSH；GPU 算好读回来之前是 0。 */
  readonly diffuseSH = new Float32Array(27);
  readonly specularLevels = Math.log2(SPECULAR_SIZE) + 1;
  readonly specular: GPUTexture;

  constructor(device: GPUDevice) {
    this.specular = device.createTexture({ label: 'SkyAtmosphere specular', size: [SPECULAR_SIZE, SPECULAR_SIZE, 6], format: FORMAT, mipLevelCount: this.specularLevels, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT });
  }
}

/** 天上的一盏光（太阳或者月亮）这一帧的状态。 */
export interface CelestialBody {
  /** 场景里有没有它（对应的方向光在这一帧的光照里）。 */
  present: boolean;
  /** 它那盏方向光的实体；没有时是 -1。 */
  entity: EntityId;
  /** 朝它的方向（世界，单位向量）。 */
  readonly direction: [number, number, number];
  /** 大气层顶的照度（光的颜色 · 强度；月亮的乘了月相）。 */
  readonly illuminance: [number, number, number];
  /** 圆盘的角半径（弧度）。 */
  angularRadius: number;
}

function celestialBody(): CelestialBody {
  return { present: false, entity: -1 as EntityId, direction: [0, 1, 0], illuminance: [0, 0, 0], angularRadius: 0.00465 };
}

/** 落到地平线以下这么多（sin 高度角）以后不再算它的散射：天文昏影（-18°）已经结束，贡献是 0。 */
const NO_SCATTERING_BELOW = -0.35;

/**
 * 场景的大气（渲染系统一份）：前向渲染器收集光照时 apply（找 SkyAtmosphere、调太阳和月亮的颜色、换天空光），网格之前
 * AtmosphereRenderFeature 的 prepare 里 update（该重算的查找表和天空光录进自己的编码器提交），画天空时 draw。
 */
export class Atmosphere {
  /** 这一帧有没有大气（场景里有 SkyAtmosphere，也有太阳或者月亮）。 */
  active = false;
  readonly settings: AtmosphereSettings = structuredClone(EARTH_ATMOSPHERE) as AtmosphereSettings;
  readonly sun = celestialBody();
  readonly moon = celestialBody();
  /** 月相：月面被太阳照亮的比例（0 新月，1 满月）。 */
  moonPhase = 1;
  /** 相机离地面的高度（千米）。 */
  cameraHeight = 0;
  /** 空气透视的距离倍数（SkyAtmosphere.aerialPerspectiveScale）；0 是不做。 */
  aerialPerspectiveScale = 1;
  /**
   * 叠在天空的环境光上的东西（体积云每帧设）：一张立方体（rgb 散射，a 透射，Stride 的立方体约定）和它的版本号，版本变了
   * 环境光重算。没有时是 undefined。
   */
  environmentOverlay: { readonly cube: GPUTexture; readonly version: number } | undefined;
  /** 星星的亮度（SkyAtmosphere.starsIntensity，白天淡到 0）。 */
  starsIntensity = 0;
  readonly #device: GPUDevice;
  readonly #resources: GpuResources;
  #gpu: AtmosphereGpu | undefined;
  #sky: DynamicSky | undefined;
  #skyLight: SkyboxLight | undefined;
  /** 上次算查找表、天空视图、环境光时的键；没变就不算。 */
  #lutKey = '';
  #skyKey = '';
  #lightingKey = '';
  #reading = false;
  // SkyAtmosphere 这一帧的值
  #sunEntity = -1 as EntityId;
  #moonEntity = -1 as EntityId;
  #moonDiskIntensity = 0;
  #stars = 0;
  /** 月面被照亮的地方的亮度（满月的照度 · moonDiskIntensity）。 */
  readonly #moonDisk: [number, number, number] = [0, 0, 0];
  /** 世界到天球坐标的旋转（三行，每行补一个 0）：SkyAtmosphere 所在实体的三个轴。 */
  readonly #celestial = new Float32Array(12);

  readonly #collect = system('Atmosphere.collect', {
    with: { atmosphere: SkyAtmosphere, transform: Transform },
    update: ({ atmosphere, transform, count }) => {
      if (count === 0 || this.active) return;
      this.active = true;
      const s = this.settings;
      s.planetRadius = atmosphere.planetRadius[0]!;
      s.atmosphereHeight = atmosphere.atmosphereHeight[0]!;
      s.rayleighScattering = [atmosphere.rayleighScattering[0]!, atmosphere.rayleighScattering[1]!, atmosphere.rayleighScattering[2]!];
      s.mieScattering = atmosphere.mieScattering[0]!;
      s.mieAbsorption = atmosphere.mieAbsorption[0]!;
      s.miePhaseG = atmosphere.miePhaseG[0]!;
      s.ozoneAbsorption = [atmosphere.ozoneAbsorption[0]!, atmosphere.ozoneAbsorption[1]!, atmosphere.ozoneAbsorption[2]!];
      s.groundAlbedo = [atmosphere.groundAlbedo[0]!, atmosphere.groundAlbedo[1]!, atmosphere.groundAlbedo[2]!];
      s.skyIntensity = atmosphere.skyIntensity[0]!;
      this.aerialPerspectiveScale = atmosphere.aerialPerspectiveScale[0]!;
      this.#sunEntity = atmosphere.sun[0]! as EntityId;
      this.#moonEntity = atmosphere.moon[0]! as EntityId;
      this.#moonDiskIntensity = atmosphere.moonDiskIntensity[0]!;
      this.#stars = atmosphere.starsIntensity[0]!;
      // 世界矩阵的三列（实体的三个轴，归一化掉缩放）就是世界到天球坐标的旋转的三行
      const w = transform.slot[0]! * 16;
      for (let axis = 0; axis < 3; axis++) {
        const x = transform.world[w + axis * 4]!, y = transform.world[w + axis * 4 + 1]!, z = transform.world[w + axis * 4 + 2]!;
        const length = Math.hypot(x, y, z) || 1;
        this.#celestial.set([x / length, y / length, z / length], axis * 4);
      }
    },
  });

  constructor(device: GPUDevice, resources: GpuResources) {
    this.#device = device;
    this.#resources = resources;
  }

  /**
   * 收集光照之后（前向渲染器调）：场景里有 SkyAtmosphere 时，太阳和月亮的颜色乘相机处的透射率（月亮的再乘月相；沉到地平线
   * 以下是黑的），天空盒光换成大气的。eye 是主相机的位置（米）。
   */
  apply(context: RenderContext, lighting: Lighting, eye: { readonly x: number; readonly y: number; readonly z: number }): void {
    this.active = false;
    context.game.entities.run(this.#collect, context.time);
    if (!this.active) return;
    const lights = lighting.directionals.slice(0, lighting.directionalCount);
    const moonLight = this.#moonEntity < 0 ? undefined : lights.find((light) => light.entity === this.#moonEntity);
    const sunLight = this.#sunEntity < 0
      ? lights.find((light) => light !== moonLight && light.shadow) ?? lights.find((light) => light !== moonLight)
      : lights.find((light) => light.entity === this.#sunEntity);
    if (!sunLight && !moonLight) {
      this.active = false;
      return;
    }
    this.cameraHeight = Math.max(eye.y / 1000, 0.001);
    place(this.sun, sunLight);
    place(this.moon, moonLight);
    // 月相：月亮在太阳对面是满月，挨着太阳是新月。没有太阳的场景当满月
    const [sun, moon] = [this.sun.direction, this.moon.direction];
    this.moonPhase = sunLight ? (1 - (sun[0] * moon[0] + sun[1] * moon[1] + sun[2] * moon[2])) / 2 : 1;
    for (let c = 0; c < 3; c++) {
      this.#moonDisk[c] = this.moon.illuminance[c]! * this.#moonDiskIntensity;
      this.moon.illuminance[c]! *= this.moonPhase;
    }
    for (const [body, light] of [[this.sun, sunLight], [this.moon, moonLight]] as const) {
      if (!light) continue;
      const [r, g, b] = this.transmittanceTo(body, this.cameraHeight);
      light.color.set(body.illuminance[0] * r, body.illuminance[1] * g, body.illuminance[2] * b, 1);
    }
    // 星星：太阳在地平线上下 6° 之间淡入淡出（再往后天空亮的地方由着色器按对比度盖掉），白天不画
    const day = sunLight && this.sun.illuminance.some((v) => v > 0) ? smoothstep(-0.1, 0.1, sun[1]) : 0;
    this.starsIntensity = this.#stars * (1 - day);
    this.#sky ??= new DynamicSky(this.#device);
    // 天空盒的约定是乘实体的旋转；大气的天空光已经在世界坐标里。强度已经乘进天空的亮度里
    this.#skyLight ??= { skybox: this.#sky, intensity: 1, rotation: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) };
    lighting.skybox = this.#skyLight;
  }

  /** 该重算的查找表、天空光录进一个编码器提交（在这一帧的画面之前执行）。 */
  update(): void {
    if (!this.active) return;
    const gpu = (this.#gpu ??= new AtmosphereGpu(this.#device, this.#resources));
    gpu.writeUniforms(this.#uniforms());
    const s = this.settings;
    const lutKey = JSON.stringify([s.planetRadius, s.atmosphereHeight, s.rayleighScattering, s.mieScattering, s.mieAbsorption, s.miePhaseG, s.ozoneAbsorption, s.groundAlbedo]);
    // 看得见的天空：太阳、月亮的方向变化约 0.05° 以内、相机高度变化 1 m 以内、亮度不变时不重算。环境光（立方体、球谐、预滤波，
    // 约 1 ms）粗一档：动了约 0.5°、亮度变了 2% 才重算，日夜循环时不每帧都算
    // 星星的亮度带着夜空的底光（进天空的环境光），黄昏时一点点亮起来：按 5% 一档
    const sky = [lutKey, Math.round(this.cameraHeight * 1000), s.skyIntensity, Math.round(this.starsIntensity * 20)];
    const bodies = [this.sun, this.moon].map((body) => ({ direction: body.direction, illuminance: this.#scattering(body) }));
    const skyKey = JSON.stringify([...sky, bodies.map((body) => [body.direction.map((v) => Math.round(v * 1000)), body.illuminance])]);
    const lightingKey = JSON.stringify([...sky, this.environmentOverlay?.version ?? -1, bodies.map((body) => [body.direction.map((v) => Math.round(v * 100)), body.illuminance.map((v) => Math.round(Math.log(Math.max(v, 1e-6)) * 50))])]);
    const skyChanged = lutKey !== this.#lutKey || skyKey !== this.#skyKey;
    const lighting = lightingKey !== this.#lightingKey;
    if (!skyChanged && !lighting) return;
    const encoder = this.#device.createCommandEncoder({ label: 'Atmosphere' });
    if (lutKey !== this.#lutKey) gpu.recordLuts(encoder);
    if (skyChanged) gpu.recordSkyView(encoder);
    if (lighting) gpu.recordLighting(encoder, this.#sky!, this.environmentOverlay?.cube);
    this.#device.queue.submit([encoder.finish()]);
    this.#lutKey = lutKey;
    this.#skyKey = skyKey;
    this.#lightingKey = lightingKey;
    if (lighting) this.#readSphericalHarmonics(gpu);
  }

  /**
   * 天空朝上（或者朝下）的半球的平均亮度（环境光的球谐在正上、正下方的值；云的环境光用）。球谐还没读回来时是 0。
   * 第四个数是 0（凑成 vec4）。
   */
  skyRadiance(up: boolean): [number, number, number, number] {
    const sh = this.#sky?.diffuseSH;
    if (!sh) return [0, 0, 0, 0];
    // evaluateSH 在 (0, ±1, 0)：c0 ± c1 - c6 - c8
    const value = (c: number) => Math.max(sh[c]! + (up ? 1 : -1) * sh[3 + c]! - sh[18 + c]! - sh[24 + c]!, 0);
    return [value(0), value(1), value(2), 0];
  }

  /** 这一帧做不做空气透视（前向渲染器据此留着深度缓冲、在不透明的之后合成）。 */
  get aerialPerspective(): boolean {
    return this.active && this.aerialPerspectiveScale > 0 && this.#gpu !== undefined;
  }

  /** 画天空用的（AtmosphereRenderFeature）。 */
  get gpu(): AtmosphereGpu | undefined {
    return this.active ? this.#gpu : undefined;
  }

  destroy(): void {
    this.#gpu?.destroy();
    this.#sky?.specular.destroy();
  }

  /**
   * 海拔 height（千米）处朝 body 的透射率，乘圆盘露在地平线上面的比例（圆盘沉下去的那一两分钟里平滑地暗掉，不是圆心一过
   * 地平线就黑）。圆心已经在地平线下面时按贴着地平线的方向算。越高地平线越低：云在地面天黑以后还被照着。
   */
  transmittanceTo(body: CelestialBody, height: number): [number, number, number] {
    const radius = this.settings.planetRadius + height;
    const horizon = -Math.acos(Math.min(this.settings.planetRadius / radius, 1));
    const [x, y, z] = body.direction;
    const elevation = Math.asin(Math.min(Math.max(y, -1), 1));
    const visible = smoothstep(horizon - body.angularRadius, horizon + body.angularRadius, elevation);
    if (visible <= 0) return [0, 0, 0];
    const lifted = Math.max(elevation, horizon + 1e-4);
    const flat = Math.hypot(x, z);
    const direction: [number, number, number] = flat > 1e-6 ? [(x / flat) * Math.cos(lifted), Math.sin(lifted), (z / flat) * Math.cos(lifted)] : [0, 1, 0];
    const [r, g, b] = sunTransmittance(this.settings, [0, radius, 0], direction);
    return [r * visible, g * visible, b * visible];
  }

  /** body 照进大气散射的照度（乘了天空的亮度）：没有它、或者落到地平线以下很多时是 0，着色器就不算它。 */
  #scattering(body: CelestialBody): number[] {
    const lit = body.present && body.direction[1] > NO_SCATTERING_BELOW;
    return body.illuminance.map((v) => (lit ? v * this.settings.skyIntensity : 0));
  }

  #uniforms(): Float32Array {
    const s = this.settings;
    // 没有这个天体时角半径的余弦给 2：视线和它的夹角的余弦永远到不了，不画圆盘
    const cosDisk = (body: CelestialBody) => (body.present ? Math.cos(body.angularRadius) : 2);
    return new Float32Array([
      ...s.rayleighScattering, s.planetRadius,
      s.mieScattering, s.mieScattering + s.mieAbsorption, s.miePhaseG, s.planetRadius + s.atmosphereHeight,
      ...s.ozoneAbsorption, s.atmosphereHeight,
      ...s.groundAlbedo, s.planetRadius + this.cameraHeight,
      ...this.sun.direction, cosDisk(this.sun),
      ...this.#scattering(this.sun), 1e4,
      ...this.moon.direction, cosDisk(this.moon),
      ...this.#scattering(this.moon), 0,
      ...this.#moonDisk, this.starsIntensity,
      ...this.#celestial,
    ]);
  }

  /** 球谐在 GPU 上算好后读回来（上一次还没读完时这次不读，晚一两帧用上）。 */
  #readSphericalHarmonics(gpu: AtmosphereGpu): void {
    if (this.#reading) return;
    this.#reading = true;
    const encoder = this.#device.createCommandEncoder({ label: 'Atmosphere SH readback' });
    encoder.copyBufferToBuffer(gpu.shResult, 0, gpu.shReadback, 0, 28 * 4);
    this.#device.queue.submit([encoder.finish()]);
    gpu.shReadback.mapAsync(GPUMapMode.READ).then(() => {
      const values = new Float32Array(gpu.shReadback.getMappedRange().slice(0, 27 * 4));
      gpu.shReadback.unmap();
      if (values.every(Number.isFinite)) this.#sky?.diffuseSH.set(values);
    }, () => {}).finally(() => {
      this.#reading = false;
    });
  }
}

/** 把这一帧的方向光记成天体：朝它的方向、大气层顶的照度、角半径。没有这盏光时照度是 0，方向留着上一帧的。 */
function place(body: CelestialBody, light: DirectionalLight | undefined): void {
  body.present = light !== undefined;
  body.entity = light?.entity ?? (-1 as EntityId);
  if (!light) {
    body.illuminance.fill(0);
    return;
  }
  const length = Math.hypot(light.direction.x, light.direction.y, light.direction.z) || 1;
  body.direction.splice(0, 3, -light.direction.x / length, -light.direction.y / length, -light.direction.z / length);
  body.illuminance.splice(0, 3, light.color.r, light.color.g, light.color.b);
  body.angularRadius = Math.max((light.angle / 2) * (Math.PI / 180), 1e-4);
}

function smoothstep(low: number, high: number, value: number): number {
  const t = Math.min(Math.max((value - low) / (high - low), 0), 1);
  return t * t * (3 - 2 * t);
}

type ComputeName = 'transmittance' | 'multiScattering' | 'skyView' | 'skyCube' | 'sh' | 'aerial';

/** 大气的 GPU 资源：查找表、计算管线、画天空的管线。 */
export class AtmosphereGpu {
  readonly uniforms: GPUBuffer;
  readonly transmittance: GPUTexture;
  readonly multiScattering: GPUTexture;
  readonly skyView: GPUTexture;
  readonly skyCube: GPUTexture;
  readonly shResult: GPUBuffer;
  readonly shReadback: GPUBuffer;
  readonly skyModule: GPUShaderModule;
  readonly skyLayout: GPUBindGroupLayout;
  readonly viewLayout: GPUBindGroupLayout;
  readonly skyBindGroup: GPUBindGroup;
  /** 查天空视图表用：u 是方位角，首尾相接。 */
  readonly skySampler: GPUSampler;
  /** 环境光上没有叠东西时绑的立方体：1x1，(0, 0, 0, 1)（什么都不加、什么都不挡）。 */
  readonly #noOverlay: GPUTexture;
  readonly #device: GPUDevice;
  readonly #resources: GpuResources;
  readonly #pipelines: Record<ComputeName, GPUComputePipeline>;
  /** 空气透视的体素表和这一帧的相机。 */
  readonly aerial: GPUTexture;
  readonly camera: GPUBuffer;
  readonly #compositeModule: GPUShaderModule;
  readonly #compositeLayout: GPUBindGroupLayout;
  readonly #composites = new Map<GPUTextureFormat, GPURenderPipeline>();

  constructor(device: GPUDevice, resources: GpuResources) {
    this.#device = device;
    this.#resources = resources;
    const storage = GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING;
    this.#noOverlay = device.createTexture({ label: 'Atmosphere no overlay', size: [1, 1, 6], format: FORMAT, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    for (let face = 0; face < 6; face++) device.queue.writeTexture({ texture: this.#noOverlay, origin: [0, 0, face] }, new Uint16Array([0, 0, 0, 0x3c00]), {}, [1, 1]);
    this.skySampler = device.createSampler({ label: 'Atmosphere sky view', magFilter: 'linear', minFilter: 'linear', addressModeU: 'repeat', addressModeV: 'clamp-to-edge' });
    this.uniforms = device.createBuffer({ label: 'Atmosphere', size: ATMOSPHERE_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.transmittance = device.createTexture({ label: 'Atmosphere transmittance', size: [256, 64], format: FORMAT, usage: storage });
    this.multiScattering = device.createTexture({ label: 'Atmosphere multiple scattering', size: [32, 32], format: FORMAT, usage: storage });
    this.skyView = device.createTexture({ label: 'Atmosphere sky view', size: [192, 108], format: FORMAT, usage: storage });
    this.skyCube = device.createTexture({ label: 'Atmosphere sky cube', size: [SKY_CUBE_SIZE, SKY_CUBE_SIZE, 6], format: FORMAT, mipLevelCount: Math.log2(SKY_CUBE_SIZE) + 1, usage: storage });
    this.shResult = device.createBuffer({ label: 'Atmosphere SH', size: 28 * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    this.shReadback = device.createBuffer({ label: 'Atmosphere SH readback', size: 28 * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const compute = (label: string, code: string) => device.createComputePipeline({ label: `Atmosphere ${label}`, layout: 'auto', compute: { module: device.createShaderModule({ label: `Atmosphere ${label}`, code }), entryPoint: 'main' } });
    this.#pipelines = {
      transmittance: compute('transmittance', TRANSMITTANCE_SHADER),
      multiScattering: compute('multiple scattering', MULTI_SCATTERING_SHADER),
      skyView: compute('sky view', SKY_VIEW_SHADER),
      skyCube: compute('sky cube', SKY_CUBE_SHADER),
      sh: compute('spherical harmonics', SH_SHADER),
      aerial: compute('aerial perspective', AERIAL_SHADER),
    };
    this.aerial = device.createTexture({ label: 'Atmosphere aerial perspective', size: [32, 32, 32], dimension: '3d', format: FORMAT, usage: storage });
    this.camera = device.createBuffer({ label: 'Atmosphere camera', size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.#compositeModule = device.createShaderModule({ label: 'Atmosphere aerial perspective composite', code: AERIAL_COMPOSITE_SHADER });
    this.#compositeLayout = device.createBindGroupLayout({
      label: 'Atmosphere aerial perspective composite',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: '3d' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      ],
    });
    this.skyModule = device.createShaderModule({ label: 'Atmosphere sky', code: SKY_SHADER });
    this.skyLayout = device.createBindGroupLayout({
      label: 'Atmosphere sky',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      ],
    });
    this.viewLayout = device.createBindGroupLayout({ label: 'Atmosphere view', entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform', hasDynamicOffset: true } }] });
    this.skyBindGroup = device.createBindGroup({
      layout: this.skyLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniforms } },
        { binding: 1, resource: this.skyView.createView() },
        { binding: 2, resource: this.transmittance.createView() },
        { binding: 3, resource: resources.linearClamp },
        { binding: 4, resource: this.skySampler },
      ],
    });
  }

  writeUniforms(data: Float32Array): void {
    this.#device.queue.writeBuffer(this.uniforms, 0, data);
  }

  /** 透射率表，然后多次散射表（它要透射率表）。 */
  recordLuts(encoder: GPUCommandEncoder): void {
    const linear = this.#resources.linearClamp;
    this.#dispatch(encoder, 'transmittance', [{ binding: 0, resource: { buffer: this.uniforms } }, { binding: 1, resource: this.transmittance.createView() }], [32, 8, 1]);
    this.#dispatch(encoder, 'multiScattering', [
      { binding: 0, resource: { buffer: this.uniforms } },
      { binding: 1, resource: this.multiScattering.createView() },
      { binding: 2, resource: this.transmittance.createView() },
      { binding: 3, resource: linear },
    ], [4, 4, 1]);
  }

  /** 天空视图表（画天空用，也是环境光的来源）。 */
  recordSkyView(encoder: GPUCommandEncoder): void {
    this.#dispatch(encoder, 'skyView', [
      { binding: 0, resource: { buffer: this.uniforms } },
      { binding: 1, resource: this.skyView.createView() },
      { binding: 2, resource: this.transmittance.createView() },
      { binding: 3, resource: this.#resources.linearClamp },
      { binding: 4, resource: this.multiScattering.createView() },
    ], [24, 14, 1]);
  }

  /** 环境光：天空立方体（每级 mip），球谐，镜面预滤波。天空视图表要先算好。 */
  recordLighting(encoder: GPUCommandEncoder, sky: DynamicSky, overlay?: GPUTexture): void {
    const clouds = (overlay ?? this.#noOverlay).createView({ dimension: 'cube' });
    for (let level = 0; level < this.skyCube.mipLevelCount; level++) {
      const size = Math.max(1, SKY_CUBE_SIZE >> level);
      this.#dispatch(encoder, 'skyCube', [
        { binding: 0, resource: { buffer: this.uniforms } },
        { binding: 1, resource: this.skyCube.createView({ dimension: '2d-array', baseMipLevel: level, mipLevelCount: 1 }) },
        { binding: 2, resource: this.skyView.createView() },
        { binding: 3, resource: this.skySampler },
        { binding: 4, resource: clouds },
      ], [Math.ceil(size / 8), Math.ceil(size / 8), 6]);
    }
    this.#dispatch(encoder, 'sh', [
      { binding: 0, resource: this.skyCube.createView({ dimension: '2d-array', baseMipLevel: SH_LEVEL, mipLevelCount: 1 }) },
      { binding: 1, resource: { buffer: this.shResult } },
    ], [1, 1, 1]);
    this.#resources.prefilter.record(encoder, this.skyCube, sky.specular, 0, PREFILTER_SAMPLES);
  }

  /**
   * 空气透视（录进这一帧的编码器）：按 view 的相机算体素表，再按 depth 合成进 target（不透明的画完之后）。scale 是距离的倍数。
   */
  recordAerialPerspective(encoder: GPUCommandEncoder, view: RenderView, scale: number, target: GPUTextureView, format: GPUTextureFormat, depth: GPUTexture): void {
    this.#device.queue.writeBuffer(this.camera, 0, new Float32Array([...view.inverseViewProjection, view.eye.x, view.eye.y, view.eye.z, scale]));
    this.#dispatch(encoder, 'aerial', [
      { binding: 0, resource: { buffer: this.uniforms } },
      { binding: 1, resource: this.aerial.createView() },
      { binding: 2, resource: this.transmittance.createView() },
      { binding: 3, resource: this.#resources.linearClamp },
      { binding: 4, resource: this.multiScattering.createView() },
      { binding: 5, resource: { buffer: this.camera } },
    ], [4, 4, 1]);
    const pass = encoder.beginRenderPass({ label: 'Atmosphere aerial perspective', colorAttachments: [{ view: target, loadOp: 'load', storeOp: 'store' }] });
    pass.setPipeline(this.#compositeFor(format));
    pass.setBindGroup(0, this.#device.createBindGroup({
      layout: this.#compositeLayout,
      entries: [
        { binding: 0, resource: this.aerial.createView() },
        { binding: 1, resource: depth.createView() },
        { binding: 2, resource: this.#resources.linearClamp },
        { binding: 3, resource: { buffer: this.camera } },
      ],
    }));
    pass.draw(3);
    pass.end();
  }

  destroy(): void {
    for (const texture of [this.transmittance, this.multiScattering, this.skyView, this.skyCube, this.aerial, this.#noOverlay]) texture.destroy();
    for (const buffer of [this.uniforms, this.shResult, this.shReadback, this.camera]) buffer.destroy();
  }

  /** 合成的管线：颜色 = 散射 + 颜色 · 透射（alpha）。 */
  #compositeFor(format: GPUTextureFormat): GPURenderPipeline {
    let pipeline = this.#composites.get(format);
    if (!pipeline) {
      pipeline = this.#device.createRenderPipeline({
        label: `Atmosphere aerial perspective ${format}`,
        layout: this.#device.createPipelineLayout({ bindGroupLayouts: [this.#compositeLayout] }),
        vertex: { module: this.#compositeModule, entryPoint: 'fullscreenVertex' },
        fragment: {
          module: this.#compositeModule,
          entryPoint: 'fs',
          targets: [{ format, blend: { color: { srcFactor: 'one', dstFactor: 'src-alpha', operation: 'add' }, alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' } } }],
        },
      });
      this.#composites.set(format, pipeline);
    }
    return pipeline;
  }

  #dispatch(encoder: GPUCommandEncoder, name: ComputeName, entries: GPUBindGroupEntry[], groups: [number, number, number]): void {
    const pipeline = this.#pipelines[name];
    const pass = encoder.beginComputePass({ label: `Atmosphere ${name}` });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, this.#device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries }));
    pass.dispatchWorkgroups(...groups);
    pass.end();
  }
}
