/**
 * 网格的根渲染特性（Stride 的 MeshRenderFeature）。着色见 meshShader.ts。
 *
 * 数据流：
 * - Extract：遍历带 Model 和 Transform 的实体，按（网格，材质，是否投射阴影，是否蒙皮）分批，每批记下实体的变换槽位；
 *   蒙皮的实体（Skinned）还记下变换槽位对应的蒙皮矩阵起点，带形变的（Morphed）记下形变权重的起点。
 * - Cull：各批的槽位连着写进 stride-native 的剔除工作区（FrustumCuller），一次调用剔除一组视图，每批用网格的包围盒；
 *   主视图顺带量出可见物体的距离范围（阴影级联要用）。一帧剔除两次：先主视图，再阴影级联。
 * - Prepare：把变换存储的世界矩阵列整段上传（直接从 wasm 内存，只传用到的那一段），动画系统算好的蒙皮矩阵也直接从 wasm 内存上传，各次剔除的结果（每个视图一段可见槽位）
 *   也直接从 wasm 内存上传成实例缓冲，每个视图的常量（相机、光照、阴影、天空盒）写进按视图分块的 uniform 缓冲（动态偏移）。
 * - Draw：每批一次实例化绘制；着色器用 worlds[slots[instance_index]] 取世界矩阵，firstInstance 是这个视图里这一批的起点。
 *   顶点布局（content/format.ts 的 VertexLayout）不同的网格用不同的管线；量化的属性在顶点着色器里按网格的参数还原
 *   （第 2 组绑定），八面体编码的法线也在那里解开。蒙皮的批次用带关节和权重属性的管线：顶点先乘 4 个蒙皮矩阵的加权和
 *   （GPU 蒙皮，Stride 的 TransformationSkinning），再乘世界矩阵。阴影投射阶段只画投射阴影的批次，管线只写深度。
 * 每帧上传都只写一次、在提交之前，不会碰到 writeBuffer 生效时机的坑（docs/lessons.md）。
 */
import type { Decals } from './Decals';
import { clusterParams, type Clusters } from '../lighting/Clusters';
import type { LocalLightBuffer } from '../lighting/LocalLights';
import type { FrustumCuller } from '@stride-ts/native';
import type { AnimationSystem } from '../../animation/AnimationSystem';
import type { EntityId } from '../../data/prop';
import type { ColumnsOf } from '../../engine/component';
import type { EntityManager } from '../../engine/EntityManager';
import { system } from '../../engine/system';
import { Transform } from '../../engine/transform';
import { Morphed } from '../../animation/morphs';
import { Instance, Instancing, Model, Skinned } from '../components';
import type { GpuResources } from '../../graphics/GpuResources';
import { Material, type MaterialShaderTrees, type MaterialTexture } from './Material';
import type { ReflectionProbes } from '../lighting/ReflectionProbes';
import type { Clouds } from '../sky/VolumetricClouds';
import { Skybox } from '../lighting/Skybox';
import type { SubsurfaceMaterials } from '../screenspace/SubsurfaceScattering';
import { MESH_EFFECT_PARAMETERS, meshEffectCode, type MeshEffect } from './meshEffect';
import { DFG_LUT_HEIGHT, DFG_LUT_SHADER, DFG_LUT_WIDTH, materialTreesCode, MESH_SHADER } from './meshShader';
import { CEL_RAMP_STOPS, vertexLayoutOffsets, type MicrofacetModel, type VertexLayout } from '../../content/format';
import { Mesh } from './Mesh';
import { inRenderMask, RootRenderFeature, type Lighting, type RenderContext, type RenderStage, type RenderSystem, type RenderView } from '../RenderSystem';
import { backToFrontRuns, sortBackToFront, type VisibleBatch } from './transparentOrder';

/** 一次实例化绘制：同一个网格和材质的实体。 */
export interface MeshBatch {
  readonly mesh: Mesh;
  readonly material: Material;
  /** 这批的实体投下阴影（Model.isShadowCaster）。 */
  readonly isShadowCaster: boolean;
  /** 这批的实体的渲染组（Model.renderGroup）。 */
  readonly renderGroup: number;
  /** 这批的实体带 Skinned：按蒙皮矩阵画。 */
  readonly skinned: boolean;
  /** 实体的变换槽位，前 count 个有效。 */
  slots: Uint32Array;
  count: number;
  /** 在这一帧所有批次连起来的槽位列表里的起点，Cull 时算。 */
  first: number;
}

/** 阴影投射的按坡度深度偏移（GPU 的 depthBiasSlopeScale，乘三角形在阴影图里的最大深度斜率）。 */
const SHADOW_SLOPE_BIAS = 1.5;

/** 每个视图的常量占一块：uniform 的动态偏移必须是 minUniformBufferOffsetAlignment（256）的整数倍。 */
const VIEW_STRIDE = 1024;
/**
 * View 结构：viewProjection 16、eye 4、环境色 4、sky 4、球谐 36、天空盒旋转 16、阴影矩阵 64、阴影参数 12、方向光 8 · 4、
 * locals 4，各缓冲这一帧和上一帧的起点 12，运动向量的两个矩阵 32。
 */
const VIEW_FLOATS = 256;
/** 材质 uniform：Material 结构（11 个 vec4、四个标量、光泽度贴图的三个 vec4），按 16 字节对齐。 */
const MATERIAL_BYTES = 544;
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
/** 反量化参数和 flags（64 字节），加上网格效果的 16 个参数。 */
const MESH_PARAMS_BYTES = 64 + MESH_EFFECT_PARAMETERS * 4;

/** 一次剔除：一个剔除工作区和它剔除的视图；结果在实例缓冲里从 offset 开始，每个视图 slotCount 个。 */
interface CullPass {
  readonly culler: FrustumCuller;
  readonly views: RenderView[];
  slotCount: number;
  batchCount: number;
  offset: number;
}

interface GpuMesh {
  /** 第 2 组绑定：反量化参数、网格效果的参数。 */
  readonly params: GPUBuffer;
  /** 上传的效果参数是哪个效果、网格的哪个版本（变了就重新上传）。 */
  effect: MeshEffect | undefined;
  effectVersion: number;
  readonly bindGroup: GPUBindGroup;
  readonly vertices: GPUBuffer;
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
}

export class MeshRenderFeature extends RootRenderFeature {
  readonly name = 'MeshRenderFeature';
  /** 网格效果（Stride 合成器里 MeshRenderFeature 的 EffectName 指的效果）：所有网格都用它画；没有时是默认的效果。 */
  effect: MeshEffect | undefined;
  /** 这一帧的批次，按第一次出现的顺序；空的批次留着下一帧复用。 */
  readonly batches: MeshBatch[] = [];
  readonly #batchByKey = new Map<number, MeshBatch>();
  #instanceCount = 0;
  /** 这一帧各视图实际画了多少实例、多少次绘制（剔除之后，所有视图加起来）。 */
  drawnInstances = 0;
  drawCalls = 0;

  readonly #extractSystem = system('MeshRenderFeature.extract', {
    with: { model: Model, transform: Transform },
    without: [Skinned, Instancing],
    update: ({ model, transform, count }) => this.#extract(model, transform.slot, count, false),
  });

  /** 实例：画主实体的模型（每帧按主实体查一次）。 */
  readonly #masters = new Map<EntityId, { mesh: number; material: number; isShadowCaster: boolean; renderGroup: number } | null>();
  #entityManager: EntityManager | undefined;
  readonly #extractInstancesSystem = system('MeshRenderFeature.extractInstances', {
    with: { instance: Instance, transform: Transform },
    update: ({ instance, transform, count }) => {
      const masters = this.#masters, entities = this.#entityManager!;
      for (let i = 0; i < count; i++) {
        const id = instance.master[i]! as EntityId;
        let master = masters.get(id);
        if (master === undefined) {
          const model = id >= 0 && entities.isAlive(id) ? entities.entity(id).get(Model) : undefined;
          master = model ? { mesh: model.mesh, material: model.material, isShadowCaster: model.isShadowCaster, renderGroup: model.renderGroup } : null;
          masters.set(id, master);
        }
        if (!master) continue;
        const batch = this.#batchFor(master.mesh, master.material, master.isShadowCaster, master.renderGroup, false);
        if (batch.count === batch.slots.length) batch.slots = grow(batch.slots, batch.count * 2);
        batch.slots[batch.count++] = transform.slot[i]!;
      }
    },
  });

  readonly #extractSkinnedSystem = system('MeshRenderFeature.extractSkinned', {
    with: { model: Model, transform: Transform, skinned: Skinned },
    update: ({ model, transform, skinned, count }) => {
      this.#extract(model, transform.slot, count, true);
      for (let i = 0; i < count; i++) this.#paletteOf.set(transform.slot[i]!, skinned.palette[i]!);
    },
  });

  /** 变换槽位 → 蒙皮矩阵的起点（只有蒙皮的槽位有意义），改了才重新上传。 */
  readonly #paletteOf = new SlotTable();

  readonly #extractMorphedSystem = system('MeshRenderFeature.extractMorphed', {
    with: { transform: Transform, morphed: Morphed },
    update: ({ transform, morphed, count }) => {
      for (let i = 0; i < count; i++) this.#morphOf.set(transform.slot[i]!, morphed.weights[i]!);
    },
  });

  /** 变换槽位 → 形变权重的起点（只有带形变网格的槽位有意义）。 */
  readonly #morphOf = new SlotTable();

  // 剔除：一帧里第 k 次 cull 用第 k 个工作区；视图到（剔除，视图在其中的下标）
  readonly #cullPasses: CullPass[] = [];
  #cullPassCount = 0;
  readonly #viewCulling = new Map<RenderView, { pass: CullPass; index: number }>();

  // GPU 资源，第一次 Prepare 时创建
  #gpu: Gpu | undefined;

  override extract(context: RenderContext): void {
    for (const batch of this.batches) batch.count = 0;
    context.game.entities.run(this.#extractSystem, context.time);
    context.game.entities.run(this.#extractSkinnedSystem, context.time);
    context.game.entities.run(this.#extractMorphedSystem, context.time);
    this.#masters.clear();
    this.#entityManager = context.game.entities;
    context.game.entities.run(this.#extractInstancesSystem, context.time);
    let first = 0;
    for (const batch of this.batches) {
      batch.first = first;
      first += batch.count;
    }
    this.#instanceCount = first;
    this.#cullPassCount = 0;
    this.#viewCulling.clear();
    this.drawnInstances = this.drawCalls = 0;
  }

  /** 这一帧提取到的实例总数（剔除之前）。 */
  get instanceCount(): number {
    return this.#instanceCount;
  }

  override stats(): Record<string, number> {
    return { instances: this.#instanceCount, drawnInstances: this.drawnInstances, drawCalls: this.drawCalls };
  }

  override cull(context: RenderContext, views: readonly RenderView[]): void {
    if (views.length === 0) return;
    const pass = (this.#cullPasses[this.#cullPassCount] ??= { culler: context.game.transforms.createCuller(), views: [], slotCount: 0, batchCount: 0, offset: 0 });
    this.#cullPassCount++;
    const { culler } = pass;
    const slotCount = this.#instanceCount, batchCount = this.batches.length;
    culler.reserve(slotCount, batchCount, views.length);
    const { slots, batchEnds, bounds } = culler;
    this.batches.forEach((batch, b) => {
      slots.set(batch.slots.subarray(0, batch.count), batch.first);
      batchEnds[b] = batch.first + batch.count;
      const { min, max } = batch.mesh.cullBounds;
      for (let c = 0; c < 3; c++) {
        bounds[b * 6 + c] = (min[c]! + max[c]!) / 2;
        bounds[b * 6 + 3 + c] = (max[c]! - min[c]!) / 2;
      }
    });
    views.forEach((view, i) => {
      culler.setView(i, view.frustumPlanes, view.ignoreDepthPlanes ? 4 : 6, view.ignoreDepthPlanes ? undefined : view.nearPlane);
      this.#viewCulling.set(view, { pass, index: i });
    });
    culler.cull(slotCount, batchCount, views.length);
    views.forEach((view, i) => {
      view.minimumDistance = Math.min(view.minimumDistance, culler.minDistance(i));
      view.maximumDistance = Math.max(view.maximumDistance, culler.maxDistance(i));
    });
    pass.views.length = 0;
    pass.views.push(...views);
    pass.slotCount = slotCount;
    pass.batchCount = batchCount;
  }

  override prepare(context: RenderContext): void {
    const gpu = this.#ensureGpu();
    gpu.nextFrame();
    gpu.uploadWorlds(context.game.transforms.world, context.game.transforms.slotLimit);
    gpu.uploadSkinning(this.#paletteOf, context.game.animation);
    gpu.uploadMorphs(this.#morphOf, context.game.animation);
    const passes = this.#cullPasses.slice(0, this.#cullPassCount);
    let offset = 0;
    for (const pass of passes) {
      pass.offset = offset;
      offset += pass.views.length * pass.slotCount;
      this.#sortTransparentInstances(context, pass);
    }
    gpu.uploadInstances(passes, offset);
    gpu.uploadViews(this.system.views, this.system.lighting, context.game.updateTime.total);
  }

  /**
   * 不透明的批画在深度预通道、不透明和阴影阶段，透明材质的批只画在透明阶段（不投阴影，和 Stride 不同：Stride 默认按 alpha
   * 抖动着投阴影）。透明的实例逐个按到相机的距离从远到近画（同 Stride 按每个物体排）：不同批的实例可以交错，同一批里连着的
   * 几个一次画完。
   */
  override get drawsDepth(): boolean {
    return this.batches.some((batch) => batch.count > 0);
  }

  override get supportsPicking(): boolean {
    return true;
  }

  override get supportsVelocity(): boolean {
    return true;
  }

  override get supportsWireframe(): boolean {
    return true;
  }

  /**
   * 预热：这个网格配这个材质在 stages 这些阶段里要用的管线，没有的在后台编译；返回都编好时完成的 Promise。加载场景时对
   * 场景里的模型调（Game.loadScene），第一帧和之后生成同样网格的实体就不用当场编译。
   */
  warm(mesh: Mesh, material: Material, skinned: boolean, isShadowCaster: boolean, stages: readonly RenderStage[]): Promise<void> {
    const gpu = this.#ensureGpu();
    const pending: Promise<void>[] = [];
    const add = (stage: RenderStage, materialPass?: MaterialPass) => {
      const warming = gpu.warmPipeline(stage, mesh.layout, skinned, mesh.data.morph !== undefined, material, this.effect, materialPass);
      if (warming) pending.push(warming);
    };
    for (const stage of stages) {
      if (stage.shadowCasters ? !isShadowCaster : stage.transparent ? !(material.isTransparent || material.hasClearCoat) : material.isTransparent && !stage.picking) continue;
      const passes = stage.transparent ? transparentPasses(material) : NO_PASSES;
      if (passes.length === 0) add(stage);
      for (const materialPass of passes) add(stage, materialPass);
    }
    return Promise.all(pending).then(() => undefined);
  }

  #ensureGpu(): Gpu {
    return (this.#gpu ??= new Gpu(this.system.device, this.system.resources, this.system.graphicsDevice.depthClipControl, this.system.subsurfaceMaterials, this.system.reflectionProbes, this.system.clouds, this.system, this.system.decals, this.system.clusters, this.system.localLights));
  }



  override draw(context: RenderContext, pass: GPURenderPassEncoder, view: RenderView, stage: RenderStage): void {
    const gpu = this.#gpu;
    const culling = this.#viewCulling.get(view);
    if (!gpu || !culling) return;
    const { pass: cullPass, index } = culling;
    const counts = cullPass.culler.counts;
    // 透明阶段画透明的材质，再给有清漆的（不透明的）材质叠一遍清漆
    // 点选、线框、阴影投射的阶段透明、不透明的都画（透明的按 alpha 抖动着投阴影，见 Material.depthFragment）
    const inStage = (material: Material) => stage.picking || stage.wireframe || stage.shadowCasters || (stage.transparent ? material.isTransparent || material.hasClearCoat : !material.isTransparent);
    const visible = (b: number) => {
      const batch = this.batches[b]!;
      return counts[index * cullPass.batchCount + b]! > 0 && inStage(batch.material) && inRenderMask(view.cullingMask, batch.renderGroup);
    };
    const viewOffset = cullPass.offset + index * cullPass.slotCount;
    // 透明阶段：一段一段（同一批里连着的几个实例）从远到近；其余阶段每批一段
    const runs = stage.transparent ? this.#backToFront(context, view, cullPass, index, visible) : undefined;
    if (runs?.length === 0) return;
    // 屏幕空间的遮蔽、接触阴影是主画面不透明的那些像素的：透明的、别的视图不用
    const screenSpace = !(stage.transparent || stage.shadowCasters);
    pass.setBindGroup(0, gpu.viewBindGroup(stage.shadowCasters ? undefined : this.system.lighting.shadowAtlas, screenSpace ? view.screenOcclusion : undefined, screenSpace ? view.screenShadow : undefined), [view.index * VIEW_STRIDE]);
    let mesh: Mesh | undefined, material: Material | undefined, pipeline: GPURenderPipeline | undefined, skinned = false;
    for (let i = 0, end = runs ? runs.length / 3 : cullPass.batchCount; i < end; i++) {
      const b = runs ? runs[i * 3]! : i;
      const batch = this.batches[b]!;
      const first = runs ? runs[i * 3 + 1]! : 0;
      const count = runs ? runs[i * 3 + 2]! : counts[index * cullPass.batchCount + b]!;
      if (!visible(b) || (stage.shadowCasters && !batch.isShadowCaster) || (view.skipsSkinned && batch.skinned) || (view.skipsTransparent && batch.material.isTransparent)) continue;
      // pass 内只在变化时重设状态（docs/lessons.md）
      const gpuMesh = gpu.mesh(batch.mesh, this.effect);
      const materialChanged = batch.material !== material, meshChanged = batch.mesh !== mesh || batch.skinned !== skinned;
      const passes = stage.transparent ? transparentPasses(batch.material) : NO_PASSES;
      const pipelineOf = (materialPass?: MaterialPass) => gpu.pipelineFor(stage, batch.mesh.layout, batch.skinned, batch.mesh.data.morph !== undefined, batch.material, this.effect, materialPass);
      if (passes.length === 0 && (materialChanged || meshChanged)) {
        // 管线也按材质分（自发光变体、两面画），同样的组合是同一条管线
        const next = pipelineOf();
        if (next !== pipeline) pass.setPipeline((pipeline = next));
      }
      if (materialChanged) {
        material = batch.material;
        pass.setBindGroup(1, gpu.material(material));
        const tree = gpu.treeBindGroup(material);
        if (tree) pass.setBindGroup(3, tree);
      }
      if (meshChanged) {
        mesh = batch.mesh;
        skinned = batch.skinned;
        pass.setBindGroup(2, gpuMesh.bindGroup);
        pass.setVertexBuffer(0, gpuMesh.vertices);
        if (stage.wireframe) pass.setIndexBuffer(gpu.edges(batch.mesh, gpuMesh).buffer, 'uint32');
        else pass.setIndexBuffer(gpuMesh.indices, gpuMesh.indexFormat);
      }
      // 多遍的材质一遍一条管线，其余只画一遍
      for (let p = 0; p < Math.max(passes.length, 1); p++) {
        if (passes.length > 0) pass.setPipeline((pipeline = pipelineOf(passes[p])));
        pass.drawIndexed(stage.wireframe ? gpu.edges(batch.mesh, gpuMesh).count : gpuMesh.indexCount, count, 0, 0, viewOffset + batch.first + first);
        this.drawCalls++;
      }
      this.drawnInstances += count;
    }
  }

  override destroy(): void {
    this.#gpu?.destroy();
    this.#gpu = undefined;
    for (const pass of this.#cullPasses) pass.culler.destroy();
    this.#cullPasses.length = 0;
  }

  /**
   * 剔除之后、上传实例之前：每个视图里，透明的批（含要叠清漆的）可见的实例在它自己那段里按到相机的距离从远到近排好。
   * 阴影视图不画透明的东西，跳过。
   */
  #sortTransparentInstances(context: RenderContext, pass: CullPass): void {
    const world = context.game.transforms.world;
    const { counts, visibleSlots } = pass.culler;
    for (let b = 0; b < pass.batchCount; b++) {
      const batch = this.batches[b]!;
      if (!batch.material.isTransparent && !batch.material.hasClearCoat) continue;
      pass.views.forEach((view, v) => {
        const count = counts[v * pass.batchCount + b]!;
        if (count < 2 || view.viewport) return;
        const start = v * pass.slotCount + batch.first;
        sortBackToFront(visibleSlots.subarray(start, start + count), world, view.eye);
      });
    }
  }

  /** 透明阶段要画的实例从远到近归并成一段一段（见 transparentOrder.ts）；各批自己那段已经排好（#sortTransparentInstances）。 */
  #backToFront(context: RenderContext, view: RenderView, pass: CullPass, viewIndex: number, visible: (b: number) => boolean): number[] {
    const { counts, visibleSlots } = pass.culler;
    const batches: VisibleBatch[] = [];
    for (let b = 0; b < pass.batchCount; b++) {
      if (visible(b)) batches.push({ batch: b, start: viewIndex * pass.slotCount + this.batches[b]!.first, count: counts[viewIndex * pass.batchCount + b]! });
    }
    return backToFrontRuns(batches, visibleSlots, context.game.transforms.world, view.eye);
  }

  /** 一张表的行按批记下变换槽位。相邻的行大多是同一批，先比较上一批，省掉大部分 Map 查找。 */
  #extract(model: ColumnsOf<typeof Model>, slots: ArrayLike<number>, count: number, skinned: boolean): void {
    const { mesh, material, isShadowCaster, renderGroup } = model;
    let batch: MeshBatch | undefined;
    for (let i = 0; i < count; i++) {
      const meshId = mesh[i]!, materialId = material[i]!, caster = isShadowCaster[i] !== 0, group = renderGroup[i]!;
      if (!batch || batch.mesh.id !== meshId || batch.material.id !== materialId || batch.isShadowCaster !== caster || batch.renderGroup !== group) {
        batch = this.#batchFor(meshId, materialId, caster, group, skinned);
      }
      if (batch.count === batch.slots.length) batch.slots = grow(batch.slots, batch.count * 2);
      batch.slots[batch.count++] = slots[i]!;
    }
  }

  #batchFor(meshId: number, materialId: number, isShadowCaster: boolean, renderGroup: number, skinned: boolean): MeshBatch {
    // 两个 id 都远小于 2^22，拼成一个整数键不会冲突（最大约 2^51，在双精度的整数范围里）
    const key = (((meshId * 0x400000 + materialId) * 32 + renderGroup) * 2 + (isShadowCaster ? 1 : 0)) * 2 + (skinned ? 1 : 0);
    let batch = this.#batchByKey.get(key);
    if (!batch) {
      const mesh = Mesh.byId(meshId);
      const material = Material.byId(materialId);
      if (!mesh) throw new Error(`Model refers to mesh ${meshId}, which does not exist`);
      if (!material) throw new Error(`Model refers to material ${materialId}, which does not exist`);
      if (skinned && !mesh.layout.joints) throw new Error(`mesh '${mesh.name}' is drawn skinned but has no joints and weights`);
      batch = { mesh, material, isShadowCaster, renderGroup, skinned, slots: new Uint32Array(64), count: 0, first: 0 };
      this.#batchByKey.set(key, batch);
      this.batches.push(batch);
    }
    return batch;
  }
}

/** 按变换槽位存的 u32（蒙皮矩阵的起点）：按需增长，记着有没有改过。 */
class SlotTable {
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

function grow(array: Uint32Array, capacity: number): Uint32Array<ArrayBuffer> {
  const grown = new Uint32Array(capacity);
  grown.set(array);
  return grown;
}

/** 一个特性在一个设备上的 GPU 资源。 */
class Gpu {
  readonly device: GPUDevice;
  readonly #resources: GpuResources;
  /** 上传材质时给次表面散射的材质登记槽位（RenderSystem.subsurfaceMaterials）。 */
  readonly #subsurface: SubsurfaceMaterials;
  readonly #probes: ReflectionProbes;
  /** 视图绑定组里的反射探针是哪一代（ReflectionProbes.generation）；换了要重建绑定组。 */
  #probeGeneration = -1;
  readonly #clouds: Clouds;
  /** 视图绑定组里的云的影子图（没有云时是 undefined，绑一张白的）；换了要重建绑定组。 */
  #cloudShadow: GPUTexture | undefined;
  /** 地面的湿和雪、判断淋不淋得到的天空遮挡（RenderSystem 的）。 */
  readonly #weather: Pick<RenderSystem, 'surfaceWeather' | 'skyOcclusion'>;
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
  #localLightBuffer: GPUBuffer | undefined;
  /** 视图绑定组里的贴花图集和缓冲；换了要重建绑定组。 */
  #decalAtlas: GPUTexture | undefined;
  #decalBuffer: GPUBuffer | undefined;
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
  #palettes: GPUBuffer | undefined;
  #morphOf: GPUBuffer | undefined;
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
  readonly #viewBindGroups = new Map<GPUTexture, Map<GPUTexture, Map<GPUTexture, GPUBindGroup>>>();
  /** 视图绑定组里的天空盒镜面立方体贴图；换了天空盒要重建绑定组。 */
  #skySpecular: GPUTexture | undefined;

  constructor(device: GPUDevice, resources: GpuResources, unclippedDepth: boolean, subsurface: SubsurfaceMaterials, probes: ReflectionProbes, clouds: Clouds, weather: Pick<RenderSystem, 'surfaceWeather' | 'skyOcclusion'>, decals: Decals, clusters: Clusters, localLights: LocalLightBuffer) {
    this.device = device;
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
      ],
    });
    this.#materialLayout = device.createBindGroupLayout({
      label: 'MeshRenderFeature material',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 5, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        ...[6, 7, 8].map((binding) => ({ binding, visibility: GPUShaderStage.FRAGMENT, sampler: {} })),
        { binding: 9, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 10, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
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
      module = createCheckedShaderModule(this.device, label, MESH_SHADER + meshEffectCode(effect) + materialTreesCode(trees));
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
  pipelineFor(stage: RenderStage, layout: VertexLayout, skinned: boolean, morphed: boolean, material: Material, effect: MeshEffect | undefined, materialPass?: MaterialPass): GPURenderPipeline {
    const key = this.#pipelineKey(stage, layout, skinned, morphed, material, effect, materialPass);
    let pipeline = this.#pipelines.get(key);
    if (!pipeline) {
      // 画的时候才发现没有：当场建。着色器的编译在这一帧里做，画面会卡一下——预热（warmPipeline）就是为了不走到这里
      pipeline = this.device.createRenderPipeline(this.#pipelineDescriptor(stage, layout, skinned, morphed, material, effect, materialPass));
      this.#pipelines.set(key, pipeline);
    }
    return pipeline;
  }

  /**
   * 预热：这条管线还没有的话在后台编译（createRenderPipelineAsync，不卡帧），好了以后放进缓存。已经有了返回 undefined，
   * 否则返回编好时完成的 Promise。编译期间画到它的话照旧当场建一条（结果一样，只是白编了一次）。
   */
  warmPipeline(stage: RenderStage, layout: VertexLayout, skinned: boolean, morphed: boolean, material: Material, effect: MeshEffect | undefined, materialPass?: MaterialPass): Promise<void> | undefined {
    const key = this.#pipelineKey(stage, layout, skinned, morphed, material, effect, materialPass);
    if (this.#pipelines.has(key)) return undefined;
    let warming = this.#warming.get(key);
    if (!warming) {
      warming = this.device.createRenderPipelineAsync(this.#pipelineDescriptor(stage, layout, skinned, morphed, material, effect, materialPass)).then((pipeline) => {
        this.#warming.delete(key);
        if (!this.#pipelines.has(key)) this.#pipelines.set(key, pipeline);
      });
      this.#warming.set(key, warming);
    }
    return warming;
  }

  #pipelineKey(stage: RenderStage, layout: VertexLayout, skinned: boolean, morphed: boolean, material: Material, effect: MeshEffect | undefined, materialPass?: MaterialPass): string {
    const { colorFormat, depthFormat } = stage.output;
    const skin = skinned ? `${layout.joints}:${layout.weights}` : 'static';
    const doubleSided = colorFormat !== undefined && material.doubleSided;
    const depthFragment = colorFormat === undefined ? material.depthFragment : undefined;
    return `${stage.name}:${colorFormat}:${depthFormat}:${layout.position}:${layout.normal}:${layout.uv}:${layout.tangent}:${skin}:${morphed}:${doubleSided}:${depthFragment}:${materialPass?.name}:${treesKey(material.shaderTrees)}:${effect?.code ?? ''}`;
  }

  #pipelineDescriptor(stage: RenderStage, layout: VertexLayout, skinned: boolean, morphed: boolean, material: Material, effect: MeshEffect | undefined, materialPass?: MaterialPass): GPURenderPipelineDescriptor {
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
      const entryPoint = stage.velocity ? `vsVelocity${skinned ? 'Skinned' : ''}` : `vs${skinned ? 'Skinned' : ''}${layout.tangent ? 'Tangent' : ''}`;
      const module = this.#module(trees, effect);
      return {
        label: `MeshRenderFeature ${stage.name} ${layout.position}/${layout.normal}/${layout.uv}${skinned ? ' skinned' : ''}${morphed ? ' morphed' : ''}${trees ? ' material trees' : ''}`,
        layout: this.#layout(trees?.textures.length ?? 0).layout,
        vertex: {
          module,
          entryPoint,
          ...(morphed ? { constants: { MORPHED: 1 } } : {}),
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
          fragment: stage.picking || stage.wireframe || stage.velocity ? { module, entryPoint: stage.picking ? 'fsPick' : stage.wireframe ? 'fsWire' : 'fsVelocity', targets: [{ format: colorFormat }] } : {
            module,
            // 要留表面的阶段（屏幕空间反射开着时的不透明阶段）：普通的材质写表面，别的那一遍不写（写掩码 0）
            entryPoint: materialPass?.entryPoint ?? (surfaceFormats ? 'fsSurface' : 'fs'),
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
            : { topology: 'triangle-list', cullMode: materialPass?.cullMode ?? (doubleSided ? 'none' : 'back'), frontFace: 'ccw' },
        // 深度预通道之后的阶段：同样的物体、同样的顶点着色器（位置是 @invariant 的）已经把深度写好了，这里只让深度相等的
        // 像素过，也不再写深度，被挡住的像素一个都不着色
        depthStencil: stage.afterDepthPrepass
          ? { format: depthFormat, depthWriteEnabled: false, depthCompare: 'equal' }
          : {
            format: depthFormat,
            depthWriteEnabled: !stage.transparent && !stage.wireframe,
            depthCompare: 'less-equal',
            // 和 Stride 不同：阴影投射另加按坡度的深度偏移。只有常量偏移加法线偏移时，太阳低（20° 左右）、光掠过地面，
            // 阴影图的深度量化在受光面上成了一圈圈的痤疮（日夜循环里常见）
            ...(stage.shadowCasters ? { depthBiasSlopeScale: SHADOW_SLOPE_BIAS, depthBiasClamp: 0.01 } : {}),
          },
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

  /** 世界矩阵列的 1..slotLimit 段（槽位 0 是空的，一起传，下标就和槽位一致），写进这一帧的那一半。 */
  uploadWorlds(world: Float32Array, slotLimit: number): void {
    const floats = (slotLimit + 1) * 16;
    if (!this.#worlds || this.#halves.worlds * 64 < floats * 4) {
      this.#worlds?.destroy();
      const half = capacityFor(floats * 4);
      this.#worlds = this.#createStorage('MeshRenderFeature worlds', half * 2);
      this.#halves.worlds = half / 64;
      this.#clearViewBindGroups();
    }
    const [current, previous] = this.#bases(this.#halves.worlds);
    this.#frameBases.set([current, previous], 0);
    // 直接从 wasm 的共享内存上传，不经过 JS 数组
    this.device.queue.writeBuffer(this.#worlds, current * 64, world, 0, floats);
  }

  /**
   * 蒙皮：变换槽位到蒙皮矩阵起点的表（改了才传），和所有蒙皮矩阵（每帧传，直接从 wasm 内存）。没有蒙皮网格时也建一个
   * 小缓冲：绑定组里的存储缓冲不能缺。
   */
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

  /** 各次剔除的可见槽位（每个视图一段，直接在 wasm 内存里）依次拼成实例缓冲。 */
  uploadInstances(passes: readonly CullPass[], total: number): void {
    const bytes = Math.max(total, 1) * 4;
    if (!this.#instances || this.#instances.size < bytes) {
      this.#instances?.destroy();
      this.#instances = this.#createStorage('MeshRenderFeature instances', capacityFor(bytes));
      this.#clearViewBindGroups();
    }
    for (const pass of passes) {
      const length = pass.views.length * pass.slotCount;
      if (length > 0) this.device.queue.writeBuffer(this.#instances, pass.offset * 4, pass.culler.visibleSlots, 0, length);
    }
  }

  uploadViews(views: readonly RenderView[], lighting: Lighting, time: number): void {
    const stride = VIEW_STRIDE / 4;
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
      data.set([this.#decals.count, 0, 0, 0], o + 244);
      data.set(clusterParams(view), o + 248);
    }
    this.#views ??= this.device.createBuffer({ label: 'MeshRenderFeature views', size: this.#viewData.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    if (views.length > 0) this.device.queue.writeBuffer(this.#views, 0, this.#viewData, 0, views.length * stride);

    const skySpecular = !skybox ? this.#resources.blackCube : skybox.skybox instanceof Skybox ? this.#resources.skyboxSpecular(skybox.skybox) : skybox.skybox.specular;
    if (skySpecular !== this.#skySpecular || probes.generation !== this.#probeGeneration || cloud?.texture !== this.#cloudShadow || occlusion !== this.#occlusionBound || (occlusion && this.#weather.skyOcclusion.depthBuffer !== this.#occlusionDepth) || this.#decals.atlas !== this.#decalAtlas || this.#decals.buffer !== this.#decalBuffer || this.#clusters.buffer !== this.#clusterBuffer || this.#localLights.buffer !== this.#localLightBuffer) {
      this.#clusterBuffer = this.#clusters.buffer;
      this.#localLightBuffer = this.#localLights.buffer;
      this.#decalAtlas = this.#decals.atlas;
      this.#decalBuffer = this.#decals.buffer;
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
   * contact 是接触阴影，没有时都用白图。
   */
  viewBindGroup(shadowAtlas: GPUTexture | undefined, occlusion?: GPUTexture, contact?: GPUTexture): GPUBindGroup {
    const atlas = shadowAtlas ?? this.#resources.emptyShadowAtlas;
    const ao = occlusion ?? this.#resources.white;
    const shadow = contact ?? this.#resources.white;
    let byAtlas = this.#viewBindGroups.get(atlas);
    if (!byAtlas) this.#viewBindGroups.set(atlas, (byAtlas = new Map()));
    let groups = byAtlas.get(ao);
    if (!groups) byAtlas.set(ao, (groups = new Map()));
    let group = groups.get(shadow);
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
          { binding: 14, resource: ao.createView() },
          { binding: 15, resource: shadow.createView() },
          { binding: 16, resource: this.#probes.cubes.createView({ dimension: 'cube-array' }) },
          { binding: 17, resource: { buffer: this.#probes.buffer } },
          { binding: 18, resource: (this.#cloudShadow ?? this.#resources.white).createView() },
          { binding: 19, resource: this.#resources.linearRepeat },
          ...this.#occlusionEntries(),
          { binding: 22, resource: { buffer: this.#decals.buffer } },
          { binding: 23, resource: this.#decals.atlas.createView({ dimension: '2d-array' }) },
          { binding: 24, resource: { buffer: this.#clusters.buffer } },
        ],
      });
      groups.set(shadow, group);
    }
    return group;
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
        vertices: this.#createFilled(`${mesh.name} vertices`, GPUBufferUsage.VERTEX, vertices),
        indices: this.#createFilled(`${mesh.name} indices`, GPUBufferUsage.INDEX, indices),
        indexFormat: indices instanceof Uint16Array ? 'uint16' : 'uint32',
        indexCount: indices.length,
      };
      this.#meshes.set(mesh, gpu);
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

  /** 材质的绑定组；参数改了（version 变了）就重新上传。 */
  material(material: Material): GPUBindGroup {
    let gpu = this.#materials.get(material);
    if (!gpu) {
      const buffer = this.device.createBuffer({ label: `${material.name} material`, size: MATERIAL_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      gpu = { buffer, bindGroup: undefined, version: -1 };
      this.#materials.set(material, gpu);
    }
    if (gpu.version !== material.version || !gpu.bindGroup) {
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
      // 第 3..5 位：光泽度贴图里金属度的通道 + 1（0 是没有）
      const metalnessChannel = gloss?.metalnessChannel ? 'rgba'.indexOf(gloss.metalnessChannel) + 1 : 0;
      const textures = (slot ? 1 : 0) | (emissiveTexture ? 2 : 0) | (occlusion.texture ? 4 : 0) | (metalnessChannel << 3);
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
        ],
      });
      gpu.version = material.version;
    }
    return gpu.bindGroup;
  }

  destroy(): void {
    for (const buffer of [this.#worlds, this.#instances, this.#views, this.#paletteOf, this.#palettes, this.#morphOf, this.#morphWeights, this.#noMorph]) buffer?.destroy();
    for (const { params, vertices, indices, edges } of this.#meshes.values()) {
      params.destroy();
      vertices.destroy();
      indices.destroy();
      edges?.buffer.destroy();
    }
    for (const { buffer } of this.#materials.values()) buffer.destroy();
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

/** Stride 的 BlendStates.AlphaBlend：颜色已经乘过 alpha。 */
/** 材质在透明阶段里多画的一遍：用哪个片元入口、怎么混合、剔哪一面。name 进管线的键。 */
interface MaterialPass {
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
const NO_PASSES: readonly MaterialPass[] = [];

/**
 * 材质在透明阶段要多画的遍（空的：照常画一遍）。
 * - 玻璃：透射、反射两遍；两面画时背面两遍、正面两遍。和 Stride 不同：Stride 的注释写的是先背面后正面，代码却是先正面
 *   （前两遍剔掉背面）；我们照注释的顺序，离相机远的面先画，它的反射才会被近的面挡掉一部分。
 * - 清漆：底下一遍在不透明阶段照常画过了，这里叠清漆的那一遍。
 */
function transparentPasses(material: Material): readonly MaterialPass[] {
  if (material.glass) return material.doubleSided ? GLASS_BOTH : GLASS_FRONT;
  return material.hasClearCoat ? CLEAR_COAT_PASSES : NO_PASSES;
}

/** 按材质的颜色树分着色器模块和管线用的键。 */
function treesKey(trees: MaterialShaderTrees | undefined): string {
  return trees ? JSON.stringify([trees.code, trees.emissive, trees.normal, trees.displacement, trees.layers, trees.clearCoat]) : '';
}

const PREMULTIPLIED_ALPHA: GPUBlendState = {
  color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
};

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/** 在 GPU 上积分出 DFG 查找表（一次计算，按存储缓冲写；着色时按 uniform 读）。 */
function createDfgLut(device: GPUDevice): GPUBuffer {
  const buffer = device.createBuffer({ label: 'DFG LUT', size: DFG_LUT_WIDTH * DFG_LUT_HEIGHT * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.UNIFORM });
  const pipeline = device.createComputePipeline({
    label: 'DFG LUT', layout: 'auto',
    compute: { module: device.createShaderModule({ label: 'DFG LUT', code: DFG_LUT_SHADER }), entryPoint: 'main' },
  });
  const encoder = device.createCommandEncoder({ label: 'DFG LUT' });
  const pass = encoder.beginComputePass({ label: 'DFG LUT' });
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer } }] }));
  pass.dispatchWorkgroups(Math.ceil(DFG_LUT_WIDTH / 8), Math.ceil(DFG_LUT_HEIGHT / 8));
  pass.end();
  device.queue.submit([encoder.finish()]);
  return buffer;
}

/** 缓冲按 2 的幂增长，避免每多一个实体就重建。 */
function capacityFor(bytes: number): number {
  return Math.max(256, 2 ** Math.ceil(Math.log2(bytes)));
}

/**
 * 建着色器模块，编译出错时把出错的行打到控制台（会进调试 CLI 的日志）：游戏写的颜色树、着色器类、网格效果拼进来的 WGSL 出错时，
 * 不然只看到管线无效、画面全黑。
 */
function createCheckedShaderModule(device: GPUDevice, label: string, code: string): GPUShaderModule {
  const module = device.createShaderModule({ label, code });
  void module.getCompilationInfo().then(({ messages }) => {
    const lines = code.split('\n');
    for (const m of messages) {
      if (m.type !== 'error') continue;
      console.error(`[stride] ${label}: WGSL ${m.lineNum}:${m.linePos}: ${m.message}\n  ${lines[m.lineNum - 1]?.trim() ?? ''}`);
    }
  });
  return module;
}
