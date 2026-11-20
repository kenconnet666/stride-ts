/**
 * 体积云（VolumetricClouds 组件；Stride 没有）：Schneider 2015 "The Real-time Volumetric Cloudscapes of Horizon Zero Dawn"
 * 的做法，对照 PlayCanvas 的 dynamic-sky（MIT，云的部分改自 Godot 的 sky shaders 示例，MIT）。要场景里有物理天空
 * （SkyAtmosphere）：光照、天空的颜色、星球的大小都从大气来。
 *
 * - 云在一层球壳里（云底到云顶，按星球的曲率弯下去，所以远处的云沉到地平线）。密度 = 形状噪声 · 高度上的轮廓，减掉
 *   （1 - 覆盖），边上再用细节噪声啃掉一圈。覆盖在大尺度上按一张天气噪声变，所以天上是一块一块的云，不是均匀的一层。
 * - 噪声是程序生成的（一张 128³ 的三维贴图，第一次用时计算着色器分几帧算完，算完之前不画云）：R 是形状（Perlin-Worley），G 是细节（Worley 的
 *   分形和），B 是天气（低频 Perlin）。三个方向都首尾相接。
 * - 每个像素沿视线在球壳里走几十步，有云的地方再朝主光走几步算透射。主光是太阳、月亮里在云的高度上更亮的那个（云比地面
 *   高，日落以后还被照着）；多次散射用几个倍频近似（Wrenninge 2013）；环境光是天空的球谐朝上、朝下两个方向的值。
 * - 半分辨率算，每帧把起点抖一下，和上一帧的结果按方向重投影后混合（云远、变得慢，十几帧收敛成平滑的结果）；然后合成进
 *   画面：只画在天空的像素上（深度是 1），颜色 = 天空 · 云的透射 + 云的散射。云到相机之间的大气按平均距离淡向天空的颜色。
 * - 云在地面上的影子：云重复的那一个周期画成一张透射率的图（影子图，朝主光走 16 步），网格着色时按地面点的位置查，乘在
 *   主光上。云的图案在水平方向上是周期的，所以一张图管整个世界；风吹着走只改采样的偏移，云和光的方向变了才重画。
 * - 环境光里的云：从相机的位置把云画进一张 64² 的立方体（步数比画面的少），大气合成天空的环境光时叠上去，所以球谐和
 *   镜面（包括反射探针拍到的天空）里都有云：阴天时环境光是云的灰白色。云、主光变了或者风吹了几秒才重画。
 * - 还没做：相机在云里或者云上面时地面的物体不被云挡（云只盖天空的像素）、
 *   穿过云的光柱（体积光那一项）。
 */
import type { EntityId } from '../../data/prop';
import { system } from '../../engine/system';
import type { GameTime } from '../../engine/GameTime';
import type { Atmosphere } from './Atmosphere';
import { COMPOSITE_SHADER, ENVIRONMENT_SHADER, MARCH_SHADER, NOISE_SHADER, SHADOW_SHADER } from './cloudShaders';
import { IRRADIANCE_PER_INTENSITY } from './lightUnits';
import { VolumetricClouds } from '../components';
import type { RenderContext, RenderView } from '../RenderSystem';

/** 噪声贴图的边长（64 时小块的云看得出一个个纹素），和一帧生成几层（分几帧算完，不在一帧里卡一下）。 */
const NOISE_SIZE = 128;
const NOISE_SLICES_PER_FRAME = 16;
/** 形状噪声重复一次是多少千米（scale 是 1 时）。 */
const SHAPE_PERIOD_KM = 9;
/** 一条视线最多走几步、朝光走几步。 */
const VIEW_STEPS = 64;
const LIGHT_STEPS = 5;
/** 和上一帧混合时这一帧占的比重。 */
const HISTORY_BLEND = 0.1;
/** 云的消光系数（每千米，密度是 1 时；真实的积云在 50 到 120 之间）。 */
const EXTINCTION_PER_KM = 60;
const FORMAT: GPUTextureFormat = 'rgba16float';
/** 云在水平方向上每几个形状的周期重复一次（着色器里的 1 / WEATHER_SCALE），和影子图的边长（一个周期 72 km 时一个纹素 140 m）。 */
const SHAPE_PERIODS = 8;
const SHADOW_SIZE = 512;
/** 环境光里的云：立方体的边长，一条视线走几步、朝光走几步（比画面的少：只要大致的明暗和颜色），风吹着走时隔几秒重画。 */
const ENVIRONMENT_SIZE = 64;
const ENVIRONMENT_STEPS = 24;
const ENVIRONMENT_LIGHT_STEPS = 3;
const ENVIRONMENT_INTERVAL = 5;

/** 云在地面上的影子（网格的着色器用，见 Clouds.shadow）。 */
export interface CloudShadow {
  /** 一个周期的透射率（r8unorm，采样器要 repeat）。 */
  readonly texture: GPUTexture;
  /** 贴图坐标 = 地面点的水平位置（米）· scale + offset。 */
  readonly scale: number;
  readonly offset: readonly [number, number];
  /** 被云挡着的那盏方向光的实体。 */
  readonly lightEntity: EntityId;
}
const UNIFORM_FLOATS = 68;

/** 云这一帧的设置（VolumetricClouds 组件的值）。 */
export interface CloudSettings {
  coverage: number;
  density: number;
  /** 云底的海拔和云层的厚度（米）。 */
  bottom: number;
  thickness: number;
  cloudType: number;
  scale: number;
  windSpeed: number;
  windDirection: number;
}

/**
 * 场景的体积云（渲染系统一份）：前向渲染器收集光照之后 apply（找 VolumetricClouds、让风吹着走），主画面不透明的画完以后
 * record（步进、和上一帧混合、合成进画面）。
 */
export class Clouds {
  /** 这一帧画不画云（场景里有 VolumetricClouds，也有物理天空）。 */
  active = false;
  readonly settings: CloudSettings = { coverage: 0.5, density: 1, bottom: 1500, thickness: 2500, cloudType: 0.7, scale: 1, windSpeed: 10, windDirection: 0 };
  /** 风吹出来的偏移（千米）：形状的和细节的（细节飘得快一点，云的边在变）。 */
  readonly offset: [number, number, number, number] = [0, 0, 0, 0];
  readonly #device: GPUDevice;
  readonly #atmosphere: Atmosphere;
  #gpu: CloudsGpu | undefined;
  #found = false;
  #frame = 0;
  /** 主光：太阳、月亮里在云的高度上更亮的那个（apply 时定）。 */
  #light: { direction: readonly number[]; color: readonly number[]; entity: EntityId } = { direction: [0, 1, 0], color: [0, 0, 0], entity: -1 as EntityId };
  /** 上次画影子图时的云和光；没变就不重画。 */
  #shadowKey = '';
  /** 上次画环境光里的云时的云、光、相机的高度和时间段；版本号每重画一次加一（大气据此重算环境光）。 */
  #environmentKey = '';
  #environmentVersion = 0;
  /** 主相机的位置（米；步进时记下，环境光里的云从这里看）和游戏时间。 */
  readonly #eye: [number, number, number] = [0, 0, 0];
  #time = 0;

  readonly #collect = system('Clouds.collect', {
    with: { clouds: VolumetricClouds },
    update: ({ clouds, count }) => {
      if (count === 0 || this.#found) return;
      this.#found = true;
      const s = this.settings;
      s.coverage = clouds.coverage[0]!;
      s.density = clouds.density[0]!;
      s.bottom = clouds.bottom[0]!;
      s.thickness = clouds.thickness[0]!;
      s.cloudType = clouds.cloudType[0]!;
      s.scale = clouds.scale[0]!;
      s.windSpeed = clouds.windSpeed[0]!;
      s.windDirection = clouds.windDirection[0]!;
    },
  });

  constructor(device: GPUDevice, atmosphere: Atmosphere) {
    this.#device = device;
    this.#atmosphere = atmosphere;
  }

  /** 大气 apply 之后调：enabled 是画质档位给不给。 */
  apply(context: RenderContext, enabled: boolean): void {
    this.#found = false;
    if (enabled && this.#atmosphere.active) context.game.entities.run(this.#collect, context.time);
    this.active = this.#found && this.settings.coverage > 0 && this.settings.density > 0;
    if (!this.active) {
      this.#atmosphere.environmentOverlay = undefined;
      return;
    }
    this.#drift(context.time);
    this.#time = context.time.total;
    this.#light = this.#mainLight();
  }

  /**
   * 画面之前（AtmosphereRenderFeature 的 prepare 里）：云或者主光的方向变了就重画影子图，录进自己的编码器提交。
   * 风吹着云走不用重画（只是采样的偏移在变）。噪声贴图还没生成完时不画。
   */
  prepare(): void {
    const gpu = this.#gpu;
    if (!this.active || !gpu?.ready) return;
    const s = this.settings;
    this.#prepareEnvironment(gpu);
    // 光的方向约 0.3° 一档：日夜循环时隔几帧画一次；云量、密度、种类 0.01 一档：天气慢慢变的时候也是隔几帧画一次
    const key = JSON.stringify([...steps(s, 100), s.bottom, s.thickness, s.scale, this.#light.direction.map((v) => Math.round(v * 200))]);
    if (key === this.#shadowKey) return;
    this.#shadowKey = key;
    const encoder = this.#device.createCommandEncoder({ label: 'Clouds shadow' });
    gpu.recordShadow(encoder, this.#uniforms(undefined, true));
    this.#device.queue.submit([encoder.finish()]);
  }

  /**
   * 环境光里的云（在大气重算环境光之前调）：云、主光、相机的高度变了，或者风吹了一阵子，就从相机的位置重画云的立方体，
   * 版本号加一，大气跟着重算环境光（球谐和镜面）。阴天时环境光是云的灰白色，不再是晴天的蓝。
   */
  #prepareEnvironment(gpu: CloudsGpu): void {
    const atmosphere = this.#atmosphere.gpu;
    if (!atmosphere) return;
    const s = this.settings;
    const level = (value: number) => Math.round(Math.log(Math.max(value, 1e-5)) * 10);
    const key = JSON.stringify([
      ...steps(s, 50), s.bottom, s.thickness, s.scale,
      this.#light.direction.map((v) => Math.round(v * 50)), this.#light.color.map(level),
      // 相机的高度 100 米一档；云在动的时候隔几秒重画一次（环境光只看大致的分布）
      Math.round(this.#eye[1] / 100), s.windSpeed > 0 ? Math.floor(this.#time / ENVIRONMENT_INTERVAL) : 0,
    ]);
    if (key !== this.#environmentKey) {
      this.#environmentKey = key;
      this.#environmentVersion++;
      const encoder = this.#device.createCommandEncoder({ label: 'Clouds environment' });
      gpu.recordEnvironment(encoder, atmosphere, this.#uniforms(undefined, true, { steps: ENVIRONMENT_STEPS, lightSteps: ENVIRONMENT_LIGHT_STEPS }));
      this.#device.queue.submit([encoder.finish()]);
    }
    this.#atmosphere.environmentOverlay = { cube: gpu.environment, version: this.#environmentVersion };
  }

  /** 云在地面上的影子；不画云、影子图还没画过时是 undefined。 */
  get shadow(): CloudShadow | undefined {
    if (!this.active || !this.#gpu || this.#shadowKey === '' || this.#light.entity < 0) return undefined;
    const period = SHAPE_PERIOD_KM * this.settings.scale * SHAPE_PERIODS;
    return { texture: this.#gpu.shadow, scale: 1 / (period * 1000), offset: [this.offset[0] / period, this.offset[1] / period], lightEntity: this.#light.entity };
  }

  /** 步进这一帧的云、合成进 target（主画面，不透明的画完以后）。depth 是主画面的深度；timestampWrites 量步进那一遍的 GPU 耗时。 */
  record(encoder: GPUCommandEncoder, view: RenderView, target: GPUTextureView, format: GPUTextureFormat, depth: GPUTexture, timestampWrites?: GPURenderPassTimestampWrites): void {
    const atmosphere = this.#atmosphere.gpu;
    if (!this.active || !atmosphere) return;
    const gpu = (this.#gpu ??= new CloudsGpu(this.#device));
    gpu.record(encoder, atmosphere, this.#uniforms(view, gpu.resize(depth.width, depth.height)), target, format, depth, timestampWrites);
    this.#frame = (this.#frame + 1) % 1024;
  }

  destroy(): void {
    this.#gpu?.destroy();
  }

  /** 主光：太阳、月亮里在云的高度上更亮的那个（云比地面高，日落以后还被照着）。 */
  #mainLight(): { direction: readonly number[]; color: readonly number[]; entity: EntityId } {
    const atmosphere = this.#atmosphere;
    const height = (this.settings.bottom + this.settings.thickness / 2) / 1000;
    const luminance = (color: readonly number[]) => 0.2126 * color[0]! + 0.7152 * color[1]! + 0.0722 * color[2]!;
    const [sun, moon] = [atmosphere.sun, atmosphere.moon].map((body) => {
      const transmittance = atmosphere.transmittanceTo(body, height);
      // 云按物理量散射：光的强度换成照度
      return { direction: body.direction, color: body.illuminance.map((v, c) => v * IRRADIANCE_PER_INTENSITY * transmittance[c]!), entity: body.entity };
    });
    return luminance(sun!.color) >= luminance(moon!.color) ? sun! : moon!;
  }

  /** 风：windDirection 是吹向的方位（度，0 是 +Z，90 是 +X），云的图案往那边挪就是采样的位置往反方向偏。 */
  #drift(time: GameTime): void {
    const angle = (this.settings.windDirection * Math.PI) / 180;
    const distance = (this.settings.windSpeed * time.elapsed) / 1000;
    const x = -Math.sin(angle) * distance, z = -Math.cos(angle) * distance;
    this.offset[0] += x;
    this.offset[1] += z;
    // 噪声是周期的：偏移取模，跑久了不丢精度
    const period = SHAPE_PERIOD_KM * this.settings.scale * 64;
    this.offset[0] %= period;
    this.offset[1] %= period;
    this.offset[2] = (this.offset[2] + x * 0.3) % 1;
    this.offset[3] = (this.offset[3] + z * 0.3) % 1;
  }

  /** 着色器的参数；view 没给时（画影子图、环境光里的云）相机的位置是上次步进时记下的，别的相机的项是 0。quality 换步数。 */
  #uniforms(view: RenderView | undefined, firstFrame: boolean, quality = { steps: VIEW_STEPS, lightSteps: LIGHT_STEPS }): Float32Array {
    const s = this.settings;
    const atmosphere = this.#atmosphere;
    const bottom = s.bottom / 1000, top = (s.bottom + s.thickness) / 1000;
    const light = this.#light;
    const data = new Float32Array(UNIFORM_FLOATS);
    if (view) {
      data.set(view.inverseViewProjection, 0);
      data.set(view.previousViewProjection, 16);
      data.set([view.eye.x, view.eye.y, view.eye.z, this.#frame], 32);
      data.set([Math.ceil(view.width / 2), Math.ceil(view.height / 2), view.width, view.height], 64);
      this.#eye.splice(0, 3, view.eye.x, view.eye.y, view.eye.z);
    } else {
      data.set([...this.#eye, 0], 32);
    }
    data.set([bottom, top, s.coverage, EXTINCTION_PER_KM * s.density], 36);
    data.set([1 / (SHAPE_PERIOD_KM * s.scale), 7, s.cloudType, quality.steps], 40);
    data.set(this.offset, 44);
    data.set([...light.direction, quality.lightSteps], 48);
    data.set([...light.color, firstFrame ? 1 : HISTORY_BLEND], 52);
    data.set(atmosphere.skyRadiance(true), 56);
    data.set(atmosphere.skyRadiance(false), 60);
    return data;
  }
}

/** 体积云的 GPU 资源：噪声贴图、云缓冲（这一帧和上一帧的，轮着写）、步进和合成的管线。 */
class CloudsGpu {
  readonly #device: GPUDevice;
  readonly #noise: GPUTexture;
  readonly #noiseSampler: GPUSampler;
  readonly #uniforms: GPUBuffer;
  /** 环境光里的云：立方体（每级 mip 各算一遍）、参数和计算管线。 */
  readonly environment: GPUTexture;
  readonly #environmentUniforms: GPUBuffer;
  readonly #environmentPipeline: GPUComputePipeline;
  /** 云在地面上的影子图、画它用的参数（和步进的分开：画的时机不同）和管线。 */
  readonly shadow: GPUTexture;
  readonly #shadowUniforms: GPUBuffer;
  readonly #shadowPipeline: GPURenderPipeline;
  readonly #march: GPURenderPipeline;
  readonly #compositeModule: GPUShaderModule;
  readonly #compositeLayout: GPUBindGroupLayout;
  readonly #composites = new Map<GPUTextureFormat, GPURenderPipeline>();
  #buffers: [GPUTexture, GPUTexture] | undefined;
  #current = 0;
  /** 噪声算到第几层了；到 NOISE_SIZE 就是算完了，生成用的管线和缓冲随即丢掉。 */
  #noiseSlices = 0;
  #noisePipeline: GPUComputePipeline | undefined;
  #noiseUniform: GPUBuffer | undefined;

  constructor(device: GPUDevice) {
    this.#device = device;
    this.#noise = device.createTexture({
      label: 'Clouds noise', size: [NOISE_SIZE, NOISE_SIZE, NOISE_SIZE], dimension: '3d', format: 'rgba8unorm',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.#noiseSampler = device.createSampler({ label: 'Clouds noise', magFilter: 'linear', minFilter: 'linear', addressModeU: 'repeat', addressModeV: 'repeat', addressModeW: 'repeat' });
    this.#uniforms = device.createBuffer({ label: 'Clouds', size: UNIFORM_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const march = device.createShaderModule({ label: 'Clouds march', code: MARCH_SHADER });
    this.#march = device.createRenderPipeline({
      label: 'Clouds march', layout: 'auto',
      vertex: { module: march, entryPoint: 'fullscreenVertex' },
      fragment: { module: march, entryPoint: 'fs', targets: [{ format: FORMAT }] },
    });
    this.environment = device.createTexture({
      label: 'Clouds environment', size: [ENVIRONMENT_SIZE, ENVIRONMENT_SIZE, 6], format: FORMAT, mipLevelCount: Math.log2(ENVIRONMENT_SIZE) + 1,
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.#environmentUniforms = device.createBuffer({ label: 'Clouds environment', size: UNIFORM_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.#environmentPipeline = device.createComputePipeline({
      label: 'Clouds environment', layout: 'auto',
      compute: { module: device.createShaderModule({ label: 'Clouds environment', code: ENVIRONMENT_SHADER }), entryPoint: 'main' },
    });
    this.shadow = device.createTexture({ label: 'Clouds shadow', size: [SHADOW_SIZE, SHADOW_SIZE], format: 'r8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
    this.#shadowUniforms = device.createBuffer({ label: 'Clouds shadow', size: UNIFORM_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const shadow = device.createShaderModule({ label: 'Clouds shadow', code: SHADOW_SHADER });
    this.#shadowPipeline = device.createRenderPipeline({
      label: 'Clouds shadow', layout: 'auto',
      vertex: { module: shadow, entryPoint: 'fullscreenVertex' },
      fragment: { module: shadow, entryPoint: 'fs', targets: [{ format: 'r8unorm' }] },
    });
    this.#compositeModule = device.createShaderModule({ label: 'Clouds composite', code: COMPOSITE_SHADER });
    this.#compositeLayout = device.createBindGroupLayout({
      label: 'Clouds composite',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth' } },
      ],
    });
  }

  /** 噪声贴图生成完了（影子图、步进都要它）。 */
  get ready(): boolean {
    return this.#noiseSlices >= NOISE_SIZE;
  }

  /** 画环境光里的云：立方体的每一级 mip 各步进一遍。 */
  recordEnvironment(encoder: GPUCommandEncoder, atmosphere: AtmosphereResources, uniforms: Float32Array): void {
    this.#device.queue.writeBuffer(this.#environmentUniforms, 0, uniforms as Float32Array<ArrayBuffer>);
    const layout = this.#environmentPipeline.getBindGroupLayout(0);
    for (let level = 0; level < this.environment.mipLevelCount; level++) {
      const size = Math.max(1, ENVIRONMENT_SIZE >> level);
      const pass = encoder.beginComputePass({ label: `Clouds environment level ${level}` });
      pass.setPipeline(this.#environmentPipeline);
      pass.setBindGroup(0, this.#device.createBindGroup({
        layout,
        entries: [
          { binding: 0, resource: { buffer: atmosphere.uniforms } },
          { binding: 1, resource: { buffer: this.#environmentUniforms } },
          { binding: 2, resource: this.#noise.createView() },
          { binding: 3, resource: this.#noiseSampler },
          { binding: 4, resource: atmosphere.skyView.createView() },
          { binding: 5, resource: atmosphere.skySampler },
          { binding: 6, resource: this.environment.createView({ dimension: '2d-array', baseMipLevel: level, mipLevelCount: 1 }) },
        ],
      }));
      pass.dispatchWorkgroups(Math.ceil(size / 8), Math.ceil(size / 8), 6);
      pass.end();
    }
  }

  /** 画影子图（一个周期，512²）：uniforms 同步进的那份，只用到云层、形状和主光的方向。 */
  recordShadow(encoder: GPUCommandEncoder, uniforms: Float32Array): void {
    this.#device.queue.writeBuffer(this.#shadowUniforms, 0, uniforms as Float32Array<ArrayBuffer>);
    const pass = encoder.beginRenderPass({ label: 'Clouds shadow', colorAttachments: [{ view: this.shadow.createView(), loadOp: 'clear', storeOp: 'store' }] });
    pass.setPipeline(this.#shadowPipeline);
    pass.setBindGroup(0, this.#device.createBindGroup({
      layout: this.#shadowPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 1, resource: { buffer: this.#shadowUniforms } },
        { binding: 2, resource: this.#noise.createView() },
        { binding: 3, resource: this.#noiseSampler },
      ],
    }));
    pass.draw(3);
    pass.end();
  }

  /** 云缓冲跟着画面的大小（一半）；重建了返回真（这一帧没有上一帧的结果可用）。 */
  resize(width: number, height: number): boolean {
    const w = Math.ceil(width / 2), h = Math.ceil(height / 2);
    if (this.#buffers?.[0].width === w && this.#buffers[0].height === h) return false;
    for (const texture of this.#buffers ?? []) texture.destroy();
    const buffer = (index: number) => this.#device.createTexture({ label: `Clouds buffer ${index}`, size: [w, h], format: FORMAT, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
    this.#buffers = [buffer(0), buffer(1)];
    return true;
  }

  record(encoder: GPUCommandEncoder, atmosphere: AtmosphereResources, uniforms: Float32Array, target: GPUTextureView, format: GPUTextureFormat, depth: GPUTexture, timestampWrites?: GPURenderPassTimestampWrites): void {
    this.#device.queue.writeBuffer(this.#uniforms, 0, uniforms as Float32Array<ArrayBuffer>);
    // 噪声还没算完：这一帧接着算几层，不画云
    if (this.#noiseSlices < NOISE_SIZE) {
      this.#generateNoise(encoder);
      return;
    }
    const previous = this.#buffers![this.#current]!;
    this.#current = 1 - this.#current;
    const output = this.#buffers![this.#current]!;
    const depthView = depth.createView();
    const march = encoder.beginRenderPass({ label: 'Clouds march', ...(timestampWrites ? { timestampWrites } : {}), colorAttachments: [{ view: output.createView(), loadOp: 'clear', storeOp: 'store' }] });
    march.setPipeline(this.#march);
    march.setBindGroup(0, this.#device.createBindGroup({
      layout: this.#march.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: atmosphere.uniforms } },
        { binding: 1, resource: { buffer: this.#uniforms } },
        { binding: 2, resource: this.#noise.createView() },
        { binding: 3, resource: this.#noiseSampler },
        { binding: 4, resource: atmosphere.skyView.createView() },
        { binding: 5, resource: atmosphere.skySampler },
        { binding: 6, resource: depthView },
        { binding: 7, resource: previous.createView() },
      ],
    }));
    march.draw(3);
    march.end();
    const composite = encoder.beginRenderPass({ label: 'Clouds composite', colorAttachments: [{ view: target, loadOp: 'load', storeOp: 'store' }] });
    composite.setPipeline(this.#compositeFor(format));
    composite.setBindGroup(0, this.#device.createBindGroup({
      layout: this.#compositeLayout,
      entries: [{ binding: 0, resource: output.createView() }, { binding: 1, resource: depthView }],
    }));
    composite.draw(3);
    composite.end();
  }

  destroy(): void {
    this.#noise.destroy();
    this.environment.destroy();
    this.#environmentUniforms.destroy();
    this.shadow.destroy();
    this.#shadowUniforms.destroy();
    this.#uniforms.destroy();
    this.#noiseUniform?.destroy();
    for (const texture of this.#buffers ?? []) texture.destroy();
  }

  #generateNoise(encoder: GPUCommandEncoder): void {
    this.#noisePipeline ??= this.#device.createComputePipeline({
      label: 'Clouds noise', layout: 'auto',
      compute: { module: this.#device.createShaderModule({ label: 'Clouds noise', code: NOISE_SHADER }), entryPoint: 'main' },
    });
    this.#noiseUniform ??= this.#device.createBuffer({ label: 'Clouds noise slices', size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.#device.queue.writeBuffer(this.#noiseUniform, 0, new Uint32Array([this.#noiseSlices, 0, 0, 0]));
    const pass = encoder.beginComputePass({ label: 'Clouds noise' });
    pass.setPipeline(this.#noisePipeline);
    pass.setBindGroup(0, this.#device.createBindGroup({
      layout: this.#noisePipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: this.#noise.createView() }, { binding: 1, resource: { buffer: this.#noiseUniform } }],
    }));
    pass.dispatchWorkgroups(NOISE_SIZE / 4, NOISE_SIZE / 4, NOISE_SLICES_PER_FRAME / 4);
    pass.end();
    this.#noiseSlices += NOISE_SLICES_PER_FRAME;
    if (this.#noiseSlices >= NOISE_SIZE) {
      this.#noisePipeline = undefined;
      // 这一帧的命令还引用着它：销毁排在提交之后也可以，交给垃圾回收更省事
      this.#noiseUniform = undefined;
    }
  }

  /** 合成的管线：颜色 = 云的散射 + 颜色 · 云的透射（alpha）。 */
  #compositeFor(format: GPUTextureFormat): GPURenderPipeline {
    let pipeline = this.#composites.get(format);
    if (!pipeline) {
      pipeline = this.#device.createRenderPipeline({
        label: `Clouds composite ${format}`,
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
}

/** 步进要的大气的资源（AtmosphereGpu 的一部分）。 */
interface AtmosphereResources {
  readonly uniforms: GPUBuffer;
  readonly skyView: GPUTexture;
  readonly skySampler: GPUSampler;
}

/** 缓存键里云量、密度、种类按 1 / perUnit 一档（天气过渡时这几项每帧都在变）。 */
function steps(s: CloudSettings, perUnit: number): number[] {
  return [s.coverage, s.density, s.cloudType].map((value) => Math.round(value * perUnit));
}
