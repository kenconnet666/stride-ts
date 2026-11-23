/** 织物和皮革：编织（经线纬线交错，每根线颜色略不同）、绒面、皮革的颗粒。光泽 sheen 给布料边缘的柔光，各向异性给丝绸的高光。 */
import { nodeGraph, plain, type LibraryMaterial } from '../define.ts';

/** 编织的布：两端的颜色、线数、编法、粗糙度、光泽色、法线强度。 */
const woven = (id: string, from: readonly [number, number, number], to: readonly [number, number, number], count: number, pattern: 'plain' | 'twill' | 'basket', roughness: number, sheen: readonly [number, number, number], strength = 1.5) => plain(id, 'fabric', {
  baseColor: [1, 1, 1, 1], metalness: 0, roughness, sheen: { color: sheen, roughness: 0.5 },
  graph: nodeGraph([
    ['uv', 'uv'],
    ['cloth', 'weave', { count: [count, count], pattern }, { uv: 'uv' }],
    ['thread', 'colorRamp', { from, to }, { t: ['cloth', 'thread'] }],
    ['fuzz', 'noise', { scale: count * 4, octaves: 3 }, { uv: 'uv' }],
    ['tint', 'colorRamp', { from: [0.88, 0.88, 0.88], to: [1.08, 1.08, 1.08] }, { t: 'fuzz' }],
    ['color', 'multiply', {}, { a: 'thread', b: 'tint' }],
    ['normal', 'normalFromHeight', { strength }, { height: ['cloth', 'height'], uv: 'uv' }],
  ], { baseColor: 'color', normal: 'normal' }),
});

/** 皮革：颗粒是 Voronoi 的格子（缝里是细沟），颜色两端、粗糙度。 */
const leather = (id: string, from: readonly [number, number, number], to: readonly [number, number, number], roughness: number) => plain(id, 'fabric', {
  baseColor: [1, 1, 1, 1], metalness: 0, roughness,
  graph: nodeGraph([
    ['uv', 'uv'],
    ['pebble', 'voronoi', { scale: 55, randomness: 0.9 }, { uv: 'uv' }],
    ['dome', 'levels', { inMin: 0, inMax: 0.2 }, { in: ['pebble', 'edge'] }],
    ['wear', 'noise', { scale: 6, octaves: 4, seed: 2 }, { uv: 'uv' }],
    ['tone', 'colorRamp', { from, to }, { t: 'wear' }],
    ['crease', 'colorRamp', { from: [0.5, 0.5, 0.5], to: [1, 1, 1] }, { t: 'dome' }],
    ['color', 'multiply', {}, { a: 'tone', b: 'crease' }],
    ['normal', 'normalFromHeight', { strength: 2.5 }, { height: 'dome', uv: 'uv' }],
  ], { baseColor: 'color', normal: 'normal' }),
});

export const FABRIC_MATERIALS: readonly LibraryMaterial[] = [
  plain('fabric', 'fabric', {
    baseColor: [1, 1, 1, 1], metalness: 0, roughness: 0.9, sheen: { color: [0.4, 0.45, 0.6], roughness: 0.5 },
    graph: nodeGraph([
      ['uv', 'uv'],
      ['weave', 'checker', { scale: 24 }, { uv: 'uv' }],
      ['fibers', 'noise', { scale: 30, octaves: 3 }, { uv: 'uv' }],
      ['color', 'colorRamp', { from: [0.1, 0.13, 0.3], to: [0.16, 0.2, 0.42] }, { t: 'fibers' }],
      ['normal', 'normalFromHeight', { strength: 0.3 }, { height: 'weave', uv: 'uv' }],
    ], { baseColor: 'color', normal: 'normal' }),
  }),
  // 牛仔布：蓝色的经线、白色的纬线，斜纹
  plain('denim', 'fabric', {
    baseColor: [1, 1, 1, 1], metalness: 0, roughness: 0.92, sheen: { color: [0.1, 0.12, 0.2], roughness: 0.6 },
    graph: nodeGraph([
      ['uv', 'uv'],
      ['cloth', 'weave', { count: [60, 60], pattern: 'twill' }, { uv: 'uv' }],
      ['indigo', 'color', { color: [0.025, 0.06, 0.18] }],
      ['weft', 'color', { color: [0.4, 0.45, 0.55] }],
      ['yarn', 'mix', {}, { a: 'weft', b: 'indigo', t: ['cloth', 'warp'] }],
      ['fade', 'noise', { scale: 5, octaves: 4, seed: 3 }, { uv: 'uv' }],
      ['wash', 'colorRamp', { from: [0.7, 0.75, 0.85], to: [1.5, 1.5, 1.5] }, { t: 'fade' }],
      ['color', 'multiply', {}, { a: 'yarn', b: 'wash' }],
      ['normal', 'normalFromHeight', { strength: 2 }, { height: ['cloth', 'height'], uv: 'uv' }],
    ], { baseColor: 'color', normal: 'normal' }),
  }),
  woven('linen', [0.5, 0.42, 0.28], [0.72, 0.64, 0.48], 40, 'plain', 0.95, [0.3, 0.27, 0.2], 2),
  woven('canvas', [0.28, 0.25, 0.16], [0.42, 0.38, 0.26], 70, 'plain', 0.95, [0.2, 0.18, 0.13], 1.5),
  // 麻袋布：粗的线、稀的织法
  woven('burlap', [0.22, 0.13, 0.055], [0.46, 0.3, 0.14], 18, 'plain', 1, [0.25, 0.17, 0.08], 3),
  // 地毯：短绒，很粗糙，满是细的绒
  plain('carpet', 'fabric', {
    baseColor: [1, 1, 1, 1], metalness: 0, roughness: 1, sheen: { color: [0.3, 0.3, 0.35], roughness: 0.8 },
    graph: nodeGraph([
      ['uv', 'uv'],
      ['pile', 'noise', { scale: 200, octaves: 3, roughness: 0.7 }, { uv: 'uv' }],
      ['tone', 'colorRamp', { from: [0.05, 0.06, 0.09], to: [0.14, 0.16, 0.22] }, { t: 'pile' }],
      ['patch', 'noise', { scale: 4, octaves: 3, seed: 5 }, { uv: 'uv' }],
      ['wear', 'colorRamp', { from: [1.2, 1.2, 1.2], to: [0.85, 0.85, 0.85] }, { t: 'patch' }],
      ['color', 'multiply', {}, { a: 'tone', b: 'wear' }],
      ['normal', 'normalFromHeight', { strength: 1.5 }, { height: 'pile', uv: 'uv' }],
    ], { baseColor: 'color', normal: 'normal' }),
  }),
  // 天鹅绒：深红，边缘（掠射角）泛亮的光泽
  plain('velvet', 'fabric', {
    baseColor: [0.2, 0.012, 0.025, 1], metalness: 0, roughness: 1, sheen: { color: [0.95, 0.3, 0.38], roughness: 0.35 },
  }),
  // 绸缎：高光沿纤维拉长（各向异性），柔滑
  plain('silk', 'fabric', {
    baseColor: [0.55, 0.03, 0.08, 1], metalness: 0, roughness: 0.3, anisotropy: { strength: 0.7 }, sheen: { color: [0.5, 0.12, 0.15], roughness: 0.3 },
  }),
  // 绒面革：软、哑，柔光很强
  plain('suede', 'fabric', {
    baseColor: [0.2, 0.1, 0.05, 1], metalness: 0, roughness: 0.98, sheen: { color: [0.5, 0.3, 0.2], roughness: 0.55 },
  }),
  leather('leather', [0.1, 0.045, 0.02], [0.24, 0.11, 0.05], 0.5),
  leather('blackLeather', [0.012, 0.012, 0.012], [0.04, 0.04, 0.04], 0.42),
  leather('tanLeather', [0.28, 0.14, 0.06], [0.5, 0.28, 0.12], 0.55),
];
