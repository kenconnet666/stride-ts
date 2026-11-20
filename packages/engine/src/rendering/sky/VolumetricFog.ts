/**
 * 体积雾和体积光（VolumetricFog 组件；Stride 没有）：Wronski 2014 "Volumetric Fog"（刺客信条 4）和 Hillaire 2015（寒霜）的做法。
 * 不要求有物理天空：照着雾的是场景的主光（投阴影的方向光，没有时是第一盏）和环境光。
 *
 * - 体素表（128x72x64，跟着主相机：屏幕上一格一格，沿视线 64 层，第 i 层到 ((i + 1) / 64)² · distance，近处层密）。
 * - 第一遍（scatter）：每个体素算那一点的雾（密度按高度指数衰减）和照进来的光——主光乘级联阴影（所以物体的影子在雾里是
 *   一道道的光柱）、乘云的影子、乘相函数（朝着光看时亮），加上各向同性的环境光。每帧把体素在层里的位置抖一下，和上一帧
 *   重投影过来的结果混合：64 层的台阶十几帧里抹平。
 * - 第二遍（integrate）：每一列从近到远累加散射、累乘透射（解析地积分每一段）。
 * - 合成：不透明的画完以后，每个像素按到相机的距离查积分好的表，颜色 = 颜色 · 透射 + 散射。天空的像素、比 distance 远的
 *   物体按 distance 处的值算。
 * - 还没做：点光和聚光照进雾里；雾的密度带噪声（一团一团、被风吹着走）；distance 以外接一段解析的高度雾；透明的物体在雾
 *   的前面还是后面（现在按它身后不透明物体的距离算）。
 */
import { system } from '../../engine/system';
import type { GpuResources } from '../../graphics/GpuResources';
import { VolumetricFog } from '../components';
import type { Lighting, RenderContext, RenderView } from '../RenderSystem';
import { FULLSCREEN_VERTEX, GRADIENT_NOISE } from '../wgsl';
import type { CloudShadow } from './VolumetricClouds';

/** 体素表的大小：屏幕上横、竖几格，沿视线几层。 */
const FROXELS = [128, 72, 64] as const;
/** 和上一帧混合时这一帧占的比重。 */
const HISTORY_BLEND = 0.08;
const FORMAT: GPUTextureFormat = 'rgba16float';
const UNIFORM_FLOATS = 156;

const FOG_STRUCT = /* wgsl */ `
struct Fog {
  inverseViewProjection: mat4x4f,
  // 上一帧的视图投影和相机位置：找上一帧的结果
  previousViewProjection: mat4x4f,
  // 主光的级联阴影：世界到图集 UV 和深度的矩阵、每个级联在图集里的范围、各级联结束处的深度
  shadowMatrices: array<mat4x4f, 4>,
  shadowRectangles: array<vec4f, 4>,
  shadowSplits: vec4f,
  // xyz 相机的位置，w 这一帧的抖动（0..1）
  eye: vec4f,
  previousEye: vec4f,
  // 世界坐标点乘它（w 是 1）得到裁剪空间的 w：选级联用的深度
  depthRow: vec4f,
  // x 密度（baseHeight 处每米的消光），y 高度衰减（每米），z baseHeight，w 体素表盖多远（米）
  fog: vec4f,
  // rgb 雾的颜色（反照率），w 相函数的 g
  albedo: vec4f,
  // xyz 朝主光的方向，w 级联数（0 是没有阴影）
  light: vec4f,
  // rgb 主光的颜色乘强度，w 这一帧的比重（没有上一帧的结果时是 1）
  lightColor: vec4f,
  // rgb 环境光的亮度，w 阴影的深度偏移
  ambient: vec4f,
  // 云的影子：x 比例，yz 偏移，w 有没有（1 / 0）
  cloud: vec4f,
};

const SLICES = ${FROXELS[2]}.0;
/** 第 slice 层（可以带小数）的远端到相机的距离。 */
fn sliceDistance(slice: f32) -> f32 {
  let s = slice / SLICES;
  return s * s * fog.fog.w;
}
`;

/** 每个体素的散射和消光，和上一帧混合。 */
const SCATTER_SHADER = /* wgsl */ `
const PI = 3.14159265;
${FOG_STRUCT}
@group(0) @binding(0) var<uniform> fog: Fog;
@group(0) @binding(1) var output: texture_storage_3d<rgba16float, write>;
@group(0) @binding(2) var history: texture_3d<f32>;
@group(0) @binding(3) var linearClamp: sampler;
@group(0) @binding(4) var shadowAtlas: texture_depth_2d;
@group(0) @binding(5) var shadowComparison: sampler_comparison;
@group(0) @binding(6) var cloudShadowMap: texture_2d<f32>;
@group(0) @binding(7) var linearRepeat: sampler;
${GRADIENT_NOISE}

/** 主光有没有被挡（1 没挡）：按深度选级联；比最远的级联还远、或者落在级联的范围外面的当作没挡。 */
fn sunShadow(world: vec3f) -> f32 {
  let count = u32(fog.light.w);
  if (count == 0u) { return 1.0; }
  let depth = dot(fog.depthRow, vec4f(world, 1.0));
  var cascade = 0u;
  for (var i = 0u; i + 1u < count; i++) {
    if (depth > fog.shadowSplits[i]) { cascade = i + 1u; }
  }
  if (depth > fog.shadowSplits[count - 1u]) { return 1.0; }
  let p = fog.shadowMatrices[cascade] * vec4f(world, 1.0);
  let s = p.xyz / p.w;
  let rectangle = fog.shadowRectangles[cascade];
  if (any(s.xy < rectangle.xy) || any(s.xy > rectangle.zw) || s.z < 0.0 || s.z > 1.0) { return 1.0; }
  return textureSampleCompareLevel(shadowAtlas, shadowComparison, s.xy, s.z - fog.ambient.w);
}

fn henyeyGreenstein(cosTheta: f32, g: f32) -> f32 {
  let g2 = g * g;
  return (1.0 - g2) / (4.0 * PI * pow(max(1.0 + g2 - 2.0 * g * cosTheta, 1e-4), 1.5));
}

@compute @workgroup_size(4, 4, 4) fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(output);
  if (any(id >= size)) { return; }
  let uv = (vec2f(id.xy) + 0.5) / vec2f(size.xy);
  let far = fog.inverseViewProjection * vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 1.0, 1.0);
  let direction = normalize(far.xyz / far.w - fog.eye.xyz);
  // 这一帧体素在层里的位置：每一列错开（交错梯度噪声），每帧再挪（黄金分割的步子）
  let jitter = fract(gradientNoise(vec2f(id.xy)) + fog.eye.w);
  let world = fog.eye.xyz + direction * sliceDistance(f32(id.z) + jitter);

  // 雾：越高越稀；比基准高度低的地方封个顶，免得坑里浓成一堵墙
  let extinction = fog.fog.x * exp(clamp(-fog.fog.y * (world.y - fog.fog.z), -20.0, 3.0));
  let toLight = fog.light.xyz;
  var sun = fog.lightColor.rgb * sunShadow(world);
  if (fog.cloud.w > 0.0) {
    let ground = world.xz - toLight.xz * (world.y / max(toLight.y, 0.05));
    sun *= textureSampleLevel(cloudShadowMap, linearRepeat, ground * fog.cloud.x + fog.cloud.yz, 0.0).r;
  }
  // 朝着光看（视线和朝光的方向一致）是往前散射，最亮；环境光各个方向都有，相函数积分是 1
  let radiance = sun * henyeyGreenstein(dot(direction, toLight), fog.albedo.w) + fog.ambient.rgb;
  var current = vec4f(radiance * fog.albedo.rgb * extinction, extinction);

  // 上一帧：体素中心在上一帧的画面上的位置和距离
  let center = fog.eye.xyz + direction * sliceDistance(f32(id.z) + 0.5);
  let clip = fog.previousViewProjection * vec4f(center, 1.0);
  let previousUv = vec2f(clip.x / clip.w * 0.5 + 0.5, 0.5 - clip.y / clip.w * 0.5);
  let previousSlice = sqrt(saturate(length(center - fog.previousEye.xyz) / fog.fog.w));
  if (clip.w > 0.0 && all(previousUv >= vec2f(0.0)) && all(previousUv <= vec2f(1.0)) && previousSlice < 1.0) {
    let old = textureSampleLevel(history, linearClamp, vec3f(previousUv, previousSlice), 0.0);
    current = mix(old, current, fog.lightColor.w);
  }
  textureStore(output, id, current);
}`;

/** 每一列从近到远积分：每层存到这一层远端为止的散射（rgb）和透射（a）。 */
const INTEGRATE_SHADER = /* wgsl */ `
${FOG_STRUCT}
@group(0) @binding(0) var<uniform> fog: Fog;
@group(0) @binding(1) var output: texture_storage_3d<rgba16float, write>;
@group(0) @binding(2) var scatter: texture_3d<f32>;

@compute @workgroup_size(8, 8, 1) fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(output);
  if (any(id.xy >= size.xy)) { return; }
  var scattered = vec3f(0.0);
  var transmittance = 1.0;
  var near = 0.0;
  for (var slice = 0u; slice < size.z; slice++) {
    let far = sliceDistance(f32(slice) + 1.0);
    let s = textureLoad(scatter, vec3u(id.xy, slice), 0);
    let stepTransmittance = exp(-s.a * (far - near));
    // 解析地积分这一段（能量守恒）
    scattered += transmittance * s.rgb * (1.0 - stepTransmittance) / max(s.a, 1e-6);
    transmittance *= stepTransmittance;
    textureStore(output, vec3u(id.xy, slice), vec4f(scattered, transmittance));
    near = far;
  }
}`;

/** 合成：按到相机的距离查积分好的表，颜色 = 颜色 · 透射 + 散射（混合：src + dst · srcAlpha）。 */
const COMPOSITE_SHADER = /* wgsl */ `
${FULLSCREEN_VERTEX}
${FOG_STRUCT}
@group(0) @binding(0) var<uniform> fog: Fog;
@group(0) @binding(1) var integrated: texture_3d<f32>;
@group(0) @binding(2) var depth: texture_depth_2d;
@group(0) @binding(3) var linearClamp: sampler;

@fragment fn fs(in: FullscreenVaryings) -> @location(0) vec4f {
  let d = textureLoad(depth, vec2i(in.position.xy), 0);
  let world = fog.inverseViewProjection * vec4f(in.ndc, d, 1.0);
  // 天空的像素、比表远的物体按表的尽头算
  let distance = select(length(world.xyz / world.w - fog.eye.xyz), fog.fog.w, d >= 1.0);
  // 层号的反函数：第 i 层的值在它的远端，纹素中心在 (i + 0.5) / 层数；比第一层还近的按距离淡到没有雾
  let w = sqrt(saturate(distance / fog.fog.w));
  let s = textureSampleLevel(integrated, linearClamp, vec3f(in.uv, max(w - 0.5 / SLICES, 0.5 / SLICES)), 0.0);
  let fade = saturate(w * SLICES);
  return vec4f(s.rgb * fade, mix(1.0, s.a, fade));
}`;

/** 按通道的名字给量 GPU 耗时的查询（GpuProfiler.passTimestamps）；没开剖析时返回 undefined。 */
type PassTimestamps = (name: string) => GPURenderPassTimestampWrites | undefined;

/** 雾这一帧的设置（VolumetricFog 组件的值）。 */
export interface FogSettings {
  density: number;
  heightFalloff: number;
  baseHeight: number;
  color: [number, number, number];
  anisotropy: number;
  distance: number;
  ambient: number;
}

/**
 * 场景的体积雾（渲染系统一份）：前向渲染器收集光照之后 apply（找 VolumetricFog），主画面不透明的画完以后 record
 * （算体素表、积分、合成进画面）。
 */
export class Fog {
  /** 这一帧画不画雾（场景里有 VolumetricFog，密度大于 0）。 */
  active = false;
  readonly settings: FogSettings = { density: 0.02, heightFalloff: 0.1, baseHeight: 0, color: [1, 1, 1], anisotropy: 0.6, distance: 120, ambient: 1 };
  readonly #device: GPUDevice;
  readonly #resources: GpuResources;
  #gpu: FogGpu | undefined;
  #found = false;
  #frame = 0;
  /** 上一帧主相机的位置；还没画过时是 undefined（那一帧不和上一帧混合）。 */
  #previousEye: [number, number, number] | undefined;

  readonly #collect = system('Fog.collect', {
    with: { fog: VolumetricFog },
    update: ({ fog, count }) => {
      if (count === 0 || this.#found) return;
      this.#found = true;
      const s = this.settings;
      s.density = fog.density[0]!;
      s.heightFalloff = fog.heightFalloff[0]!;
      s.baseHeight = fog.baseHeight[0]!;
      s.color = [fog.color[0]!, fog.color[1]!, fog.color[2]!];
      s.anisotropy = fog.anisotropy[0]!;
      s.distance = fog.distance[0]!;
      s.ambient = fog.ambient[0]!;
    },
  });

  constructor(device: GPUDevice, resources: GpuResources) {
    this.#device = device;
    this.#resources = resources;
  }

  /** 收集光照之后调：enabled 是画质档位给不给。 */
  apply(context: RenderContext, enabled: boolean): void {
    this.#found = false;
    if (enabled) context.game.entities.run(this.#collect, context.time);
    this.active = this.#found && this.settings.density > 0;
    // 停了一阵再开：上一帧的结果不是上一帧的了
    if (!this.active) this.#previousEye = undefined;
  }

  /**
   * 算这一帧的体素表、积分、合成进 target（主画面，不透明的画完以后）。depth 是主画面的深度；cloud 是云在地面上的影子
   * （落在主光上的才用）；timestamps 按通道的名字（Fog scatter、Fog integrate、Fog composite）给量 GPU 耗时的查询。
   */
  record(encoder: GPUCommandEncoder, view: RenderView, lighting: Lighting, cloud: CloudShadow | undefined, target: GPUTextureView, format: GPUTextureFormat, depth: GPUTexture, timestamps?: PassTimestamps): void {
    if (!this.active) return;
    const gpu = (this.#gpu ??= new FogGpu(this.#device, this.#resources));
    const light = lighting.directionals[Math.max(lighting.shadowLight, 0)];
    const lit = lighting.directionalCount > 0 && light !== undefined;
    const shadow = lit && lighting.shadowLight >= 0 ? lighting.shadow : undefined;
    const clouds = lit && cloud?.lightEntity === light.entity ? cloud : undefined;
    gpu.record(encoder, this.#uniforms(view, lighting, lit ? light : undefined, shadow !== undefined, clouds), shadow ? lighting.shadowAtlas : undefined, clouds?.texture, target, format, depth, timestamps);
    this.#previousEye = [view.eye.x, view.eye.y, view.eye.z];
    this.#frame = (this.#frame + 1) % 1024;
  }

  destroy(): void {
    this.#gpu?.destroy();
  }

  #uniforms(view: RenderView, lighting: Lighting, light: Lighting['directionals'][number] | undefined, shadowed: boolean, cloud: CloudShadow | undefined): Float32Array {
    const s = this.settings;
    const data = new Float32Array(UNIFORM_FLOATS);
    const eye = [view.eye.x, view.eye.y, view.eye.z];
    data.set(view.inverseViewProjection, 0);
    data.set(view.previousViewProjection, 16);
    const shadow = shadowed ? lighting.shadow : undefined;
    if (shadow) {
      data.set(shadow.worldToShadow, 32);
      data.set(shadow.rectangles, 96);
      data.set(shadow.splits, 112);
    }
    data.set([...eye, (this.#frame * 0.61803399) % 1], 116);
    data.set([...(this.#previousEye ?? eye), 0], 120);
    // 裁剪空间的 w 是视图投影矩阵的第四行点乘世界坐标（列优先存的：下标 3、7、11、15）
    const vp = view.viewProjection;
    data.set([vp[3]!, vp[7]!, vp[11]!, vp[15]!], 124);
    data.set([s.density, s.heightFalloff, s.baseHeight, s.distance], 128);
    data.set([...s.color, s.anisotropy], 132);
    if (light) {
      const length = Math.hypot(light.direction.x, light.direction.y, light.direction.z) || 1;
      data.set([-light.direction.x / length, -light.direction.y / length, -light.direction.z / length, shadow?.cascadeCount ?? 0], 136);
      data.set([light.color.r, light.color.g, light.color.b], 140);
    } else {
      data.set([0, 1, 0, 0], 136);
    }
    data[143] = this.#previousEye ? HISTORY_BLEND : 1;
    // 环境光：环境色加天空盒光的球谐的常数项（各个方向的平均）
    const sky = lighting.skybox;
    const sh = sky?.skybox.diffuseSH;
    const intensity = sky?.intensity ?? 0;
    data.set([
      (lighting.ambient.r + (sh?.[0] ?? 0) * intensity) * s.ambient,
      (lighting.ambient.g + (sh?.[1] ?? 0) * intensity) * s.ambient,
      (lighting.ambient.b + (sh?.[2] ?? 0) * intensity) * s.ambient,
      shadow?.depthBias ?? 0,
    ], 144);
    data.set(cloud ? [cloud.scale, cloud.offset[0], cloud.offset[1], 1] : [0, 0, 0, 0], 148);
    return data;
  }
}

/** 体积雾的 GPU 资源：两张轮着写的散射表（这一帧和上一帧）、积分好的表、三条管线。 */
class FogGpu {
  readonly #device: GPUDevice;
  readonly #resources: GpuResources;
  readonly #uniforms: GPUBuffer;
  readonly #scatter: [GPUTexture, GPUTexture];
  readonly #integrated: GPUTexture;
  readonly #scatterPipeline: GPUComputePipeline;
  readonly #integratePipeline: GPUComputePipeline;
  readonly #compositeModule: GPUShaderModule;
  readonly #compositeLayout: GPUBindGroupLayout;
  readonly #composites = new Map<GPUTextureFormat, GPURenderPipeline>();
  #current = 0;

  constructor(device: GPUDevice, resources: GpuResources) {
    this.#device = device;
    this.#resources = resources;
    this.#uniforms = device.createBuffer({ label: 'Fog', size: UNIFORM_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const volume = (label: string) => device.createTexture({ label, size: [...FROXELS], dimension: '3d', format: FORMAT, usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING });
    this.#scatter = [volume('Fog scatter 0'), volume('Fog scatter 1')];
    this.#integrated = volume('Fog integrated');
    const compute = (label: string, code: string) => device.createComputePipeline({ label, layout: 'auto', compute: { module: device.createShaderModule({ label, code }), entryPoint: 'main' } });
    this.#scatterPipeline = compute('Fog scatter', SCATTER_SHADER);
    this.#integratePipeline = compute('Fog integrate', INTEGRATE_SHADER);
    this.#compositeModule = device.createShaderModule({ label: 'Fog composite', code: COMPOSITE_SHADER });
    this.#compositeLayout = device.createBindGroupLayout({
      label: 'Fog composite',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: '3d' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      ],
    });
  }

  record(encoder: GPUCommandEncoder, uniforms: Float32Array, shadowAtlas: GPUTexture | undefined, cloudShadow: GPUTexture | undefined, target: GPUTextureView, format: GPUTextureFormat, depth: GPUTexture, timestamps?: PassTimestamps): void {
    const timed = (label: string) => {
      const timestampWrites = timestamps?.(label);
      return timestampWrites ? { label, timestampWrites } : { label };
    };
    this.#device.queue.writeBuffer(this.#uniforms, 0, uniforms as Float32Array<ArrayBuffer>);
    const previous = this.#scatter[this.#current]!;
    this.#current = 1 - this.#current;
    const scatter = this.#scatter[this.#current]!;
    const uniformBuffer = { buffer: this.#uniforms };
    const lit = encoder.beginComputePass(timed('Fog scatter'));
    lit.setPipeline(this.#scatterPipeline);
    lit.setBindGroup(0, this.#device.createBindGroup({
      layout: this.#scatterPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: uniformBuffer },
        { binding: 1, resource: scatter.createView() },
        { binding: 2, resource: previous.createView() },
        { binding: 3, resource: this.#resources.linearClamp },
        { binding: 4, resource: (shadowAtlas ?? this.#resources.emptyShadowAtlas).createView() },
        { binding: 5, resource: this.#resources.shadowComparison },
        { binding: 6, resource: (cloudShadow ?? this.#resources.white).createView() },
        { binding: 7, resource: this.#resources.linearRepeat },
      ],
    }));
    lit.dispatchWorkgroups(FROXELS[0] / 4, FROXELS[1] / 4, FROXELS[2] / 4);
    lit.end();
    const integrate = encoder.beginComputePass(timed('Fog integrate'));
    integrate.setPipeline(this.#integratePipeline);
    integrate.setBindGroup(0, this.#device.createBindGroup({
      layout: this.#integratePipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: uniformBuffer }, { binding: 1, resource: this.#integrated.createView() }, { binding: 2, resource: scatter.createView() }],
    }));
    integrate.dispatchWorkgroups(FROXELS[0] / 8, FROXELS[1] / 8, 1);
    integrate.end();
    const composite = encoder.beginRenderPass({ ...timed('Fog composite'), colorAttachments: [{ view: target, loadOp: 'load', storeOp: 'store' }] });
    composite.setPipeline(this.#compositeFor(format));
    composite.setBindGroup(0, this.#device.createBindGroup({
      layout: this.#compositeLayout,
      entries: [
        { binding: 0, resource: uniformBuffer },
        { binding: 1, resource: this.#integrated.createView() },
        { binding: 2, resource: depth.createView() },
        { binding: 3, resource: this.#resources.linearClamp },
      ],
    }));
    composite.draw(3);
    composite.end();
  }

  destroy(): void {
    for (const texture of [...this.#scatter, this.#integrated]) texture.destroy();
    this.#uniforms.destroy();
  }

  /** 合成的管线：颜色 = 散射 + 颜色 · 透射（alpha）。 */
  #compositeFor(format: GPUTextureFormat): GPURenderPipeline {
    let pipeline = this.#composites.get(format);
    if (!pipeline) {
      pipeline = this.#device.createRenderPipeline({
        label: `Fog composite ${format}`,
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
