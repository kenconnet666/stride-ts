/**
 * 阴影图（Stride 的 ShadowMapRenderer）：主视图剔除完以后算出阴影视图（Collect）——方向光按可见范围切级联，点光是立方体的
 * 六个面，聚光一个——各画进一张深度图集里的一块（只写深度、不剔背面），着色时按 lighting.shadow、lighting.localShadows 采样。
 * 大小和图集的规则同 Stride：每块 min(1024 · 2^(档位 - 3), 光源在画面上盖住的大小的下一个 2 的幂 · 同样的倍数)（方向光盖住整个
 * 画面），每帧清空、按矩形重排（GuillotinePacker）。和 Stride 不同：图集不是固定的 4096²，从 1024² 起、放不下才翻倍（最大 4096²），
 * 一直用不到一半时缩回去，见 collect。
 * 和 Stride 一样（暂时）：最大的图集也放不下的光这一帧没有阴影。
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
/** 用到的地方连着这么多帧不到一半才缩小（相机转一下就够用、再转回来又不够的时候不来回重建）。 */
const SHRINK_FRAMES = 300;
const FILTER_SIZES: Readonly<Record<ShadowMapFilter, number>> = { none: 0, pcf3x3: 3, pcf5x5: 5, pcf7x7: 7 };
const SHADOW_ATLAS_FORMAT: GPUTextureFormat = 'depth32float';
/** Stride 的 MathUtil.ZeroTolerance。 */
const ZERO_TOLERANCE = 1e-6;

export class ShadowMapRenderer {
  /** 画阴影投射者的阶段：只有深度。方向光的级联和聚光用（不按近、远平面裁剪）。 */
  readonly casterStage = new RenderStage('ShadowMapCaster', { depthFormat: SHADOW_ATLAS_FORMAT }, { shadowCasters: true });
  /** 点光的六个面用的阶段：按近、远平面裁剪（Stride 的 ShadowMapCasterCubeMap）。 */
  readonly cubeMapCasterStage = new RenderStage('ShadowMapCasterCubeMap', { depthFormat: SHADOW_ATLAS_FORMAT }, { shadowCasters: true, depthClip: true });
  readonly #graphicsDevice: GraphicsDevice;
  readonly #cascades = new DirectionalShadowCascades();
  readonly #locals = new LocalShadowViews();
  /** 图集现在的边长：按这一帧要放的阴影图够用的最小的 2 的幂（见 collect）。 */
  #atlasSize = MIN_ATLAS_SIZE;
  #packer = new GuillotinePacker(MIN_ATLAS_SIZE, MIN_ATLAS_SIZE);
  /** 这一帧有阴影图没放下。 */
  #full = false;
  /** 这一帧放进去的阴影图占到哪（x、y 方向上最远的边）。 */
  #extent = 0;
  /** 连着多少帧用到的地方不到图集的一半。 */
  #roomyFrames = 0;
  /** 这一帧每个阴影视图用哪个阶段画。 */
  readonly #stages = new Map<RenderView, RenderStage>();
  #atlas: GPUTexture | undefined;
  #receiver: ShadowReceiver | undefined;
  #warnedDepthClip = false;

  constructor(graphicsDevice: GraphicsDevice) {
    this.#graphicsDevice = graphicsDevice;
  }

  /**
   * 按剔除过的主视图算出这一帧的阴影视图，并设好 lighting.shadow（方向光）、lighting.localShadows 和各盏光的 shadowIndex
   * （点光、聚光）。没有光投阴影，或者主视图里什么都看不见时返回空数组。
   */
  collect(main: RenderView, lighting: Lighting): readonly RenderView[] {
    lighting.shadow = undefined;
    lighting.shadowAtlas = undefined;
    lighting.localShadowCount = 0;
    this.#stages.clear();
    if (Math.abs(main.minimumDistance - main.maximumDistance) < ZERO_TOLERANCE) main.maximumDistance = main.minimumDistance + ZERO_TOLERANCE;
    if (!Number.isFinite(main.minimumDistance) || !Number.isFinite(main.maximumDistance)) return [];
    // 一直有富余：缩一半（在这一帧开始排之前换，排出来的位置才对得上图集的大小）
    if (this.#roomyFrames >= SHRINK_FRAMES) this.#resize(this.#atlasSize / 2);
    let views: RenderView[];
    for (;;) {
      this.#packer.clear();
      this.#stages.clear();
      this.#full = false;
      this.#extent = 0;
      lighting.shadow = undefined;
      lighting.localShadowCount = 0;
      views = [...this.#collectDirectional(main, lighting), ...this.#collectLocals(main, lighting)];
      if (!this.#full || this.#atlasSize >= MAX_ATLAS_SIZE) break;
      // 放不下：图集翻倍，这一帧重新排（阴影图在图集里的位置、采样用的变换都跟着图集的大小）
      this.#resize(this.#atlasSize * 2);
    }
    this.#roomyFrames = views.length > 0 && this.#atlasSize > MIN_ATLAS_SIZE && this.#extent * 2 <= this.#atlasSize ? this.#roomyFrames + 1 : 0;
    if (views.length > 0) lighting.shadowAtlas = this.#atlasTexture();
    return views;
  }

  /** 方向光的级联；不投阴影时返回空数组。 */
  #collectDirectional(main: RenderView, lighting: Lighting): readonly RenderView[] {
    const settings = lighting.directionalShadow;
    if (!settings) return [];
    if (!this.#graphicsDevice.depthClipControl && !this.#warnedDepthClip) {
      this.#warnedDepthClip = true;
      console.warn('This GPU has no "depth-clip-control": shadow casters in front of a shadow cascade are clipped');
    }

    // 方向光覆盖整个画面，按长边算（Stride 的 LightDirectional.ComputeScreenCoverage）
    const size = shadowMapSize(settings.size, Math.max(main.width, main.height));
    const rectangles = this.#insert(size, settings.cascadeCount);
    if (!rectangles) return [];
    const receiver = (this.#receiver ??= {
      cascadeCount: 0,
      worldToShadow: new Float32Array(64),
      splits: new Float32Array(4),
      depthBias: 0,
      normalOffsetScale: 0,
      filterSize: 0,
      blendCascades: true,
      depthRangeAutomatic: true,
    });
    receiver.depthBias = settings.depthBias;
    receiver.normalOffsetScale = settings.normalOffsetScale;
    receiver.filterSize = FILTER_SIZES[settings.filter];
    receiver.blendCascades = settings.blendCascades;
    receiver.depthRangeAutomatic = settings.depthRange === 'automatic';
    this.#cascades.collect(main, lighting.directionals[lighting.shadowLight]!.direction, settings, size, rectangles, this.#atlasSize, receiver);
    lighting.shadow = receiver;
    const views = this.#cascades.views.slice(0, receiver.cascadeCount);
    for (const view of views) this.#stages.set(view, this.casterStage);
    return views;
  }

  /** 点光、聚光：每盏投阴影的光按它在画面上盖住的大小要一块（点光六块），放得下的才有阴影。 */
  #collectLocals(main: RenderView, lighting: Lighting): RenderView[] {
    const views: RenderView[] = [];
    this.#locals.reset();
    for (let i = 0; i < lighting.localCount; i++) {
      const light = lighting.locals[i]!;
      if (!light.castsShadow) continue;
      const size = shadowMapSize(light.shadow.size, screenCoverage(main, light));
      const rectangles = size > 0 ? this.#insert(size, light.spot ? 1 : 6) : undefined;
      if (!rectangles) continue;
      const receiver = (lighting.localShadows[lighting.localShadowCount] ??= createLocalShadowReceiver());
      receiver.filterSize = FILTER_SIZES[light.shadow.filter];
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
    this.#receiver = undefined;
  }

  /** 在图集里要 count 块 size 见方的地方；放不下时记下来（collect 会把图集翻倍重排），返回 undefined。 */
  #insert(size: number, count: number): ReturnType<GuillotinePacker['insert']> {
    const rectangles = this.#packer.insert(size, size, count);
    if (!rectangles) this.#full = true;
    for (const { x, y, width, height } of rectangles ?? []) this.#extent = Math.max(this.#extent, x + width, y + height);
    return rectangles;
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
