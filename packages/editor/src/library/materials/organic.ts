/** 有机的：树皮、叶子（背光透光）、青苔、皮肤（次表面散射）、蜡、果皮、蛋壳、骨头。 */
import { nodeGraph, plain, type LibraryMaterial } from '../define.ts';

/** 叶子：基础色两端、透过去的颜色；叶脉是 UV 里一条中脉加斜着的侧脉（波）。 */
const leaf = (id: string, from: readonly [number, number, number], to: readonly [number, number, number], through: readonly [number, number, number]) => plain(id, 'organic', {
  baseColor: [1, 1, 1, 1], metalness: 0, roughness: 0.5, sheen: { color: [0.15, 0.2, 0.08], roughness: 0.5 }, diffuseTransmission: { factor: 0.45, color: through },
  graph: nodeGraph([
    ['uv', 'uv'],
    ['blotch', 'noise', { scale: 6, octaves: 4, seed: 2 }, { uv: 'uv' }],
    ['blade', 'colorRamp', { from, to }, { t: 'blotch' }],
    ['midrib', 'wave', { frequency: 1, angle: 0, shape: 'triangle' }, { uv: 'uv' }],
    ['rib', 'levels', { inMin: 0.94, inMax: 1 }, { in: 'midrib' }],
    ['side', 'uvTransform', { scale: [1, 1], rotation: 55 }, { uv: 'uv' }],
    ['lateral', 'wave', { frequency: 14, angle: 0, shape: 'triangle' }, { uv: 'side' }],
    ['vein', 'levels', { inMin: 0.9, inMax: 1 }, { in: 'lateral' }],
    ['veins', 'add', {}, { a: 'rib', b: 'vein' }],
    ['pale', 'color', { color: [0.5, 0.62, 0.2] }],
    ['color', 'mix', {}, { a: 'blade', b: 'pale', t: 'veins' }],
    ['normal', 'normalFromHeight', { strength: 1 }, { height: 'veins', uv: 'uv' }],
  ], { baseColor: 'color', normal: 'normal' }),
});

export const ORGANIC_MATERIALS: readonly LibraryMaterial[] = [
  leaf('leaf', [0.03, 0.12, 0.015], [0.1, 0.28, 0.04], [0.35, 0.8, 0.12]),
  leaf('autumnLeaf', [0.28, 0.07, 0.01], [0.65, 0.3, 0.03], [0.9, 0.5, 0.1]),
  // 树皮：竖着的深沟（脊状噪声）和块
  plain('bark', 'organic', {
    baseColor: [1, 1, 1, 1], metalness: 0, roughness: 0.95,
    graph: nodeGraph([
      ['uv', 'uv', { scale: [5, 1] }],
      ['furrows', 'noise', { scale: 5, octaves: 6, roughness: 0.6, ridged: 0.9, seed: 3 }, { uv: 'uv' }],
      ['grain', 'noise', { scale: 40, octaves: 4 }, { uv: 'uv' }],
      ['tone', 'colorRamp', { from: [0.025, 0.018, 0.012], to: [0.26, 0.19, 0.13] }, { t: 'furrows' }],
      ['fine', 'colorRamp', { from: [0.85, 0.85, 0.85], to: [1.1, 1.1, 1.1] }, { t: 'grain' }],
      ['color', 'multiply', {}, { a: 'tone', b: 'fine' }],
      ['relief', 'add', {}, { a: 'furrows', b: 'furrows' }],
      ['normal', 'normalFromHeight', { strength: 3.5 }, { height: 'relief', uv: 'uv' }],
    ], { baseColor: 'color', normal: 'normal' }),
  }),
  // 青苔：一团团短绒，湿润的绿，边缘泛光
  plain('moss', 'organic', {
    baseColor: [1, 1, 1, 1], metalness: 0, roughness: 1, sheen: { color: [0.2, 0.3, 0.1], roughness: 0.7 },
    graph: nodeGraph([
      ['uv', 'uv'],
      ['clumps', 'noise', { scale: 12, octaves: 5, roughness: 0.65, seed: 5 }, { uv: 'uv' }],
      ['fuzz', 'noise', { scale: 150, octaves: 3 }, { uv: 'uv' }],
      ['tone', 'colorRamp', { from: [0.025, 0.07, 0.01], to: [0.14, 0.26, 0.04] }, { t: 'clumps' }],
      ['tips', 'colorRamp', { from: [0.85, 0.85, 0.85], to: [1.2, 1.2, 1.1] }, { t: 'fuzz' }],
      ['color', 'multiply', {}, { a: 'tone', b: 'tips' }],
      ['normal', 'normalFromHeight', { strength: 2 }, { height: 'clumps', uv: 'uv' }],
    ], { baseColor: 'color', normal: 'normal' }),
  }),
  // 皮肤：次表面散射（Stride 的皮肤默认值），油光的高光，毛孔
  plain('skin', 'organic', {
    baseColor: [1, 1, 1, 1], metalness: 0, roughness: 0.45, subsurfaceScattering: { width: 0.015, translucency: 0.83, strength: [0.48, 0.41, 0.28], falloff: [1, 0.37, 0.3] },
    graph: nodeGraph([
      ['uv', 'uv'],
      ['pores', 'voronoi', { scale: 140, randomness: 1 }, { uv: 'uv' }],
      ['flush', 'noise', { scale: 5, octaves: 4, seed: 3 }, { uv: 'uv' }],
      ['tone', 'colorRamp', { from: [0.5, 0.28, 0.2], to: [0.7, 0.45, 0.35] }, { t: 'flush' }],
      ['pore', 'colorRamp', { from: [0.8, 0.7, 0.68], to: [1, 1, 1] }, { t: ['pores', 'distance'] }],
      ['color', 'multiply', {}, { a: 'tone', b: 'pore' }],
      ['normal', 'normalFromHeight', { strength: 0.6 }, { height: ['pores', 'distance'], uv: 'uv' }],
    ], { baseColor: 'color', normal: 'normal' }),
  }),
  // 蜡：乳黄、半透明，一点点透光，光滑
  plain('wax', 'organic', {
    baseColor: [0.85, 0.78, 0.55, 1], metalness: 0, roughness: 0.4, diffuseTransmission: { factor: 0.5, color: [1, 0.8, 0.4] },
  }),
  // 橙子皮：橙色，满是凹下去的油胞
  plain('orangePeel', 'organic', {
    baseColor: [1, 1, 1, 1], metalness: 0, roughness: 0.4,
    graph: nodeGraph([
      ['uv', 'uv'],
      ['glands', 'voronoi', { scale: 60, randomness: 1 }, { uv: 'uv' }],
      ['rind', 'colorRamp', { from: [0.55, 0.12, 0.005], to: [0.85, 0.28, 0.01] }, { t: ['glands', 'distance'] }],
      ['normal', 'normalFromHeight', { strength: 2 }, { height: ['glands', 'distance'], uv: 'uv' }],
    ], { baseColor: 'rind', normal: 'normal' }),
  }),
  // 蛋壳：米白、有细小的斑点和微微的颗粒
  plain('eggshell', 'organic', {
    baseColor: [1, 1, 1, 1], metalness: 0, roughness: 0.55,
    graph: nodeGraph([
      ['uv', 'uv'],
      ['grain', 'noise', { scale: 120, octaves: 3 }, { uv: 'uv' }],
      ['tone', 'colorRamp', { from: [0.6, 0.5, 0.36], to: [0.8, 0.7, 0.55] }, { t: 'grain' }],
      ['freckles', 'spots', { scale: 40, size: 0.3, variation: 0.9, density: 0.25, seed: 4 }, { uv: 'uv' }],
      ['brown', 'color', { color: [0.3, 0.17, 0.08] }],
      ['color', 'mix', {}, { a: 'tone', b: 'brown', t: ['freckles', 'mask'] }],
      ['normal', 'normalFromHeight', { strength: 0.5 }, { height: 'grain', uv: 'uv' }],
    ], { baseColor: 'color', normal: 'normal' }),
  }),
  // 骨头：象牙白，细的纵向纹，一点点透光
  plain('bone', 'organic', {
    baseColor: [1, 1, 1, 1], metalness: 0, roughness: 0.5, diffuseTransmission: { factor: 0.15, color: [1, 0.85, 0.7] },
    graph: nodeGraph([
      ['uv', 'uv', { scale: [4, 1] }],
      ['fibers', 'noise', { scale: 40, octaves: 4, seed: 2 }, { uv: 'uv' }],
      ['tone', 'colorRamp', { from: [0.5, 0.42, 0.3], to: [0.78, 0.72, 0.6] }, { t: 'fibers' }],
      ['normal', 'normalFromHeight', { strength: 0.7 }, { height: 'fibers', uv: 'uv' }],
    ], { baseColor: 'tone', normal: 'normal' }),
  }),
];
