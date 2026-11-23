/** 石头：方石板、大理石，花岗岩、板岩、砂岩、石灰岩、水磨石、鹅卵石、岩壁。 */
import { nodeGraph, plain, type LibraryMaterial } from '../define.ts';

export const STONE_MATERIALS: readonly LibraryMaterial[] = [
  // 方石板：不错缝的砖（每块一个色调）加表面的细噪声
  plain('stoneTiles', 'stone', {
    baseColor: [1, 1, 1, 1], metalness: 0, roughness: 0.7,
    graph: nodeGraph([
      ['uv', 'uv'],
      ['tiles', 'bricks', { columns: 12, rows: 6, mortar: 0.015, shift: 0 }, { uv: 'uv' }],
      ['tone', 'colorRamp', { from: [0.36, 0.35, 0.33], to: [0.6, 0.58, 0.54] }, { t: ['tiles', 'brick'] }],
      ['grain', 'noise', { tileable: true, scale: 48, octaves: 4 }, { uv: 'uv' }],
      ['speckle', 'colorRamp', { from: [0.85, 0.85, 0.85], to: [1.05, 1.05, 1.05] }, { t: 'grain' }],
      ['surface', 'multiply', {}, { a: 'tone', b: 'speckle' }],
      ['joint', 'color', { color: [0.2, 0.19, 0.18] }],
      ['color', 'mix', {}, { a: 'joint', b: 'surface', t: ['tiles', 'mask'] }],
      ['normal', 'normalFromHeight', { strength: 1.5 }, { height: ['tiles', 'mask'], uv: 'uv' }],
    ], { baseColor: 'color', normal: 'normal' }),
  }),
  plain('marble', 'stone', {
    baseColor: [1, 1, 1, 1], metalness: 0, roughness: 0.15,
    graph: nodeGraph([
      ['uv', 'uv'],
      ['veins', 'noise', { tileable: true, scale: 4, octaves: 7, roughness: 0.6, seed: 2 }, { uv: 'uv' }],
      // 纹路是噪声等于 0.5 的那条线：往上一段从 0 升到 1、往下一段从 1 降到 0，乘起来只在 0.5 附近是 1
      ['rise', 'levels', { inMin: 0.46, inMax: 0.5 }, { in: 'veins' }],
      ['fall', 'levels', { inMin: 0.5, inMax: 0.54, outMin: 1, outMax: 0 }, { in: 'veins' }],
      ['vein', 'multiply', {}, { a: 'rise', b: 'fall' }],
      ['color', 'colorRamp', { from: [0.93, 0.92, 0.89], to: [0.35, 0.35, 0.38] }, { t: 'vein' }],
    ], { baseColor: 'color' }),
  }),
  // 黑金花大理石：黑底、金白的纹
  plain('blackMarble', 'stone', {
    baseColor: [1, 1, 1, 1], metalness: 0, roughness: 0.12,
    graph: nodeGraph([
      ['uv', 'uv'],
      ['veins', 'noise', { tileable: true, scale: 3, octaves: 7, roughness: 0.6, seed: 8, ridged: 0 }, { uv: 'uv' }],
      ['rise', 'levels', { inMin: 0.47, inMax: 0.5 }, { in: 'veins' }],
      ['fall', 'levels', { inMin: 0.5, inMax: 0.53, outMin: 1, outMax: 0 }, { in: 'veins' }],
      ['vein', 'multiply', {}, { a: 'rise', b: 'fall' }],
      ['cloud', 'noise', { tileable: true, scale: 8, octaves: 4, seed: 1 }, { uv: 'uv' }],
      ['base', 'colorRamp', { from: [0.006, 0.006, 0.007], to: [0.03, 0.03, 0.033] }, { t: 'cloud' }],
      ['gold', 'color', { color: [0.7, 0.55, 0.3] }],
      ['color', 'mix', {}, { a: 'base', b: 'gold', t: 'vein' }],
    ], { baseColor: 'color' }),
  }),
  // 花岗岩：灰底、黑白粉的小晶粒，抛光的
  plain('granite', 'stone', {
    baseColor: [1, 1, 1, 1], metalness: 0, roughness: 0.22,
    graph: nodeGraph([
      ['uv', 'uv'],
      ['base', 'noise', { tileable: true, scale: 20, octaves: 4 }, { uv: 'uv' }],
      ['ground', 'colorRamp', { from: [0.1, 0.095, 0.095], to: [0.22, 0.2, 0.2] }, { t: 'base' }],
      ['grains', 'spots', { tileable: true, scale: 60, size: 0.7, variation: 0.8, density: 0.85 }, { uv: 'uv' }],
      ['mineral', 'colorRamp', {
        from: [0.02, 0.02, 0.02], to: [0.85, 0.8, 0.78],
        colorStops: [{ position: 0.4, color: [0.55, 0.25, 0.22] }, { position: 0.7, color: [0.75, 0.72, 0.7] }],
      }, { t: ['grains', 'id'] }],
      ['color', 'mix', {}, { a: 'ground', b: 'mineral', t: ['grains', 'mask'] }],
    ], { baseColor: 'color' }),
  }),
  // 板岩：深灰、一层层的，表面有粗糙的起伏
  plain('slate', 'stone', {
    baseColor: [1, 1, 1, 1], metalness: 0, roughness: 0.65,
    graph: nodeGraph([
      ['uv', 'uv', { scale: [1, 6] }],
      ['layers', 'noise', { tileable: true, scale: 6, octaves: 5, roughness: 0.6, ridged: 0.6, seed: 4 }, { uv: 'uv' }],
      ['tone', 'colorRamp', { from: [0.045, 0.05, 0.058], to: [0.16, 0.17, 0.19] }, { t: 'layers' }],
      ['normal', 'normalFromHeight', { strength: 1.4 }, { height: 'layers', uv: 'uv' }],
    ], { baseColor: 'tone', normal: 'normal' }),
  }),
  // 砂岩：暖黄的地层，一条条的
  plain('sandstone', 'stone', {
    baseColor: [1, 1, 1, 1], metalness: 0, roughness: 0.9,
    graph: nodeGraph([
      ['uv', 'uv', { scale: [1, 8] }],
      ['strata', 'noise', { tileable: true, scale: 7, octaves: 5, roughness: 0.55, seed: 2 }, { uv: 'uv' }],
      ['grain', 'noise', { tileable: true, scale: 120, octaves: 3 }, { uv: 'uv' }],
      ['tone', 'colorRamp', { from: [0.36, 0.2, 0.1], to: [0.68, 0.46, 0.27] }, { t: 'strata' }],
      ['sand', 'colorRamp', { from: [0.9, 0.9, 0.9], to: [1.08, 1.08, 1.08] }, { t: 'grain' }],
      ['color', 'multiply', {}, { a: 'tone', b: 'sand' }],
      ['normal', 'normalFromHeight', { strength: 0.8 }, { height: 'grain', uv: 'uv' }],
    ], { baseColor: 'color', normal: 'normal' }),
  }),
  // 石灰岩：浅米色，满是小孔
  plain('limestone', 'stone', {
    baseColor: [1, 1, 1, 1], metalness: 0, roughness: 0.85,
    graph: nodeGraph([
      ['uv', 'uv'],
      ['cloud', 'noise', { tileable: true, scale: 6, octaves: 4 }, { uv: 'uv' }],
      ['tone', 'colorRamp', { from: [0.55, 0.51, 0.44], to: [0.78, 0.74, 0.66] }, { t: 'cloud' }],
      ['pits', 'spots', { tileable: true, scale: 45, size: 0.5, variation: 0.9, density: 0.45, seed: 3 }, { uv: 'uv' }],
      ['dark', 'color', { color: [0.2, 0.18, 0.15] }],
      ['color', 'mix', {}, { a: 'tone', b: 'dark', t: ['pits', 'mask'] }],
      ['normal', 'normalFromHeight', { strength: 1.8 }, { height: ['pits', 'dome'], uv: 'uv' }],
    ], { baseColor: 'color', normal: 'normal' }),
  }),
  // 洞石：米黄，一层层的带，层里有长条的孔
  plain('travertine', 'stone', {
    baseColor: [1, 1, 1, 1], metalness: 0, roughness: 0.5,
    graph: nodeGraph([
      ['uv', 'uv', { scale: [1, 5] }],
      ['bands', 'noise', { tileable: true, scale: 5, octaves: 4, seed: 6 }, { uv: 'uv' }],
      ['tone', 'colorRamp', { from: [0.55, 0.45, 0.32], to: [0.85, 0.78, 0.65] }, { t: 'bands' }],
      ['pores', 'spots', { tileable: true, scale: 30, size: 0.45, variation: 0.9, density: 0.3, seed: 1 }, { uv: 'uv' }],
      ['hole', 'color', { color: [0.28, 0.2, 0.12] }],
      ['color', 'mix', {}, { a: 'tone', b: 'hole', t: ['pores', 'mask'] }],
      ['normal', 'normalFromHeight', { strength: 1.2 }, { height: ['pores', 'dome'], uv: 'uv' }],
    ], { baseColor: 'color', normal: 'normal' }),
  }),
  // 水磨石：奶白的底，嵌着各色的石屑，磨得发亮
  plain('terrazzo', 'stone', {
    baseColor: [1, 1, 1, 1], metalness: 0, roughness: 0.15,
    graph: nodeGraph([
      ['uv', 'uv'],
      ['chips', 'spots', { tileable: true, scale: 22, size: 0.95, variation: 0.7, density: 1, seed: 5 }, { uv: 'uv' }],
      ['chip', 'colorRamp', {
        from: [0.6, 0.2, 0.12], to: [0.05, 0.05, 0.05],
        colorStops: [{ position: 0.3, color: [0.1, 0.25, 0.15] }, { position: 0.6, color: [0.85, 0.82, 0.78] }],
        interpolation: 'constant',
      }, { t: ['chips', 'id'] }],
      ['cement', 'color', { color: [0.72, 0.69, 0.64] }],
      ['color', 'mix', {}, { a: 'cement', b: 'chip', t: ['chips', 'mask'] }],
    ], { baseColor: 'color' }),
  }),
  // 鹅卵石路：一块块圆的石头，缝里黑
  plain('cobblestone', 'stone', {
    baseColor: [1, 1, 1, 1], metalness: 0, roughness: 0.8,
    graph: nodeGraph([
      ['uv', 'uv'],
      ['cells', 'voronoi', { tileable: true, scale: 10, randomness: 0.85 }, { uv: 'uv' }],
      ['dome', 'levels', { inMin: 0, inMax: 0.18 }, { in: ['cells', 'edge'] }],
      ['stone', 'colorRamp', { from: [0.18, 0.16, 0.14], to: [0.5, 0.46, 0.4] }, { t: ['cells', 'cell'] }],
      ['grain', 'noise', { tileable: true, scale: 80, octaves: 3 }, { uv: 'uv' }],
      ['speckle', 'colorRamp', { from: [0.88, 0.88, 0.88], to: [1.08, 1.08, 1.08] }, { t: 'grain' }],
      ['surface', 'multiply', {}, { a: 'stone', b: 'speckle' }],
      ['joint', 'color', { color: [0.03, 0.028, 0.025] }],
      ['color', 'mix', {}, { a: 'joint', b: 'surface', t: 'dome' }],
      ['normal', 'normalFromHeight', { strength: 5 }, { height: 'dome', uv: 'uv' }],
    ], { baseColor: 'color', normal: 'normal' }),
  }),
  // 不规则的石板路：大块的、棱角分明的碎石板，缝是灰泥
  plain('flagstone', 'stone', {
    baseColor: [1, 1, 1, 1], metalness: 0, roughness: 0.75,
    graph: nodeGraph([
      ['uv', 'uv'],
      ['cells', 'voronoi', { tileable: true, scale: 4, randomness: 0.9 }, { uv: 'uv' }],
      ['slab', 'levels', { inMin: 0.012, inMax: 0.03 }, { in: ['cells', 'edge'] }],
      ['stone', 'colorRamp', { from: [0.25, 0.23, 0.2], to: [0.55, 0.5, 0.44] }, { t: ['cells', 'cell'] }],
      ['weather', 'noise', { tileable: true, scale: 20, octaves: 4, seed: 2 }, { uv: 'uv' }],
      ['wear', 'colorRamp', { from: [0.82, 0.82, 0.82], to: [1.1, 1.1, 1.1] }, { t: 'weather' }],
      ['surface', 'multiply', {}, { a: 'stone', b: 'wear' }],
      ['mortar', 'color', { color: [0.28, 0.27, 0.25] }],
      ['color', 'mix', {}, { a: 'mortar', b: 'surface', t: 'slab' }],
      ['normal', 'normalFromHeight', { strength: 3 }, { height: 'slab', uv: 'uv' }],
    ], { baseColor: 'color', normal: 'normal' }),
  }),
  // 玄武岩：深灰带气孔
  plain('basalt', 'stone', {
    baseColor: [1, 1, 1, 1], metalness: 0, roughness: 0.7,
    graph: nodeGraph([
      ['uv', 'uv'],
      ['grain', 'noise', { tileable: true, scale: 40, octaves: 5, roughness: 0.6 }, { uv: 'uv' }],
      ['tone', 'colorRamp', { from: [0.03, 0.03, 0.035], to: [0.12, 0.12, 0.13] }, { t: 'grain' }],
      ['vesicles', 'spots', { tileable: true, scale: 28, size: 0.45, variation: 0.9, density: 0.4, seed: 7 }, { uv: 'uv' }],
      ['hole', 'color', { color: [0.006, 0.006, 0.006] }],
      ['color', 'mix', {}, { a: 'tone', b: 'hole', t: ['vesicles', 'mask'] }],
      ['normal', 'normalFromHeight', { strength: 2 }, { height: 'grain', uv: 'uv' }],
    ], { baseColor: 'color', normal: 'normal' }),
  }),
  // 岩壁：大起伏的岩石，脊状的噪声叠几层，缝里暗
  plain('rockCliff', 'stone', {
    baseColor: [1, 1, 1, 1], metalness: 0, roughness: 0.95,
    graph: nodeGraph([
      ['uv', 'uv'],
      ['big', 'noise', { tileable: true, scale: 3, octaves: 6, roughness: 0.55, ridged: 0.7, seed: 11 }, { uv: 'uv' }],
      ['small', 'noise', { tileable: true, scale: 24, octaves: 5, roughness: 0.6, ridged: 0.4, seed: 3 }, { uv: 'uv' }],
      ['relief', 'add', {}, { a: 'big', b: 'small' }],
      ['tone', 'colorRamp', { from: [0.06, 0.055, 0.05], to: [0.34, 0.3, 0.26] }, { t: 'big' }],
      ['fine', 'colorRamp', { from: [0.8, 0.8, 0.8], to: [1.15, 1.15, 1.15] }, { t: 'small' }],
      ['color', 'multiply', {}, { a: 'tone', b: 'fine' }],
      ['normal', 'normalFromHeight', { strength: 3 }, { height: 'relief', uv: 'uv' }],
    ], { baseColor: 'color', normal: 'normal' }),
  }),
];
