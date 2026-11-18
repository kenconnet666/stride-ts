/**
 * 阴影图（Stride 的 ShadowMapRenderer，目前只有方向光）：主视图剔除完以后，按可见范围算出级联视图（Collect），
 * 各级联画进一张深度图集的不同方块（ShadowMapCaster 阶段，只写深度、不剔背面、不做深度裁剪），着色时按
 * lighting.shadow 采样。大小和图集的规则同 Stride：每个级联 min(1024 · 2^(档位 - 3), 画面长边的下一个 2 的幂 · 同样的倍数)，
 * 图集固定 4096²（xlarge 的两倍），每帧清一次。
 */
import type { GraphicsDevice } from '../../graphics/GraphicsDevice';
import { RenderStage, type Lighting, type RenderContext, type RenderSystem, type RenderView, type ShadowMapFilter, type ShadowMapSize, type ShadowReceiver } from '../RenderSystem';
import { DirectionalShadowCascades, type CascadeRectangle } from './DirectionalShadowCascades';

const REFERENCE_SHADOW_SIZE = 1024;
const SIZE_INDEX: Readonly<Record<ShadowMapSize, number>> = { xsmall: 0, small: 1, medium: 2, large: 3, xlarge: 4 };
const ATLAS_SIZE = REFERENCE_SHADOW_SIZE * 2 ** (SIZE_INDEX.xlarge - 3) * 2;
const FILTER_SIZES: Readonly<Record<ShadowMapFilter, number>> = { none: 0, pcf3x3: 3, pcf5x5: 5, pcf7x7: 7 };
export const SHADOW_ATLAS_FORMAT: GPUTextureFormat = 'depth32float';
/** Stride 的 MathUtil.ZeroTolerance。 */
const ZERO_TOLERANCE = 1e-6;

export class ShadowMapRenderer {
  /** 画阴影投射者的阶段：只有深度。 */
  readonly casterStage = new RenderStage('ShadowMapCaster', { depthFormat: SHADOW_ATLAS_FORMAT }, { shadowCasters: true });
  readonly #graphicsDevice: GraphicsDevice;
  readonly #cascades = new DirectionalShadowCascades();
  #atlas: GPUTexture | undefined;
  #receiver: ShadowReceiver | undefined;
  #warnedDepthClip = false;

  constructor(graphicsDevice: GraphicsDevice) {
    this.#graphicsDevice = graphicsDevice;
  }

  /**
   * 按剔除过的主视图算出这一帧的阴影视图，并设好 lighting.shadow；方向光不投阴影，或者主视图里什么都看不见时，
   * lighting.shadow 是 undefined，返回空数组。
   */
  collect(main: RenderView, lighting: Lighting): readonly RenderView[] {
    lighting.shadow = undefined;
    const settings = lighting.directionalShadow;
    if (!settings) return [];
    if (Math.abs(main.minimumDistance - main.maximumDistance) < ZERO_TOLERANCE) main.maximumDistance = main.minimumDistance + ZERO_TOLERANCE;
    if (!Number.isFinite(main.minimumDistance) || !Number.isFinite(main.maximumDistance)) return [];
    if (!this.#graphicsDevice.depthClipControl && !this.#warnedDepthClip) {
      this.#warnedDepthClip = true;
      console.warn('This GPU has no "depth-clip-control": shadow casters in front of a shadow cascade are clipped');
    }

    // 方向光覆盖整个画面，按长边算（Stride 的 LightDirectional.ComputeScreenCoverage）
    const factor = 2 ** (SIZE_INDEX[settings.size] - 3);
    const size = Math.min(REFERENCE_SHADOW_SIZE * factor, nextPowerOfTwo(Math.max(main.width, main.height) * factor));
    const perRow = ATLAS_SIZE / size;
    const rectangles: CascadeRectangle[] = Array.from({ length: settings.cascadeCount }, (_, i) => ({ x: (i % perRow) * size, y: Math.floor(i / perRow) * size }));
    const receiver = (this.#receiver ??= {
      atlas: this.#atlasTexture(),
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
    this.#cascades.collect(main, lighting.direction, settings, size, rectangles, ATLAS_SIZE, receiver);
    lighting.shadow = receiver;
    return this.#cascades.views.slice(0, receiver.cascadeCount);
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
      renderSystem.draw(context, pass, view, this.casterStage);
    }
    pass.end();
  }

  destroy(): void {
    this.#atlas?.destroy();
    this.#atlas = undefined;
    this.#receiver = undefined;
  }

  #atlasTexture(): GPUTexture {
    return (this.#atlas ??= this.#graphicsDevice.device.createTexture({
      label: 'Shadow map atlas',
      size: [ATLAS_SIZE, ATLAS_SIZE],
      format: SHADOW_ATLAS_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    }));
  }
}

/** 不小于 size 的 2 的幂（Stride 的 MathUtil.NextPowerOfTwo）。 */
function nextPowerOfTwo(size: number): number {
  return 2 ** Math.ceil(Math.log2(size));
}
