/**
 * 阴影图（Stride 的 ShadowMapRenderer）：主视图剔除完以后算出阴影视图（Collect）——方向光按可见范围切级联，点光是立方体的
 * 六个面，聚光一个——各画进一张深度图集里的一块（只写深度、不剔背面），着色时按 lighting.shadow、lighting.localShadows 采样。
 * 大小和图集的规则同 Stride：每块 min(1024 · 2^(档位 - 3), 光源在画面上盖住的大小的下一个 2 的幂 · 同样的倍数)（方向光盖住整个
 * 画面），每帧清空、按矩形重排（GuillotinePacker）。和 Stride 不同：图集不是固定的 4096²，从 1024² 起、放不下才翻倍（最大 4096²），
 * 一直用不到一半时缩回去，见 collect。
 * 和 Stride 不同：最大的图集也放不下时，所有阴影图按一半、四分之一……的边长重排（最多缩三次），不让哪盏光、哪个视图这一帧
 * 没有阴影（Stride 是放不下的光没有阴影）。比如 TPP 的方向光是最大的档位，主视图的四个级联就占满了 4096²，画进渲染目标贴图的
 * 相机的级联放不下。
 * 方向光的级联按视图切：主视图和每个接收阴影的视图（画进渲染目标贴图的相机）各一套，都放进同一张图集（同 Stride：每个
 * 相机的 ForwardRenderer 各算自己的级联）；点光、聚光的阴影和视图无关，大家共用。
 */
import type { GraphicsDevice } from '../../graphics/GraphicsDevice';
import {
  RenderStage, type Lighting, type LocalShadowReceiver, type RenderContext, type RenderSystem, type RenderView, type ShadowMapFilter, type ShadowMapSize, type ShadowReceiver,
} from '../RenderSystem';
import { DirectionalShadowCascades } from './DirectionalShadowCascades';
import { GuillotinePacker } from './GuillotinePacker';
import { LocalShadowViews, screenCoverage } from './LocalShadowViews';

const REFERENCE_SHADOW_SIZE = 1024;
const SIZE_INDEX: Readonly<Record<ShadowMapSize, number>> = { xsmall: 0, small: 1, medium: 2, large: 3, xlarge: 4 };
/** 图集最大这么大（边长）：放得下四个 xlarge 的级联。 */
const MAX_ATLAS_SIZE = REFERENCE_SHADOW_SIZE * 2 ** (SIZE_INDEX.xlarge - 3) * 2;
/** 图集从这么大起，不够了翻倍。和 Stride 不同：Stride 一上来就建最大的（4096x4096 的 depth32float 是 64 MB），不管用了多少。 */
const MIN_ATLAS_SIZE = 1024;
/** 最大的图集放不下时阴影图最多缩几次（每次边长减半）。 */
const MAX_DOWNSCALE = 3;
/** 连着这么多帧在一半大的图集里也放得下才缩小（相机转一下就够用、再转回来又不够的时候不来回重建）。 */
const SHRINK_FRAMES = 300;
/** 着色器里的滤波编号（ShadowReceiver.filterSize）；PCSS 只有方向光有，点光、聚光按 7x7。 */
const FILTER_SIZES: Readonly<Record<ShadowMapFilter, number>> = { none: 0, pcf3x3: 3, pcf5x5: 5, pcf7x7: 7, pcss: 1 };
const SHADOW_ATLAS_FORMAT: GPUTextureFormat = 'depth32float';
/** Stride 的 MathUtil.ZeroTolerance。 */
const ZERO_TOLERANCE = 1e-6;

export class ShadowMapRenderer {
  /** 画阴影投射者的阶段：只有深度。方向光的级联和聚光用（不按近、远平面裁剪）。 */
  readonly casterStage = new RenderStage('ShadowMapCaster', { depthFormat: SHADOW_ATLAS_FORMAT }, { shadowCasters: true });
  /** 点光的六个面用的阶段：按近、远平面裁剪（Stride 的 ShadowMapCasterCubeMap）。 */
  readonly cubeMapCasterStage = new RenderStage('ShadowMapCasterCubeMap', { depthFormat: SHADOW_ATLAS_FORMAT }, { shadowCasters: true, depthClip: true });
  readonly #graphicsDevice: GraphicsDevice;
  /** 每个接收阴影的视图一套级联（按 collect 给的顺序：主视图在前）。 */
  readonly #cascades: DirectionalShadowCascades[] = [];
  readonly #receivers: ShadowReceiver[] = [];
  readonly #locals = new LocalShadowViews();
  /** 图集现在的边长：按这一帧要放的阴影图够用的最小的 2 的幂（见 collect）。 */
  #atlasSize = MIN_ATLAS_SIZE;
  #packer = new GuillotinePacker(MIN_ATLAS_SIZE, MIN_ATLAS_SIZE);
  /** 这一帧有阴影图没放下。 */
  #full = false;
  /** 这一帧按顺序要过的地方：每次是 count 块 size 见方的（缩小之前拿它在一半大的图集里试排）。 */
  readonly #requests: { size: number; count: number }[] = [];
  /** 连着多少帧在一半大的图集里也放得下。 */
  #roomyFrames = 0;
  /** 这一帧阴影图的边长缩了几次（最大的图集放不下时，见 collect）。 */
  #downscale = 0;
  #warnedDownscale = false;
  /** 这一帧每个阴影视图用哪个阶段画。 */
  readonly #stages = new Map<RenderView, RenderStage>();
  #atlas: GPUTexture | undefined;
  #warnedDepthClip = false;

  constructor(graphicsDevice: GraphicsDevice) {
    this.#graphicsDevice = graphicsDevice;
  }

  /**
   * 按剔除过的视图算出这一帧的阴影视图：主视图和 others（别的接收阴影的视图，比如画进渲染目标贴图的相机）各一套方向光的
   * 级联（设进各自的 view.shadow，主视图的也设进 lighting.shadow，体积雾用），点光、聚光的阴影共用（lighting.localShadows 和
   * 各盏光的 shadowIndex，按主视图上盖住的大小定分辨率）。没有光投阴影，或者主视图里什么都看不见时返回空数组。
   */
  collect(main: RenderView, lighting: Lighting, others: readonly RenderView[] = []): readonly RenderView[] {
    lighting.shadow = undefined;
    lighting.shadowAtlas = undefined;
    lighting.localShadowCount = 0;
    this.#stages.clear();
    for (const view of [main, ...others]) view.shadow = undefined;
    if (Math.abs(main.minimumDistance - main.maximumDistance) < ZERO_TOLERANCE) main.maximumDistance = main.minimumDistance + ZERO_TOLERANCE;
    if (!Number.isFinite(main.minimumDistance) || !Number.isFinite(main.maximumDistance)) return [];
    // 别的视图里什么都看不见（可见范围不是有限的）时不给它切级联
    const receivers = [main, ...others.filter((view) => Number.isFinite(view.minimumDistance) && Number.isFinite(view.maximumDistance))];
    // 一直有富余：缩一半（在这一帧开始排之前换，排出来的位置才对得上图集的大小）
    if (this.#roomyFrames >= SHRINK_FRAMES) this.#resize(this.#atlasSize / 2);
    let views: RenderView[];
    this.#downscale = 0;
    for (;;) {
      this.#packer.clear();
      this.#stages.clear();
      this.#full = false;
      this.#requests.length = 0;
      lighting.shadow = undefined;
      lighting.localShadowCount = 0;
      views = [...receivers.flatMap((view, i) => this.#collectDirectional(view, i, lighting)), ...this.#collectLocals(main, lighting)];
      lighting.shadow = main.shadow;
      if (!this.#full) break;
      // 放不下：图集翻倍，这一帧重新排（阴影图在图集里的位置、采样用的变换都跟着图集的大小）；已经最大了就把阴影图都缩一半
      if (this.#atlasSize < MAX_ATLAS_SIZE) this.#resize(this.#atlasSize * 2);
      else if (this.#downscale < MAX_DOWNSCALE) this.#downscale++;
      else break;
    }
    if (this.#downscale > 0 && !this.#warnedDownscale) {
      this.#warnedDownscale = true;
      console.warn(`Shadow maps do not fit into a ${MAX_ATLAS_SIZE}x${MAX_ATLAS_SIZE} atlas; they are drawn at 1/${2 ** this.#downscale} of their size`);
    }
    this.#roomyFrames = views.length > 0 && this.#atlasSize > MIN_ATLAS_SIZE && this.#fitsHalf() ? this.#roomyFrames + 1 : 0;
    if (views.length > 0) lighting.shadowAtlas = this.#atlasTexture();
    return views;
  }

  /** view 的方向光级联（index 是它在这一帧的接收者里排第几，各用自己的一套）；不投阴影时返回空数组。 */
  #collectDirectional(view: RenderView, index: number, lighting: Lighting): readonly RenderView[] {
    const settings = lighting.directionalShadow;
    if (!settings) return [];
    if (!this.#graphicsDevice.depthClipControl && !this.#warnedDepthClip) {
      this.#warnedDepthClip = true;
      console.warn('This GPU has no "depth-clip-control": shadow casters in front of a shadow cascade are clipped');
    }

    // 方向光覆盖整个画面，按长边算（Stride 的 LightDirectional.ComputeScreenCoverage）
    const size = shadowMapSize(settings.size, Math.max(view.width, view.height)) >> this.#downscale;
    const rectangles = this.#insert(size, settings.cascadeCount);
    if (!rectangles) return [];
    const cascades = (this.#cascades[index] ??= new DirectionalShadowCascades());
    const receiver = (this.#receivers[index] ??= {
      cascadeCount: 0,
      worldToShadow: new Float32Array(64),
      splits: new Float32Array(4),
      rectangles: new Float32Array(16),
      depthBias: 0,
      normalOffsetScale: 0,
      filterSize: 0,
      penumbraTangent: 0,
      blendCascades: true,
      depthRangeAutomatic: true,
    });
    receiver.depthBias = settings.depthBias;
    receiver.normalOffsetScale = settings.normalOffsetScale;
    receiver.filterSize = FILTER_SIZES[settings.filter];
    receiver.penumbraTangent = Math.tan((settings.lightAngle / 2) * (Math.PI / 180));
    receiver.blendCascades = settings.blendCascades;
    receiver.depthRangeAutomatic = settings.depthRange === 'automatic';
    cascades.collect(view, lighting.directionals[lighting.shadowLight]!.direction, settings, size, rectangles, this.#atlasSize, receiver);
    view.shadow = receiver;
    const views = cascades.views.slice(0, receiver.cascadeCount);
    for (const cascade of views) this.#stages.set(cascade, this.casterStage);
    return views;
  }

  /** 点光、聚光：每盏投阴影的光按它在画面上盖住的大小要一块（点光六块），放得下的才有阴影。 */
  #collectLocals(main: RenderView, lighting: Lighting): RenderView[] {
    const views: RenderView[] = [];
    this.#locals.reset();
    for (let i = 0; i < lighting.localCount; i++) {
      const light = lighting.locals[i]!;
      if (!light.castsShadow) continue;
      const size = shadowMapSize(light.shadow.size, screenCoverage(main, light)) >> this.#downscale;
      const rectangles = size > 0 ? this.#insert(size, light.spot ? 1 : 6) : undefined;
      if (!rectangles) continue;
      const receiver = (lighting.localShadows[lighting.localShadowCount] ??= createLocalShadowReceiver());
      receiver.filterSize = FILTER_SIZES[light.shadow.filter === 'pcss' ? 'pcf7x7' : light.shadow.filter];
      const stage = light.spot ? this.casterStage : this.cubeMapCasterStage;
      for (const view of this.#locals.collect(light, rectangles, this.#atlasSize, receiver)) {
        this.#stages.set(view, stage);
        views.push(view);
      }
      light.shadowIndex = lighting.localShadowCount++;
    }
    return views;
  }

  /** 把投射者画进图集：清一次，每个级联设自己的视口。 */
  draw(context: RenderContext, encoder: GPUCommandEncoder, renderSystem: RenderSystem, views: readonly RenderView[]): void {
    if (views.length === 0) return;
    const timestampWrites = this.#graphicsDevice.profiler.passTimestamps('ShadowMapRenderer');
    const pass = encoder.beginRenderPass({
      label: 'ShadowMapRenderer',
      ...(timestampWrites ? { timestampWrites } : {}),
      colorAttachments: [],
      depthStencilAttachment: { view: this.#atlasTexture().createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' },
    });
    for (const view of views) {
      const { x, y, width, height } = view.viewport!;
      pass.setViewport(x, y, width, height, 0, 1);
      renderSystem.draw(context, pass, view, this.#stages.get(view) ?? this.casterStage);
    }
    pass.end();
  }

  destroy(): void {
    this.#atlas?.destroy();
    this.#atlas = undefined;
    this.#receivers.length = 0;
  }

  /** 在图集里要 count 块 size 见方的地方；放不下时记下来（collect 会把图集翻倍重排），返回 undefined。 */
  #insert(size: number, count: number): ReturnType<GuillotinePacker['insert']> {
    const rectangles = this.#packer.insert(size, size, count);
    if (!rectangles) this.#full = true;
    this.#requests.push({ size, count });
    return rectangles;
  }

  /**
   * 这一帧要的地方在一半大的图集里照同样的顺序排不排得下。不能只看占到哪：级联是排成一行的，四块 1024 在 4096 的图集里
   * 占满一整行，2048 的图集其实放得下。
   */
  #fitsHalf(): boolean {
    const half = this.#atlasSize / 2;
    const packer = new GuillotinePacker(half, half);
    return this.#requests.every(({ size, count }) => packer.insert(size, size, count) !== undefined);
  }

  #resize(size: number): void {
    this.#atlasSize = size;
    this.#packer = new GuillotinePacker(size, size);
    this.#atlas?.destroy();
    this.#atlas = undefined;
    this.#roomyFrames = 0;
  }

  #atlasTexture(): GPUTexture {
    return (this.#atlas ??= this.#graphicsDevice.device.createTexture({
      label: 'Shadow map atlas',
      size: [this.#atlasSize, this.#atlasSize],
      format: SHADOW_ATLAS_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    }));
  }
}

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
