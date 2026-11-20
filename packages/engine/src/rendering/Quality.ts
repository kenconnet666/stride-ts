/**
 * 画质档位（虚幻的 Scalability 那样）：低、中、高、极高四档，每档是一组上限——内容（场景里的光、合成器的后处理设置）
 * 要的效果不超过这一档给的。极高是"照内容写的画"，也是默认；往下各档只会关掉、降低，不会打开内容没要的东西。
 *
 *   game.graphicsCompositor.quality = QUALITY_TIERS.medium;
 *
 * 同一个游戏靠它在笔记本和台式机上都跑得动（docs/roadmap.md 第二节）。分辨率不在档位里：上采样和动态分辨率是玩家另外的
 * 选项，不拿它当性能优化。以后的效果（TAA、GTAO、SSR、体积雾……）各自在这里加自己的上限。
 */
import type { ShadowMapFilter, ShadowMapSize } from './RenderSystem';

export type QualityTier = 'low' | 'medium' | 'high' | 'ultra';

export interface QualitySettings {
  /** 画不画阴影。 */
  readonly shadows: boolean;
  /** 每块阴影图最大到哪一档。 */
  readonly shadowSize: ShadowMapSize;
  /** 阴影的滤波最多到哪一档。 */
  readonly shadowFilter: ShadowMapFilter;
  /** 方向光最多几个级联。 */
  readonly shadowCascades: 1 | 2 | 4;
  /** 抗锯齿（FXAA 或 TAA）。 */
  readonly antialiasing: boolean;
  /** 屏幕空间的环境光遮蔽（GTAO）。 */
  readonly ambientOcclusion: boolean;
  /** 屏幕空间反射。 */
  readonly screenSpaceReflections: boolean;
  /** 接触阴影（屏幕空间的阴影，开着时才算）。 */
  readonly contactShadows: boolean;
  /** 运动模糊（开着时才算）。 */
  readonly motionBlur: boolean;
  readonly bloom: boolean;
  readonly lightStreak: boolean;
  readonly lensFlare: boolean;
}

/**
 * 各档给什么（自己定的，Stride 没有档位）：
 * - 极高：不设上限；
 * - 高：阴影图到 large（每块 1024，极高的 xlarge 是 2048，图集小到四分之一）、滤波到 5x5；
 * - 中：阴影图到 medium、3x3、两个级联；光芒和镜头光晕关掉（各要好几遍全屏的通道）；
 * - 低：阴影图到 small、一个级联；泛光、环境光遮蔽也关掉。抗锯齿留着：一遍全屏，比它省下的锯齿便宜。
 */
export const QUALITY_TIERS: Readonly<Record<QualityTier, QualitySettings>> = {
  low: { shadows: true, shadowSize: 'small', shadowFilter: 'pcf3x3', shadowCascades: 1, antialiasing: true, ambientOcclusion: false, screenSpaceReflections: false, contactShadows: false, motionBlur: false, bloom: false, lightStreak: false, lensFlare: false },
  medium: { shadows: true, shadowSize: 'medium', shadowFilter: 'pcf3x3', shadowCascades: 2, antialiasing: true, ambientOcclusion: true, screenSpaceReflections: false, contactShadows: false, motionBlur: false, bloom: true, lightStreak: false, lensFlare: false },
  high: { shadows: true, shadowSize: 'large', shadowFilter: 'pcf5x5', shadowCascades: 4, antialiasing: true, ambientOcclusion: true, screenSpaceReflections: true, contactShadows: true, motionBlur: true, bloom: true, lightStreak: true, lensFlare: true },
  ultra: { shadows: true, shadowSize: 'xlarge', shadowFilter: 'pcf7x7', shadowCascades: 4, antialiasing: true, ambientOcclusion: true, screenSpaceReflections: true, contactShadows: true, motionBlur: true, bloom: true, lightStreak: true, lensFlare: true },
};

const SIZES: readonly ShadowMapSize[] = ['xsmall', 'small', 'medium', 'large', 'xlarge'];
const FILTERS: readonly ShadowMapFilter[] = ['none', 'pcf3x3', 'pcf5x5', 'pcf7x7'];

/** 内容要的阴影图大小，不超过这一档的上限。 */
export const limitShadowSize = (wanted: ShadowMapSize, { shadowSize }: QualitySettings): ShadowMapSize =>
  SIZES[Math.min(SIZES.indexOf(wanted), SIZES.indexOf(shadowSize))]!;

/** 内容要的阴影滤波，不超过这一档的上限。 */
export const limitShadowFilter = (wanted: ShadowMapFilter, { shadowFilter }: QualitySettings): ShadowMapFilter =>
  FILTERS[Math.min(FILTERS.indexOf(wanted), FILTERS.indexOf(shadowFilter))]!;

/** 内容要的级联数，不超过这一档的上限。 */
export const limitShadowCascades = (wanted: 1 | 2 | 4, { shadowCascades }: QualitySettings): 1 | 2 | 4 => (wanted < shadowCascades ? wanted : shadowCascades);
