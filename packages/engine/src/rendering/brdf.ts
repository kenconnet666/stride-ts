/** 着色、环境 BRDF 查找表和天空盒预滤波共用的 WGSL 片段。 */

/** BRDF 的几个函数，同 Stride 的 BRDFMicrofacet.sdsl。 */
export const BRDF = /* wgsl */ `
const PI = 3.14159265358979;

fn normalDistributionGGX(alphaR: f32, nDotH: f32) -> f32 {
  let alphaR2 = alphaR * alphaR;
  let d = max(nDotH * nDotH * (alphaR2 - 1.0) + 1.0, 0.0001);
  return alphaR2 / (PI * d * d);
}

fn visibilitySchlickGGX(alphaR: f32, nDotX: f32) -> f32 {
  let k = alphaR * 0.5;
  return nDotX / (nDotX * (1.0 - k) + k);
}

/** Smith-Schlick-GGX，已经除以 N·L · N·V。 */
fn visibilitySmithSchlickGGX(alphaR: f32, nDotL: f32, nDotV: f32) -> f32 {
  return visibilitySchlickGGX(alphaR, nDotL) * visibilitySchlickGGX(alphaR, nDotV) / (nDotL * nDotV);
}`;
