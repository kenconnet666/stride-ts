/** 砖、砌块和屋面（瓦、油毡瓦）：砖块的遮罩混两种颜色，缝里是灰泥；同一个遮罩算高度、再算法线。 */
import { nodeGraph, plain, type LibraryMaterial } from '../define.ts';

/** 一种砖墙：砖色的两端、灰泥色、粗糙度、每米几块（列、行）、法线强度。 */
const wall = (id: string, from: readonly [number, number, number], to: readonly [number, number, number], mortar: readonly [number, number, number], roughness: number, columns = 4, rows = 8) => plain(id, 'brick', {
  baseColor: [1, 1, 1, 1], metalness: 0, roughness,
  graph: nodeGraph([
    ['uv', 'uv'],
    ['bricks', 'bricks', { columns, rows, mortar: 0.03, shift: 0.5 }, { uv: 'uv' }],
    ['variation', 'colorRamp', { from, to }, { t: ['bricks', 'brick'] }],
    ['grain', 'noise', { tileable: true, scale: 60, octaves: 4 }, { uv: 'uv' }],
    ['speckle', 'colorRamp', { from: [0.86, 0.86, 0.86], to: [1.1, 1.1, 1.1] }, { t: 'grain' }],
    ['surface', 'multiply', {}, { a: 'variation', b: 'speckle' }],
    ['mortar', 'color', { color: mortar }],
    ['color', 'mix', {}, { a: 'mortar', b: 'surface', t: ['bricks', 'mask'] }],
    ['normal', 'normalFromHeight', { strength: 2 }, { height: ['bricks', 'mask'], uv: 'uv' }],
  ], { baseColor: 'color', normal: 'normal' }),
});

export const BRICK_MATERIALS: readonly LibraryMaterial[] = [
  plain('redBrick', 'brick', {
    baseColor: [1, 1, 1, 1], metalness: 0, roughness: 0.85,
    graph: nodeGraph([
      ['uv', 'uv'],
      ['bricks', 'bricks', { columns: 4, rows: 8, mortar: 0.03, shift: 0.5 }, { uv: 'uv' }],
      ['variation', 'colorRamp', { from: [0.3, 0.07, 0.04], to: [0.55, 0.18, 0.1] }, { t: ['bricks', 'brick'] }],
      ['mortar', 'color', { color: [0.55, 0.53, 0.5] }],
      ['color', 'mix', {}, { a: 'mortar', b: 'variation', t: ['bricks', 'mask'] }],
      ['normal', 'normalFromHeight', { strength: 2 }, { height: ['bricks', 'mask'], uv: 'uv' }],
    ], { baseColor: 'color', normal: 'normal' }),
  }),
  // 黄砖（伦敦的黄褐色）
  wall('yellowBrick', [0.34, 0.22, 0.07], [0.6, 0.45, 0.18], [0.6, 0.58, 0.52], 0.88),
  // 刷白的砖墙：白漆盖着砖，缝还看得出来，漆有点斑驳
  wall('whiteBrick', [0.62, 0.62, 0.6], [0.78, 0.78, 0.75], [0.7, 0.7, 0.68], 0.8),
  // 空心砖、煤渣砖：灰的大块，满是小孔
  plain('cinderBlock', 'brick', {
    baseColor: [1, 1, 1, 1], metalness: 0, roughness: 0.92,
    graph: nodeGraph([
      ['uv', 'uv'],
      ['blocks', 'bricks', { columns: 2.5, rows: 5, mortar: 0.025, shift: 0.5 }, { uv: 'uv' }],
      ['pores', 'spots', { tileable: true, scale: 55, size: 0.45, variation: 0.9, density: 0.5, seed: 2 }, { uv: 'uv' }],
      ['body', 'colorRamp', { from: [0.3, 0.3, 0.29], to: [0.46, 0.46, 0.44] }, { t: ['blocks', 'brick'] }],
      ['dark', 'color', { color: [0.09, 0.09, 0.09] }],
      ['pitted', 'mix', {}, { a: 'body', b: 'dark', t: ['pores', 'mask'] }],
      ['mortar', 'color', { color: [0.55, 0.55, 0.53] }],
      ['color', 'mix', {}, { a: 'mortar', b: 'pitted', t: ['blocks', 'mask'] }],
      ['relief', 'add', {}, { a: ['blocks', 'mask'], b: ['pores', 'dome'] }],
      ['normal', 'normalFromHeight', { strength: 1.5 }, { height: 'relief', uv: 'uv' }],
    ], { baseColor: 'color', normal: 'normal' }),
  }),
  // 陶土瓦：一排排叠着，每片颜色不同
  plain('roofTiles', 'brick', {
    baseColor: [1, 1, 1, 1], metalness: 0, roughness: 0.8,
    graph: nodeGraph([
      ['uv', 'uv'],
      ['tiles', 'bricks', { columns: 8, rows: 14, mortar: 0.012, shift: 0.5 }, { uv: 'uv' }],
      ['clay', 'colorRamp', { from: [0.3, 0.07, 0.035], to: [0.6, 0.2, 0.1] }, { t: ['tiles', 'brick'] }],
      ['weather', 'noise', { tileable: true, scale: 12, octaves: 4, seed: 4 }, { uv: 'uv' }],
      ['mossy', 'colorRamp', { from: [0.95, 0.95, 0.95], to: [0.6, 0.7, 0.5] }, { t: 'weather' }],
      ['surface', 'multiply', {}, { a: 'clay', b: 'mossy' }],
      ['gap', 'color', { color: [0.02, 0.015, 0.012] }],
      ['color', 'mix', {}, { a: 'gap', b: 'surface', t: ['tiles', 'mask'] }],
      ['normal', 'normalFromHeight', { strength: 3 }, { height: ['tiles', 'mask'], uv: 'uv' }],
    ], { baseColor: 'color', normal: 'normal' }),
  }),
  // 油毡瓦（沥青瓦）：深灰、有颗粒
  plain('shingles', 'brick', {
    baseColor: [1, 1, 1, 1], metalness: 0, roughness: 0.95,
    graph: nodeGraph([
      ['uv', 'uv'],
      ['rows', 'bricks', { columns: 6, rows: 16, mortar: 0.02, shift: 0.5 }, { uv: 'uv' }],
      ['body', 'colorRamp', { from: [0.035, 0.035, 0.04], to: [0.12, 0.11, 0.1] }, { t: ['rows', 'brick'] }],
      ['grit', 'spots', { tileable: true, scale: 120, size: 0.6, variation: 0.7, density: 0.8 }, { uv: 'uv' }],
      ['grain', 'colorRamp', { from: [0.7, 0.7, 0.7], to: [1.5, 1.5, 1.5] }, { t: ['grit', 'id'] }],
      ['surface', 'multiply', {}, { a: 'body', b: 'grain' }],
      ['joint', 'color', { color: [0.006, 0.006, 0.006] }],
      ['color', 'mix', {}, { a: 'joint', b: 'surface', t: ['rows', 'mask'] }],
      ['normal', 'normalFromHeight', { strength: 2.5 }, { height: ['rows', 'mask'], uv: 'uv' }],
    ], { baseColor: 'color', normal: 'normal' }),
  }),
];
