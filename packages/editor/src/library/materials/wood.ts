/** 木头：木纹（年轮加纤维）、木板、胶合板、竹、清漆木、风化的木头、软木。 */
import { nodeGraph, plain, type LibraryMaterial } from '../define.ts';

/** 一种有纹路的木头：木纹的两端颜色、粗糙度、年轮数；木板沿 V 方向长（UV 的 V 方向拉长）。 */
const grain = (id: string, from: readonly [number, number, number], to: readonly [number, number, number], roughness: number, rings = 8, seed = 0) => plain(id, 'wood', {
  baseColor: [1, 1, 1, 1], metalness: 0, roughness,
  graph: nodeGraph([
    ['uv', 'uv', { scale: [1, 1] }],
    ['wood', 'woodGrain', { tileable: true, rings, distortion: 1.2, fiberScale: 70, seed }, { uv: 'uv' }],
    ['ringTone', 'colorRamp', { from, to, interpolation: 'smooth' }, { t: ['wood', 'rings'] }],
    ['fiberTone', 'colorRamp', { from: [0.82, 0.82, 0.82], to: [1.12, 1.12, 1.12] }, { t: ['wood', 'fibers'] }],
    ['color', 'multiply', {}, { a: 'ringTone', b: 'fiberTone' }],
    ['normal', 'normalFromHeight', { strength: 0.6 }, { height: ['wood', 'fibers'], uv: 'uv' }],
  ], { baseColor: 'color', normal: 'normal' }),
});

export const WOOD_MATERIALS: readonly LibraryMaterial[] = [
  plain('wood', 'wood', {
    baseColor: [1, 1, 1, 1], metalness: 0, roughness: 0.6,
    graph: nodeGraph([
      ['uv', 'uv', { scale: [1, 12] }],
      ['grain', 'noise', { tileable: true, scale: 6, octaves: 5, roughness: 0.55 }, { uv: 'uv' }],
      ['color', 'colorRamp', { from: [0.18, 0.08, 0.03], to: [0.5, 0.27, 0.12] }, { t: 'grain' }],
      ['normal', 'normalFromHeight', { strength: 0.5 }, { height: 'grain', uv: 'uv' }],
    ], { baseColor: 'color', normal: 'normal' }),
  }),
  grain('oak', [0.34, 0.2, 0.09], [0.66, 0.46, 0.24], 0.55, 8, 1),
  grain('walnut', [0.05, 0.022, 0.01], [0.24, 0.12, 0.06], 0.5, 10, 3),
  grain('pine', [0.5, 0.33, 0.14], [0.82, 0.62, 0.33], 0.6, 6, 2),
  grain('cherry', [0.28, 0.08, 0.035], [0.55, 0.22, 0.1], 0.45, 9, 5),
  // 清漆的木头：同橡木，但表面亮得多（清漆层把粗糙度压下去）
  plain('varnishedOak', 'wood', {
    baseColor: [1, 1, 1, 1], metalness: 0, roughness: 0.18,
    graph: nodeGraph([
      ['uv', 'uv'],
      ['wood', 'woodGrain', { tileable: true, rings: 9, distortion: 1.2, fiberScale: 70, seed: 4 }, { uv: 'uv' }],
      ['ringTone', 'colorRamp', { from: [0.3, 0.14, 0.05], to: [0.62, 0.36, 0.15], interpolation: 'smooth' }, { t: ['wood', 'rings'] }],
      ['color', 'multiply', {}, { a: 'ringTone', b: ['wood', 'fibers'] }],
    ], { baseColor: 'color' }),
  }),
  // 木地板：一条条的板，错开半块，每块木纹和色调不同
  plain('woodPlanks', 'wood', {
    baseColor: [1, 1, 1, 1], metalness: 0, roughness: 0.5,
    graph: nodeGraph([
      ['uv', 'uv'],
      ['planks', 'bricks', { columns: 1, rows: 8, mortar: 0.004, shift: 0 }, { uv: 'uv' }],
      ['wood', 'woodGrain', { tileable: true, rings: 12, distortion: 1.4, fiberScale: 70, seed: 2 }, { uv: 'uv' }],
      ['ringTone', 'colorRamp', { from: [0.3, 0.17, 0.07], to: [0.62, 0.4, 0.2] }, { t: ['wood', 'rings'] }],
      ['plank', 'colorRamp', { from: [0.78, 0.78, 0.78], to: [1.15, 1.1, 1.05] }, { t: ['planks', 'brick'] }],
      ['surface', 'multiply', {}, { a: 'ringTone', b: 'plank' }],
      ['gap', 'color', { color: [0.02, 0.012, 0.008] }],
      ['color', 'mix', {}, { a: 'gap', b: 'surface', t: ['planks', 'mask'] }],
      ['normal', 'normalFromHeight', { strength: 1 }, { height: ['planks', 'mask'], uv: 'uv' }],
    ], { baseColor: 'color', normal: 'normal' }),
  }),
  // 胶合板：侧面一层层的单板，表面浅黄的细纹
  plain('plywood', 'wood', {
    baseColor: [1, 1, 1, 1], metalness: 0, roughness: 0.6,
    graph: nodeGraph([
      ['uv', 'uv'],
      ['wood', 'woodGrain', { tileable: true, rings: 4, distortion: 2, fiberScale: 90, seed: 8 }, { uv: 'uv' }],
      ['tone', 'colorRamp', { from: [0.55, 0.38, 0.18], to: [0.78, 0.6, 0.35] }, { t: ['wood', 'rings'] }],
      ['color', 'multiply', {}, { a: 'tone', b: ['wood', 'fibers'] }],
    ], { baseColor: 'color' }),
  }),
  // 竹：竖直的纤维，一节一节的
  plain('bamboo', 'wood', {
    baseColor: [1, 1, 1, 1], metalness: 0, roughness: 0.4,
    graph: nodeGraph([
      ['uv', 'uv'],
      ['strands', 'uv', { scale: [1, 0.05] }],
      ['strand', 'noise', { tileable: true, scale: 80, octaves: 3, seed: 2 }, { uv: 'strands' }],
      ['nodes', 'wave', { frequency: 3, angle: 90, shape: 'triangle' }, { uv: 'uv' }],
      ['ring', 'levels', { inMin: 0.9, inMax: 1 }, { in: 'nodes' }],
      ['tone', 'colorRamp', { from: [0.45, 0.4, 0.12], to: [0.72, 0.66, 0.28] }, { t: 'strand' }],
      ['knot', 'color', { color: [0.28, 0.22, 0.06] }],
      ['color', 'mix', {}, { a: 'tone', b: 'knot', t: 'ring' }],
      ['normal', 'normalFromHeight', { strength: 0.8 }, { height: 'strand', uv: 'strands' }],
    ], { baseColor: 'color', normal: 'normal' }),
  }),
  // 风化的木头：晒得发灰，纹理被雨水冲出沟
  plain('weatheredWood', 'wood', {
    baseColor: [1, 1, 1, 1], metalness: 0, roughness: 0.92,
    graph: nodeGraph([
      ['uv', 'uv'],
      ['wood', 'woodGrain', { tileable: true, rings: 7, distortion: 1.6, fiberScale: 50, seed: 6 }, { uv: 'uv' }],
      ['gray', 'colorRamp', { from: [0.1, 0.09, 0.08], to: [0.38, 0.34, 0.3] }, { t: ['wood', 'fibers'] }],
      ['ring', 'colorRamp', { from: [0.8, 0.78, 0.76], to: [1.05, 1.03, 1] }, { t: ['wood', 'rings'] }],
      ['color', 'multiply', {}, { a: 'gray', b: 'ring' }],
      ['checks', 'cracks', { tileable: true, scale: 6, width: 0.01, warp: 0.4, seed: 3 }, { uv: 'uv' }],
      ['relief', 'subtract', {}, { a: ['wood', 'fibers'], b: ['checks', 'mask'] }],
      ['normal', 'normalFromHeight', { strength: 2 }, { height: 'relief', uv: 'uv' }],
    ], { baseColor: 'color', normal: 'normal' }),
  }),
  // 软木：褐色的小颗粒
  plain('cork', 'wood', {
    baseColor: [1, 1, 1, 1], metalness: 0, roughness: 0.9,
    graph: nodeGraph([
      ['uv', 'uv'],
      ['granules', 'voronoi', { tileable: true, scale: 40, randomness: 1 }, { uv: 'uv' }],
      ['tone', 'colorRamp', { from: [0.22, 0.1, 0.03], to: [0.55, 0.33, 0.13] }, { t: ['granules', 'cell'] }],
      ['seam', 'levels', { inMin: 0, inMax: 0.06 }, { in: ['granules', 'edge'] }],
      ['dark', 'color', { color: [0.06, 0.03, 0.012] }],
      ['color', 'mix', {}, { a: 'dark', b: 'tone', t: 'seam' }],
      ['normal', 'normalFromHeight', { strength: 2 }, { height: 'seam', uv: 'uv' }],
    ], { baseColor: 'color', normal: 'normal' }),
  }),
];
