/**
 * 网格的根渲染特性（Stride 的 MeshRenderFeature）。着色见 meshShader.ts，一个设备上的 GPU 资源（缓冲、绑定组、管线、网格和材质的上传）在 MeshGpu.ts。
 *
 * 数据流：
 * - Extract：遍历带 Model 和 Transform 的实体，按（网格，材质，是否投射阴影，是否蒙皮）分批，每批记下实体的变换槽位；
 *   蒙皮的实体（Skinned）还记下变换槽位对应的蒙皮矩阵起点，带形变的（Morphed）记下形变权重的起点。
 * - Cull：GPU 剔除（GpuCulling.ts，设备有 'indirect-first-instance' 时，W7）：这里只记下视图，Prepare 时一次计算着色器剔除这一帧
 *   所有视图，画的时候间接绘制；视图的距离范围（阴影级联要用）用上一帧读回来的。透明的批（要从远到近排）和画线框的帧照旧在
 *   CPU 上剔：各批的槽位连着写进 stride-native 的剔除工作区（FrustumCuller），一次调用剔除一组视图，每批用网格的包围盒，
 *   顺带量出可见物体的距离范围。一帧剔除两次：先主视图，再阴影级联。
 * - Prepare：把变换存储的世界矩阵列整段上传（直接从 wasm 内存，只传用到的那一段），动画系统算好的蒙皮矩阵也直接从 wasm 内存上传，各次剔除的结果（每个视图一段可见槽位）
 *   也直接从 wasm 内存上传成实例缓冲，每个视图的常量（相机、光照、阴影、天空盒）写进按视图分块的 uniform 缓冲（动态偏移）。
 * - Draw：每批一次实例化绘制；着色器用 worlds[slots[instance_index]] 取世界矩阵，firstInstance 是这个视图里这一批的起点。
 *   顶点布局（content/formats/format.ts 的 VertexLayout）不同的网格用不同的管线；量化的属性在顶点着色器里按网格的参数还原
 *   （第 2 组绑定），八面体编码的法线也在那里解开。蒙皮的批次用带关节和权重属性的管线：顶点先乘 4 个蒙皮矩阵的加权和
 *   （GPU 蒙皮，Stride 的 TransformationSkinning），再乘世界矩阵。阴影投射阶段只画投射阴影的批次，管线只写深度。
 * 每帧上传都只写一次、在提交之前，不会碰到 writeBuffer 生效时机的坑（docs/lessons.md）。
 */
import { shaderTime } from '../../engine/GameTime';
import type { EntityId } from '../../data/prop';
import type { ColumnsOf } from '../../engine/component';
import type { EntityManager } from '../../engine/EntityManager';
import { system } from '../../engine/system';
import { Transform } from '../../engine/transform';
import { Morphed } from '../../animation/morphs';
import { Instance, Instancing, Model, Skinned } from '../components';
import { Material } from './Material';
import type { MeshEffect } from './meshEffect';
import { Mesh } from './Mesh';
import { HeightfieldTile, HeightPages } from './HeightPages';
import { inRenderMask, RootRenderFeature, type RenderContext, type RenderStage, type RenderView } from '../RenderSystem';
import { backToFrontRuns, sortBackToFront, type VisibleBatch } from './transparentOrder';
import { CULL_ALWAYS_VISIBLE, CULL_ON_CPU, GpuCulling, type CullBatchInput, type CullViewInput } from './GpuCulling';
import { type CachedPipeline, type CullPass, deformOf, grow, type MaterialPass, MeshGpu, NO_PASSES, SlotTable, transparentPasses, VIEW_STRIDE } from './MeshGpu';

/** 一次实例化绘制：同一个网格和材质的实体。 */
export interface MeshBatch {
  readonly mesh: Mesh;
  readonly material: Material;
  /** 这批的实体投下阴影（Model.isShadowCaster）。 */
  readonly isShadowCaster: boolean;
  /** 这批的实体进光追场景（Model.visibleInRayTracing）。 */
  readonly visibleInRayTracing: boolean;
  /** 这批的实体画进相机的画面（Model.visibleInCamera）；不画时只在投阴影、烘表面颜色的阶段画。 */
  readonly visibleInCamera: boolean;
  /** 这批的实体的渲染组（Model.renderGroup）。 */
  readonly renderGroup: number;
  /** 这批的实体带 Skinned：按蒙皮矩阵画。 */
  readonly skinned: boolean;
  /** 实体的变换槽位，前 count 个有效。 */
  slots: Uint32Array;
  count: number;
  /** 在这一帧所有批次连起来的槽位列表里的起点，Cull 时算。 */
  first: number;
  /**
   * @internal 这批所有实例的世界（渲染空间）包围盒，GPU 剔除时整批在视锥外就不发绘制；槽位列表变了、有实例动了才重算
   * （#updateBatchBounds）。上一次算时的槽位列表留着比较。
   */
  readonly bounds: { readonly min: Float64Array; readonly max: Float64Array; dirty: boolean; slots: Uint32Array };
  /** @internal 各阶段上次用的管线（材质改了、输出格式或网格效果换了才重新查，不用每次画都拼管线的键）。 */
  readonly pipelines: Map<RenderStage, CachedPipeline>;
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
  readonly #masters = new Map<EntityId, { mesh: number; material: number; isShadowCaster: boolean; visibleInRayTracing: boolean; visibleInCamera: boolean; renderGroup: number } | null>();
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
          master = model ? { mesh: model.mesh, material: model.material, isShadowCaster: model.isShadowCaster, visibleInRayTracing: model.visibleInRayTracing, visibleInCamera: model.visibleInCamera, renderGroup: model.renderGroup } : null;
          masters.set(id, master);
        }
        if (!master) continue;
        const batch = this.#batchFor(master.mesh, master.material, master.isShadowCaster, master.visibleInRayTracing, master.visibleInCamera, master.renderGroup, false);
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

  /** 地形块：它的高度页的起点也放在 morphOf 里（一个实体不会既是地形块又带形变）。 */
  readonly #extractHeightfieldSystem = system('MeshRenderFeature.extractHeightfield', {
    with: { transform: Transform, tile: HeightfieldTile },
    update: ({ transform, tile, count }) => {
      for (let i = 0; i < count; i++) this.#morphOf.set(transform.slot[i]!, tile.page[i]!);
    },
  });

  /** 变换槽位 → 形变权重的起点（只有带形变网格的槽位有意义），地形块是高度页的起点。 */
  readonly #morphOf = new SlotTable();

  /** 地形块的高度页（见 HeightPages.ts）：地形系统写，这里每帧上传改了的部分。 */
  readonly heightPages = new HeightPages();

  /** 地形块（槽位）的高度页的起点（float）；光追场景按它建地形块的 BVH。 */
  heightPageOf(slot: number): number {
    return this.#morphOf.values[slot] ?? 0;
  }

  // 剔除：一帧里第 k 次 cull 用第 k 个工作区；视图到（剔除，视图在其中的下标）
  readonly #cullPasses: CullPass[] = [];
  #cullPassCount = 0;
  readonly #viewCulling = new Map<RenderView, { pass: CullPass; index: number }>();

  // GPU 资源，第一次 Prepare 时创建
  #gpu: MeshGpu | undefined;

  /**
   * 不透明的批在 GPU 上剔除（GpuCulling.ts）。设备没有 'indirect-first-instance'、画线框的帧（RenderSystem.wireframe）照旧全在
   * CPU 上剔；关掉它也是（`stride call culling '{"on": false}'`，对比用）。
   */
  gpuCulling = true;
  #culling: GpuCulling | undefined;
  /** 这一帧 GPU 剔除的视图（按 cull 的调用顺序），Prepare 时定各自在实例列表里的起点。 */
  readonly #gpuViews: { readonly view: RenderView; readonly pass: CullPass; readonly index: number }[] = [];
  /** 这一帧的实例（槽位、批号）。 */
  #items = new Uint32Array(0);

  override extract(context: RenderContext): void {
    for (const batch of this.batches) batch.count = 0;
    context.game.entities.run(this.#extractSystem, context.time);
    context.game.entities.run(this.#extractSkinnedSystem, context.time);
    context.game.entities.run(this.#extractMorphedSystem, context.time);
    context.game.entities.run(this.#extractHeightfieldSystem, context.time);
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
    this.#gpuViews.length = 0;
    this.drawnInstances = this.drawCalls = 0;
  }

  /** 这一帧用不用 GPU 剔除。 */
  #gpuCullingOn(): boolean {
    return this.gpuCulling && !this.system.wireframe && this.system.graphicsDevice.indirectFirstInstance;
  }

  /** 批的包围盒上次是第几次更新（GameTime.frameCount）时的；槽位 → 批（重算哪些批），槽位列表变了时重建。 */
  #boundsUpdate = -Infinity;
  #batchOfSlot = new Int32Array(0);
  #batchOfSlotStale = true;

  /**
   * 各批的世界包围盒跟上这一帧（GPU 剔除前调，一帧一次）：槽位列表变了的批、这次更新里有实例动了的批重算（只隔一次更新时按
   * changedSlots 找，隔得多了全部重算）。静止的世界每帧几乎不花时间。
   */
  #updateBatchBounds(context: RenderContext): void {
    const update = context.game.updateTime.frameCount;
    if (update === this.#boundsUpdate) return;
    const transforms = context.game.transforms;
    this.batches.forEach((batch) => {
      const previous = batch.bounds.slots;
      if (previous.length !== batch.count || previous.some((slot, i) => slot !== batch.slots[i])) {
        batch.bounds.slots = batch.slots.slice(0, batch.count);
        batch.bounds.dirty = true;
        this.#batchOfSlotStale = true;
      }
    });
    if (update !== this.#boundsUpdate + 1) {
      for (const batch of this.batches) batch.bounds.dirty = true;
    } else {
      if (this.#batchOfSlotStale) {
        this.#batchOfSlot = new Int32Array(transforms.slotLimit + 1).fill(-1);
        this.batches.forEach((batch, b) => {
          for (let i = 0; i < batch.count; i++) this.#batchOfSlot[batch.slots[i]!] = b;
        });
        this.#batchOfSlotStale = false;
      }
      for (const slot of transforms.changedSlots()) {
        const b = slot < this.#batchOfSlot.length ? this.#batchOfSlot[slot]! : -1;
        if (b >= 0) this.batches[b]!.bounds.dirty = true;
      }
    }
    this.#boundsUpdate = update;
    const world = transforms.renderWorld;
    for (const batch of this.batches) {
      const { bounds } = batch;
      if (!bounds.dirty) continue;
      bounds.dirty = false;
      const { min: lo, max: hi } = batch.mesh.cullBounds;
      const cx = (lo[0]! + hi[0]!) / 2, cy = (lo[1]! + hi[1]!) / 2, cz = (lo[2]! + hi[2]!) / 2;
      const ex = (hi[0]! - lo[0]!) / 2, ey = (hi[1]! - lo[1]!) / 2, ez = (hi[2]! - lo[2]!) / 2;
      bounds.min.fill(Infinity);
      bounds.max.fill(-Infinity);
      for (let i = 0; i < batch.count; i++) {
        const m = batch.slots[i]! * 16;
        for (let r = 0; r < 3; r++) {
          const center = world[m + r]! * cx + world[m + 4 + r]! * cy + world[m + 8 + r]! * cz + world[m + 12 + r]!;
          const extent = Math.abs(world[m + r]!) * ex + Math.abs(world[m + 4 + r]!) * ey + Math.abs(world[m + 8 + r]!) * ez;
          if (center - extent < bounds.min[r]!) bounds.min[r] = center - extent;
          if (center + extent > bounds.max[r]!) bounds.max[r] = center + extent;
        }
      }
    }
  }

  /** 批的世界包围盒和视图的视锥相交（包围盒是 0 的网格总是可见，同原生的剔除）。 */
  #batchInView(batch: MeshBatch, view: RenderView): boolean {
    const local = batch.mesh.cullBounds;
    if (local.min.every((value, i) => value === local.max[i])) return true;
    const { min, max } = batch.bounds;
    if (!(min[0]! <= max[0]!)) return false;
    const planes = view.frustumPlanes;
    for (let p = 0, count = view.ignoreDepthPlanes ? 4 : 6; p < count; p++) {
      const nx = planes[p * 4]!, ny = planes[p * 4 + 1]!, nz = planes[p * 4 + 2]!, d = planes[p * 4 + 3]!;
      // 盒子里离平面最靠里的那个角在平面外面：整个在外面
      const x = nx >= 0 ? max[0]! : min[0]!, y = ny >= 0 ? max[1]! : min[1]!, z = nz >= 0 ? max[2]! : min[2]!;
      if (nx * x + ny * y + nz * z + d <= 0) return false;
    }
    return true;
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
    const pass = (this.#cullPasses[this.#cullPassCount] ??= { culler: context.game.transforms.createCuller(), views: [], slotCount: 0, batchCount: 0, offset: 0, gpuView: -1, cpuBatches: [], cpuIndexOf: new Int32Array(0), cpuFirst: [], cpuSlotCount: 0 });
    this.#cullPassCount++;
    const slotCount = this.#instanceCount, batchCount = this.batches.length;
    const gpu = this.#gpuCullingOn();
    // CPU 上剔哪些批：GPU 剔除时只剔透明的（要从远到近排），不然全部
    pass.cpuBatches.length = pass.cpuFirst.length = 0;
    if (pass.cpuIndexOf.length < batchCount) pass.cpuIndexOf = new Int32Array(batchCount * 2);
    pass.cpuIndexOf.fill(-1);
    let cpuSlots = 0;
    this.batches.forEach((batch, b) => {
      if (gpu && !batch.material.isTransparent && !batch.material.hasClearCoat) return;
      pass.cpuIndexOf[b] = pass.cpuBatches.length;
      pass.cpuBatches.push(b);
      pass.cpuFirst.push(cpuSlots);
      cpuSlots += batch.count;
    });
    pass.cpuSlotCount = cpuSlots;
    pass.views.length = 0;
    pass.views.push(...views);
    pass.slotCount = slotCount;
    pass.batchCount = batchCount;
    pass.gpuView = gpu ? this.#gpuViews.length : -1;
    if (gpu) this.#updateBatchBounds(context);
    views.forEach((view, i) => {
      this.#viewCulling.set(view, { pass, index: i });
      if (!gpu) return;
      this.#gpuViews.push({ view, pass, index: i });
      // 距离范围：上一帧 GPU 剔除读回来的（还没有时取相机的近、远平面）
      if (view.ignoreDepthPlanes) return;
      const result = this.#culling?.result(view);
      view.minimumDistance = Math.min(view.minimumDistance, result ? result.minimumDistance : view.nearClipPlane);
      view.maximumDistance = Math.max(view.maximumDistance, result ? result.maximumDistance : view.farClipPlane);
    });
    if (pass.cpuBatches.length === 0) return;
    const { culler } = pass;
    culler.reserve(cpuSlots, pass.cpuBatches.length, views.length);
    const { slots, batchEnds, bounds } = culler;
    pass.cpuBatches.forEach((b, j) => {
      const batch = this.batches[b]!;
      slots.set(batch.slots.subarray(0, batch.count), pass.cpuFirst[j]!);
      batchEnds[j] = pass.cpuFirst[j]! + batch.count;
      const { min, max } = batch.mesh.cullBounds;
      for (let c = 0; c < 3; c++) {
        bounds[j * 6 + c] = (min[c]! + max[c]!) / 2;
        bounds[j * 6 + 3 + c] = (max[c]! - min[c]!) / 2;
      }
    });
    views.forEach((view, i) => culler.setView(i, view.frustumPlanes, view.ignoreDepthPlanes ? 4 : 6, view.ignoreDepthPlanes ? undefined : view.nearPlane));
    culler.cull(cpuSlots, pass.cpuBatches.length, views.length);
    views.forEach((view, i) => {
      view.minimumDistance = Math.min(view.minimumDistance, culler.minDistance(i));
      view.maximumDistance = Math.max(view.maximumDistance, culler.maxDistance(i));
    });
  }

  /** 一次剔除里第 viewIndex 个视图、第 b 批 CPU 剔出来的个数；这批在 GPU 上剔时是 undefined。 */
  #cpuCount(pass: CullPass, viewIndex: number, b: number): number | undefined {
    const j = pass.cpuIndexOf[b]!;
    return j < 0 ? undefined : pass.culler.counts[viewIndex * pass.cpuBatches.length + j]!;
  }

  override prepare(context: RenderContext): void {
    const gpu = this.#ensureGpu();
    gpu.nextFrame();
    const transforms = context.game.transforms;
    gpu.uploadWorlds(transforms.renderWorld, transforms.slotLimit, transforms.changedSlots(), context.game.updateTime.frameCount);
    gpu.uploadSkinning(this.#paletteOf, context.game.animation);
    gpu.uploadMorphs(this.#morphOf, context.game.animation);
    gpu.uploadHeights(this.heightPages);
    const passes = this.#cullPasses.slice(0, this.#cullPassCount);
    let offset = 0;
    for (const pass of passes) {
      pass.offset = offset;
      offset += pass.views.length * pass.slotCount;
      this.#sortTransparentInstances(context, pass);
    }
    gpu.uploadInstances(passes, offset, this.batches);
    gpu.uploadViews(this.system.views, this.system.lighting, shaderTime(context.game.updateTime.total));
    if (this.#gpuViews.length > 0) this.#recordGpuCulling(gpu);
  }

  /** 这一帧所有 GPU 剔除的视图一次剔完：实例、批、视图传上去，计算着色器录进这一帧的编码器（在所有画之前）。 */
  #recordGpuCulling(gpu: MeshGpu): void {
    const culling = (this.#culling ??= new GpuCulling(this.system.device));
    const count = this.#instanceCount;
    if (this.#items.length < count * 2) this.#items = new Uint32Array(count * 4);
    const batches: CullBatchInput[] = this.batches.map((batch, b) => {
      for (let k = 0; k < batch.count; k++) {
        this.#items[(batch.first + k) * 2] = batch.slots[k]!;
        this.#items[(batch.first + k) * 2 + 1] = b;
      }
      const { min, max } = batch.mesh.cullBounds;
      const center = [0, 1, 2].map((c) => (min[c]! + max[c]!) / 2), extent = [0, 1, 2].map((c) => (max[c]! - min[c]!) / 2);
      const always = extent.every((value) => Math.abs(value) < 1e-9);
      const transparent = batch.material.isTransparent || batch.material.hasClearCoat;
      return { center, extent, first: batch.first, indexCount: gpu.mesh(batch.mesh, this.effect).indexCount, flags: (always ? CULL_ALWAYS_VISIBLE : 0) | (transparent ? CULL_ON_CPU : 0) };
    });
    const views: CullViewInput[] = this.#gpuViews.map(({ view, pass, index }) => ({ view, region: pass.offset + index * pass.slotCount }));
    culling.setFrame(this.#items, count, batches, views);
    culling.record(this.system.graphicsDevice.frameEncoder, gpu.worldsBuffer!, gpu.worldsBase, gpu.instancesBuffer!, this.system.graphicsDevice.profiler.passTimestamps('GpuCulling'));
    for (const { view } of this.#gpuViews) this.drawnInstances += culling.result(view)?.visible ?? 0;
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
      const warming = gpu.warmPipeline(stage, mesh.layout, skinned, deformOf(mesh), material, this.effect, materialPass);
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

  #ensureGpu(): MeshGpu {
    return (this.#gpu ??= new MeshGpu(this.system.device, this.system.resources, this.system.graphicsDevice.depthClipControl, this.system.subsurfaceMaterials, this.system.reflectionProbes, this.system.clouds, this.system, this.system.decals, this.system.clusters, this.system.localLights, this.system.planarReflections, this.system.refraction));
  }


  override draw(context: RenderContext, pass: GPURenderPassEncoder, view: RenderView, stage: RenderStage): void {
    const gpu = this.#gpu;
    const culling = this.#viewCulling.get(view);
    if (!gpu || !culling) return;
    const { pass: cullPass, index } = culling;
    const indirect = cullPass.gpuView >= 0 ? this.#culling : undefined;
    // 透明阶段画透明的材质，再给有清漆的（不透明的）材质叠一遍清漆
    // 点选、线框、阴影投射的阶段透明、不透明的都画（透明的按 alpha 抖动着投阴影，见 Material.depthFragment）
    const inStage = (material: Material) => stage.picking || stage.wireframe || stage.shadowCasters || stage.impostor || (stage.transparent ? material.isTransparent || material.hasClearCoat : !material.isTransparent);
    // GPU 剔除的批不知道剔剩几个：整批的包围盒在视锥里就画（剔光了的话间接参数里的实例数是 0，GPU 上什么也不做）
    const visible = (b: number) => {
      const batch = this.batches[b]!;
      const cpu = this.#cpuCount(cullPass, index, b);
      return (cpu === undefined ? this.#batchInView(batch, view) : cpu > 0) && inStage(batch.material) && inRenderMask(view.cullingMask, batch.renderGroup);
    };
    const viewOffset = cullPass.offset + index * cullPass.slotCount;
    // 透明阶段：一段一段（同一批里连着的几个实例）从远到近；其余阶段每批一段
    const runs = stage.transparent ? this.#backToFront(context, view, cullPass, index, visible) : undefined;
    if (runs?.length === 0) return;
    // 屏幕空间的遮蔽、接触阴影是主画面不透明的那些像素的：透明的、别的视图不用
    const screenSpace = !(stage.transparent || stage.shadowCasters);
    // 屏幕的贴图（第 26 个绑定）：不透明阶段是平面反射图，透明阶段是折射拷的画面，都只给用它着色的视图（主画面）绑——镜像的视图
    // 正往反射图里画，同一个通道里不能又画又采样
    const { planarReflections: planar, refraction } = this.system;
    const screen = stage.transparent
      ? (view === refraction.receiver ? refraction.texture : undefined)
      : (screenSpace && planar.active && view === planar.receiver ? planar.texture : undefined);
    pass.setBindGroup(0, gpu.viewBindGroup(stage.shadowCasters ? undefined : this.system.lighting.shadowAtlas, screenSpace ? view.screenOcclusion : undefined, screenSpace ? view.screenShadow : undefined, screen), [view.index * VIEW_STRIDE]);
    let mesh: Mesh | undefined, material: Material | undefined, pipeline: GPURenderPipeline | undefined, skinned = false;
    for (let i = 0, end = runs ? runs.length / 3 : cullPass.batchCount; i < end; i++) {
      const b = runs ? runs[i * 3]! : i;
      const batch = this.batches[b]!;
      const first = runs ? runs[i * 3 + 1]! : 0;
      const count = runs ? runs[i * 3 + 2]! : this.#cpuCount(cullPass, index, b);
      if (!visible(b) || (stage.shadowCasters ? !batch.isShadowCaster : !batch.visibleInCamera && !stage.surfaceBake) || (view.skipsSkinned && batch.skinned) || (view.skipsTransparent && batch.material.isTransparent)) continue;
      // pass 内只在变化时重设状态（docs/lessons.md）
      const gpuMesh = gpu.mesh(batch.mesh, this.effect);
      const materialChanged = batch.material !== material, meshChanged = batch.mesh !== mesh || batch.skinned !== skinned;
      const passes = stage.transparent ? transparentPasses(batch.material) : NO_PASSES;
      const pipelineOf = (materialPass?: MaterialPass) => gpu.pipelineFor(stage, batch.mesh.layout, batch.skinned, deformOf(batch.mesh), batch.material, this.effect, materialPass);
      if (passes.length === 0 && (materialChanged || meshChanged)) {
        // 管线也按材质分（自发光变体、两面画），同样的组合是同一条管线；上次的输入没变就用上次的
        const { colorFormat, depthFormat } = stage.output;
        let cached = batch.pipelines.get(stage);
        if (!cached || cached.materialVersion !== batch.material.version || cached.effect !== this.effect || cached.colorFormat !== colorFormat || cached.depthFormat !== depthFormat) {
          cached = { pipeline: pipelineOf(), materialVersion: batch.material.version, effect: this.effect, colorFormat, depthFormat };
          batch.pipelines.set(stage, cached);
        }
        if (cached.pipeline !== pipeline) pass.setPipeline((pipeline = cached.pipeline));
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
        if (count === undefined) pass.drawIndexedIndirect(indirect!.args!, indirect!.argsOffset(cullPass.gpuView + index, b));
        else pass.drawIndexed(stage.wireframe ? gpu.edges(batch.mesh, gpuMesh).count : gpuMesh.indexCount, count, 0, 0, viewOffset + batch.first + first);
        this.drawCalls++;
      }
      this.drawnInstances += count ?? 0;
    }
  }

  /**
   * 表面颜色的烘焙（raytracing/SurfaceColors.ts）：批的一个实例（槽位）按纹理坐标（地形块按格坐标）画进图集的一格（视口），stage 是
   * surfaceBake 的阶段。view 是这一帧写过常量的视图（材质按世界坐标、天气的那些量取它的；位置不用它的投影）。不经剔除，直接按槽位画。
   */
  bakeSurfaces(pass: GPURenderPassEncoder, view: RenderView, stage: RenderStage, tiles: readonly { readonly batch: MeshBatch; readonly slot: number; readonly x: number; readonly y: number; readonly size: number }[]): void {
    const gpu = this.#gpu;
    if (!gpu || tiles.length === 0) return;
    pass.setBindGroup(0, gpu.viewBindGroup(undefined), [view.index * VIEW_STRIDE]);
    for (const { batch, slot, x, y, size } of tiles) {
      const gpuMesh = gpu.mesh(batch.mesh, this.effect);
      pass.setViewport(x, y, size, size, 0, 1);
      pass.setPipeline(gpu.pipelineFor(stage, batch.mesh.layout, false, deformOf(batch.mesh), batch.material, this.effect));
      pass.setBindGroup(1, gpu.material(batch.material));
      const tree = gpu.treeBindGroup(batch.material);
      if (tree) pass.setBindGroup(3, tree);
      pass.setBindGroup(2, gpuMesh.bindGroup);
      pass.setVertexBuffer(0, gpuMesh.vertices);
      pass.setIndexBuffer(gpuMesh.indices, gpuMesh.indexFormat);
      // 实例号就是槽位（vsSurfaceBake 不查视图的实例表）
      pass.drawIndexed(gpuMesh.indexCount, 1, 0, 0, slot);
      this.drawCalls++;
    }
  }

  /** 网格释放了（Mesh.dispose，流式加载的地形块这类）：它的批和显存跟着去掉。 */
  readonly #stopForgetting = Mesh.onDispose((mesh) => {
    for (const [key, batch] of this.#batchByKey) if (batch.mesh === mesh) this.#batchByKey.delete(key);
    const kept = this.batches.filter((batch) => batch.mesh !== mesh);
    this.batches.splice(0, this.batches.length, ...kept);
    this.#gpu?.forget(mesh);
  });

  override destroy(): void {
    this.#stopForgetting();
    this.#gpu?.destroy();
    this.#gpu = undefined;
    for (const pass of this.#cullPasses) pass.culler.destroy();
    this.#cullPasses.length = 0;
    this.#culling?.destroy();
    this.#culling = undefined;
  }

  /**
   * 剔除之后、上传实例之前：每个视图里，透明的批（含要叠清漆的）可见的实例在它自己那段里按到相机的距离从远到近排好。
   * 阴影视图不画透明的东西，跳过。
   */
  #sortTransparentInstances(context: RenderContext, pass: CullPass): void {
    const world = context.game.transforms.renderWorld;
    const { visibleSlots } = pass.culler;
    pass.cpuBatches.forEach((b, j) => {
      const batch = this.batches[b]!;
      if (!batch.material.isTransparent && !batch.material.hasClearCoat) return;
      pass.views.forEach((view, v) => {
        const count = this.#cpuCount(pass, v, b)!;
        if (count < 2 || view.viewport) return;
        const start = v * pass.cpuSlotCount + pass.cpuFirst[j]!;
        sortBackToFront(visibleSlots.subarray(start, start + count), world, view.eye);
      });
    });
  }

  /** 透明阶段要画的实例从远到近归并成一段一段（见 transparentOrder.ts）；各批自己那段已经排好（#sortTransparentInstances）。 */
  #backToFront(context: RenderContext, view: RenderView, pass: CullPass, viewIndex: number, visible: (b: number) => boolean): number[] {
    const { visibleSlots } = pass.culler;
    const batches: VisibleBatch[] = [];
    pass.cpuBatches.forEach((b, j) => {
      if (visible(b)) batches.push({ batch: b, start: viewIndex * pass.cpuSlotCount + pass.cpuFirst[j]!, count: this.#cpuCount(pass, viewIndex, b)! });
    });
    return backToFrontRuns(batches, visibleSlots, context.game.transforms.renderWorld, view.eye);
  }

  /** 一张表的行按批记下变换槽位。相邻的行大多是同一批，先比较上一批，省掉大部分 Map 查找。 */
  #extract(model: ColumnsOf<typeof Model>, slots: ArrayLike<number>, count: number, skinned: boolean): void {
    const { mesh, material, isShadowCaster, visibleInRayTracing, visibleInCamera, renderGroup } = model;
    let batch: MeshBatch | undefined;
    for (let i = 0; i < count; i++) {
      const meshId = mesh[i]!, materialId = material[i]!, caster = isShadowCaster[i] !== 0, traced = visibleInRayTracing[i] !== 0, seen = visibleInCamera[i] !== 0, group = renderGroup[i]!;
      if (!batch || batch.mesh.id !== meshId || batch.material.id !== materialId || batch.isShadowCaster !== caster || batch.visibleInRayTracing !== traced || batch.visibleInCamera !== seen || batch.renderGroup !== group) {
        batch = this.#batchFor(meshId, materialId, caster, traced, seen, group, skinned);
      }
      if (batch.count === batch.slots.length) batch.slots = grow(batch.slots, batch.count * 2);
      batch.slots[batch.count++] = slots[i]!;
    }
  }

  #batchFor(meshId: number, materialId: number, isShadowCaster: boolean, visibleInRayTracing: boolean, visibleInCamera: boolean, renderGroup: number, skinned: boolean): MeshBatch {
    // 两个 id 都小于 2^22，拼成一个整数键不会冲突（最大约 2^53，在双精度的整数范围里）
    const flags = (isShadowCaster ? 8 : 0) + (visibleInRayTracing ? 4 : 0) + (visibleInCamera ? 2 : 0) + (skinned ? 1 : 0);
    const key = ((meshId * 0x400000 + materialId) * 32 + renderGroup) * 16 + flags;
    let batch = this.#batchByKey.get(key);
    if (!batch) {
      const mesh = Mesh.byId(meshId);
      const material = Material.byId(materialId);
      if (!mesh) throw new Error(`Model refers to mesh ${meshId}, which does not exist`);
      if (!material) throw new Error(`Model refers to material ${materialId}, which does not exist`);
      if (skinned && !mesh.layout.joints) throw new Error(`mesh '${mesh.name}' is drawn skinned but has no joints and weights`);
      batch = { mesh, material, isShadowCaster, visibleInRayTracing, visibleInCamera, renderGroup, skinned, slots: new Uint32Array(64), count: 0, first: 0, pipelines: new Map(), bounds: { min: new Float64Array(3), max: new Float64Array(3), dirty: true, slots: new Uint32Array(0) } };
      this.#batchByKey.set(key, batch);
      this.batches.push(batch);
    }
    return batch;
  }
}
