/** 网格渲染特性在一个设备上的 GPU 资源：缓冲（世界矩阵、蒙皮、形变、高度页、实例、视图常量）、绑定组、着色器模块和管线、网格和材质的上传、DFG 查找表。 */
import { createCheckedShaderModule } from '../../graphics/shaderModule';
import type { Decals } from './Decals';
import { clusterParams, type Clusters } from '../lighting/Clusters';
import type { LocalLightBuffer } from '../lighting/LocalLights';
import type { PlanarReflections } from '../lighting/PlanarReflections';
import type { Refraction } from '../screenspace/Refraction';
import type { FrustumCuller } from '@stride-ts/native';
import type { AnimationSystem } from '../../animation/AnimationSystem';
import type { GpuResources } from '../../graphics/GpuResources';
import { Material, type MaterialShaderTrees, type MaterialTexture } from './Material';
import type { ReflectionProbes } from '../lighting/ReflectionProbes';
import type { Clouds } from '../sky/VolumetricClouds';
import { Skybox } from '../lighting/Skybox';
import type { SubsurfaceMaterials } from '../screenspace/SubsurfaceScattering';
import { MESH_EFFECT_PARAMETERS, meshEffectCode, type MeshEffect } from './meshEffect';
import { DFG_LUT_SHADER, materialTreesCode, MESH_SHADER, screenTextureCode } from './meshShader';
import { DFG_LUT_HEIGHT, DFG_LUT_WIDTH } from './wgsl/view';
import { GraphParams } from './materialGraph';
import { CEL_RAMP_STOPS, vertexLayoutOffsets, type MicrofacetModel, type VertexLayout } from '../../content/formats/format';
import { Mesh } from './Mesh';
import { HeightPages } from './HeightPages';
import type { Lighting, RenderStage, RenderSystem, RenderView } from '../RenderSystem';
import type { MeshBatch } from './MeshRenderFeature';

/** 一批在一个阶段上次用的管线，和当时的输入。 */
export interface CachedPipeline {
  readonly pipeline: GPURenderPipeline;
  readonly materialVersion: number;
  readonly effect: MeshEffect | undefined;
  readonly colorFormat: GPUTextureFormat | undefined;
  readonly depthFormat: GPUTextureFormat;
}

/** 阴影投射的按坡度深度偏移（GPU 的 depthBiasSlopeScale，乘三角形在阴影图里的最大深度斜率）。 */
const SHADOW_SLOPE_BIAS = 1.5;

/** 每个视图的常量占一块：uniform 的动态偏移必须是 minUniformBufferOffsetAlignment（256）的整数倍。 */
export const VIEW_STRIDE = 1536;
/**
 * View 结构：viewProjection 16、eye 4、环境色 4、sky 4、球谐 36、天空盒旋转 16、阴影矩阵 64、阴影参数 12、方向光 8 · 4、
 * locals 4，各缓冲这一帧和上一帧的起点 12，运动向量的两个矩阵 32，云影、天气、贴花、分簇 20，平面反射 28，原点 4，风 4，
 * 局部风源 4 · 4 和它们的强度 4，辐照度体 16。
 */
const VIEW_FLOATS = 328;
/** 不用平面反射的视图在那几个数的位置写的：全是 0（用不用的那一位是 0）。 */
const PLANAR_OFF = new Float32Array(28);
/** 按世界坐标的图案（水洼、积雪）重复的周期（米）：渲染原点按它取模交给着色器。 */
const ORIGIN_PATTERN_PERIOD = 65536;
/** 材质 uniform：Material 结构（按 materialBindings.ts 的字段顺序），按 16 字节对齐。 */
const MATERIAL_BYTES = 1744;
const CHANNELS = { r: [1, 0, 0, 0], g: [0, 1, 0, 0], b: [0, 0, 1, 0], a: [0, 0, 0, 1] } as const;
const OPERATOR_CODES = { multiply: 0, add: 1 } as const;
const DISTRIBUTION_CODES = { ggx: 0, beckmann: 1, blinnPhong: 2 } as const;
const VISIBILITY_CODES = { smithSchlickGGX: 0, implicit: 1, neumann: 2, cookTorrance: 3, kelemen: 4, smithBeckmann: 5, smithGGXCorrelated: 6, smithSchlickBeckmann: 7 } as const;

/**
 * 微表面模型的各项打包进材质的 specular 码的高位（着色器的 microfacetSpecular 拆开）：第 4 位菲涅耳为 none，第 5、6 位分布，
 * 第 7 到 9 位可见性，第 10 位环境项用多项式。全 0 是默认的那套。
 */
function microfacetBits(model: Required<MicrofacetModel>): number {
  return (model.fresnel === 'none' ? 16 : 0) | (DISTRIBUTION_CODES[model.distribution] << 5) | (VISIBILITY_CODES[model.visibility] << 7) | (model.environment === 'polynomial' ? 1024 : 0);
}
/** 网格的 uniform：MeshParams（三个 vec4、标志、效果参数、纹理坐标的范围）。 */
const MESH_PARAMS_BYTES = 64 + MESH_EFFECT_PARAMETERS * 4 + 16;

/** 一次剔除：一个剔除工作区和它剔除的视图；结果在实例缓冲里从 offset 开始，每个视图 slotCount 个。 */
export interface CullPass {
  readonly culler: FrustumCuller;
  readonly views: RenderView[];
  /** 这一帧所有批的实例数、批数（实例列表按它排：每个视图 slotCount 个，各批从 batch.first 起）。 */
  slotCount: number;
  batchCount: number;
  /** 这一次剔除的视图在实例列表里的起点（Prepare 时定）。 */
  offset: number;
  /** GPU 剔除时这些视图在 GpuCulling 的视图表里从第几个起；全在 CPU 上剔时是 −1。 */
  gpuView: number;
  /** 在 CPU 上剔的批（全局下标）；culler 里的批号是在这里的下标。全在 CPU 上剔时就是 0..batchCount−1。 */
  cpuBatches: number[];
  /** 全局批号 → cpuBatches 里的下标，不在 CPU 上剔的是 −1。 */
  cpuIndexOf: Int32Array;
  /** CPU 剔除的工作区里各批的起点、实例总数（每个视图一段这么长）。 */
  cpuFirst: number[];
  cpuSlotCount: number;
}

interface GpuMesh {
  /** 第 2 组绑定：反量化参数、网格效果的参数。 */
  readonly params: GPUBuffer;
  /** 上传的效果参数是哪个效果、网格的哪个版本（变了就重新上传）。 */
  effect: MeshEffect | undefined;
  effectVersion: number;
  readonly bindGroup: GPUBindGroup;
  readonly vertices: GPUBuffer;
  /** 上传的顶点是网格的第几版（动态网格改了就重新上传）。 */
  vertexVersion: number;
  readonly indices: GPUBuffer;
  readonly indexFormat: GPUIndexFormat;
  readonly indexCount: number;
  /** 线框用的索引（每条边两个顶点，line-list）；第一次画线框时才建。 */
  edges?: { readonly buffer: GPUBuffer; readonly count: number };
}

interface GpuMaterial {
  readonly buffer: GPUBuffer;
  bindGroup: GPUBindGroup | undefined;
  version: number;
  /** 矢量贴图的数据（Material.vectorAtlas）；没有时绑 #noVector。 */
  vector: GPUBuffer | undefined;
  /** 上传时 MeshGpu.vectorAtlases 开没开（开关一变就重建绑定组）。 */
  vectorOn: boolean;
}

/** 顶点在网格空间里怎么变形：不变、按形变目标、按高度页（地形块）。 */
type VertexDeform = 'none' | 'morph' | 'heightfield' | 'impostor';
export const deformOf = (mesh: Mesh): VertexDeform => (mesh.heightfield ? 'heightfield' : mesh.impostor ? 'impostor' : mesh.data.morph ? 'morph' : 'none');

/** 按变换槽位存的 u32（蒙皮矩阵的起点）：按需增长，记着有没有改过。 */
export class SlotTable {
  values = new Uint32Array(256);
  dirty = true;

  set(slot: number, value: number): void {
    if (slot >= this.values.length) {
      this.values = grow(this.values, Math.max(slot + 1, this.values.length * 2));
      this.dirty = true;
    }
    if (this.values[slot] === value) return;
    this.values[slot] = value;
    this.dirty = true;
  }
}

/**
 * 按变换槽位存的材质实例参数（MaterialParams）：每个槽 4 个 u32——tint 打包成 rgba8（线性，a 是 255 时有 tint、0 时没有）、
 * 种子（0 是按槽位）、状态层（湿、脏、旧、雪各一个字节）、留着的一个。没挂 MaterialParams 的槽是 0。
 */
export class SlotParams {
  values = new Uint32Array(1024);
  dirty = true;

  set(slot: number, tint: number, seed: number, state: number): void {
    const o = slot * 4;
    if (o + 4 > this.values.length) {
      this.values = grow(this.values, Math.max(o + 4, this.values.length * 2));
      this.dirty = true;
    }
    if (this.values[o] === tint && this.values[o + 1] === seed && this.values[o + 2] === state) return;
    this.values[o] = tint;
    this.values[o + 1] = seed;
    this.values[o + 2] = state;
    this.dirty = true;
  }
}

export function grow(array: Uint32Array, capacity: number): Uint32Array<ArrayBuffer> {
  const grown = new Uint32Array(capacity);
  grown.set(array);
  return grown;
}

/** 一个特性在一个设备上的 GPU 资源。 */
export class MeshGpu {
  readonly device: GPUDevice;
  readonly #resources: GpuResources;
  /** 上传材质时给次表面散射的材质登记槽位（RenderSystem.subsurfaceMaterials）。 */
  readonly #subsurface: SubsurfaceMaterials;
  readonly #probes: ReflectionProbes;
  /** 视图绑定组里的反射探针是哪一代（ReflectionProbes.generation）；换了要重建绑定组。 */
  #probeGeneration = -1;
  #planarGeneration = -1;
  #irradianceGeneration = -1;
  #refractionGeneration = -1;
  readonly #clouds: Clouds;
  /** 视图绑定组里的云的影子图（没有云时是 undefined，绑一张白的）；换了要重建绑定组。 */
  #cloudShadow: GPUTexture | undefined;
  /** 地面的湿和雪、判断淋不淋得到的天空遮挡（RenderSystem 的）。 */
  readonly #weather: Pick<RenderSystem, 'surfaceWeather' | 'skyOcclusion' | 'renderOrigin' | 'wind' | 'irradianceVolumes'>;
  /** 视图绑定组里绑的是真的天空遮挡（有湿或雪时），还是空的；换了要重建绑定组。 */
  #occlusionBound = false;
  /** 没有湿和雪时绑的天空遮挡参数（有效位是 0：着色器不查）和深度缓冲。 */
  readonly #noOcclusion: GPUBuffer;
  readonly #noOcclusionDepth: GPUBuffer;
  /** 视图绑定组里的天空遮挡深度缓冲（重画后换成另一个）；换了要重建绑定组。 */
  #occlusionDepth: GPUBuffer | undefined;
  readonly #decals: Decals;
  readonly #clusters: Clusters;
  /** 点光、聚光（渲染系统一份，前向渲染器上传）；换了缓冲要重建绑定组。 */
  readonly #localLights: LocalLightBuffer;
  readonly #planar: PlanarReflections;
  readonly #refraction: Refraction;
  #localLightBuffer: GPUBuffer | undefined;
  /** 视图绑定组里的贴花图集和缓冲；换了要重建绑定组。 */
  #decalAtlas: GPUTexture | undefined;
  #decalBuffer: GPUBuffer | undefined;
  #decalVectors: GPUBuffer | undefined;
  readonly #unclippedDepth: boolean;
  /** 着色器按自发光分变体：默认的是 ''，颜色树的按它的代码。 */
  readonly #modules = new Map<string, GPUShaderModule>();
  readonly #viewLayout: GPUBindGroupLayout;
  readonly #materialLayout: GPUBindGroupLayout;
  readonly #meshLayout: GPUBindGroupLayout;
  /** 按颜色树的贴图数：0 是三个绑定组，多的再加绑定组 3。 */
  readonly #pipelineLayouts = new Map<number, { readonly layout: GPUPipelineLayout; readonly textures?: GPUBindGroupLayout }>();
  readonly #pipelines = new Map<string, GPURenderPipeline>();
  /** 正在后台编译的管线（warmPipeline）。 */
  readonly #warming = new Map<string, Promise<void>>();
  /** 颜色树的贴图绑定组（绑定组 3）。 */
  readonly #treeBindGroups = new Map<Material, GPUBindGroup>();
  readonly #meshes = new Map<Mesh, GpuMesh>();
  readonly #materials = new Map<Material, GpuMaterial>();
  readonly #materialData = new ArrayBuffer(MATERIAL_BYTES);
  /** DFG 查找表（存储缓冲，见 meshShader.ts 的 dfgLookup）。 */
  readonly #dfgLut: GPUBuffer;

  #worlds: GPUBuffer | undefined;
  #instances: GPUBuffer | undefined;
  #paletteOf: GPUBuffer | undefined;
  /** 材质实例的参数（SlotParams），片元着色器按槽位读。 */
  #instanceParams: GPUBuffer | undefined;
  #palettes: GPUBuffer | undefined;
  #morphOf: GPUBuffer | undefined;
  /** 地形块的高度页（HeightPages 的 GPU 那份）。 */
  #heights: GPUBuffer | undefined;
  #morphWeights: GPUBuffer | undefined;
  /** 没有形变的网格绑的空缓冲。 */
  readonly #noMorph: GPUBuffer;
  #views: GPUBuffer | undefined;
  /** 每个视图一块常量；视图多了就换大的（主视图、渲染目标贴图的相机，加上每个阴影级联、点光的每个面各一个）。 */
  #viewData = new Float32Array((VIEW_STRIDE / 4) * 8);
  /**
   * 世界矩阵、蒙皮、形变的缓冲各分两半，每帧轮着写，另一半留着上一帧的（运动向量要上一帧的位置）；不另建缓冲：顶点着色器
   * 能绑的存储缓冲只有 8 个，已经用了 7 个。parity 是这一帧写哪一半。
   */
  #parity = 0;
  /** 各缓冲一半的大小（世界矩阵、两张表按槽位，蒙皮矩阵按矩阵，形变权重按个）。 */
  #halves = { worlds: 0, paletteOf: 0, palettes: 0, morphOf: 0, morphWeights: 0 };
  /** 世界矩阵的两半各是第几次更新（GameTime.frameCount）时的；−∞ 是没写过。 */
  readonly #worldsAt = [-Infinity, -Infinity];
  /** 最近两次更新各自变了的槽位（拷出来的：原生那边的视图下一次更新就失效）。 */
  #changed: { update: number; slots: Int32Array } = { update: -1, slots: new Int32Array(0) };
  #changedBefore: { update: number; slots: Int32Array } = { update: -1, slots: new Int32Array(0) };
  /** 两张表改了以后两半都要写一遍（另一半是上一帧的，下一帧轮到它时也得是新的）。 */
  #paletteOfWrites = 0;
  #morphOfWrites = 0;
  /** 视图常量里的各缓冲这一帧、上一帧的起点（View.bases）。 */
  readonly #frameBases = new Uint32Array(12);
  /** 绑定组里的簇表缓冲；视图多了 Clusters 会换一个更大的，要重建绑定组。 */
  #clusterBuffer: GPUBuffer | undefined;
  /**
   * 视图绑定组：阴影图集 → 环境光遮蔽 → 接触阴影 → 绑定组。按绑在阴影位置上的深度图分开：画阴影图集时不能同时采样它。
   */
  /** 按阴影图集、屏幕遮蔽、接触阴影、平面反射图分的视图绑定组。 */
  /** 视图绑定组按用到的几张贴图缓存（键是它们的编号连起来，#textureId）。 */
  readonly #viewBindGroups = new Map<string, GPUBindGroup>();
  readonly #textureIds = new WeakMap<GPUTexture, number>();
  #nextTextureId = 0;
  /** 视图绑定组里的天空盒镜面立方体贴图；换了天空盒要重建绑定组。 */
  #skySpecular: GPUTexture | undefined;

  constructor(device: GPUDevice, resources: GpuResources, unclippedDepth: boolean, subsurface: SubsurfaceMaterials, probes: ReflectionProbes, clouds: Clouds, weather: Pick<RenderSystem, 'surfaceWeather' | 'skyOcclusion' | 'renderOrigin' | 'wind' | 'irradianceVolumes'>, decals: Decals, clusters: Clusters, localLights: LocalLightBuffer, planar: PlanarReflections, refraction: Refraction) {
    this.device = device;
    this.#planar = planar;
    this.#refraction = refraction;
    this.#resources = resources;
    this.#subsurface = subsurface;
    this.#probes = probes;
    this.#clouds = clouds;
    this.#weather = weather;
    this.#decals = decals;
    this.#clusters = clusters;
    this.#localLights = localLights;
    this.#noOcclusion = device.createBuffer({ label: 'MeshRenderFeature no sky occlusion', size: 80, usage: GPUBufferUsage.UNIFORM });
    this.#noOcclusionDepth = device.createBuffer({ label: 'MeshRenderFeature no sky occlusion depth', size: 16, usage: GPUBufferUsage.STORAGE });
    this.#unclippedDepth = unclippedDepth;
    this.#viewLayout = device.createBindGroupLayout({
      label: 'MeshRenderFeature view',
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: VIEW_FLOATS * 4 } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: 'cube' } },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 5, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        { binding: 6, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth' } },
        { binding: 7, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'comparison' } },
        { binding: 8, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 9, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 10, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
        { binding: 11, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 12, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 13, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 14, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 15, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 16, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: 'cube-array' } },
        { binding: 17, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
        { binding: 18, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 19, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        { binding: 20, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
        { binding: 21, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 22, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
        { binding: 23, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: '2d-array' } },
        { binding: 24, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
        { binding: 25, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        ...(planar.supported ? [26, 27].map((binding) => ({ binding, visibility: GPUShaderStage.FRAGMENT, texture: {} })) : []),
        { binding: 29, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
        { binding: 30, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
      ],
    });
    this.#materialLayout = device.createBindGroupLayout({
      label: 'MeshRenderFeature material',
      entries: [
        // 顶点着色器也读：植被的风（Material.wind）
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 5, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        ...[6, 7, 8].map((binding) => ({ binding, visibility: GPUShaderStage.FRAGMENT, sampler: {} })),
        { binding: 9, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 10, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        // 矢量贴图（vectorAtlas.ts）；没有时是 #noVector
        { binding: 11, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
      ],
    });
    this.#meshLayout = device.createBindGroupLayout({
      label: 'MeshRenderFeature mesh',
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
      ],
    });
    this.#noMorph = this.#createFilled('MeshRenderFeature no morph', GPUBufferUsage.STORAGE, new Uint32Array(4));
    this.#dfgLut = createDfgLut(device);
  }

  /** 着色器模块：按自发光的颜色树和网格效果分变体（两段代码是键）。 */
  #module(trees: MaterialShaderTrees | undefined, effect: MeshEffect | undefined): GPUShaderModule {
    const key = `${treesKey(trees)}|${effect?.code ?? ''}`;
    let module = this.#modules.get(key);
    if (!module) {
      const label = `MeshRenderFeature${trees ? ' (material trees)' : ''}${effect ? ' (mesh effect)' : ''}`;
      module = createCheckedShaderModule(this.device, label, MESH_SHADER + screenTextureCode(this.#planar.supported) + meshEffectCode(effect) + materialTreesCode(trees));
      this.#modules.set(key, module);
    }
    return module;
  }

  /** 颜色树有 textureCount 张贴图时的管线布局（贴图在绑定组 3）。 */
  #layout(textureCount: number): { readonly layout: GPUPipelineLayout; readonly textures?: GPUBindGroupLayout } {
    let found = this.#pipelineLayouts.get(textureCount);
    if (!found) {
      const groups = [this.#viewLayout, this.#materialLayout, this.#meshLayout];
      const textures = textureCount > 0 ? this.device.createBindGroupLayout({
        label: `MeshRenderFeature material trees ${textureCount}`,
        entries: Array.from({ length: textureCount }, (_, i) => [
          // 位移贴图的树在顶点着色器里采样
          { binding: i * 2, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, texture: {} },
          { binding: i * 2 + 1, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, sampler: {} },
        ]).flat(),
      }) : undefined;
      found = { layout: this.device.createPipelineLayout({ bindGroupLayouts: textures ? [...groups, textures] : groups }), ...(textures ? { textures } : {}) };
      this.#pipelineLayouts.set(textureCount, found);
    }
    return found;
  }

  /** 材质的颜色树贴图的绑定组（没有颜色树或者没有贴图时是 undefined）。 */
  treeBindGroup(material: Material): GPUBindGroup | undefined {
    const shader = material.shaderTrees;
    if (!shader || shader.textures.length === 0) return undefined;
    let group = this.#treeBindGroups.get(material);
    if (!group) {
      group = this.device.createBindGroup({
        label: `${material.name} material trees`,
        layout: this.#layout(shader.textures.length).textures!,
        entries: shader.textures.flatMap(({ texture, sampler }, i) => [
          { binding: i * 2, resource: this.#resources.texture(texture).createView() },
          { binding: i * 2 + 1, resource: this.#resources.sampler(sampler) },
        ]),
      });
      this.#treeBindGroups.set(material, group);
    }
    return group;
  }

  /**
   * 一个阶段加一种顶点布局（再分蒙皮不蒙皮）一条管线；画颜色的阶段再按材质的自发光变体和两面画分。只有深度的阶段（深度预通道、
   * 阴影投射）没有片元着色器；阴影投射还不剔背面、不做深度裁剪（Stride 的 ShadowMeshPipelineProcessor）。深度比较是 less-equal
   * （Stride 的 DepthStencilStates.Default），不透明阶段靠它复用深度预通道的结果。
   */
  pipelineFor(stage: RenderStage, layout: VertexLayout, skinned: boolean, deform: VertexDeform, material: Material, effect: MeshEffect | undefined, materialPass?: MaterialPass): GPURenderPipeline {
    const key = this.#pipelineKey(stage, layout, skinned, deform, material, effect, materialPass);
    let pipeline = this.#pipelines.get(key);
    if (!pipeline) {
      // 画的时候才发现没有：当场建。着色器的编译在这一帧里做，画面会卡一下——预热（warmPipeline）就是为了不走到这里
      pipeline = this.device.createRenderPipeline(this.#pipelineDescriptor(stage, layout, skinned, deform, material, effect, materialPass));
      this.#pipelines.set(key, pipeline);
    }
    return pipeline;
  }

  /** 这条管线已经编好、放进缓存了（预热在后台编，没好的话这里是 false）。 */
  hasPipeline(stage: RenderStage, layout: VertexLayout, skinned: boolean, deform: VertexDeform, material: Material, effect: MeshEffect | undefined, materialPass?: MaterialPass): boolean {
    return this.#pipelines.has(this.#pipelineKey(stage, layout, skinned, deform, material, effect, materialPass));
  }

  /**
   * 预热：这条管线还没有的话在后台编译（createRenderPipelineAsync，不卡帧），好了以后放进缓存。已经有了返回 undefined，
   * 否则返回编好时完成的 Promise。编译期间画到它的话照旧当场建一条（结果一样，只是白编了一次）。
   */
  warmPipeline(stage: RenderStage, layout: VertexLayout, skinned: boolean, deform: VertexDeform, material: Material, effect: MeshEffect | undefined, materialPass?: MaterialPass): Promise<void> | undefined {
    const key = this.#pipelineKey(stage, layout, skinned, deform, material, effect, materialPass);
    if (this.#pipelines.has(key)) return undefined;
    let warming = this.#warming.get(key);
    if (!warming) {
      warming = this.device.createRenderPipelineAsync(this.#pipelineDescriptor(stage, layout, skinned, deform, material, effect, materialPass)).then((pipeline) => {
        this.#warming.delete(key);
        if (!this.#pipelines.has(key)) this.#pipelines.set(key, pipeline);
      });
      this.#warming.set(key, warming);
    }
    return warming;
  }

  #pipelineKey(stage: RenderStage, layout: VertexLayout, skinned: boolean, deform: VertexDeform, material: Material, effect: MeshEffect | undefined, materialPass?: MaterialPass): string {
    const { colorFormat, depthFormat } = stage.output;
    const skin = skinned ? `${layout.joints}:${layout.weights}` : 'static';
    const doubleSided = colorFormat !== undefined && material.doubleSided;
    const depthFragment = colorFormat === undefined ? material.depthFragment : undefined;
    const transmits = stage.transparent && material.transmission !== undefined;
    const coated = colorFormat !== undefined && material.coat !== undefined;
    return `${stage.name}:${colorFormat}:${depthFormat}:${layout.position}:${layout.normal}:${layout.uv}:${layout.tangent}:${skin}:${deform}:${doubleSided}:${depthFragment}:${materialPass?.name}:${transmits}:${coated}:${treesKey(material.shaderTrees)}:${effect?.code ?? ''}`;
  }

  #pipelineDescriptor(stage: RenderStage, layout: VertexLayout, skinned: boolean, deform: VertexDeform, material: Material, effect: MeshEffect | undefined, materialPass?: MaterialPass): GPURenderPipelineDescriptor {
    const { colorFormat, depthFormat, surfaceFormats } = stage.output;
    // 只有深度的阶段不看材质（两面画的材质也只影响颜色阶段，阴影投射本来就不剔背面）
    // 颜色树的变体每个阶段都用：位移贴图在只写深度的阶段也要算（深度预通道和不透明阶段的深度要一样）
    const trees = material.shaderTrees;
    const doubleSided = colorFormat !== undefined && material.doubleSided;
    // Alpha 裁剪、透明混合的材质在只写深度的阶段也要片元着色器（丢掉被裁的、抖动掉的像素），别的材质那里不要
    const depthFragment = colorFormat === undefined ? material.depthFragment : undefined;
    {
      const offsets = vertexLayoutOffsets(layout);
      // 运动向量阶段不要切线（只算位置），用自己的顶点着色器
      // 高度场（地形块）的顶点按高度页算，有自己的入口；切线在着色器里由高度算
      // 远处卡片（Impostors.ts）的四个顶点按相机转、选图集的格子，也有自己的入口
      const entryPoint = stage.surfaceBake ? (deform === 'heightfield' ? 'vsSurfaceBakeHeightfield' : 'vsSurfaceBake')
        : deform === 'heightfield' ? (stage.velocity ? 'vsVelocityHeightfield' : 'vsHeightfield')
        : deform === 'impostor' ? (stage.velocity ? 'vsVelocityImpostor' : 'vsImpostor')
        : stage.velocity ? `vsVelocity${skinned ? 'Skinned' : ''}` : `vs${skinned ? 'Skinned' : ''}${layout.tangent ? 'Tangent' : ''}`;
      const module = this.#module(trees, effect);
      return {
        label: `MeshRenderFeature ${stage.name} ${layout.position}/${layout.normal}/${layout.uv}${skinned ? ' skinned' : ''}${deform === 'none' ? '' : ` ${deform}`}${trees ? ' material trees' : ''}`,
        layout: this.#layout(trees?.textures.length ?? 0).layout,
        vertex: {
          module,
          entryPoint,
          ...(deform === 'morph' ? { constants: { MORPHED: 1 } } : {}),
          buffers: [{
            arrayStride: offsets.stride,
            attributes: [
              { shaderLocation: 0, offset: offsets.position, format: layout.position },
              { shaderLocation: 1, offset: offsets.normal, format: layout.normal },
              { shaderLocation: 2, offset: offsets.uv, format: layout.uv },
              ...(layout.tangent && !stage.velocity ? [{ shaderLocation: 3, offset: offsets.tangent!, format: layout.tangent }] : []),
              ...(skinned ? [
                { shaderLocation: 4, offset: offsets.joints!, format: layout.joints! },
                { shaderLocation: 5, offset: offsets.weights!, format: layout.weights! },
              ] : []),
            ],
          }],
        },
        ...(colorFormat ? {
          fragment: stage.impostor || stage.surfaceBake ? {
            module, entryPoint: stage.impostor ? 'fsImpostorBake' : 'fsSurfaceBake', targets: [{ format: colorFormat }, ...(surfaceFormats ?? []).map((format) => ({ format }))],
          } : stage.picking || stage.wireframe || stage.velocity ? { module, entryPoint: stage.picking ? 'fsPick' : stage.wireframe ? 'fsWire' : 'fsVelocity', targets: [{ format: colorFormat }] } : {
            module,
            // 要留表面的阶段（屏幕空间反射开着时的不透明阶段）：普通的材质写表面，别的那一遍不写（写掩码 0）
            entryPoint: materialPass?.entryPoint ?? (surfaceFormats ? 'fsSurface' : 'fs'),
            ...(stage.transparent || material.coat ? { constants: { ...(stage.transparent ? { TRANSPARENT_STAGE: 1 } : {}), ...(material.coat ? { COATED: 1 } : {}) } } : {}),
            targets: [
              { format: colorFormat, ...(stage.transparent ? { blend: materialPass?.blend ?? PREMULTIPLIED_ALPHA } : {}) },
              ...(surfaceFormats ?? []).map((format) => ({ format, ...(materialPass ? { writeMask: 0 } : {}) })),
            ],
          },
        } : {}),
        ...(depthFragment ? { fragment: { module, entryPoint: depthFragment, targets: [] } } : {}),
        primitive: stage.wireframe
          ? { topology: 'line-list' }
          : stage.shadowCasters
            ? { topology: 'triangle-list', cullMode: 'none', unclippedDepth: this.#unclippedDepth && !stage.depthClip }
            : { topology: 'triangle-list', cullMode: stage.impostor || stage.surfaceBake ? 'none' : materialPass?.cullMode ?? (doubleSided ? 'none' : 'back'), frontFace: 'ccw' },
        // 深度预通道之后的阶段：同样的物体、同样的顶点着色器（位置是 @invariant 的）已经把深度写好了，这里只让深度相等的
        // 像素过，也不再写深度，被挡住的像素一个都不着色
        ...(stage.surfaceBake ? {} : { depthStencil: stage.afterDepthPrepass
          ? { format: depthFormat, depthWriteEnabled: false, depthCompare: 'equal' } as const
          : {
            format: depthFormat,
            // 透射的材质在透明阶段也写深度（照 Filament：它输出的是不透明的颜色，背景已经折射着取进来了）：一个合成的网格里
            // 前后好几个瓶子，不写深度时后面的三角形会盖住前面的
            depthWriteEnabled: (!stage.transparent || material.transmission !== undefined) && !stage.wireframe,
            // 反向 Z（RenderView.reversedDepth）：相机的视图近 1 远 0；阴影投射的阶段（阴影、天空遮挡）照旧是正向
            depthCompare: stage.shadowCasters || stage.impostor ? 'less-equal' : 'greater-equal',
            // 和 Stride 不同：阴影投射另加按坡度的深度偏移。只有常量偏移加法线偏移时，太阳低（20° 左右）、光掠过地面，
            // 阴影图的深度量化在受光面上成了一圈圈的痤疮（日夜循环里常见）
            ...(stage.shadowCasters ? { depthBiasSlopeScale: SHADOW_SLOPE_BIAS, depthBiasClamp: 0.01 } : {}),
          } }),
      };
    }
  }

  /** 新的一帧：换写另一半。 */
  nextFrame(): void {
    this.#parity = 1 - this.#parity;
  }

  /** 这一帧、上一帧的一半从哪起（单位同 half）。 */
  #bases(half: number): [current: number, previous: number] {
    return [this.#parity * half, (1 - this.#parity) * half];
  }

  /**
   * 世界矩阵列的 1..slotLimit 段（槽位 0 是空的，一起传，下标就和槽位一致），写进这一帧的那一半。没变就不传：这一半上次写的
   * 是第几次更新的，从那以后变了的槽位（changed 是这次更新的，TransformStore.changedSlots；再早一次的自己留着）按连着的段传；
   * 隔了两次以上的更新（编辑状态按需出帧时）、缓冲新建了、变了的太多时整段传。
   */
  uploadWorlds(world: Float32Array, slotLimit: number, changed: Int32Array, update: number): void {
    const floats = (slotLimit + 1) * 16;
    if (!this.#worlds || this.#halves.worlds * 64 < floats * 4) {
      this.#worlds?.destroy();
      const half = capacityFor(floats * 4);
      this.#worlds = this.#createStorage('MeshRenderFeature worlds', half * 2);
      this.#halves.worlds = half / 64;
      this.#worldsAt.fill(-Infinity);
      this.#clearViewBindGroups();
    }
    if (this.#changed.update !== update) {
      this.#changedBefore = this.#changed;
      this.#changed = { update, slots: changed.slice() };
    }
    const [current, previous] = this.#bases(this.#halves.worlds);
    this.#frameBases.set([current, previous], 0);
    const held = this.#worldsAt[this.#parity]!;
    this.#worldsAt[this.#parity] = update;
    if (held === update) return;
    const missing = held === update - 1 ? [this.#changed.slots] : held === update - 2 && this.#changedBefore.update === update - 1 ? [this.#changedBefore.slots, this.#changed.slots] : undefined;
    const count = missing?.reduce((sum, list) => sum + list.length, 0) ?? Infinity;
    // 直接从 wasm 的共享内存上传，不经过 JS 数组
    if (!missing || count > slotLimit / 4) {
      this.device.queue.writeBuffer(this.#worlds, current * 64, world, 0, floats);
      return;
    }
    const slots = missing.length === 1 ? missing[0]!.slice() : Int32Array.from([...missing[0]!, ...missing[1]!]);
    slots.sort();
    // 连着的（中间空不到 8 个的也算）合成一段传
    for (let i = 0; i < slots.length; ) {
      const start = slots[i]!;
      let end = start;
      while (++i < slots.length && slots[i]! <= end + 8) end = Math.max(end, slots[i]!);
      if (start > slotLimit) break;
      const last = Math.min(end, slotLimit);
      this.device.queue.writeBuffer(this.#worlds, (current + start) * 64, world, start * 16, (last - start + 1) * 16);
    }
  }

  /**
   * 蒙皮：变换槽位到蒙皮矩阵起点的表（改了才传），和所有蒙皮矩阵（每帧传，直接从 wasm 内存）。没有蒙皮网格时也建一个
   * 小缓冲：绑定组里的存储缓冲不能缺。
   */
  /** 材质实例的参数改了才整张传（缓冲换大了，视图绑定组作废）。 */
  uploadInstanceParams(params: SlotParams): void {
    if (!params.dirty && this.#instanceParams) return;
    params.dirty = false;
    const bytes = params.values.byteLength;
    if (!this.#instanceParams || this.#instanceParams.size < bytes) {
      this.#instanceParams?.destroy();
      this.#instanceParams = this.#createStorage('MeshRenderFeature instance params', capacityFor(bytes));
      this.#clearViewBindGroups();
    }
    this.device.queue.writeBuffer(this.#instanceParams, 0, params.values);
  }

  uploadSkinning(paletteOf: SlotTable, animation: AnimationSystem): void {
    const tableBytes = paletteOf.values.byteLength;
    if (!this.#paletteOf || this.#halves.paletteOf * 4 < tableBytes) {
      this.#paletteOf?.destroy();
      const half = capacityFor(tableBytes);
      this.#paletteOf = this.#createStorage('MeshRenderFeature paletteOf', half * 2);
      this.#halves.paletteOf = half / 4;
      this.#clearViewBindGroups();
      paletteOf.dirty = true;
    }
    const [table, previousTable] = this.#bases(this.#halves.paletteOf);
    if (paletteOf.dirty) {
      this.#paletteOfWrites = 2;
      paletteOf.dirty = false;
    }
    if (this.#paletteOfWrites > 0) {
      this.device.queue.writeBuffer(this.#paletteOf, table * 4, paletteOf.values);
      this.#paletteOfWrites--;
    }
    const paletteBytes = Math.max(animation.paletteCapacity, 1) * 64;
    if (!this.#palettes || this.#halves.palettes * 64 < paletteBytes) {
      this.#palettes?.destroy();
      const half = capacityFor(paletteBytes);
      this.#palettes = this.#createStorage('MeshRenderFeature palettes', half * 2);
      this.#halves.palettes = half / 64;
      this.#clearViewBindGroups();
    }
    const [current, previous] = this.#bases(this.#halves.palettes);
    this.#frameBases.set([table, previousTable, current, previous], 2);
    const palettes = this.#palettes;
    animation.forEachPalette((base, matrices) => this.device.queue.writeBuffer(palettes, (current + base) * 64, matrices));
  }

  /** 形变：槽位到权重起点的表（改了才传）和所有模型实例的权重（每帧传）。 */
  uploadMorphs(morphOf: SlotTable, animation: AnimationSystem): void {
    const tableBytes = morphOf.values.byteLength;
    if (!this.#morphOf || this.#halves.morphOf * 4 < tableBytes) {
      this.#morphOf?.destroy();
      const half = capacityFor(tableBytes);
      this.#morphOf = this.#createStorage('MeshRenderFeature morphOf', half * 2);
      this.#halves.morphOf = half / 4;
      this.#clearViewBindGroups();
      morphOf.dirty = true;
    }
    const [table, previousTable] = this.#bases(this.#halves.morphOf);
    if (morphOf.dirty) {
      this.#morphOfWrites = 2;
      morphOf.dirty = false;
    }
    if (this.#morphOfWrites > 0) {
      this.device.queue.writeBuffer(this.#morphOf, table * 4, morphOf.values);
      this.#morphOfWrites--;
    }
    const weightBytes = Math.max(animation.morphCapacity, 1) * 4;
    if (!this.#morphWeights || this.#halves.morphWeights * 4 < weightBytes) {
      this.#morphWeights?.destroy();
      const half = capacityFor(weightBytes);
      this.#morphWeights = this.#createStorage('MeshRenderFeature morph weights', half * 2);
      this.#halves.morphWeights = half / 4;
      this.#clearViewBindGroups();
    }
    const [current, previous] = this.#bases(this.#halves.morphWeights);
    this.#frameBases.set([table, previousTable, current, previous], 6);
    const weights = this.#morphWeights;
    animation.forEachMorph((base, values) => this.device.queue.writeBuffer(weights, (current + base) * 4, values));
  }

  /** 高度页：缓冲长大了重建、整个传，否则只传改了的那段（地形的块好了才写，平时不传）。 */
  uploadHeights(pages: HeightPages): void {
    if (!this.#heights || pages.grown) {
      this.#heights?.destroy();
      this.#heights = this.#createStorage('MeshRenderFeature heights', pages.data.byteLength);
      this.#clearViewBindGroups();
      this.device.queue.writeBuffer(this.#heights, 0, pages.data);
      pages.grown = false;
    } else if (pages.dirtyEnd > pages.dirtyStart) {
      this.device.queue.writeBuffer(this.#heights, pages.dirtyStart * 4, pages.data, pages.dirtyStart, pages.dirtyEnd - pages.dirtyStart);
    }
    pages.dirtyStart = Infinity;
    pages.dirtyEnd = 0;
  }

  /** 各次剔除的可见槽位（每个视图一段，直接在 wasm 内存里）依次拼成实例缓冲。 */
  /**
   * 各次剔除里 CPU 剔出来的可见槽位传进实例列表：全在 CPU 上剔的一次传整段（布局一样），GPU 剔除的只传透明的那几批各自的段
   * （别的段 GPU 自己写）。
   */
  uploadInstances(passes: readonly CullPass[], total: number, batches: readonly MeshBatch[]): void {
    const bytes = Math.max(total, 1) * 4;
    if (!this.#instances || this.#instances.size < bytes) {
      this.#instances?.destroy();
      this.#instances = this.#createStorage('MeshRenderFeature instances', capacityFor(bytes));
      this.#clearViewBindGroups();
    }
    for (const pass of passes) {
      if (pass.gpuView < 0) {
        const length = pass.views.length * pass.slotCount;
        if (length > 0) this.device.queue.writeBuffer(this.#instances, pass.offset * 4, pass.culler.visibleSlots, 0, length);
        continue;
      }
      const cpuCount = pass.cpuBatches.length;
      pass.views.forEach((_, v) => pass.cpuBatches.forEach((b, j) => {
        const count = pass.culler.counts[v * cpuCount + j]!;
        if (count > 0) this.device.queue.writeBuffer(this.#instances!, (pass.offset + v * pass.slotCount + batches[b]!.first) * 4, pass.culler.visibleSlots, v * pass.cpuSlotCount + pass.cpuFirst[j]!, count);
      }));
    }
  }

  /** 世界矩阵的缓冲、这一帧那一半的起点（第几个矩阵），实例列表的缓冲：GPU 剔除读写。 */
  get worldsBuffer(): GPUBuffer | undefined {
    return this.#worlds;
  }

  get worldsBase(): number {
    return this.#frameBases[0]!;
  }

  get instancesBuffer(): GPUBuffer | undefined {
    return this.#instances;
  }

  uploadViews(views: readonly RenderView[], lighting: Lighting, time: number): void {
    const stride = VIEW_STRIDE / 4;
    const planar = this.#planar;
    if (views.length * stride > this.#viewData.length) {
      this.#viewData = new Float32Array(2 ** Math.ceil(Math.log2(views.length)) * stride);
      this.#views?.destroy();
      this.#views = undefined;
      this.#clearViewBindGroups();
    }
    const { directionals, directionalCount, ambient, skybox, shadowAtlas, localCount } = lighting;
    const probes = this.#probes;
    // 云的影子落在哪盏方向光上（光照里按实体找；那盏光是黑的、被拿掉了时没有影子）
    const cloud = this.#clouds.shadow;
    const cloudLight = cloud ? directionals.findIndex((light, i) => i < directionalCount && light.entity === cloud.lightEntity) : -1;
    const data = this.#viewData, words = new Uint32Array(data.buffer);
    const { wetness, puddles, snowCover, rain } = this.#weather.surfaceWeather;
    const volumes = this.#weather.irradianceVolumes;
    // 路径追踪的间接光开着时：用不用的那一位是 2，漫反射的环境光整个由它（屏幕空间的间接光）代替
    const irradiance = volumes.shading();
    const occlusion = wetness > 0 || snowCover > 0;
    for (const view of views) {
      const o = view.index * stride;
      // 方向光的级联是这个视图自己的（ShadowMapRenderer 给每个接收阴影的视图各算一套）
      const shadow = view.receivesShadows ? view.shadow : undefined;
      data.set(view.viewProjection, o);
      data.set([view.eye.x, view.eye.y, view.eye.z, 1], o + 16);
      data.set([ambient.r, ambient.g, ambient.b, 1], o + 20);
      data.set([skybox?.intensity ?? 0, skybox?.skybox.specularLevels ?? 0, directionalCount, shadow && view.receivesShadows ? lighting.shadowLight : -1], o + 24);
      for (let c = 0; c < 9; c++) {
        const sh = skybox?.skybox.diffuseSH;
        data.set(sh ? [sh[c * 3]!, sh[c * 3 + 1]!, sh[c * 3 + 2]!, 0] : [0, 0, 0, 0], o + 28 + c * 4);
      }
      data.set(skybox ? skybox.rotation : IDENTITY, o + 64);
      data.fill(0, o + 80, o + 156);
      if (shadowAtlas && view.receivesShadows) {
        if (shadow) {
          data.set(shadow.worldToShadow, o + 80);
          data.set(shadow.splits, o + 144);
          data.set([shadow.cascadeCount, shadow.depthBias, shadow.normalOffsetScale, shadow.filterSize], o + 148);
        }
        data.set([1 / shadowAtlas.width, shadowAtlas.width, shadow?.blendCascades ? 1 : 0, shadow?.depthRangeAutomatic ? 1 : 0], o + 152);
      }
      for (let i = 0; i < directionalCount; i++) {
        const { direction, color } = directionals[i]!;
        const length = Math.hypot(direction.x, direction.y, direction.z) || 1;
        const penumbra = shadow && i === lighting.shadowLight ? shadow.penumbraTangent : 0;
        data.set([direction.x / length, direction.y / length, direction.z / length, penumbra], o + 156 + i * 4);
        data.set([color.r, color.g, color.b, 1], o + 172 + i * 4);
      }
      data.set([localCount, time, view.screenIndirect ? 1 : 0, probes.count], o + 188);
      words.set(this.#frameBases, o + 192);
      data.set(view.unjitteredViewProjection, o + 204);
      data.set(view.previousViewProjection, o + 220);
      data.set(cloud ? [cloud.scale, cloud.offset[0], cloud.offset[1], cloudLight] : [0, 0, 0, -1], o + 236);
      data.set([wetness, snowCover, puddles, rain], o + 240);
      const refraction = this.#refraction;
      data.set([this.#decals.count, view === refraction.receiver && refraction.texture ? refraction.maxMip + 1 : 0, 0, 0], o + 244);
      data.set(clusterParams(view), o + 248);
      data.set(planar.active && view === planar.receiver ? planar.params : PLANAR_OFF, o + 256);
      // 原点是 1024 米的整数倍，按 65536 米取模（图案 65 公里重复一次，单精度在这个范围里是毫米级）
      const origin = this.#weather.renderOrigin;
      data.set([origin[0] % ORIGIN_PATTERN_PERIOD, 0, origin[2] % ORIGIN_PATTERN_PERIOD, 0], o + 284);
      const wind = this.#weather.wind;
      data.set(view.windless ? [0, 0, 0, 0] : [...wind.velocity, wind.turbulence], o + 288);
      // 局部风源：中心已经在渲染空间里（同风场），没有的那几个强度是 0
      data.fill(0, o + 292, o + 312);
      if (!view.windless) wind.locals.forEach((local, i) => {
        data.set([...local.center, local.radius], o + 292 + i * 4);
        data[o + 308 + i] = local.strength;
      });
      data.set(irradiance, o + 312);
    }
    this.#views ??= this.device.createBuffer({ label: 'MeshRenderFeature views', size: this.#viewData.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    if (views.length > 0) this.device.queue.writeBuffer(this.#views, 0, this.#viewData, 0, views.length * stride);

    const skySpecular = !skybox ? this.#resources.blackCube : skybox.skybox instanceof Skybox ? this.#resources.skyboxSpecular(skybox.skybox) : skybox.skybox.specular;
    if (skySpecular !== this.#skySpecular || probes.generation !== this.#probeGeneration || cloud?.texture !== this.#cloudShadow || occlusion !== this.#occlusionBound || (occlusion && this.#weather.skyOcclusion.depthBuffer !== this.#occlusionDepth) || this.#decals.atlas !== this.#decalAtlas || this.#decals.buffer !== this.#decalBuffer || this.#decals.vectors !== this.#decalVectors || this.#clusters.buffer !== this.#clusterBuffer || this.#localLights.buffer !== this.#localLightBuffer || planar.generation !== this.#planarGeneration || this.#refraction.generation !== this.#refractionGeneration || volumes.generation !== this.#irradianceGeneration) {
      this.#planarGeneration = planar.generation;
      this.#irradianceGeneration = volumes.generation;
      this.#refractionGeneration = this.#refraction.generation;
      this.#clusterBuffer = this.#clusters.buffer;
      this.#localLightBuffer = this.#localLights.buffer;
      this.#decalAtlas = this.#decals.atlas;
      this.#decalBuffer = this.#decals.buffer;
      this.#decalVectors = this.#decals.vectors;
      this.#cloudShadow = cloud?.texture;
      this.#occlusionBound = occlusion;
      this.#occlusionDepth = occlusion ? this.#weather.skyOcclusion.depthBuffer : undefined;
      this.#skySpecular = skySpecular;
      this.#probeGeneration = probes.generation;
      this.#clearViewBindGroups();
    }
  }

  /**
   * 视图绑定组；shadowAtlas 是这个阶段采样的阴影图集，没有阴影或者正在画阴影时用空的；occlusion 是屏幕空间的环境光遮蔽，
   * contact 是接触阴影，没有时都用白图；screen 是第 26 个绑定（平面反射图或者折射拷的画面），没有时用 1x1 的空图。
   */
  viewBindGroup(shadowAtlas: GPUTexture | undefined, occlusion?: GPUTexture, contact?: GPUTexture, screen?: GPUTexture): GPUBindGroup {
    const atlas = shadowAtlas ?? this.#resources.emptyShadowAtlas;
    const ao = occlusion ?? this.#resources.openOcclusion;
    const shadow = contact ?? this.#resources.white;
    const reflection = screen ?? this.#planar.empty;
    const key = [atlas, ao, shadow, reflection].map((texture) => this.#textureId(texture)).join(',');
    let group = this.#viewBindGroups.get(key);
    if (!group) {
      group = this.device.createBindGroup({
        label: 'MeshRenderFeature view',
        layout: this.#viewLayout,
        entries: [
          { binding: 0, resource: { buffer: this.#views!, size: VIEW_FLOATS * 4 } },
          { binding: 1, resource: { buffer: this.#worlds! } },
          { binding: 2, resource: { buffer: this.#instances! } },
          { binding: 3, resource: this.#skySpecular!.createView({ dimension: 'cube' }) },
          { binding: 4, resource: { buffer: this.#dfgLut } },
          { binding: 5, resource: this.#resources.linearClamp },
          { binding: 6, resource: atlas.createView() },
          { binding: 7, resource: this.#resources.shadowComparison },
          { binding: 8, resource: { buffer: this.#paletteOf! } },
          { binding: 9, resource: { buffer: this.#palettes! } },
          { binding: 10, resource: { buffer: this.#localLights.buffer } },
          { binding: 11, resource: { buffer: this.#morphOf! } },
          { binding: 12, resource: { buffer: this.#morphWeights! } },
          { binding: 13, resource: { buffer: this.#heights! } },
          { binding: 14, resource: ao.createView() },
          { binding: 15, resource: shadow.createView() },
          { binding: 16, resource: this.#probes.cubes.createView({ dimension: 'cube-array' }) },
          { binding: 17, resource: { buffer: this.#probes.buffer } },
          { binding: 18, resource: (this.#cloudShadow ?? this.#resources.white).createView() },
          { binding: 19, resource: this.#resources.linearRepeat },
          ...this.#occlusionEntries(),
          { binding: 22, resource: { buffer: this.#decals.buffer } },
          { binding: 30, resource: { buffer: this.#decals.vectors } },
          { binding: 23, resource: this.#decals.atlas.createView({ dimension: '2d-array' }) },
          { binding: 24, resource: { buffer: this.#clusters.buffer } },
          { binding: 25, resource: { buffer: this.#localLights.ltc } },
          ...(this.#planar.supported ? [
            { binding: 26, resource: reflection.createView() },
            { binding: 27, resource: this.#weather.irradianceVolumes.atlas.createView() },
          ] : []),
          { binding: 29, resource: { buffer: this.#instanceParams ??= this.#createStorage('MeshRenderFeature instance params', 16) } },
        ],
      });
      this.#viewBindGroups.set(key, group);
    }
    return group;
  }

  #textureId(texture: GPUTexture): number {
    let id = this.#textureIds.get(texture);
    if (id === undefined) this.#textureIds.set(texture, (id = this.#nextTextureId++));
    return id;
  }

  /** 视图绑定组都作废（换了天空盒、探针、云影、天空遮挡，缓冲换大了）。 */
  #clearViewBindGroups(): void {
    this.#viewBindGroups.clear();
  }

  /** 天空遮挡的绑定：有湿或雪时绑真的（第一次用时才建），否则绑空的深度缓冲和有效位是 0 的参数。 */
  #occlusionEntries(): GPUBindGroupEntry[] {
    const sky = this.#weather.skyOcclusion;
    return this.#occlusionBound
      ? [{ binding: 20, resource: { buffer: sky.depthBuffer } }, { binding: 21, resource: { buffer: sky.uniform } }]
      : [{ binding: 20, resource: { buffer: this.#noOcclusionDepth } }, { binding: 21, resource: { buffer: this.#noOcclusion } }];
  }

  /** 网格的边的索引（线框）：每个三角形三条边，两个三角形共用的边只留一条。 */
  edges(mesh: Mesh, gpu: GpuMesh): { readonly buffer: GPUBuffer; readonly count: number } {
    if (!gpu.edges) {
      const { indices } = mesh.data;
      // 比顶点数大的一个数（顶点至少占一个字节）：两个下标并成一个键
      const span = mesh.data.vertices.byteLength;
      const seen = new Set<number>();
      const edges: number[] = [];
      for (let t = 0; t + 2 < indices.length; t += 3) {
        for (let e = 0; e < 3; e++) {
          const a = indices[t + e]!, b = indices[t + ((e + 1) % 3)]!;
          const key = Math.min(a, b) * span + Math.max(a, b);
          if (seen.has(key)) continue;
          seen.add(key);
          edges.push(a, b);
        }
      }
      gpu.edges = { buffer: this.#createFilled(`${mesh.name} edges`, GPUBufferUsage.INDEX, new Uint32Array(edges)), count: edges.length };
    }
    return gpu.edges;
  }

  mesh(mesh: Mesh, effect: MeshEffect | undefined): GpuMesh {
    let gpu = this.#meshes.get(mesh);
    if (!gpu) {
      const { vertices, indices } = mesh.data;
      const { positionOffset: po, positionScale: ps, uvOffset: uo, uvScale: us } = mesh.dequantize;
      const data = new ArrayBuffer(MESH_PARAMS_BYTES);
      new Float32Array(data).set([...po, 0, ...ps, 0, us[0], us[1], uo[0], uo[1]]);
      new Uint32Array(data)[12] = mesh.layout.normal === 'snorm16x2' ? 1 : 0;
      const [u0, v0, u1, v1] = mesh.uvBounds();
      new Float32Array(data).set([u0, v0, 1 / Math.max(u1 - u0, 1e-6), 1 / Math.max(v1 - v0, 1e-6)], 16 + MESH_EFFECT_PARAMETERS);
      const params = this.#createFilled(`${mesh.name} params`, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, new Uint8Array(data));
      gpu = {
        params,
        effect: undefined,
        effectVersion: -1,
        bindGroup: this.device.createBindGroup({
          label: `${mesh.name} params`,
          layout: this.#meshLayout,
          entries: [
            { binding: 0, resource: { buffer: params } },
            { binding: 1, resource: { buffer: mesh.data.morph ? this.#createFilled(`${mesh.name} morph`, GPUBufferUsage.STORAGE, mesh.data.morph) : this.#noMorph } },
          ],
        }),
        vertices: this.#createFilled(`${mesh.name} vertices`, GPUBufferUsage.VERTEX | (mesh.dynamic ? GPUBufferUsage.COPY_DST : 0), vertices),
        vertexVersion: mesh.vertexVersion,
        indices: this.#createFilled(`${mesh.name} indices`, GPUBufferUsage.INDEX, indices),
        indexFormat: indices instanceof Uint16Array ? 'uint16' : 'uint32',
        indexCount: indices.length,
      };
      this.#meshes.set(mesh, gpu);
    }
    if (gpu.vertexVersion !== mesh.vertexVersion) {
      const { vertices } = mesh.data;
      this.device.queue.writeBuffer(gpu.vertices, 0, vertices.buffer, vertices.byteOffset, vertices.byteLength);
      gpu.vertexVersion = mesh.vertexVersion;
    }
    if (effect && (gpu.effect !== effect || gpu.effectVersion !== mesh.effectVersion)) {
      // 网格改过的参数盖在效果的默认值上（NaN 是没改）
      const values = Float32Array.from(effect.defaults, (value, i) => {
        const own = mesh.effectParameters?.[i];
        return own === undefined || Number.isNaN(own) ? value : own;
      });
      this.device.queue.writeBuffer(gpu.params, 64, values);
      gpu.effect = effect;
      gpu.effectVersion = mesh.effectVersion;
    }
    return gpu;
  }

  /** 材质的矢量贴图用不用（调试命令 vector：和位图比清晰度、量开销）。 */
  vectorAtlases = true;

  /** 没有矢量贴图的材质绑的空数据（头是 0，着色器认出来不画）。 */
  #noVector: GPUBuffer | undefined;

  /** 材质的矢量贴图上传一次（同一份数据不重复传），没有时用空的。 */
  #vectorBuffer(gpu: GpuMaterial, data: Uint32Array | undefined): GPUBuffer {
    if (!data) return (this.#noVector ??= this.device.createBuffer({ label: 'MeshRenderFeature no vector atlas', size: 64, usage: GPUBufferUsage.STORAGE }));
    if (!gpu.vector || gpu.vector.size !== data.byteLength) {
      gpu.vector?.destroy();
      gpu.vector = this.device.createBuffer({ label: 'MeshRenderFeature vector atlas', size: data.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      this.device.queue.writeBuffer(gpu.vector, 0, data.buffer, data.byteOffset, data.byteLength);
    }
    return gpu.vector;
  }

  /** 材质的绑定组；参数改了（version 变了）就重新上传。 */
  material(material: Material): GPUBindGroup {
    let gpu = this.#materials.get(material);
    if (!gpu) {
      const buffer = this.device.createBuffer({ label: `${material.name} material`, size: MATERIAL_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      gpu = { buffer, bindGroup: undefined, version: -1, vector: undefined, vectorOn: this.vectorAtlases };
      this.#materials.set(material, gpu);
    }
    if (gpu.version !== material.version || !gpu.bindGroup || gpu.vectorOn !== this.vectorAtlases) {
      gpu.vectorOn = this.vectorAtlases;
      const { baseColorTexture: slot, normalMap, emissiveTexture, ambientOcclusion: occlusion, transparency } = material;
      const { r, g, b, a } = material.baseColor;
      const uv = (texture: Required<MaterialTexture> | undefined) => [...(texture?.scale ?? [1, 1]), ...(texture?.offset ?? [0, 0])];
      const floats = new Float32Array(this.#materialData);
      // emissive.w：镜面项的透明系数（matDiffuseSpecularAlphaBlend.y），不透明是 1
      floats.set([r, g, b, a, ...uv(slot), ...material.emissive, transparency ? transparency.specularAlpha : 1]);
      floats.set([material.metalness ?? 0, material.roughness, material.cavity.diffuse, material.cavity.specular], 12);
      floats.set(uv(normalMap), 16);
      floats.set([...(material.specular ?? [0, 0, 0]), 0], 20);
      floats.set(uv(emissiveTexture), 24);
      floats.set(occlusion.texture ? CHANNELS[occlusion.texture.channel] : [occlusion.value, 0, 0, 0], 28);
      floats.set(uv(occlusion.texture), 32);
      floats.set(transparency ? [...transparency.tint, transparency.alpha] : [1, 1, 1, 1], 36);
      const codes = new Uint32Array(this.#materialData);
      codes[40] = OPERATOR_CODES[material.baseColorOperator];
      // 清漆的两遍都是金属度工作流（各自的金属度由颜色树给）
      const workflow = material.hasClearCoat ? 1 : material.specular ? (material.specularEnergyConservative ? 3 : 2) : material.metalness === undefined ? 0 : 1;
      codes[41] = workflow | (material.specularShading ? 0 : 4) | (material.diffuseShading ? 0 : 8) | microfacetBits(material.microfacet);
      codes[42] = normalMap ? 1 | (normalMap.scaleAndBias ? 2 : 0) | (normalMap.invertY ? 4 : 0) | (normalMap.isXYNormal ? 8 : 0) : 0;
      floats[43] = occlusion.directLighting;
      const gloss = material.glossinessMap;
      floats.set(gloss ? CHANNELS[gloss.channel] : [0, 0, 0, 0], 44);
      floats.set(uv(gloss), 48);
      // 第 3..5 位、6..8 位：光泽度贴图里金属度、透射的通道 + 1（0 是没有）
      const channelBits = (channel: string | undefined) => (channel ? 'rgba'.indexOf(channel) + 1 : 0);
      // 第 9 位：有矢量贴图（近处代替基础色贴图，vectorAtlas.ts）
      const vector = slot && material.vectorAtlas && this.vectorAtlases ? material.vectorAtlas : undefined;
      const textures = (slot ? 1 : 0) | (emissiveTexture ? 2 : 0) | (occlusion.texture ? 4 : 0) | (channelBits(gloss?.metalnessChannel) << 3) | (channelBits(gloss?.transmissionChannel) << 6) | (vector ? 512 : 0);
      floats.set([gloss?.invert ? 1 : 0, material.alphaCutoff ?? -1, material.glass?.refractiveIndex ?? 0, textures], 52);
      const scattering = material.subsurfaceScattering;
      floats.set([this.#subsurface.slotOf(material), scattering?.translucency ?? 0, scattering?.width ?? 0, 0], 56);
      const { sheen, anisotropy } = material;
      floats.set(sheen ? [...sheen.color, sheen.roughness] : [0, 0, 0, 0], 60);
      floats.set(anisotropy ? [anisotropy.strength, Math.cos(anisotropy.rotation), Math.sin(anisotropy.rotation), 0] : [0, 1, 0, 0], 64);
      // 卡通着色：节点数（0 是不用）、FakeNDotL，再是两条渐变各 CEL_RAMP_STOPS 个节点
      const cel = material.celShading;
      floats.set([cel?.diffuse?.ramp.length ?? 0, cel?.specular?.ramp.length ?? 0, cel?.diffuse?.fakeNDotL ?? 0, 0], 68);
      floats.fill(0, 72, 72 + CEL_RAMP_STOPS * 8);
      cel?.diffuse?.ramp.forEach((stop, i) => floats.set(stop, 72 + i * 4));
      cel?.specular?.ramp.forEach((stop, i) => floats.set(stop, 72 + CEL_RAMP_STOPS * 4 + i * 4));
      // 透射：比例、折射率、厚度；吸收系数 -ln(颜色) / 距离（glTF 的 volume）
      const transmission = material.transmission;
      floats.set(transmission ? [transmission.factor, transmission.ior, transmission.thickness, 0] : [0, 1.5, 0, 0], 72 + CEL_RAMP_STOPS * 8);
      floats.set(transmission ? [...transmission.attenuationColor.map((c) => -Math.log(Math.max(c, 1e-4)) / transmission.attenuationDistance), 0] : [0, 0, 0, 0], 76 + CEL_RAMP_STOPS * 8);
      floats.set(material.wind ? [material.wind.bend, material.wind.flutter, material.wind.mode === 'grass' ? 1 : 0, 0] : [0, 0, 0, 0], 80 + CEL_RAMP_STOPS * 8);
      const interior = material.interior;
      floats.set(interior ? [...interior.room, interior.lit, interior.brightness, 0, 0, 0] : [0, 0, 0, 0, 0, 0, 0, 0], 84 + CEL_RAMP_STOPS * 8);
      const parallax = material.normalMap?.parallax;
      floats.set(parallax ? [parallax.depth, parallax.steps ?? 24, 0, 0] : [0, 0, 0, 0], 92 + CEL_RAMP_STOPS * 8);
      const { iridescence, diffuseTransmission } = material;
      floats.set(iridescence ? [iridescence.factor, iridescence.ior, iridescence.thickness, 0] : [0, 1.3, 400, 0], 96 + CEL_RAMP_STOPS * 8);
      floats.set(diffuseTransmission ? [...diffuseTransmission.color, diffuseTransmission.factor] : [1, 1, 1, 0], 100 + CEL_RAMP_STOPS * 8);
      const variation = material.variation;
      floats.set([((variation?.hue ?? 0) * Math.PI) / 180, variation?.saturation ?? 0, variation?.value ?? 0, variation?.roughness ?? 0], 104 + CEL_RAMP_STOPS * 8);
      const coat = material.coat;
      floats.set(coat ? [coat.factor, coat.roughness, 0, 0, ...(coat.color ?? [1, 1, 1]), 0] : [0, 0, 0, 0, 1, 1, 1, 0], 108 + CEL_RAMP_STOPS * 8);
      // 节点图的数值参数（缓冲是共用的，上一个材质的留着，先清掉）
      const graphAt = 116 + CEL_RAMP_STOPS * 8;
      floats.fill(0, graphAt, graphAt + GraphParams.SLOTS);
      if (material.shaderTrees?.graphParams) floats.set(material.shaderTrees.graphParams, graphAt);
      this.device.queue.writeBuffer(gpu.buffer, 0, this.#materialData);
      const view = (texture: Required<MaterialTexture> | undefined) => (texture ? this.#resources.texture(texture.texture) : this.#resources.white).createView();
      const sampler = (texture: Required<MaterialTexture> | undefined) => this.#resources.sampler(texture?.sampler ?? {});
      gpu.bindGroup = this.device.createBindGroup({
        label: `${material.name} material`,
        layout: this.#materialLayout,
        entries: [
          { binding: 0, resource: { buffer: gpu.buffer } },
          { binding: 1, resource: view(slot) },
          { binding: 2, resource: sampler(slot) },
          { binding: 3, resource: view(normalMap) },
          { binding: 4, resource: view(emissiveTexture) },
          { binding: 5, resource: view(occlusion.texture) },
          { binding: 6, resource: sampler(normalMap) },
          { binding: 7, resource: sampler(emissiveTexture) },
          { binding: 8, resource: sampler(occlusion.texture) },
          { binding: 9, resource: view(gloss) },
          { binding: 10, resource: sampler(gloss) },
          { binding: 11, resource: { buffer: this.#vectorBuffer(gpu, vector) } },
        ],
      });
      gpu.version = material.version;
    }
    return gpu.bindGroup;
  }

  /** 网格的显存释放掉（之后再画会重新上传）。 */
  forget(mesh: Mesh): void {
    const gpu = this.#meshes.get(mesh);
    if (!gpu) return;
    for (const buffer of [gpu.params, gpu.vertices, gpu.indices, gpu.edges?.buffer]) buffer?.destroy();
    this.#meshes.delete(mesh);
  }

  destroy(): void {
    for (const buffer of [this.#worlds, this.#instances, this.#instanceParams, this.#views, this.#paletteOf, this.#palettes, this.#morphOf, this.#morphWeights, this.#heights, this.#noMorph]) buffer?.destroy();
    for (const { params, vertices, indices, edges } of this.#meshes.values()) {
      params.destroy();
      vertices.destroy();
      indices.destroy();
      edges?.buffer.destroy();
    }
    for (const { buffer, vector } of this.#materials.values()) {
      buffer.destroy();
      vector?.destroy();
    }
    this.#noVector?.destroy();
    this.#dfgLut.destroy();
  }

  #createStorage(label: string, size: number): GPUBuffer {
    return this.device.createBuffer({ label, size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  }

  /** 建好就填上数据的缓冲；用 mappedAtCreation，所以 16 位索引的字节数不必是 4 的倍数。 */
  #createFilled(label: string, usage: number, data: ArrayBufferView): GPUBuffer {
    const buffer = this.device.createBuffer({ label, size: Math.ceil(data.byteLength / 4) * 4, usage, mappedAtCreation: true });
    new Uint8Array(buffer.getMappedRange()).set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    buffer.unmap();
    return buffer;
  }
}

/** 材质在透明阶段里多画的一遍：用哪个片元入口、怎么混合、剔哪一面。name 进管线的键。 */
export interface MaterialPass {
  readonly name: string;
  readonly entryPoint: 'fs' | 'fsGlassTransmittance' | 'fsClearCoat';
  readonly blend: GPUBlendState;
  readonly cullMode: GPUCullMode;
}

/** 目标的 alpha 不动。 */
const KEEP_ALPHA: GPUBlendComponent = { srcFactor: 'zero', dstFactor: 'one' };
/** 玻璃透射的那一遍：背景乘上着色器的输出。 */
const GLASS_TRANSMITTANCE: GPUBlendState = { color: { srcFactor: 'zero', dstFactor: 'src' }, alpha: KEEP_ALPHA };
/** 玻璃反射的那一遍：加到背景上（Stride 的 BlendStates.Additive：源乘它的 alpha）。 */
const GLASS_REFLECTANCE: GPUBlendState = { color: { srcFactor: 'src-alpha', dstFactor: 'one' }, alpha: KEEP_ALPHA };
/** 清漆的那一遍：原样加到底下一遍上（Stride 的 PremultipliedAdditive：颜色已经乘过 alpha）。 */
const CLEAR_COAT_ADDITIVE: GPUBlendState = { color: { srcFactor: 'one', dstFactor: 'one' }, alpha: KEEP_ALPHA };

const glassPass = (face: 'back' | 'front', part: 'transmittance' | 'reflectance'): MaterialPass => ({
  name: `glass-${face}-${part}`,
  entryPoint: part === 'transmittance' ? 'fsGlassTransmittance' : 'fs',
  blend: part === 'transmittance' ? GLASS_TRANSMITTANCE : GLASS_REFLECTANCE,
  // 画背面就是剔掉正面
  cullMode: face === 'back' ? 'front' : 'back',
});
const GLASS_FRONT = [glassPass('front', 'transmittance'), glassPass('front', 'reflectance')];
const GLASS_BOTH = [glassPass('back', 'transmittance'), glassPass('back', 'reflectance'), ...GLASS_FRONT];
const CLEAR_COAT_PASSES: readonly MaterialPass[] = [{ name: 'clear-coat', entryPoint: 'fsClearCoat', blend: CLEAR_COAT_ADDITIVE, cullMode: 'back' }];
export const NO_PASSES: readonly MaterialPass[] = [];

/**
 * 材质在透明阶段要多画的遍（空的：照常画一遍）。
 * - 玻璃：透射、反射两遍；两面画时背面两遍、正面两遍。和 Stride 不同：Stride 的注释写的是先背面后正面，代码却是先正面
 *   （前两遍剔掉背面）；我们照注释的顺序，离相机远的面先画，它的反射才会被近的面挡掉一部分。
 * - 清漆：底下一遍在不透明阶段照常画过了，这里叠清漆的那一遍。
 */
export function transparentPasses(material: Material): readonly MaterialPass[] {
  if (material.glass) return material.doubleSided ? GLASS_BOTH : GLASS_FRONT;
  return material.hasClearCoat ? CLEAR_COAT_PASSES : NO_PASSES;
}

/** 按材质的颜色树分着色器模块和管线用的键。 */
function treesKey(trees: MaterialShaderTrees | undefined): string {
  return trees ? JSON.stringify([trees.code, trees.emissive, trees.normal, trees.displacement, trees.layers, trees.graphs, trees.clearCoat]) : '';
}

/** Stride 的 BlendStates.AlphaBlend：颜色已经乘过 alpha。 */
const PREMULTIPLIED_ALPHA: GPUBlendState = {
  color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
};

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/**
 * 在 GPU 上积分出 DFG 查找表（一次计算，按存储缓冲写；着色时按 uniform 读）。管线在后台编（引擎启动时建，加载内容要几秒，
 * 第一帧之前早就算好了），编好再算。
 */
function createDfgLut(device: GPUDevice): GPUBuffer {
  const buffer = device.createBuffer({ label: 'DFG LUT', size: DFG_LUT_WIDTH * DFG_LUT_HEIGHT * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.UNIFORM });
  void device.createComputePipelineAsync({
    label: 'DFG LUT', layout: 'auto',
    compute: { module: device.createShaderModule({ label: 'DFG LUT', code: DFG_LUT_SHADER }), entryPoint: 'main' },
  }).then((pipeline) => integrateDfg(device, pipeline, buffer));
  return buffer;
}

function integrateDfg(device: GPUDevice, pipeline: GPUComputePipeline, buffer: GPUBuffer): void {
  const encoder = device.createCommandEncoder({ label: 'DFG LUT' });
  const pass = encoder.beginComputePass({ label: 'DFG LUT' });
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer } }] }));
  pass.dispatchWorkgroups(Math.ceil(DFG_LUT_WIDTH / 8), Math.ceil(DFG_LUT_HEIGHT / 8));
  pass.end();
  device.queue.submit([encoder.finish()]);
}

/** 缓冲按 2 的幂增长，避免每多一个实体就重建。 */
function capacityFor(bytes: number): number {
  return Math.max(256, 2 ** Math.ceil(Math.log2(bytes)));
}
