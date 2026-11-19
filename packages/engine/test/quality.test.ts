import { describe, expect, test } from 'vitest';
import { limitShadowCascades, limitShadowFilter, limitShadowSize, QUALITY_TIERS, type QualityTier } from '../src/rendering/Quality';

describe('画质档位（Quality）', () => {
  test('档位是上限：内容要的不超过它，内容要得少的照内容', () => {
    const { low, medium, ultra } = QUALITY_TIERS;
    expect([limitShadowSize('xlarge', medium), limitShadowSize('xsmall', medium), limitShadowSize('large', ultra)]).toEqual(['medium', 'xsmall', 'large']);
    expect([limitShadowFilter('pcf7x7', low), limitShadowFilter('none', low), limitShadowFilter('pcf5x5', ultra)]).toEqual(['pcf3x3', 'none', 'pcf5x5']);
    expect([limitShadowCascades(4, low), limitShadowCascades(4, medium), limitShadowCascades(1, medium), limitShadowCascades(4, ultra)]).toEqual([1, 2, 1, 4]);
  });

  test('往下每一档都不比上一档多：极高不设限，低档关掉的东西中档以上才有', () => {
    const order: QualityTier[] = ['low', 'medium', 'high', 'ultra'];
    for (let i = 1; i < order.length; i++) {
      const lower = QUALITY_TIERS[order[i - 1]!], higher = QUALITY_TIERS[order[i]!];
      // 在高一档的上限里再套低一档的上限，结果还是低一档的：低档的每一项都不超过高档
      expect([limitShadowSize(lower.shadowSize, higher), limitShadowFilter(lower.shadowFilter, higher), limitShadowCascades(lower.shadowCascades, higher)])
        .toEqual([lower.shadowSize, lower.shadowFilter, lower.shadowCascades]);
      for (const effect of ['shadows', 'antialiasing', 'bloom', 'lightStreak', 'lensFlare'] as const) expect([order[i], effect, lower[effect] && !higher[effect]]).toEqual([order[i], effect, false]);
    }
    expect([limitShadowSize('xlarge', QUALITY_TIERS.ultra), limitShadowFilter('pcf7x7', QUALITY_TIERS.ultra), limitShadowCascades(4, QUALITY_TIERS.ultra)]).toEqual(['xlarge', 'pcf7x7', 4]);
  });
});
