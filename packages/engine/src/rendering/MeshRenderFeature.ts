/**
 * 网格的根渲染特性（Stride 的 MeshRenderFeature；现在只有漫反射（颜色加一张贴图）、一个方向光和环境光，
 * 着色公式同 Stride 的 Lambert：直射光 albedo / π · 光色 · N·L，环境光 albedo · 环境色，光色是线性的、已经乘过强度）。
 *
 * 数据流：
 * - Extract：遍历带 Model 和 Transform 的实体，按（网格，材质）分批，每批记下实体的变换槽位。
 * - Prepare：把变换存储的世界矩阵列整段上传（直接从 wasm 内存，只传用到的那一段），批次的槽位拼成一个
 *   实例缓冲上传，每个视图的常量写进按视图分块的 uniform 缓冲（动态偏移）。
 * - Draw：每批一次实例化绘制；着色器用 worlds[slots[instance_index]] 取世界矩阵，firstInstance 是批次的起点。
 * 每帧上传都只写一次、在提交之前，不会碰到 writeBuffer 生效时机的坑（docs/lessons.md）。
 */
import { system } from '../engine/system';
import { Transform } from '../engine/transform';
import { Model } from './components';
import { Material } from './Material';
import { Mesh, VERTEX_FLOATS } from './Mesh';
import type { Texture } from './Texture';
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

const SHADER = /* wgsl */ `
struct View {
  viewProjection: mat4x4f,
  lightDirection: vec4f,
  lightColor: vec4f,
  ambientColor: vec4f,
};
@group(0) @binding(0) var<uniform> view: View;
@group(0) @binding(1) var<storage, read> worlds: array<mat4x4f>;
@group(0) @binding(2) var<storage, read> slots: array<u32>;

// 漫反射 = combine(贴图(uv * scale + offset), baseColor)；combine 0 是乘，1 是加（operator 是 WGSL 的保留字）。没有贴图的材质绑一张 1x1 的白图
struct Material { baseColor: vec4f, uvTransform: vec4f, combine: u32 };
@group(1) @binding(0) var<uniform> material: Material;
@group(1) @binding(1) var baseColorTexture: texture_2d<f32>;
@group(1) @binding(2) var baseColorSampler: sampler;

struct Varyings {
  @builtin(position) position: vec4f,
  @location(0) normal: vec3f,
  @location(1) uv: vec2f,
};

const PI = 3.14159265358979;

@vertex fn vs(@location(0) position: vec3f, @location(1) normal: vec3f, @location(2) uv: vec2f, @builtin(instance_index) instance: u32) -> Varyings {
  let world = worlds[slots[instance]];
  var out: Varyings;
  out.position = view.viewProjection * world * vec4f(position, 1.0);
  // 均匀缩放下法线直接用世界矩阵变换；非均匀缩放要用逆转置，等材质系统一起做
  out.normal = (world * vec4f(normal, 0.0)).xyz;
  out.uv = uv;
  return out;
}

@fragment fn fs(in: Varyings) -> @location(0) vec4f {
  let n = normalize(in.normal);
  let nDotL = max(dot(n, -view.lightDirection.xyz), 0.0);
  let texel = textureSample(baseColorTexture, baseColorSampler, in.uv * material.uvTransform.xy + material.uvTransform.zw).rgb;
  let albedo = select(texel * material.baseColor.rgb, texel + material.baseColor.rgb, material.combine == 1u);
  let color = albedo / PI * view.lightColor.rgb * nDotL + albedo * view.ambientColor.rgb;
  return vec4f(color, material.baseColor.a);
}`;

/** 每个视图的常量占一块：uniform 的动态偏移必须是 minUniformBufferOffsetAlignment（256）的整数倍。 */
const VIEW_STRIDE = 256;
const VIEW_FLOATS = 28;
/** 材质 uniform：baseColor、uvTransform（scale.xy, offset.xy）、combine，按 16 字节对齐。 */
const MATERIAL_BYTES = 48;
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
    const gpu = (this.#gpu ??= new Gpu(this.system.device));
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
        pass.setBindGroup(1, gpu.material(material).bindGroup);
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
  readonly #module: GPUShaderModule;
  readonly #viewLayout: GPUBindGroupLayout;
  readonly #materialLayout: GPUBindGroupLayout;
  readonly #pipelineLayout: GPUPipelineLayout;
  readonly #pipelines = new Map<string, GPURenderPipeline>();
  readonly #meshes = new Map<Mesh, GpuMesh>();
  readonly #materials = new Map<Material, GpuMaterial>();
  readonly #textures = new Map<Texture, GPUTexture>();
  readonly #sampler: GPUSampler;
  readonly #white: GPUTexture;
  readonly #materialData = new ArrayBuffer(MATERIAL_BYTES);

  #worlds: GPUBuffer | undefined;
  #instances: GPUBuffer | undefined;
  #instanceStaging = new Uint32Array(1024);
  #views: GPUBuffer | undefined;
  readonly #viewData = new Float32Array((VIEW_STRIDE / 4) * 4);
  #viewBindGroup: GPUBindGroup | undefined;

  constructor(device: GPUDevice) {
    this.device = device;
    this.#module = device.createShaderModule({ label: 'MeshRenderFeature', code: SHADER });
    this.#viewLayout = device.createBindGroupLayout({
      label: 'MeshRenderFeature view',
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: VIEW_FLOATS * 4 } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
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
    // Stride 贴图采样的默认值：重复、线性过滤（ComputeTextureBase 的 Filtering、AddressModeU/V）；各向异性让斜看的地面不糊
    this.#sampler = device.createSampler({
      label: 'MeshRenderFeature linear wrap',
      addressModeU: 'repeat',
      addressModeV: 'repeat',
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
      maxAnisotropy: 16,
    });
    this.#white = device.createTexture({ label: 'white', size: [1, 1], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    device.queue.writeTexture({ texture: this.#white }, new Uint8Array([255, 255, 255, 255]), { bytesPerRow: 4 }, [1, 1]);
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
    const { direction, color, ambient } = lighting;
    const length = Math.hypot(direction.x, direction.y, direction.z) || 1;
    const data = this.#viewData;
    for (const view of views) {
      const o = view.index * stride;
      data.set(view.viewProjection, o);
      data[o + 16] = direction.x / length;
      data[o + 17] = direction.y / length;
      data[o + 18] = direction.z / length;
      data[o + 20] = color.r;
      data[o + 21] = color.g;
      data[o + 22] = color.b;
      data[o + 24] = ambient.r;
      data[o + 25] = ambient.g;
      data[o + 26] = ambient.b;
    }
    this.#views ??= this.device.createBuffer({ label: 'MeshRenderFeature views', size: this.#viewData.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    if (views.length > 0) this.device.queue.writeBuffer(this.#views, 0, this.#viewData, 0, views.length * stride);
  }

  viewBindGroup(): GPUBindGroup {
    return (this.#viewBindGroup ??= this.device.createBindGroup({
      label: 'MeshRenderFeature view',
      layout: this.#viewLayout,
      entries: [
        { binding: 0, resource: { buffer: this.#views!, size: VIEW_FLOATS * 4 } },
        { binding: 1, resource: { buffer: this.#worlds! } },
        { binding: 2, resource: { buffer: this.#instances! } },
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

  material(material: Material): GpuMaterial & { readonly bindGroup: GPUBindGroup } {
    let gpu = this.#materials.get(material);
    if (!gpu) {
      const buffer = this.device.createBuffer({ label: `${material.name} material`, size: MATERIAL_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      gpu = { buffer, bindGroup: undefined, version: -1 };
      this.#materials.set(material, gpu);
    }
    if (gpu.version !== material.version || !gpu.bindGroup) {
      const slot = material.baseColorTexture;
      const floats = new Float32Array(this.#materialData);
      const { r, g, b, a } = material.baseColor;
      floats.set([r, g, b, a, ...(slot?.scale ?? [1, 1]), ...(slot?.offset ?? [0, 0])]);
      new Uint32Array(this.#materialData)[8] = OPERATOR_CODES[material.baseColorOperator];
      this.device.queue.writeBuffer(gpu.buffer, 0, this.#materialData);
      gpu.bindGroup = this.device.createBindGroup({
        label: `${material.name} material`,
        layout: this.#materialLayout,
        entries: [
          { binding: 0, resource: { buffer: gpu.buffer } },
          { binding: 1, resource: (slot ? this.texture(slot.texture) : this.#white).createView() },
          { binding: 2, resource: this.#sampler },
        ],
      });
      gpu.version = material.version;
    }
    return gpu as GpuMaterial & { readonly bindGroup: GPUBindGroup };
  }

  /** 贴图第一次用到时上传所有 mip；压缩格式按块算每行字节数，小于一个块的 mip 按整块拷贝。 */
  texture(texture: Texture): GPUTexture {
    let gpu = this.#textures.get(texture);
    if (!gpu) {
      const { format, width, height, levels } = texture.data;
      gpu = this.device.createTexture({ label: texture.name, size: [width, height], format, mipLevelCount: levels.length, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
      const block = texture.blockBytes;
      levels.forEach((data, mipLevel) => {
        const w = Math.max(1, width >> mipLevel), h = Math.max(1, height >> mipLevel);
        const layout = block ? { bytesPerRow: Math.ceil(w / 4) * block, rowsPerImage: Math.ceil(h / 4) } : { bytesPerRow: w * 4 };
        const size = block ? [Math.ceil(w / 4) * 4, Math.ceil(h / 4) * 4] : [w, h];
        this.device.queue.writeTexture({ texture: gpu!, mipLevel }, data, layout, size);
      });
      this.#textures.set(texture, gpu);
    }
    return gpu;
  }

  destroy(): void {
    for (const buffer of [this.#worlds, this.#instances, this.#views]) buffer?.destroy();
    for (const { vertices, indices } of this.#meshes.values()) {
      vertices.destroy();
      indices.destroy();
    }
    for (const { buffer } of this.#materials.values()) buffer.destroy();
    for (const texture of this.#textures.values()) texture.destroy();
    this.#white.destroy();
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

/** 缓冲按 2 的幂增长，避免每多一个实体就重建。 */
function capacityFor(bytes: number): number {
  return Math.max(256, 2 ** Math.ceil(Math.log2(bytes)));
}
