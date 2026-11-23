/** 纸和卡：薄，背光时透光（漫透射），表面是细的纤维。 */
import { nodeGraph, plain, type LibraryMaterial } from '../define.ts';

export const PAPER_MATERIALS: readonly LibraryMaterial[] = [
  plain('paper', 'paper', {
    baseColor: [1, 1, 1, 1], metalness: 0, roughness: 0.9, diffuseTransmission: { factor: 0.3, color: [1, 0.98, 0.92] },
    graph: nodeGraph([
      ['uv', 'uv'],
      ['fibers', 'noise', { tileable: true, scale: 150, octaves: 3, roughness: 0.7 }, { uv: 'uv' }],
      ['tone', 'colorRamp', { from: [0.78, 0.78, 0.76], to: [0.88, 0.88, 0.86] }, { t: 'fibers' }],
      ['normal', 'normalFromHeight', { strength: 0.4 }, { height: 'fibers', uv: 'uv' }],
    ], { baseColor: 'tone', normal: 'normal' }),
  }),
  // 报纸：偏灰黄，纤维粗一些
  plain('newsprint', 'paper', {
    baseColor: [1, 1, 1, 1], metalness: 0, roughness: 0.95, diffuseTransmission: { factor: 0.3, color: [0.95, 0.92, 0.82] },
    graph: nodeGraph([
      ['uv', 'uv'],
      ['fibers', 'noise', { tileable: true, scale: 90, octaves: 3, roughness: 0.7 }, { uv: 'uv' }],
      ['stain', 'noise', { tileable: true, scale: 4, octaves: 4, seed: 2 }, { uv: 'uv' }],
      ['tone', 'colorRamp', { from: [0.55, 0.52, 0.44], to: [0.72, 0.69, 0.6] }, { t: 'stain' }],
      ['grain', 'colorRamp', { from: [0.92, 0.92, 0.92], to: [1.06, 1.06, 1.06] }, { t: 'fibers' }],
      ['color', 'multiply', {}, { a: 'tone', b: 'grain' }],
    ], { baseColor: 'color' }),
  }),
  // 羊皮纸：奶黄，边上发深、有斑
  plain('parchment', 'paper', {
    baseColor: [1, 1, 1, 1], metalness: 0, roughness: 0.8, diffuseTransmission: { factor: 0.45, color: [1, 0.85, 0.55] },
    graph: nodeGraph([
      ['uv', 'uv'],
      ['blotch', 'noise', { tileable: true, scale: 5, octaves: 6, roughness: 0.6, seed: 7 }, { uv: 'uv' }],
      ['edge', 'gradient', { shape: 'radial' }, { uv: 'uv' }],
      ['age', 'multiply', {}, { a: 'edge', b: 'blotch' }],
      ['color', 'colorRamp', { from: [0.62, 0.5, 0.28], to: [0.28, 0.17, 0.06] }, { t: 'age' }],
      ['fibers', 'noise', { tileable: true, scale: 120, octaves: 3 }, { uv: 'uv' }],
      ['normal', 'normalFromHeight', { strength: 0.6 }, { height: 'fibers', uv: 'uv' }],
    ], { baseColor: 'color', normal: 'normal' }),
  }),
  // 牛皮纸卡：棕色，粗纤维
  plain('cardboard', 'paper', {
    baseColor: [1, 1, 1, 1], metalness: 0, roughness: 0.95,
    graph: nodeGraph([
      ['uv', 'uv'],
      ['fibers', 'noise', { tileable: true, scale: 80, octaves: 4, roughness: 0.65 }, { uv: 'uv' }],
      ['stain', 'noise', { tileable: true, scale: 3, octaves: 4, seed: 3 }, { uv: 'uv' }],
      ['tone', 'colorRamp', { from: [0.22, 0.13, 0.065], to: [0.4, 0.26, 0.14] }, { t: 'stain' }],
      ['grain', 'colorRamp', { from: [0.9, 0.9, 0.9], to: [1.1, 1.1, 1.1] }, { t: 'fibers' }],
      ['color', 'multiply', {}, { a: 'tone', b: 'grain' }],
      ['normal', 'normalFromHeight', { strength: 0.6 }, { height: 'fibers', uv: 'uv' }],
    ], { baseColor: 'color', normal: 'normal' }),
  }),
  // 瓦楞纸板：切面一排排的波（看侧边）
  plain('corrugatedCardboard', 'paper', {
    baseColor: [1, 1, 1, 1], metalness: 0, roughness: 0.95,
    graph: nodeGraph([
      ['uv', 'uv'],
      ['flutes', 'wave', { frequency: 30, angle: 0, shape: 'sine' }, { uv: 'uv' }],
      ['fibers', 'noise', { tileable: true, scale: 80, octaves: 3 }, { uv: 'uv' }],
      ['tone', 'colorRamp', { from: [0.2, 0.12, 0.06], to: [0.42, 0.28, 0.15] }, { t: 'fibers' }],
      ['shade', 'colorRamp', { from: [0.7, 0.7, 0.7], to: [1.05, 1.05, 1.05] }, { t: 'flutes' }],
      ['color', 'multiply', {}, { a: 'tone', b: 'shade' }],
      ['normal', 'normalFromHeight', { strength: 4 }, { height: 'flutes', uv: 'uv' }],
    ], { baseColor: 'color', normal: 'normal' }),
  }),
  // 灯罩的布：暖白，背面有灯时透出柔和的光
  plain('lampshade', 'paper', {
    baseColor: [1, 1, 1, 1], metalness: 0, roughness: 0.9, diffuseTransmission: { factor: 0.65, color: [1, 0.82, 0.55] },
    graph: nodeGraph([
      ['uv', 'uv'],
      ['cloth', 'weave', { count: [80, 80], pattern: 'plain' }, { uv: 'uv' }],
      ['thread', 'colorRamp', { from: [0.62, 0.57, 0.46], to: [0.8, 0.75, 0.62] }, { t: ['cloth', 'thread'] }],
      ['normal', 'normalFromHeight', { strength: 0.8 }, { height: ['cloth', 'height'], uv: 'uv' }],
    ], { baseColor: 'thread', normal: 'normal' }),
  }),
];
