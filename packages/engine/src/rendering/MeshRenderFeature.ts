/**
 * 网格的根渲染特性（Stride 的 MeshRenderFeature）。着色和 Stride 默认的 PBR 材质一致（StrideForwardShadingEffect
 * 里 MaterialSurfaceShadingDiffuseLambert 加 MaterialSurfaceShadingSpecularMicrofacet）：
 * - 金属度工作流：镜面色 = lerp(0.02, albedo, 金属度)，漫反射色 = albedo · (1 - 金属度)，再乘 cavity；
 * - 直射光：漫反射 albedo / π · 光色 · N·L；镜面 F · G · D / 4 · 光色 · N·L，D 是 GGX，F 是 Schlick（用 L·H），
 *   G 是 Smith-Schlick-GGX（已除以 N·L · N·V），alphaR = 粗糙度²（至少 0.001），N·L 至少 0.0001；
 * - 环境光（Stride 的 LightSimpleAmbient）：漫反射和镜面都用环境色；
 * - 天空盒光（LightSkyboxShader）：漫反射用 3 阶球谐，镜面在反射方向上按 mip = sqrt(alphaR) · 级数 采样预滤波的
 *   立方体贴图；方向先按天空盒的旋转转回去，再把 z 取反（Stride 的立方体贴图约定）；
 * - 环境光的镜面项乘 DFG 查找表（MaterialSpecularMicrofacetEnvironmentGGXLUT：按 (1 - sqrt(alphaR), N·V) 采样，
 *   specular · r + g）。查找表启动时在 GPU 上积分生成，和 Stride 自带的那张一致（最大误差约 0.02）；
 * - 自发光直接加上。
 * 输出线性的 HDR 颜色，色调映射在后面（ToneMapRenderer）。
 *
 * 数据流：
 * - Extract：遍历带 Model 和 Transform 的实体，按（网格，材质）分批，每批记下实体的变换槽位。
 * - Prepare：把变换存储的世界矩阵列整段上传（直接从 wasm 内存，只传用到的那一段），批次的槽位拼成一个
 *   实例缓冲上传，每个视图的常量（相机、光照、天空盒）写进按视图分块的 uniform 缓冲（动态偏移）。
 * - Draw：每批一次实例化绘制；着色器用 worlds[slots[instance_index]] 取世界矩阵，firstInstance 是批次的起点。
 * 每帧上传都只写一次、在提交之前，不会碰到 writeBuffer 生效时机的坑（docs/lessons.md）。
 */
import { system } from '../engine/system';
import { Transform } from '../engine/transform';
import { Model } from './components';
import { FULLSCREEN_VERTEX } from './fullscreen';
import type { GpuResources } from './GpuResources';
import { Material } from './Material';
import { Mesh, VERTEX_FLOATS } from './Mesh';
import { RootRenderFeature, type Lighting, type RenderContext, type RenderStage, type RenderView } from './RenderSystem';

/** 一次实例化绘制：同一个网格和材质的实体。 */
export interface MeshBatch {
  readonly mesh: Mesh;
  readonly material: Material;
  /** 实体的变换槽位，前 count 个有效。 */
  slots: Uint32Array;
  count: number;
  /** 在实例缓冲里的起点，Prepare 时算。 */
  first: number;
}

/** BRDF 的几个函数，同 Stride 的 BRDFMicrofacet.sdsl。 */
const BRDF = /* wgsl */ `
const PI = 3.14159265358979;

fn normalDistributionGGX(alphaR: f32, nDotH: f32) -> f32 {
  let alphaR2 = alphaR * alphaR;
  let d = max(nDotH * nDotH * (alphaR2 - 1.0) + 1.0, 0.0001);
  return alphaR2 / (PI * d * d);
}

fn visibilitySchlickGGX(alphaR: f32, nDotX: f32) -> f32 {
  let k = alphaR * 0.5;
  return nDotX / (nDotX * (1.0 - k) + k);
}

/** Smith-Schlick-GGX，已经除以 N·L · N·V。 */
fn visibilitySmithSchlickGGX(alphaR: f32, nDotL: f32, nDotV: f32) -> f32 {
  return visibilitySchlickGGX(alphaR, nDotL) * visibilitySchlickGGX(alphaR, nDotV) / (nDotL * nDotV);
}`;

const SHADER = /* wgsl */ `
${BRDF}

struct View {
  viewProjection: mat4x4f,
  eye: vec4f,
  lightDirection: vec4f,
  lightColor: vec4f,
  ambientColor: vec4f,
  // x：天空盒光的强度（没有天空盒时是 0），y：镜面立方体贴图的级数
  sky: vec4f,
  skySH: array<vec4f, 9>,
  skyRotation: mat4x4f,
};
@group(0) @binding(0) var<uniform> view: View;
@group(0) @binding(1) var<storage, read> worlds: array<mat4x4f>;
@group(0) @binding(2) var<storage, read> slots: array<u32>;
@group(0) @binding(3) var skySpecular: texture_cube<f32>;
@group(0) @binding(4) var dfgLut: texture_2d<f32>;
@group(0) @binding(5) var linearClamp: sampler;

// 漫反射 = combine(贴图(uv * scale + offset), baseColor)；combine 0 是乘，1 是加（operator 是 WGSL 的保留字）。
// 没有贴图的材质绑一张 1x1 的白图。surface：金属度、粗糙度、漫反射 cavity、镜面 cavity。
struct Material {
  baseColor: vec4f,
  uvTransform: vec4f,
  emissive: vec4f,
  surface: vec4f,
  combine: u32,
  specular: u32,
};
@group(1) @binding(0) var<uniform> material: Material;
@group(1) @binding(1) var baseColorTexture: texture_2d<f32>;
@group(1) @binding(2) var baseColorSampler: sampler;

struct Varyings {
  @builtin(position) position: vec4f,
  @location(0) world: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
};

@vertex fn vs(@location(0) position: vec3f, @location(1) normal: vec3f, @location(2) uv: vec2f, @builtin(instance_index) instance: u32) -> Varyings {
  let world = worlds[slots[instance]];
  let worldPosition = world * vec4f(position, 1.0);
  var out: Varyings;
  out.position = view.viewProjection * worldPosition;
  out.world = worldPosition.xyz;
  // 均匀缩放下法线直接用世界矩阵变换；非均匀缩放要用逆转置，等材质系统一起做
  out.normal = (world * vec4f(normal, 0.0)).xyz;
  out.uv = uv;
  return out;
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

@fragment fn fs(in: Varyings) -> @location(0) vec4f {
  let n = normalize(in.normal);
  let v = normalize(view.eye.xyz - in.world);
  let texel = textureSample(baseColorTexture, baseColorSampler, in.uv * material.uvTransform.xy + material.uvTransform.zw).rgb;
  let albedo = select(texel * material.baseColor.rgb, texel + material.baseColor.rgb, material.combine == 1u);

  // 金属度工作流（MaterialSurfaceMetalness），再乘 cavity（PrepareMaterialForLightingAndShading）
  let hasSpecular = material.specular == 1u;
  let metalness = material.surface.x;
  let diffuse = select(albedo, albedo * (1.0 - metalness), hasSpecular) * material.surface.z;
  let specular = select(vec3f(0.0), mix(vec3f(0.02), albedo, metalness), hasSpecular) * material.surface.w;
  let roughness = material.surface.y;
  let alphaR = max(roughness * roughness, 0.001);
  let nDotV = max(dot(n, v), 0.0001);

  // 直射光（DirectLightGroup）
  let l = -view.lightDirection.xyz;
  let nDotL = max(dot(n, l), 0.0001);
  let lightColorNdotL = view.lightColor.rgb * nDotL;
  var color = diffuse / PI * lightColorNdotL;
  let h = normalize(v + l);
  let nDotH = saturate(dot(n, h));
  let lDotH = saturate(dot(l, h));
  let fresnel = specular + (1.0 - specular) * pow(1.0 - lDotH, 5.0);
  let reflected = fresnel * visibilitySmithSchlickGGX(alphaR, nDotL, nDotV) * normalDistributionGGX(alphaR, nDotH) / 4.0;
  color += select(vec3f(0.0), reflected * lightColorNdotL, hasSpecular);

  // 环境光：镜面项都乘 DFG（Stride 的环境 BRDF 查找表）
  let dfg = textureSampleLevel(dfgLut, linearClamp, vec2f(1.0 - sqrt(alphaR), nDotV), 0.0).rg;
  let environmentSpecular = select(vec3f(0.0), specular * dfg.x + dfg.y, hasSpecular);
  color += diffuse * view.ambientColor.rgb + environmentSpecular * view.ambientColor.rgb;

  // 天空盒光：强度是 0 时贡献也是 0，不用分支
  let skyIntensity = view.sky.x;
  let skyDiffuse = evaluateSH(skyDirection(n)) * skyIntensity;
  let reflection = skyDirection(reflect(-v, n));
  let skySpecularColor = textureSampleLevel(skySpecular, linearClamp, reflection, sqrt(alphaR) * view.sky.y).rgb * skyIntensity;
  color += diffuse * skyDiffuse + environmentSpecular * skySpecularColor;

  color += material.emissive.rgb;
  return vec4f(color, 1.0);
}`;

const DFG_LUT_WIDTH = 32;
const DFG_LUT_HEIGHT = 64;

/**
 * 环境 BRDF 的 DFG 查找表：x 是光泽度（1 - sqrt(alphaR)），y 是 N·V，值是 (scale, bias)，镜面项 = specular · scale + bias。
 * GGX 重要性采样（1024 个 Hammersley 点），G 用 Smith-Schlick-GGX，F 用 Schlick；尺寸同 Stride 的 EnvironmentLightingDFGLUT16。
 */
const DFG_LUT_SHADER = /* wgsl */ `
${BRDF}
${FULLSCREEN_VERTEX}

const SAMPLES = 1024u;

@fragment fn fs(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let size = vec2f(${DFG_LUT_WIDTH}.0, ${DFG_LUT_HEIGHT}.0);
  let glossiness = position.x / size.x;
  let nDotV = position.y / size.y;
  let roughness = 1.0 - glossiness;
  let alphaR = roughness * roughness;
  let a2 = alphaR * alphaR;
  let v = vec3f(sqrt(1.0 - nDotV * nDotV), 0.0, nDotV);
  var scale = 0.0;
  var bias = 0.0;
  for (var i = 0u; i < SAMPLES; i++) {
    let xi = vec2f(f32(reverseBits(i)) * 2.3283064365386963e-10, (f32(i) + 0.5) / f32(SAMPLES));
    let phi = 2.0 * PI * xi.x;
    let cosTheta = sqrt((1.0 - xi.y) / (1.0 + (a2 - 1.0) * xi.y));
    let sinTheta = sqrt(1.0 - cosTheta * cosTheta);
    let h = vec3f(sinTheta * cos(phi), sinTheta * sin(phi), cosTheta);
    let vDotH = dot(v, h);
    let l = 2.0 * vDotH * h - v;
    let nDotL = l.z;
    if (nDotL > 0.0) {
      let g = visibilitySchlickGGX(alphaR, nDotL) * visibilitySchlickGGX(alphaR, nDotV);
      let visibility = g * max(vDotH, 0.0) / (max(h.z, 0.0) * nDotV);
      let fc = pow(1.0 - max(vDotH, 0.0), 5.0);
      scale += (1.0 - fc) * visibility;
      bias += fc * visibility;
    }
  }
  return vec4f(scale / f32(SAMPLES), bias / f32(SAMPLES), 0.0, 1.0);
}`;

/** 每个视图的常量占一块：uniform 的动态偏移必须是 minUniformBufferOffsetAlignment（256）的整数倍。 */
const VIEW_STRIDE = 512;
/** View 结构：viewProjection 16、eye 4、光方向 4、光色 4、环境色 4、sky 4、球谐 36、天空盒旋转 16。 */
const VIEW_FLOATS = 88;
/** 材质 uniform：baseColor、uvTransform、emissive、surface 各一个 vec4，再加 combine、specular 两个 u32，补齐到 16 字节。 */
const MATERIAL_BYTES = 80;
const OPERATOR_CODES = { multiply: 0, add: 1 } as const;
/** 交错的顶点：位置 xyz、法线 xyz、UV xy（Mesh 的布局）。 */
const VERTEX_STRIDE = VERTEX_FLOATS * 4;

interface GpuMesh {
  readonly vertices: GPUBuffer;
  readonly indices: GPUBuffer;
  readonly indexFormat: GPUIndexFormat;
  readonly indexCount: number;
}

interface GpuMaterial {
  readonly buffer: GPUBuffer;
  bindGroup: GPUBindGroup | undefined;
  version: number;
}

export class MeshRenderFeature extends RootRenderFeature {
  /** 这一帧的批次，按第一次出现的顺序；空的批次留着下一帧复用。 */
  readonly batches: MeshBatch[] = [];
  readonly #batchByKey = new Map<number, MeshBatch>();
  #instanceCount = 0;

  readonly #extractSystem = system('MeshRenderFeature.extract', {
    with: { model: Model, transform: Transform },
    update: ({ model, transform, count }) => {
      const { mesh, material } = model;
      const { slot } = transform;
      // 相邻的行大多是同一批，先比较上一批，省掉大部分 Map 查找
      let batch: MeshBatch | undefined;
      for (let i = 0; i < count; i++) {
        const meshId = mesh[i]!, materialId = material[i]!;
        if (!batch || batch.mesh.id !== meshId || batch.material.id !== materialId) batch = this.#batchFor(meshId, materialId);
        if (batch.count === batch.slots.length) batch.slots = grow(batch.slots, batch.count * 2);
        batch.slots[batch.count++] = slot[i]!;
      }
    },
  });

  // GPU 资源，第一次 Prepare 时创建
  #gpu: Gpu | undefined;

  override extract(context: RenderContext): void {
    for (const batch of this.batches) batch.count = 0;
    context.game.entities.run(this.#extractSystem, context.time);
  }

  /** 这一帧要画的实例总数。 */
  get instanceCount(): number {
    return this.#instanceCount;
  }

  override prepare(context: RenderContext): void {
    const gpu = (this.#gpu ??= new Gpu(this.system.device, this.system.resources));
    let first = 0;
    for (const batch of this.batches) {
      batch.first = first;
      first += batch.count;
    }
    this.#instanceCount = first;

    gpu.uploadWorlds(context.game.transforms.world, context.game.transforms.slotLimit);
    gpu.uploadInstances(this.batches, first);
    gpu.uploadViews(this.system.views, this.system.lighting);
  }

  override draw(_context: RenderContext, pass: GPURenderPassEncoder, view: RenderView, stage: RenderStage): void {
    const gpu = this.#gpu;
    if (!gpu || this.#instanceCount === 0) return;
    pass.setPipeline(gpu.pipelineFor(stage));
    pass.setBindGroup(0, gpu.viewBindGroup(), [view.index * VIEW_STRIDE]);
    let mesh: Mesh | undefined, material: Material | undefined;
    for (const batch of this.batches) {
      if (batch.count === 0) continue;
      // pass 内只在变化时重设状态（docs/lessons.md）
      if (batch.material !== material) {
        material = batch.material;
        pass.setBindGroup(1, gpu.material(material));
      }
      const gpuMesh = gpu.mesh(batch.mesh);
      if (batch.mesh !== mesh) {
        mesh = batch.mesh;
        pass.setVertexBuffer(0, gpuMesh.vertices);
        pass.setIndexBuffer(gpuMesh.indices, gpuMesh.indexFormat);
      }
      pass.drawIndexed(gpuMesh.indexCount, batch.count, 0, 0, batch.first);
    }
  }

  override destroy(): void {
    this.#gpu?.destroy();
    this.#gpu = undefined;
  }

  #batchFor(meshId: number, materialId: number): MeshBatch {
    // 两个 id 都远小于 2^26，拼成一个整数键不会冲突
    const key = meshId * 0x4000000 + materialId;
    let batch = this.#batchByKey.get(key);
    if (!batch) {
      const mesh = Mesh.byId(meshId);
      const material = Material.byId(materialId);
      if (!mesh) throw new Error(`Model refers to mesh ${meshId}, which does not exist`);
      if (!material) throw new Error(`Model refers to material ${materialId}, which does not exist`);
      batch = { mesh, material, slots: new Uint32Array(64), count: 0, first: 0 };
      this.#batchByKey.set(key, batch);
      this.batches.push(batch);
    }
    return batch;
  }
}

function grow(array: Uint32Array, capacity: number): Uint32Array {
  const grown = new Uint32Array(capacity);
  grown.set(array);
  return grown;
}

/** 一个特性在一个设备上的 GPU 资源。 */
class Gpu {
  readonly device: GPUDevice;
  readonly #resources: GpuResources;
  readonly #module: GPUShaderModule;
  readonly #viewLayout: GPUBindGroupLayout;
  readonly #materialLayout: GPUBindGroupLayout;
  readonly #pipelineLayout: GPUPipelineLayout;
  readonly #pipelines = new Map<string, GPURenderPipeline>();
  readonly #meshes = new Map<Mesh, GpuMesh>();
  readonly #materials = new Map<Material, GpuMaterial>();
  readonly #materialData = new ArrayBuffer(MATERIAL_BYTES);
  readonly #dfgLut: GPUTexture;

  #worlds: GPUBuffer | undefined;
  #instances: GPUBuffer | undefined;
  #instanceStaging = new Uint32Array(1024);
  #views: GPUBuffer | undefined;
  readonly #viewData = new Float32Array((VIEW_STRIDE / 4) * 4);
  #viewBindGroup: GPUBindGroup | undefined;
  /** 视图绑定组里的天空盒镜面立方体贴图；换了天空盒要重建绑定组。 */
  #skySpecular: GPUTexture | undefined;

  constructor(device: GPUDevice, resources: GpuResources) {
    this.device = device;
    this.#resources = resources;
    this.#module = device.createShaderModule({ label: 'MeshRenderFeature', code: SHADER });
    this.#viewLayout = device.createBindGroupLayout({
      label: 'MeshRenderFeature view',
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: VIEW_FLOATS * 4 } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: 'cube' } },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 5, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      ],
    });
    this.#materialLayout = device.createBindGroupLayout({
      label: 'MeshRenderFeature material',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      ],
    });
    this.#pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [this.#viewLayout, this.#materialLayout] });
    this.#dfgLut = createDfgLut(device);
  }

  pipelineFor(stage: RenderStage): GPURenderPipeline {
    const { colorFormat, depthFormat } = stage.output;
    const key = `${stage.name}:${colorFormat}:${depthFormat}`;
    let pipeline = this.#pipelines.get(key);
    if (!pipeline) {
      pipeline = this.device.createRenderPipeline({
        label: `MeshRenderFeature ${stage.name}`,
        layout: this.#pipelineLayout,
        vertex: {
          module: this.#module,
          entryPoint: 'vs',
          buffers: [{
            arrayStride: VERTEX_STRIDE,
            attributes: [
              { shaderLocation: 0, offset: 0, format: 'float32x3' },
              { shaderLocation: 1, offset: 12, format: 'float32x3' },
              { shaderLocation: 2, offset: 24, format: 'float32x2' },
            ],
          }],
        },
        fragment: { module: this.#module, entryPoint: 'fs', targets: [{ format: colorFormat }] },
        primitive: { topology: 'triangle-list', cullMode: 'back', frontFace: 'ccw' },
        depthStencil: { format: depthFormat, depthWriteEnabled: true, depthCompare: 'less' },
      });
      this.#pipelines.set(key, pipeline);
    }
    return pipeline;
  }

  /** 世界矩阵列的 1..slotLimit 段（槽位 0 是空的，一起传，下标就和槽位一致）。 */
  uploadWorlds(world: Float32Array, slotLimit: number): void {
    const floats = (slotLimit + 1) * 16;
    if (!this.#worlds || this.#worlds.size < floats * 4) {
      this.#worlds?.destroy();
      this.#worlds = this.#createStorage('MeshRenderFeature worlds', capacityFor(floats * 4));
      this.#viewBindGroup = undefined;
    }
    // 直接从 wasm 的共享内存上传，不经过 JS 数组
    this.device.queue.writeBuffer(this.#worlds, 0, world, 0, floats);
  }

  uploadInstances(batches: readonly MeshBatch[], total: number): void {
    if (this.#instanceStaging.length < total) this.#instanceStaging = new Uint32Array(capacityFor(total));
    for (const batch of batches) this.#instanceStaging.set(batch.slots.subarray(0, batch.count), batch.first);
    const bytes = Math.max(total, 1) * 4;
    if (!this.#instances || this.#instances.size < bytes) {
      this.#instances?.destroy();
      this.#instances = this.#createStorage('MeshRenderFeature instances', capacityFor(bytes));
      this.#viewBindGroup = undefined;
    }
    if (total > 0) this.device.queue.writeBuffer(this.#instances, 0, this.#instanceStaging, 0, total);
  }

  uploadViews(views: readonly RenderView[], lighting: Lighting): void {
    const stride = VIEW_STRIDE / 4;
    if (this.#viewData.length < views.length * stride) throw new RangeError(`MeshRenderFeature supports ${this.#viewData.length / stride} views, got ${views.length}`);
    const { direction, color, ambient, skybox } = lighting;
    const length = Math.hypot(direction.x, direction.y, direction.z) || 1;
    const data = this.#viewData;
    for (const view of views) {
      const o = view.index * stride;
      data.set(view.viewProjection, o);
      data.set([view.eye.x, view.eye.y, view.eye.z, 1], o + 16);
      data.set([direction.x / length, direction.y / length, direction.z / length, 0], o + 20);
      data.set([color.r, color.g, color.b, 1], o + 24);
      data.set([ambient.r, ambient.g, ambient.b, 1], o + 28);
      data.set([skybox?.intensity ?? 0, skybox?.skybox.specular.data.levels.length ?? 0, 0, 0], o + 32);
      for (let c = 0; c < 9; c++) {
        const sh = skybox?.skybox.diffuseSH;
        data.set(sh ? [sh[c * 3]!, sh[c * 3 + 1]!, sh[c * 3 + 2]!, 0] : [0, 0, 0, 0], o + 36 + c * 4);
      }
      if (skybox) data.set(skybox.rotation, o + 72);
      else data.set(IDENTITY, o + 72);
    }
    this.#views ??= this.device.createBuffer({ label: 'MeshRenderFeature views', size: this.#viewData.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    if (views.length > 0) this.device.queue.writeBuffer(this.#views, 0, this.#viewData, 0, views.length * stride);

    const skySpecular = skybox ? this.#resources.cubemap(skybox.skybox.specular) : this.#resources.blackCube;
    if (skySpecular !== this.#skySpecular) {
      this.#skySpecular = skySpecular;
      this.#viewBindGroup = undefined;
    }
  }

  viewBindGroup(): GPUBindGroup {
    return (this.#viewBindGroup ??= this.device.createBindGroup({
      label: 'MeshRenderFeature view',
      layout: this.#viewLayout,
      entries: [
        { binding: 0, resource: { buffer: this.#views!, size: VIEW_FLOATS * 4 } },
        { binding: 1, resource: { buffer: this.#worlds! } },
        { binding: 2, resource: { buffer: this.#instances! } },
        { binding: 3, resource: this.#skySpecular!.createView({ dimension: 'cube' }) },
        { binding: 4, resource: this.#dfgLut.createView() },
        { binding: 5, resource: this.#resources.linearClamp },
      ],
    }));
  }

  mesh(mesh: Mesh): GpuMesh {
    let gpu = this.#meshes.get(mesh);
    if (!gpu) {
      const { vertices, indices } = mesh.data;
      gpu = {
        vertices: this.#createFilled(`${mesh.name} vertices`, GPUBufferUsage.VERTEX, vertices),
        indices: this.#createFilled(`${mesh.name} indices`, GPUBufferUsage.INDEX, indices),
        indexFormat: indices instanceof Uint16Array ? 'uint16' : 'uint32',
        indexCount: indices.length,
      };
      this.#meshes.set(mesh, gpu);
    }
    return gpu;
  }

  /** 材质的绑定组；参数改了（version 变了）就重新上传。 */
  material(material: Material): GPUBindGroup {
    let gpu = this.#materials.get(material);
    if (!gpu) {
      const buffer = this.device.createBuffer({ label: `${material.name} material`, size: MATERIAL_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      gpu = { buffer, bindGroup: undefined, version: -1 };
      this.#materials.set(material, gpu);
    }
    if (gpu.version !== material.version || !gpu.bindGroup) {
      const slot = material.baseColorTexture;
      const { r, g, b, a } = material.baseColor;
      const floats = new Float32Array(this.#materialData);
      floats.set([r, g, b, a, ...(slot?.scale ?? [1, 1]), ...(slot?.offset ?? [0, 0]), ...material.emissive, 0]);
      floats.set([material.metalness ?? 0, material.roughness, material.cavity.diffuse, material.cavity.specular], 12);
      const codes = new Uint32Array(this.#materialData);
      codes[16] = OPERATOR_CODES[material.baseColorOperator];
      codes[17] = material.metalness === undefined ? 0 : 1;
      this.device.queue.writeBuffer(gpu.buffer, 0, this.#materialData);
      gpu.bindGroup = this.device.createBindGroup({
        label: `${material.name} material`,
        layout: this.#materialLayout,
        entries: [
          { binding: 0, resource: { buffer: gpu.buffer } },
          { binding: 1, resource: (slot ? this.#resources.texture(slot.texture) : this.#resources.white).createView() },
          { binding: 2, resource: this.#resources.linearRepeat },
        ],
      });
      gpu.version = material.version;
    }
    return gpu.bindGroup;
  }

  destroy(): void {
    for (const buffer of [this.#worlds, this.#instances, this.#views]) buffer?.destroy();
    for (const { vertices, indices } of this.#meshes.values()) {
      vertices.destroy();
      indices.destroy();
    }
    for (const { buffer } of this.#materials.values()) buffer.destroy();
    this.#dfgLut.destroy();
  }

  #createStorage(label: string, size: number): GPUBuffer {
    return this.device.createBuffer({ label, size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  }

  /** 建好就填上数据的缓冲；用 mappedAtCreation，所以 16 位索引的字节数不必是 4 的倍数。 */
  #createFilled(label: string, usage: number, data: Float32Array | Uint16Array | Uint32Array): GPUBuffer {
    const buffer = this.device.createBuffer({ label, size: Math.ceil(data.byteLength / 4) * 4, usage, mappedAtCreation: true });
    new Uint8Array(buffer.getMappedRange()).set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    buffer.unmap();
    return buffer;
  }
}

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/** 在 GPU 上积分出 DFG 查找表（一次全屏绘制）。 */
function createDfgLut(device: GPUDevice): GPUTexture {
  const texture = device.createTexture({ label: 'DFG LUT', size: [DFG_LUT_WIDTH, DFG_LUT_HEIGHT], format: 'rg16float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT });
  const module = device.createShaderModule({ label: 'DFG LUT', code: DFG_LUT_SHADER });
  const pipeline = device.createRenderPipeline({
    label: 'DFG LUT',
    layout: 'auto',
    vertex: { module, entryPoint: 'fullscreenVertex' },
    fragment: { module, entryPoint: 'fs', targets: [{ format: 'rg16float' }] },
  });
  const encoder = device.createCommandEncoder({ label: 'DFG LUT' });
  const pass = encoder.beginRenderPass({ colorAttachments: [{ view: texture.createView(), loadOp: 'clear', storeOp: 'store' }] });
  pass.setPipeline(pipeline);
  pass.draw(3);
  pass.end();
  device.queue.submit([encoder.finish()]);
  return texture;
}

/** 缓冲按 2 的幂增长，避免每多一个实体就重建。 */
function capacityFor(bytes: number): number {
  return Math.max(256, 2 ** Math.ceil(Math.log2(bytes)));
}
