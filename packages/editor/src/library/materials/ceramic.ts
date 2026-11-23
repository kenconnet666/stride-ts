/** 陶瓷和瓷砖：釉面光滑、缝里粗糙。 */
import { nodeGraph, plain, type LibraryMaterial } from '../define.ts';

export const CERAMIC_MATERIALS: readonly LibraryMaterial[] = [
  // 墙砖：白釉面的方砖（每米 4 块、不错缝，包柱、墙面），每块白得略有不同，浅灰的缝；釉面光滑、缝粗糙
  plain('wallTiles', 'ceramic', {
    baseColor: [1, 1, 1, 1], metalness: 0, roughness: 0.12,
    graph: nodeGraph([
      ['uv', 'uv'],
      ['tiles', 'bricks', { columns: 4, rows: 4, mortar: 0.008, shift: 0 }, { uv: 'uv' }],
      ['tone', 'colorRamp', { from: [0.78, 0.78, 0.76], to: [0.86, 0.86, 0.84] }, { t: ['tiles', 'brick'] }],
      ['joint', 'color', { color: [0.42, 0.42, 0.4] }],
      ['color', 'mix', {}, { a: 'joint', b: 'tone', t: ['tiles', 'mask'] }],
      ['glaze', 'value', { value: 0.1 }],
      ['grout', 'value', { value: 0.7 }],
      ['roughness', 'mix', {}, { a: 'grout', b: 'glaze', t: ['tiles', 'mask'] }],
      ['normal', 'normalFromHeight', { strength: 0.4 }, { height: ['tiles', 'mask'], uv: 'uv' }],
    ], { baseColor: 'color', roughness: 'roughness', normal: 'normal' }),
  }),
  // 地铁砖（斜缝的小长方砖，白釉）：一排排错开半块
  plain('subwayTiles', 'ceramic', {
    baseColor: [1, 1, 1, 1], metalness: 0, roughness: 0.1,
    graph: nodeGraph([
      ['uv', 'uv'],
      ['tiles', 'bricks', { columns: 5, rows: 15, mortar: 0.01, shift: 0.5 }, { uv: 'uv' }],
      ['tone', 'colorRamp', { from: [0.8, 0.8, 0.78], to: [0.9, 0.9, 0.88] }, { t: ['tiles', 'brick'] }],
      ['grime', 'noise', { tileable: true, scale: 8, octaves: 4, seed: 3 }, { uv: 'uv' }],
      ['dirt', 'colorRamp', { from: [1, 1, 1], to: [0.82, 0.8, 0.74] }, { t: 'grime' }],
      ['surface', 'multiply', {}, { a: 'tone', b: 'dirt' }],
      ['joint', 'color', { color: [0.3, 0.29, 0.27] }],
      ['color', 'mix', {}, { a: 'joint', b: 'surface', t: ['tiles', 'mask'] }],
      ['glaze', 'value', { value: 0.08 }],
      ['grout', 'value', { value: 0.8 }],
      ['roughness', 'mix', {}, { a: 'grout', b: 'glaze', t: ['tiles', 'mask'] }],
      ['normal', 'normalFromHeight', { strength: 0.6 }, { height: ['tiles', 'mask'], uv: 'uv' }],
    ], { baseColor: 'color', roughness: 'roughness', normal: 'normal' }),
  }),
  // 六角砖：黑白两色随机，浅灰的缝
  plain('hexTilesCeramic', 'ceramic', {
    baseColor: [1, 1, 1, 1], metalness: 0, roughness: 0.15,
    graph: nodeGraph([
      ['uv', 'uv'],
      ['hex', 'hexTiles', { scale: 10, gap: 0.05 }, { uv: 'uv' }],
      ['tone', 'colorRamp', {
        from: [0.02, 0.02, 0.02], to: [0.85, 0.85, 0.83],
        colorStops: [{ position: 0.4, color: [0.85, 0.85, 0.83] }, { position: 0.7, color: [0.1, 0.12, 0.14] }],
        interpolation: 'constant',
      }, { t: ['hex', 'id'] }],
      ['joint', 'color', { color: [0.35, 0.35, 0.33] }],
      ['color', 'mix', {}, { a: 'joint', b: 'tone', t: ['hex', 'mask'] }],
      ['glaze', 'value', { value: 0.1 }],
      ['grout', 'value', { value: 0.8 }],
      ['roughness', 'mix', {}, { a: 'grout', b: 'glaze', t: ['hex', 'mask'] }],
      ['normal', 'normalFromHeight', { strength: 0.8 }, { height: ['hex', 'mask'], uv: 'uv' }],
    ], { baseColor: 'color', roughness: 'roughness', normal: 'normal' }),
  }),
  // 黑白方格地砖
  plain('checkerTiles', 'ceramic', {
    baseColor: [1, 1, 1, 1], metalness: 0, roughness: 0.1,
    graph: nodeGraph([
      ['uv', 'uv'],
      ['squares', 'checker', { scale: 8 }, { uv: 'uv' }],
      ['white', 'color', { color: [0.8, 0.8, 0.78] }],
      ['black', 'color', { color: [0.012, 0.012, 0.014] }],
      ['color', 'mix', {}, { a: 'white', b: 'black', t: 'squares' }],
      ['wear', 'noise', { tileable: true, scale: 30, octaves: 4, seed: 2 }, { uv: 'uv' }],
      ['rough', 'colorRamp', { from: [0.06, 0.06, 0.06], to: [0.3, 0.3, 0.3] }, { t: 'wear' }],
    ], { baseColor: 'color', roughness: 'rough' }),
  }),
  // 马赛克：小方块，蓝绿的各种色
  plain('mosaic', 'ceramic', {
    baseColor: [1, 1, 1, 1], metalness: 0, roughness: 0.12,
    graph: nodeGraph([
      ['uv', 'uv'],
      ['chips', 'bricks', { columns: 28, rows: 28, mortar: 0.006, shift: 0 }, { uv: 'uv' }],
      ['tone', 'colorRamp', {
        from: [0.02, 0.15, 0.4], to: [0.05, 0.5, 0.55],
        colorStops: [{ position: 0.4, color: [0.1, 0.3, 0.6] }, { position: 0.75, color: [0.6, 0.78, 0.82] }],
      }, { t: ['chips', 'brick'] }],
      ['grout', 'color', { color: [0.5, 0.5, 0.48] }],
      ['color', 'mix', {}, { a: 'grout', b: 'tone', t: ['chips', 'mask'] }],
      ['normal', 'normalFromHeight', { strength: 1 }, { height: ['chips', 'mask'], uv: 'uv' }],
    ], { baseColor: 'color', normal: 'normal' }),
  }),
  // 赤陶地砖：红陶色、没上釉（微微发亮），每块深浅不同
  plain('terracottaTiles', 'ceramic', {
    baseColor: [1, 1, 1, 1], metalness: 0, roughness: 0.75,
    graph: nodeGraph([
      ['uv', 'uv'],
      ['tiles', 'bricks', { columns: 3, rows: 3, mortar: 0.012, shift: 0 }, { uv: 'uv' }],
      ['clay', 'colorRamp', { from: [0.3, 0.08, 0.04], to: [0.58, 0.2, 0.1] }, { t: ['tiles', 'brick'] }],
      ['mottle', 'noise', { tileable: true, scale: 14, octaves: 5, seed: 6 }, { uv: 'uv' }],
      ['tint', 'colorRamp', { from: [0.8, 0.75, 0.7], to: [1.15, 1.08, 1] }, { t: 'mottle' }],
      ['surface', 'multiply', {}, { a: 'clay', b: 'tint' }],
      ['grout', 'color', { color: [0.3, 0.28, 0.25] }],
      ['color', 'mix', {}, { a: 'grout', b: 'surface', t: ['tiles', 'mask'] }],
      ['normal', 'normalFromHeight', { strength: 1.5 }, { height: ['tiles', 'mask'], uv: 'uv' }],
    ], { baseColor: 'color', normal: 'normal' }),
  }),
  // 白瓷（洁具）：很亮的釉面，一点点冰裂的细纹
  plain('porcelain', 'ceramic', {
    baseColor: [0.85, 0.85, 0.83, 1], metalness: 0, roughness: 0.06,
  }),
  // 蓝釉陶：深蓝的釉，厚薄不均
  plain('blueGlaze', 'ceramic', {
    baseColor: [1, 1, 1, 1], metalness: 0, roughness: 0.1,
    graph: nodeGraph([
      ['uv', 'uv'],
      ['pool', 'noise', { tileable: true, scale: 6, octaves: 5, roughness: 0.6, seed: 4 }, { uv: 'uv' }],
      ['glaze', 'colorRamp', { from: [0.01, 0.05, 0.3], to: [0.02, 0.22, 0.55] }, { t: 'pool' }],
      ['speck', 'spots', { tileable: true, scale: 50, size: 0.25, variation: 0.8, density: 0.15 }, { uv: 'uv' }],
      ['iron', 'color', { color: [0.02, 0.012, 0.01] }],
      ['color', 'mix', {}, { a: 'glaze', b: 'iron', t: ['speck', 'mask'] }],
    ], { baseColor: 'color' }),
  }),
];
