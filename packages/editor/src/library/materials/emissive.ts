/** 发光：霓虹、灯泡、LED、熔岩、烧红的铁（自发光是线性颜色乘强度，超过 1 的会被泛光拉出光晕）。 */
import { nodeGraph, plain, type LibraryMaterial } from '../define.ts';

const neon = (id: string, emissive: readonly [number, number, number]) => plain(id, 'emissive', { baseColor: [0.02, 0.02, 0.02, 1], metalness: 0, roughness: 0.4, emissive });

export const EMISSIVE_MATERIALS: readonly LibraryMaterial[] = [
  plain('neonCyan', 'emissive', { baseColor: [0.02, 0.02, 0.02, 1], metalness: 0, roughness: 0.4, emissive: [0.2, 5, 6] }),
  plain('neonMagenta', 'emissive', { baseColor: [0.02, 0.02, 0.02, 1], metalness: 0, roughness: 0.4, emissive: [6, 0.3, 4] }),
  neon('neonWarm', [6, 1.6, 0.2]),
  neon('neonGreen', [0.3, 6, 0.6]),
  neon('neonRed', [7, 0.15, 0.1]),
  // LED 面板：白色的、很亮
  plain('ledWhite', 'emissive', { baseColor: [0.6, 0.6, 0.6, 1], metalness: 0, roughness: 0.3, emissive: [5, 5, 5] }),
  // 钨丝灯泡：暖白
  plain('warmBulb', 'emissive', { baseColor: [0.3, 0.3, 0.3, 1], metalness: 0, roughness: 0.2, emissive: [9, 4.4, 1.6] }),
  // 熔岩：黑的壳，裂缝里透出橙黄的光
  plain('lava', 'emissive', {
    baseColor: [1, 1, 1, 1], metalness: 0, roughness: 0.85,
    graph: nodeGraph([
      ['uv', 'uv'],
      ['cracks', 'cracks', { tileable: true, scale: 4, width: 0.07, warp: 1, seed: 2 }, { uv: 'uv' }],
      ['grain', 'noise', { tileable: true, scale: 30, octaves: 5, roughness: 0.6 }, { uv: 'uv' }],
      ['crust', 'colorRamp', { from: [0.01, 0.008, 0.008], to: [0.06, 0.05, 0.05] }, { t: 'grain' }],
      ['glowTone', 'colorRamp', { from: [3, 0.5, 0.05], to: [8, 3.5, 0.6] }, { t: 'grain' }],
      ['glow', 'multiply', {}, { a: 'glowTone', b: ['cracks', 'mask'] }],
      ['normal', 'normalFromHeight', { strength: 2 }, { height: ['cracks', 'height'], uv: 'uv' }],
    ], { baseColor: 'crust', emissive: 'glow', normal: 'normal' }),
  }),
  // 烧红的铁：不均匀的暗红到橙黄
  plain('hotMetal', 'emissive', {
    baseColor: [1, 1, 1, 1], metalness: 0.6, roughness: 0.6,
    graph: nodeGraph([
      ['uv', 'uv'],
      ['heat', 'noise', { tileable: true, scale: 4, octaves: 5, roughness: 0.6, seed: 6 }, { uv: 'uv' }],
      ['fine', 'noise', { tileable: true, scale: 40, octaves: 4 }, { uv: 'uv' }],
      ['metal', 'colorRamp', { from: [0.08, 0.07, 0.07], to: [0.2, 0.18, 0.17] }, { t: 'fine' }],
      ['glow', 'colorRamp', { from: [0.2, 0.01, 0], to: [6, 1.6, 0.15] }, { t: 'heat' }],
    ], { baseColor: 'metal', emissive: 'glow' }),
  }),
];
