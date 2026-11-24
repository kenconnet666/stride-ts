/**
 * 阴影图（照 Stride 的 ShadowMapRenderer 算阴影视图，按 docs/realtime.md 缓存）：主视图剔除完以后算这一帧的阴影视图——方向光
 * 按可见范围切级联，点光是立方体的六个面，聚光一个——画进一张跨帧留着的深度图集，着色时按 lighting.shadow、lighting.localShadows
 * 采样。
 *
 * 和 Stride 不同（Stride 每帧清空图集、所有投阴影的光全部重画）：
 * - 图集跨帧留着：每盏点光、聚光一组固定的块（ShadowAtlasAllocator），块的大小按光源在画面上盖住多大分档（同 Stride 的规则），
 *   档位连着 SIZE_FRAMES 帧都要换才换，换了才重画这一盏。
 * - 两层（静态、动态）：不动的投影者画进静态层的图集（另一张），只在失效时重画——这盏光的位置、方向、射程、阴影设置变了，或者
 *   静态的投影者在它的范围里加了、删了、挪了（mesh/ShadowCasters.ts 报的区域）。照到动的投影者（最近动过的、蒙皮的、风里摆的）
 *   的光每帧把静态层拷到采样的图集，再画上动的；不照到的什么都不做。静止的场景每帧几乎不花时间，改了下一帧就对。
 * - 每帧重画静态层最多 STATIC_FACES_PER_FRAME 块（一下子来了很多灯时分几帧画完；还没画过的光这几帧先不投阴影，画过的先用旧的）。
 * - 方向光的级联照旧每帧画（以后换成按纹素对齐、缓存的级联，见 realtime.md 第 8 步），块也是固定分的，画之前先清空自己那几块。
 * - 图集从 MIN_ATLAS_SIZE 起，放不下时翻倍（到 MAX_ATLAS_SIZE，翻倍时里面的全部重分、重画）；再放不下时这盏光的块缩一半，
 *   最多缩 MAX_DOWNSCALE 次，还放不下就没有阴影。
 * 方向光的级联按视图切：主视图和每个接收阴影的视图（画进渲染目标贴图的相机）各一套；点光、聚光的阴影和视图无关，大家共用。
 */
import type { GraphicsDevice } from '../../graphics/GraphicsDevice';
import {
  RenderStage, type Lighting, type LocalLight, type LocalShadowReceiver, type RenderContext, type RenderSystem, type RenderView, type ShadowMapFilter, type ShadowMapSize, type ShadowReceiver,
} from '../RenderSystem';
import { boxTouchesSphere, type ShadowCasters } from '../mesh/ShadowCasters';
import { DirectionalShadowCascades } from './DirectionalShadowCascades';
import { ShadowAtlasAllocator, type PackedRectangle } from './ShadowAtlasAllocator';
import { ShadowAtlasBlit } from './ShadowAtlasBlit';
import { LocalShadowViews, screenCoverage } from './LocalShadowViews';

const REFERENCE_SHADOW_SIZE = 1024;
const SIZE_INDEX: Readonly<Record<ShadowMapSize, number>> = { xsmall: 0, small: 1, medium: 2, large: 3, xlarge: 4 };
/** 图集最大这么大（边长）：放得下四个 xlarge 的级联。 */
const MAX_ATLAS_SIZE = REFERENCE_SHADOW_SIZE * 2 ** (SIZE_INDEX.xlarge - 3) * 2;
/** 图集从这么大起，不够了翻倍。和 Stride 不同：Stride 一上来就建最大的（4096x4096 的 depth32float 是 64 MB），不管用了多少。 */
const MIN_ATLAS_SIZE = 1024;
/** 最大的图集放不下时一盏光的块最多缩几次（每次边长减半）。 */
const MAX_DOWNSCALE = 3;
/** 光源在画面上的大小连着这么多帧都要换档才换（相机来回挪一点不反复重画）。 */
const SIZE_FRAMES = 30;
/** 这么多帧没用到的光（不在画面附近了）还回它的块。 */
const EVICT_FRAMES = 300;
/** 每帧最多重画静态层的块数（一下子来了很多灯时分几帧画完，不卡那一帧）。 */
const STATIC_FACES_PER_FRAME = 24;
/** 着色器里的滤波编号（ShadowReceiver.filterSize）；PCSS 只有方向光有，点光、聚光按 7x7。 */
const FILTER_SIZES: Readonly<Record<ShadowMapFilter, number>> = { none: 0, pcf3x3: 3, pcf5x5: 5, pcf7x7: 7, pcss: 1 };
const SHADOW_ATLAS_FORMAT: GPUTextureFormat = 'depth32float';
/** Stride 的 MathUtil.ZeroTolerance。 */
const ZERO_TOLERANCE = 1e-6;
/** 一盏光的签名有几个数（见 #signature）。 */
const SIGNATURE_LENGTH = 26;

/** 一张跨帧留着的深度图集和它的分配。 */
class ShadowAtlas {
  readonly #device: GPUDevice;
  readonly #label: string;
  allocator = new ShadowAtlasAllocator(MIN_ATLAS_SIZE);
  #texture: GPUTexture | undefined;
  /** 下一帧开始时翻倍（这一帧有块放不下）。 */
  growNext = false;
  /** 换了大小（翻倍）是第几次：块的主人据此知道自己的块作废了。 */
  generation = 0;

  constructor(device: GPUDevice, label: string) {
    this.#device = device;
    this.#label = label;
  }

  get size(): number {
    return this.allocator.size;
  }

  get texture(): GPUTexture {
    return (this.#texture ??= this.#device.createTexture({
      label: `${this.#label} ${this.size}x${this.size}`,
      size: [this.size, this.size],
      format: SHADOW_ATLAS_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    }));
  }

  /** 这一帧开始时：上一帧有块放不下就翻倍（里面的块全部作废）。 */
  beginFrame(): void {
    if (!this.growNext) return;
    this.growNext = false;
    if (this.size >= MAX_ATLAS_SIZE) return;
    this.allocator = new ShadowAtlasAllocator(this.size * 2);
    this.#texture?.destroy();
    this.#texture = undefined;
    this.generation++;
  }

  /** 分 count 块 size 见方的；放不下时一块也不占、记下下一帧翻倍。 */
  allocate(size: number, count: number): PackedRectangle[] | undefined {
    const placed: PackedRectangle[] = [];
    for (let i = 0; i < count; i++) {
      const rectangle = this.allocator.allocate(size);
      if (!rectangle) {
        for (const r of placed) this.allocator.release(r);
        this.growNext = true;
        return undefined;
      }
      placed.push(rectangle);
    }
    return placed;
  }

  release(rectangles: readonly PackedRectangle[], generation: number): void {
    if (generation !== this.generation) return;
    for (const r of rectangles) this.allocator.release(r);
  }

  destroy(): void {
    this.#texture?.destroy();
    this.#texture = undefined;
  }
}

/** 一盏点光、聚光缓存的阴影。 */
interface LocalEntry {
  /** 块的边长（档位，还没算上缩小）、实际分到的边长。 */
  wanted: number;
  size: number;
  /** 想换的档位连着几帧了。 */
  sizeVotes: number;
  faces: number;
  /** 采样的图集里的块、静态层图集里的块（各自分的时候图集是第几代）。 */
  final: PackedRectangle[];
  finalGeneration: number;
  statics: PackedRectangle[];
  staticGeneration: number;
  /** 静态层画好了、和现在的光一致。 */
  staticValid: boolean;
  /** 静态层画过（哪怕已经过时：没轮上重画的这几帧先用旧的）。 */
  staticDrawn: boolean;
  /** 上一帧采样的图集里有动的投影者（这一帧没有了也要拷一次静态层盖掉）。 */
  hadDynamic: boolean;
  readonly signature: Float64Array;
  readonly receiver: LocalShadowReceiver;
  lastUsed: number;
}

export class ShadowMapRenderer {
  /** 画阴影投射者的阶段：只有深度。方向光的级联和聚光用（不按近、远平面裁剪）。 */
  readonly casterStage = new RenderStage('ShadowMapCaster', { depthFormat: SHADOW_ATLAS_FORMAT }, { shadowCasters: true });
  /** 点光的六个面用的阶段：按近、远平面裁剪（Stride 的 ShadowMapCasterCubeMap）。 */
  readonly cubeMapCasterStage = new RenderStage('ShadowMapCasterCubeMap', { depthFormat: SHADOW_ATLAS_FORMAT }, { shadowCasters: true, depthClip: true });
  readonly #graphicsDevice: GraphicsDevice;
  /** 采样的图集（级联、点光聚光的结果）和点光聚光静态层的图集。 */
  readonly #final: ShadowAtlas;
  readonly #static: ShadowAtlas;
  readonly #blit: ShadowAtlasBlit;
  /** 每个接收阴影的视图一套级联（按 collect 给的顺序：主视图在前）和它们的块。 */
  readonly #cascades: DirectionalShadowCascades[] = [];
  readonly #receivers: ShadowReceiver[] = [];
  readonly #cascadeTiles: ({ wanted: number; size: number; count: number; rectangles: PackedRectangle[]; generation: number } | undefined)[] = [];
  /** 点光、聚光：光源的变换槽位 → 缓存。 */
  readonly #locals = new Map<number, LocalEntry>();
  readonly #localViews = new LocalShadowViews();
  readonly #signature = new Float64Array(SIGNATURE_LENGTH);
  #frame = 0;
  #warnedFull = false;
  #warnedDepthClip = false;

  // 这一帧要做的事（collect 定，draw 做）
  /** 静态层：要清空、重画的视图。 */
  readonly #staticViews: RenderView[] = [];
  /** 采样的图集：要清空的块（级联）、从静态层拷过来的块、画上去的视图（级联、动的投影者）。 */
  readonly #clears: PackedRectangle[] = [];
  readonly #copies: (readonly [PackedRectangle, PackedRectangle])[] = [];
  readonly #finalViews: RenderView[] = [];
  /** 这一帧每个阴影视图用哪个阶段画。 */
  readonly #stages = new Map<RenderView, RenderStage>();

  /** 这一帧重画了几块静态层、拷了几块、画了几个动态层和级联的视图（调试、统计）。 */
  readonly stats = { staticFaces: 0, copies: 0, dynamicFaces: 0, cachedLights: 0 };

  constructor(graphicsDevice: GraphicsDevice) {
    this.#graphicsDevice = graphicsDevice;
    this.#final = new ShadowAtlas(graphicsDevice.device, 'Shadow map atlas');
    this.#static = new ShadowAtlas(graphicsDevice.device, 'Shadow map static atlas');
    this.#blit = new ShadowAtlasBlit(graphicsDevice.device);
  }

  /** 在后台编清空、拷贝图块的管线。 */
  warm(): Promise<void> {
    return this.#blit.warm();
  }

  /**
   * 按剔除过的视图算出这一帧要画的阴影视图：主视图和 others（别的接收阴影的视图，比如画进渲染目标贴图的相机）各一套方向光的
   * 级联（设进各自的 view.shadow，主视图的也设进 lighting.shadow，体积雾用），点光、聚光的阴影共用（lighting.localShadows 和
   * 各盏光的 shadowIndex，按主视图上盖住的大小定分辨率），casters 是这一帧投影者的变化（MeshRenderFeature.shadowCasterChanges）。
   * 返回这一帧要画（要剔除）的视图；缓存着没变的光不在里面。
   */
  collect(main: RenderView, lighting: Lighting, others: readonly RenderView[], casters: ShadowCasters): readonly RenderView[] {
    this.#frame++;
    lighting.shadow = undefined;
    lighting.shadowAtlas = undefined;
    lighting.localShadowCount = 0;
    this.#stages.clear();
    this.#staticViews.length = this.#clears.length = this.#copies.length = this.#finalViews.length = 0;
    Object.assign(this.stats, { staticFaces: 0, copies: 0, dynamicFaces: 0, cachedLights: 0 });
    for (const view of [main, ...others]) view.shadow = undefined;
    if (Math.abs(main.minimumDistance - main.maximumDistance) < ZERO_TOLERANCE) main.maximumDistance = main.minimumDistance + ZERO_TOLERANCE;
    if (!Number.isFinite(main.minimumDistance) || !Number.isFinite(main.maximumDistance)) return [];
    this.#final.beginFrame();
    this.#static.beginFrame();
    // 别的视图里什么都看不见（可见范围不是有限的）时不给它切级联
    const receivers = [main, ...others.filter((view) => Number.isFinite(view.minimumDistance) && Number.isFinite(view.maximumDistance))];
    receivers.forEach((view, i) => this.#collectDirectional(view, i, lighting));
    lighting.shadow = main.shadow;
    this.#collectLocals(main, lighting, casters);
    this.#evict();
    if (lighting.shadow || lighting.localShadowCount > 0) lighting.shadowAtlas = this.#final.texture;
    return [...this.#staticViews, ...this.#finalViews];
  }

  /** view 的方向光级联（index 是它在这一帧的接收者里排第几，各用自己的一套），每帧重画。 */
  #collectDirectional(view: RenderView, index: number, lighting: Lighting): void {
    const settings = lighting.directionalShadow;
    if (!settings) return;
    if (!this.#graphicsDevice.depthClipControl && !this.#warnedDepthClip) {
      this.#warnedDepthClip = true;
      console.warn('This GPU has no "depth-clip-control": shadow casters in front of a shadow cascade are clipped');
    }
    // 方向光覆盖整个画面，按长边算（Stride 的 LightDirectional.ComputeScreenCoverage）
    const wanted = shadowMapSize(settings.size, Math.max(view.width, view.height));
    const tiles = this.#cascadeTileFor(index, wanted, settings.cascadeCount);
    if (!tiles) return;
    const cascades = (this.#cascades[index] ??= new DirectionalShadowCascades());
    const receiver = (this.#receivers[index] ??= {
      cascadeCount: 0, worldToShadow: new Float32Array(64), splits: new Float32Array(4), rectangles: new Float32Array(16),
      depthBias: 0, normalOffsetScale: 0, filterSize: 0, penumbraTangent: 0, blendCascades: true, depthRangeAutomatic: true,
    });
    receiver.depthBias = settings.depthBias;
    receiver.normalOffsetScale = settings.normalOffsetScale;
    receiver.filterSize = FILTER_SIZES[settings.filter];
    receiver.penumbraTangent = Math.tan((settings.lightAngle / 2) * (Math.PI / 180));
    receiver.blendCascades = settings.blendCascades;
    receiver.depthRangeAutomatic = settings.depthRange === 'automatic';
    cascades.collect(view, lighting.directionals[lighting.shadowLight]!.direction, settings, tiles.size, tiles.rectangles, this.#final.size, receiver);
    view.shadow = receiver;
    for (const cascade of cascades.views.slice(0, receiver.cascadeCount)) {
      this.#stages.set(cascade, this.casterStage);
      cascade.skipsRayTraced = view.rayTracedShadows;
      cascade.casterLayer = undefined;
      this.#finalViews.push(cascade);
    }
    this.#clears.push(...tiles.rectangles.slice(0, receiver.cascadeCount));
  }

  /** 第 index 套级联的块：大小、个数变了（或图集翻倍了）重分；放不下时缩小，还放不下返回 undefined。 */
  #cascadeTileFor(index: number, wanted: number, count: number): { size: number; rectangles: PackedRectangle[] } | undefined {
    const tiles = this.#cascadeTiles[index];
    if (tiles && tiles.generation === this.#final.generation && tiles.count === count && tiles.wanted === wanted) return tiles;
    if (tiles) this.#final.release(tiles.rectangles, tiles.generation);
    this.#cascadeTiles[index] = undefined;
    for (let size = wanted, k = 0; k <= MAX_DOWNSCALE && size >= 16; k++, size /= 2) {
      const rectangles = this.#final.allocate(size, count);
      if (!rectangles) continue;
      const placed = { wanted, size, count, rectangles, generation: this.#final.generation };
      this.#cascadeTiles[index] = placed;
      return placed;
    }
    this.#warnFull();
    return undefined;
  }

  /** 点光、聚光：按缓存决定这一帧谁要重画静态层、谁要拷、谁要画动的投影者。 */
  #collectLocals(main: RenderView, lighting: Lighting, casters: ShadowCasters): void {
    let staticBudget = STATIC_FACES_PER_FRAME;
    // 画面上大的先来：图集紧张时它们先分到块、先轮上重画
    const order: LocalLight[] = [];
    for (let i = 0; i < lighting.localCount; i++) if (lighting.locals[i]!.castsShadow) order.push(lighting.locals[i]!);
    const coverage = new Map(order.map((light) => [light, screenCoverage(main, light)]));
    order.sort((a, b) => coverage.get(b)! - coverage.get(a)!);
    this.#localViews.reset();
    for (const light of order) {
      const entry = this.#entryFor(light, shadowMapSize(light.shadow.size, coverage.get(light)!));
      if (!entry) continue;
      entry.lastUsed = this.#frame;
      // 光自己变了、或者静态的投影者在它的范围里变了：静态层作废
      if (this.#signatureChanged(light, entry)) entry.staticValid = false;
      const { x, y, z } = light.position, reach = light.radius * 2;
      for (let r = 0; entry.staticValid && r < casters.regions.length / 6; r++) if (boxTouchesSphere(casters.regions, r, x, y, z, reach)) entry.staticValid = false;
      let dynamic = false;
      for (let d = 0; !dynamic && d < casters.dynamic.length / 6; d++) dynamic = boxTouchesSphere(casters.dynamic, d, x, y, z, reach);
      const redrawStatic = !entry.staticValid && staticBudget >= entry.faces;
      if (!entry.staticDrawn && !redrawStatic) continue;
      const receiver = entry.receiver;
      receiver.filterSize = FILTER_SIZES[light.shadow.filter === 'pcss' ? 'pcf7x7' : light.shadow.filter];
      const stage = light.spot ? this.casterStage : this.cubeMapCasterStage;
      if (redrawStatic) {
        staticBudget -= entry.faces;
        for (const view of this.#localViews.collect(light, entry.statics, this.#static.size, scratchReceiver)) {
          view.casterLayer = 'static';
          this.#stages.set(view, stage);
          this.#staticViews.push(view);
        }
        entry.staticValid = entry.staticDrawn = true;
        this.stats.staticFaces += entry.faces;
      }
      // 采样的图集：静态层重画了、有动的投影者、或者上一帧有（要盖掉）时从静态层拷过来
      const finalViews = this.#localViews.collect(light, entry.final, this.#final.size, receiver);
      if (redrawStatic || dynamic || entry.hadDynamic) {
        entry.final.forEach((to, face) => this.#copies.push([to, entry.statics[face]!]));
        this.stats.copies += entry.faces;
      }
      if (dynamic) {
        for (const view of finalViews) {
          view.casterLayer = 'dynamic';
          this.#stages.set(view, stage);
          this.#finalViews.push(view);
        }
        this.stats.dynamicFaces += entry.faces;
      }
      entry.hadDynamic = dynamic;
      lighting.localShadows[lighting.localShadowCount] = receiver;
      light.shadowIndex = lighting.localShadowCount++;
      this.stats.cachedLights++;
    }
  }

  /** 这盏光的缓存：没有就建；档位、面数变了（或图集翻倍了）重分块（静态层跟着作废）。放不下时缩小，还放不下返回 undefined。 */
  #entryFor(light: LocalLight, wanted: number): LocalEntry | undefined {
    const faces = light.spot ? 1 : 6;
    let entry = this.#locals.get(light.slot);
    if (!entry) {
      entry = {
        wanted, size: 0, sizeVotes: 0, faces, final: [], finalGeneration: -1, statics: [], staticGeneration: -1, staticValid: false, staticDrawn: false, hadDynamic: false,
        signature: new Float64Array(SIGNATURE_LENGTH).fill(Number.NaN), receiver: createLocalShadowReceiver(), lastUsed: this.#frame,
      };
      this.#locals.set(light.slot, entry);
    }
    entry.sizeVotes = wanted === entry.wanted ? 0 : entry.sizeVotes + 1;
    const resize = entry.sizeVotes >= SIZE_FRAMES;
    if (resize) {
      entry.wanted = wanted;
      entry.sizeVotes = 0;
    }
    const placed = entry.size > 0 && entry.faces === faces && entry.finalGeneration === this.#final.generation && entry.staticGeneration === this.#static.generation;
    if (placed && !resize) return entry;
    this.#releaseEntry(entry);
    entry.faces = faces;
    for (let size = entry.wanted, k = 0; k <= MAX_DOWNSCALE && size >= 16; k++, size /= 2) {
      const final = this.#final.allocate(size, faces);
      if (!final) continue;
      const statics = this.#static.allocate(size, faces);
      if (!statics) {
        this.#final.release(final, this.#final.generation);
        continue;
      }
      Object.assign(entry, { size, final, finalGeneration: this.#final.generation, statics, staticGeneration: this.#static.generation, staticValid: false, staticDrawn: false, hadDynamic: false });
      return entry;
    }
    this.#warnFull();
    return undefined;
  }

  #releaseEntry(entry: LocalEntry): void {
    this.#final.release(entry.final, entry.finalGeneration);
    this.#static.release(entry.statics, entry.staticGeneration);
    entry.final = [];
    entry.statics = [];
    entry.size = 0;
  }

  /** 好久没用到的光还回块。 */
  #evict(): void {
    for (const [slot, entry] of this.#locals) {
      if (this.#frame - entry.lastUsed < EVICT_FRAMES) continue;
      this.#releaseEntry(entry);
      this.#locals.delete(slot);
    }
  }

  /** 光的阴影视图跟着变的那些量（渲染空间的位置、方向、射程、聚光的角和朝向、偏移、块的大小）和上次的比，变了记下新的。 */
  #signatureChanged(light: LocalLight, entry: LocalEntry): boolean {
    const s = this.#signature;
    s.set([light.position.x, light.position.y, light.position.z, light.radius, light.spot ? light.angleOuter : -1, light.shadow.depthBias, light.shadow.normalOffsetScale, entry.size, entry.faces, 0]);
    // 聚光的视图按光源的世界矩阵摆（点光的六个面只看位置）
    if (light.spot) s.set(light.world, 10);
    else s.fill(0, 10);
    if (s.every((value, i) => value === entry.signature[i])) return false;
    entry.signature.set(s);
    return true;
  }

  #warnFull(): void {
    if (this.#warnedFull) return;
    this.#warnedFull = true;
    console.warn(`Shadow maps do not all fit into a ${MAX_ATLAS_SIZE}x${MAX_ATLAS_SIZE} atlas even at 1/${2 ** MAX_DOWNSCALE} of their size; some lights have no shadow`);
  }

  /** 画：静态层的通道（清空、重画失效的块），采样图集的通道（清空级联的块、从静态层拷、画级联和动的投影者）。 */
  draw(context: RenderContext, encoder: GPUCommandEncoder, renderSystem: RenderSystem): void {
    const profiler = this.#graphicsDevice.profiler;
    if (this.#staticViews.length > 0) {
      const timestampWrites = profiler.passTimestamps('ShadowMapRenderer static');
      const pass = encoder.beginRenderPass({
        label: 'ShadowMapRenderer static',
        ...(timestampWrites ? { timestampWrites } : {}),
        colorAttachments: [],
        depthStencilAttachment: { view: this.#static.texture.createView(), depthLoadOp: 'load', depthStoreOp: 'store' },
      });
      this.#blit.clear(pass, this.#staticViews.map((view) => view.viewport!));
      this.#drawViews(context, pass, renderSystem, this.#staticViews);
      pass.end();
    }
    if (this.#clears.length + this.#copies.length + this.#finalViews.length === 0) return;
    const timestampWrites = profiler.passTimestamps('ShadowMapRenderer');
    const pass = encoder.beginRenderPass({
      label: 'ShadowMapRenderer',
      ...(timestampWrites ? { timestampWrites } : {}),
      colorAttachments: [],
      depthStencilAttachment: { view: this.#final.texture.createView(), depthLoadOp: 'load', depthStoreOp: 'store' },
    });
    this.#blit.clear(pass, this.#clears);
    this.#blit.copy(pass, this.#static.texture, this.#copies);
    this.#drawViews(context, pass, renderSystem, this.#finalViews);
    pass.end();
  }

  #drawViews(context: RenderContext, pass: GPURenderPassEncoder, renderSystem: RenderSystem, views: readonly RenderView[]): void {
    for (const view of views) {
      const { x, y, width, height } = view.viewport!;
      pass.setViewport(x, y, width, height, 0, 1);
      renderSystem.draw(context, pass, view, this.#stages.get(view) ?? this.casterStage);
    }
  }

  /** 所有缓存的阴影作废（下一帧全部重画）。 */
  invalidate(): void {
    for (const entry of this.#locals.values()) entry.staticValid = false;
  }

  destroy(): void {
    this.#final.destroy();
    this.#static.destroy();
    this.#blit.destroy();
    this.#locals.clear();
    this.#cascadeTiles.length = 0;
    this.#receivers.length = 0;
  }
}

/** 画静态层的视图时用的接收者：矩阵按静态层的图集算，着色器不用，丢掉。 */
const scratchReceiver = createLocalShadowReceiver();

/** 阴影图一块的边长：档位定上限，光源在画面上盖住 coverage 像素时不用更大的（Stride 的 CollectShadowMaps）。 */
function shadowMapSize(size: ShadowMapSize, coverage: number): number {
  const factor = 2 ** (SIZE_INDEX[size] - 3);
  return Math.floor(Math.min(REFERENCE_SHADOW_SIZE * factor, nextPowerOfTwo(coverage * factor)));
}

function createLocalShadowReceiver(): LocalShadowReceiver {
  return { point: true, worldToShadow: new Float32Array(96), depthA: 0, depthB: 0, depthBias: 0, normalOffsetScale: 0, filterSize: 0 };
}

/** 不小于 size 的 2 的幂（Stride 的 MathUtil.NextPowerOfTwo）。 */
function nextPowerOfTwo(size: number): number {
  return 2 ** Math.ceil(Math.log2(size));
}
