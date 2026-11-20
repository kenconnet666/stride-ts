/**
 * 天空遮挡（Stride 没有）：一张从上往下看的深度图，跟着相机，记着"头顶有没有东西挡着天"。Godot 的
 * GPUParticlesCollisionHeightField3D、别处的 rain occlusion map 都是这个。雨雪用它（GPU 粒子按它碰撞：雪落上去就没了，雨点
 * 溅起来；屋里、桥下不下雨），地面的湿润、积雪查"哪里淋得到"也用它。`renderSystem.skyOcclusion`。
 *
 * - 只有能挡阳光的才挡天：用阴影投射者的阶段画（ShadowMapRenderer.casterStage，不透明、投阴影的网格；透明的、不投阴影的、
 *   粒子、精灵不画），管线和阴影共用、加载时就预热了。蒙皮的网格（角色、动物）也不画：它们一直在动，脚下不该留一块不湿、
 *   不积雪的地，雨点穿过角色看不出来。
 * - 正交视图从相机上方往下看，覆盖 size 米见方、resolution 像素。中心按纹素吸附（size / resolution 米一格），相机走远了
 *   redrawDistance 米才重画，两次之间贴图在世界里不动，遮挡的边缘不随相机游动。
 * - 没变就不重画：遮挡物（开着的门、移动的平台）动了、加了、删了，而且在画的范围里，才重画（变换存储报的变了的槽位，
 *   TransformStore.changedSlots；一直有东西在动时最多每 minRedrawInterval 秒一次）。范围外的东西动不算：开放世界里远处
 *   的车、门不让它重画。
 * - 没人用就不画、不建贴图：用户每帧调 use()；画质档位关掉时（skyOcclusion: false，低档）也不画。
 * - 对外给：深度贴图 depthView、拷进存储缓冲的同一张深度 depthBuffer（网格着色器用：不占采样贴图的名额）、世界到贴图的
 *   矩阵 worldToTexture（视图投影：xy 是 -1..1，z 是深度）、version（重画了才变）。它是一个深度表面（rendering/DepthSurface.ts）：
 *   GPU 上的用户绑 uniform（矩阵、有效位、逆矩阵、视线方向；网格着色器只读前两个）。前向渲染器画完的这一张，下一帧开头（begin）才换成对外的那张：这一帧的粒子
 *   模拟录在画之前，那时深度图还是旧的。
 *
 * 只能表示"头顶最高的表面"：悬空的结构下面一样算挡着，斜着吹的雨照竖直判断。
 */
import { Matrix } from '../data/Matrix';
import { DEPTH_SURFACE_BYTES, packDepthSurface, type GpuDepthSurface } from '../rendering/DepthSurface';
import type { RenderContext, RenderStage, RenderSystem } from '../rendering/RenderSystem';
import { RenderView } from '../rendering/RenderSystem';
import type { MeshBatch } from '../rendering/mesh/MeshRenderFeature';
import type { TransformStore } from '@stride-ts/native';

/** 阴影投射者阶段的深度格式（ShadowMapRenderer 的 SHADOW_ATLAS_FORMAT）。 */
const FORMAT: GPUTextureFormat = 'depth32float';
/** 视图在相机上方多高、往下看多深，米。 */
const ABOVE = 150;
const BELOW = 300;

export class SkyOcclusion implements GpuDepthSurface {
  /** 覆盖的边长，米。 */
  size = 64;
  /** 深度图的边长，像素（64 米、512 像素是一格 12.5 厘米，深度图 1 MB）。在第一次用之前改。 */
  resolution = 512;
  /** 相机离上次画的中心多远才重画，米。 */
  redrawDistance = 8;
  /** 遮挡物动了时两次重画至少隔多久，秒（一直在动的平台不让它每帧重画）。 */
  minRedrawInterval = 0.2;
  /** 画质档位开着（前向渲染器每帧设）。 */
  enabled = true;
  readonly view = Object.assign(new RenderView(), { receivesShadows: false, skipsSkinned: true, skipsTransparent: true });
  readonly #device: GPUDevice;
  #texture: GPUTexture | undefined;
  #depthView: GPUTextureView | undefined;
  /**
   * 深度图拷进的两个存储缓冲（网格着色器按缓冲读：不占片元阶段采样贴图的名额）：画完拷进另一个，下一帧开头和矩阵一起
   * 换上——这一帧画完以后着色的还在用旧的矩阵，读的也得是旧的深度。
   */
  #depthBuffers: [GPUBuffer, GPUBuffer] | undefined;
  #published = 0;
  #uniform: GPUBuffer | undefined;
  #used = false;
  #center: [number, number, number] | undefined;
  #drawnAt = -Infinity;
  /** 这一帧在画（begin 给了视图）。 */
  #drawing = false;
  /** 上一帧有人用：中间停过的话，停的时候动了什么不知道，接着用时先重画一次。 */
  #watched = false;
  /** 画过以后，画的范围里的遮挡物变了。 */
  #dirty = false;
  /** 槽位 → 遮挡物的包围半径（本地，乘缩放前；0 是不是遮挡物），这一帧的和上一帧的。 */
  #occluders = new Float32Array(0);
  #previousOccluders = new Float32Array(0);
  /** 处理过的变换存储的帧（暂停的帧不算一次 update，变了的槽位还是上一次的）。 */
  #checkedFrame = -1;
  /** 槽位 → 遮挡物上一次记下的位置和最大的缩放（xyz、s）。 */
  #positions = new Float32Array(0);
  /** 画好了、还没换成对外那张的视图投影和 uniform。 */
  #pending: { readonly worldToTexture: Float32Array<ArrayBuffer>; readonly uniform: ArrayBuffer } | undefined;
  #worldToTexture: Float32Array<ArrayBuffer> = new Float32Array(16);
  #version = 0;

  constructor(device: GPUDevice) {
    this.#device = device;
  }

  /** 这一帧要用（每帧在画之前调用；没人调就不画）。 */
  use(): void {
    this.#used = true;
  }

  /** 重画并换上了一次就加一；0 是还没有。 */
  get version(): number {
    return this.#version;
  }

  /** 世界到贴图的矩阵（视图投影）：version 是 0 时没意义。 */
  get worldToTexture(): Readonly<Float32Array> {
    return this.#worldToTexture;
  }

  get depthView(): GPUTextureView {
    this.#ensure();
    return this.#depthView!;
  }

  get uniform(): GPUBuffer {
    this.#ensure();
    return this.#uniform!;
  }

  /** 换上了的那张深度图的缓冲（边长 resolution 的 f32，按行存；网格着色器用）。重画换上以后是另一个缓冲。 */
  get depthBuffer(): GPUBuffer {
    this.#ensure();
    return this.#depthBuffers![this.#published]!;
  }

  /**
   * @internal 前向渲染器每帧调用（剔除之前）：上一次画好的换成对外那张；这一帧要画就设好视图返回它，不画时返回 undefined。
   * eye 是主相机的位置，time 是游戏时间（秒）。
   */
  begin(eye: { readonly x: number; readonly y: number; readonly z: number }, time: number): RenderView | undefined {
    this.#commit();
    const used = this.#used && this.enabled, resumed = !this.#watched;
    this.#used = false;
    this.#watched = used;
    this.#drawing = false;
    if (!used) return undefined;
    const far = !this.#center || Math.hypot(eye.x - this.#center[0], eye.z - this.#center[2]) > this.redrawDistance || Math.abs(eye.y - this.#center[1]) > this.redrawDistance;
    if (!far && !resumed && !(this.#dirty && time - this.#drawnAt >= this.minRedrawInterval)) return undefined;
    this.#drawing = true;
    this.#dirty = false;
    const center = skyOcclusionCenter(eye, this.size / this.resolution);
    this.#center = center;
    this.#drawnAt = time;
    const view = this.view, half = this.size / 2;
    const [x, y, z] = center;
    // 从上往下看：屏幕的上方是世界的 -Z
    Matrix.lookAtRH(view.view, [x, y + ABOVE, z], [x, y, z], [0, 0, -1]);
    Matrix.orthoOffCenterRH(view.projection, -half, half, -half, half, 0, ABOVE + BELOW);
    view.nearClipPlane = 0;
    view.farClipPlane = ABOVE + BELOW;
    view.width = view.height = this.resolution;
    view.update();
    return view;
  }

  /**
   * @internal 前向渲染器在提取之后调用（有人用的帧）：看这一帧的遮挡物（投阴影、不透明、不蒙皮的网格批次）比上一帧加了、删了
   * 哪些，变换存储报的变了的槽位里哪些是遮挡物；在画的范围里就记下"要重画"，下一帧 begin 时重画。这一帧在画就不用记：画的
   * 就是这一帧的样子。
   */
  watch(batches: readonly MeshBatch[], transforms: TransformStore, frame: number): void {
    if (!this.#watched) return;
    const limit = transforms.slotLimit + 1;
    [this.#previousOccluders, this.#occluders] = [this.#occluders, this.#previousOccluders];
    if (this.#occluders.length < limit) this.#occluders = new Float32Array(Math.max(limit, this.#occluders.length * 2));
    else this.#occluders.fill(0, 0, limit);
    const occluders = this.#occluders, previous = this.#previousOccluders;
    let dirty = false;
    for (const batch of batches) {
      if (!batch.isShadowCaster || batch.skinned || batch.material.isTransparent || batch.count === 0) continue;
      const { min, max } = batch.mesh.cullBounds;
      let center = 0, half = 0;
      for (let c = 0; c < 3; c++) {
        center += ((min[c]! + max[c]!) / 2) ** 2;
        half += ((max[c]! - min[c]!) / 2) ** 2;
      }
      const radius = Math.sqrt(center) + Math.sqrt(half);
      for (let i = 0; i < batch.count; i++) {
        const slot = batch.slots[i]!;
        occluders[slot] = radius;
        if (previous[slot]! > 0) continue;
        // 新出现的遮挡物
        this.#remember(transforms.world, slot);
        if (!dirty) dirty = this.#covers(transforms.world, slot, radius);
      }
    }
    // 不再是遮挡物的（删了、换了不投阴影的材质）：按它最后的世界矩阵看（释放的槽位矩阵还留着）
    for (let slot = 1; !dirty && slot < Math.min(limit, previous.length); slot++) {
      if (previous[slot]! > 0 && !(occluders[slot]! > 0)) dirty = this.#covers(transforms.world, slot, previous[slot]!);
    }
    if (frame !== this.#checkedFrame) {
      this.#checkedFrame = frame;
      // 动了的遮挡物：动之前或之后在范围里都算（瞬移出范围的那一下，新位置不在范围里，旧位置的影子还画着）
      for (const slot of transforms.changedSlots()) {
        const radius = Math.max(occluders[slot] ?? 0, previous[slot] ?? 0);
        if (!(radius > 0)) continue;
        if (!dirty) dirty = this.#covers(transforms.world, slot, radius) || this.#coveredBefore(slot, radius);
        this.#remember(transforms.world, slot);
      }
    }
    if (dirty && !this.#drawing) this.#dirty = true;
  }

  /** @internal 前向渲染器在阴影之后调用：用阴影投射者的阶段 stage 把 begin 给的视图画进深度图。 */
  draw(context: RenderContext, encoder: GPUCommandEncoder, renderSystem: RenderSystem, stage: RenderStage): void {
    const timestampWrites = renderSystem.graphicsDevice.profiler.passTimestamps('SkyOcclusion');
    const pass = encoder.beginRenderPass({
      label: 'SkyOcclusion',
      ...(timestampWrites ? { timestampWrites } : {}),
      colorAttachments: [],
      depthStencilAttachment: { view: this.depthView, depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' },
    });
    renderSystem.draw(context, pass, this.view, stage);
    pass.end();
    encoder.copyTextureToBuffer({ texture: this.#texture!, aspect: 'depth-only' }, { buffer: this.#depthBuffers![1 - this.#published]!, bytesPerRow: this.resolution * 4 }, [this.resolution, this.resolution]);
    this.#pending = { worldToTexture: new Float32Array(this.view.viewProjection), uniform: packDepthSurface(this.view, this.resolution, this.resolution) };
  }

  destroy(): void {
    this.#texture?.destroy();
    this.#uniform?.destroy();
    for (const buffer of this.#depthBuffers ?? []) buffer.destroy();
    this.#texture = undefined;
    this.#uniform = undefined;
    this.#depthBuffers = undefined;
  }

  /** 槽位的包围球（世界矩阵的平移为球心，本地半径乘最大的缩放）和画的范围相交。 */
  #covers(world: Float32Array, slot: number, radius: number): boolean {
    const o = slot * 16;
    return this.#overlaps(world[o + 12]!, world[o + 13]!, world[o + 14]!, radius * maxScale(world, o));
  }

  /** 按记下的上一个位置看（半径按记下的缩放）。 */
  #coveredBefore(slot: number, radius: number): boolean {
    const p = this.#positions, o = slot * 4;
    return o + 3 < p.length && this.#overlaps(p[o]!, p[o + 1]!, p[o + 2]!, radius * p[o + 3]!);
  }

  #overlaps(x: number, y: number, z: number, radius: number): boolean {
    const center = this.#center;
    if (!center) return false;
    const half = this.size / 2 + radius;
    return Math.abs(x - center[0]) <= half && Math.abs(z - center[2]) <= half && y + radius >= center[1] - BELOW && y - radius <= center[1] + ABOVE;
  }

  /** 记下槽位现在的位置和最大的缩放（动了以后看它是不是从范围里离开的）。 */
  #remember(world: Float32Array, slot: number): void {
    if (this.#positions.length < slot * 4 + 4) {
      const grown = new Float32Array(Math.max(slot * 4 + 4, this.#positions.length * 2));
      grown.set(this.#positions);
      this.#positions = grown;
    }
    const o = slot * 16, p = this.#positions;
    p[slot * 4] = world[o + 12]!;
    p[slot * 4 + 1] = world[o + 13]!;
    p[slot * 4 + 2] = world[o + 14]!;
    p[slot * 4 + 3] = maxScale(world, o);
  }

  /** 画好的那张换成对外的：矩阵、uniform、版本号。 */
  #commit(): void {
    const pending = this.#pending;
    if (!pending) return;
    this.#pending = undefined;
    this.#worldToTexture = pending.worldToTexture;
    this.#version++;
    this.#published = 1 - this.#published;
    this.#device.queue.writeBuffer(this.uniform, 0, pending.uniform);
  }

  #ensure(): void {
    if (this.#texture) return;
    this.#texture = this.#device.createTexture({ label: 'SkyOcclusion', size: [this.resolution, this.resolution], format: FORMAT, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC });
    this.#depthView = this.#texture.createView();
    // 每行的字节数要是 256 的倍数：边长取 64 的倍数
    if (this.resolution % 64 !== 0) throw new Error(`SkyOcclusion: resolution must be a multiple of 64, got ${this.resolution}`);
    const bytes = this.resolution * this.resolution * 4;
    this.#depthBuffers = [0, 1].map((i) => this.#device.createBuffer({ label: `SkyOcclusion depth ${i}`, size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })) as [GPUBuffer, GPUBuffer];
    // 有效位是 0：还没画过时用户不判断
    this.#uniform = this.#device.createBuffer({ label: 'SkyOcclusion', size: DEPTH_SURFACE_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  }
}

/** 列主序矩阵（world 从 o 起）三根轴里最长的那根。 */
function maxScale(world: Float32Array, o: number): number {
  const axis = (a: number) => world[a]! ** 2 + world[a + 1]! ** 2 + world[a + 2]! ** 2;
  return Math.sqrt(Math.max(axis(o), axis(o + 4), axis(o + 8)));
}

/** 视图的中心：相机的位置吸附到 texel 米的格子上（纹素对齐，重画以后遮挡的边缘落在同样的位置）。 */
export function skyOcclusionCenter(eye: { readonly x: number; readonly y: number; readonly z: number }, texel: number): [number, number, number] {
  const cell = (c: number) => Math.round(c / texel) * texel;
  return [cell(eye.x), cell(eye.y), cell(eye.z)];
}
