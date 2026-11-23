/** 混凝土、抹灰和沥青：素混凝土、抛光、清水模、骨料外露、灰泥、拉毛、沥青路面、铺路板、开裂。 */
import { nodeGraph, plain, type LibraryMaterial } from '../define.ts';

export const CONCRETE_MATERIALS: readonly LibraryMaterial[] = [
  plain('concrete', 'concrete', {
    baseColor: [1, 1, 1, 1], metalness: 0, roughness: 0.9,
    graph: nodeGraph([
      ['uv', 'uv'],
      ['grain', 'noise', { scale: 40, octaves: 5, roughness: 0.6 }, { uv: 'uv' }],
      ['stains', 'noise', { scale: 3, octaves: 3, seed: 4 }, { uv: 'uv' }],
      ['tone', 'colorRamp', { from: [0.32, 0.31, 0.29], to: [0.55, 0.54, 0.52] }, { t: 'stains' }],
      ['speckle', 'colorRamp', { from: [0.85, 0.85, 0.85], to: [1.1, 1.1, 1.1] }, { t: 'grain' }],
      ['color', 'multiply', {}, { a: 'tone', b: 'speckle' }],
      ['normal', 'normalFromHeight', { strength: 0.6 }, { height: 'grain', uv: 'uv' }],
    ], { baseColor: 'color', normal: 'normal' }),
  }),
  // 抛光混凝土：云一样的浅灰，很光滑，偶尔一个小气孔
  plain('polishedConcrete', 'concrete', {
    baseColor: [1, 1, 1, 1], metalness: 0, roughness: 0.22,
    graph: nodeGraph([
      ['uv', 'uv'],
      ['cloud', 'noise', { scale: 4, octaves: 5, roughness: 0.55, seed: 2 }, { uv: 'uv' }],
      ['tone', 'colorRamp', { from: [0.36, 0.36, 0.35], to: [0.58, 0.57, 0.55] }, { t: 'cloud' }],
      ['pits', 'spots', { scale: 40, size: 0.25, variation: 0.9, density: 0.12 }, { uv: 'uv' }],
      ['dark', 'color', { color: [0.12, 0.12, 0.12] }],
      ['color', 'mix', {}, { a: 'tone', b: 'dark', t: ['pits', 'mask'] }],
      ['rough', 'colorRamp', { from: [0.15, 0.15, 0.15], to: [0.35, 0.35, 0.35] }, { t: 'cloud' }],
    ], { baseColor: 'color', roughness: 'rough' }),
  }),
  // 清水混凝土：模板板条留下的竖纹，一块块模板的接缝，对拉螺栓的孔
  plain('boardConcrete', 'concrete', {
    baseColor: [1, 1, 1, 1], metalness: 0, roughness: 0.85,
    graph: nodeGraph([
      ['uv', 'uv'],
      ['boards', 'bricks', { columns: 10, rows: 1, mortar: 0.004, shift: 0 }, { uv: 'uv' }],
      ['grain', 'noise', { scale: 6, octaves: 5, roughness: 0.6 }, { uv: 'uv' }],
      ['stripe', 'noise', { scale: 80, octaves: 3 }, { uv: 'uv' }],
      ['tone', 'colorRamp', { from: [0.3, 0.3, 0.29], to: [0.52, 0.51, 0.49] }, { t: 'grain' }],
      ['board', 'colorRamp', { from: [0.88, 0.88, 0.88], to: [1.08, 1.08, 1.08] }, { t: ['boards', 'brick'] }],
      ['surface', 'multiply', {}, { a: 'tone', b: 'board' }],
      ['seam', 'color', { color: [0.14, 0.14, 0.14] }],
      ['color', 'mix', {}, { a: 'seam', b: 'surface', t: ['boards', 'mask'] }],
      ['relief', 'add', {}, { a: ['boards', 'mask'], b: 'stripe' }],
      ['normal', 'normalFromHeight', { strength: 1.2 }, { height: 'relief', uv: 'uv' }],
    ], { baseColor: 'color', normal: 'normal' }),
  }),
  // 骨料外露（洗石米）：一粒粒石子嵌在水泥里
  plain('exposedAggregate', 'concrete', {
    baseColor: [1, 1, 1, 1], metalness: 0, roughness: 0.7,
    graph: nodeGraph([
      ['uv', 'uv'],
      ['stones', 'spots', { scale: 26, size: 0.9, variation: 0.6, density: 1 }, { uv: 'uv' }],
      ['pebble', 'colorRamp', { from: [0.15, 0.13, 0.11], to: [0.75, 0.7, 0.62] }, { t: ['stones', 'id'] }],
      ['cement', 'color', { color: [0.22, 0.21, 0.2] }],
      ['color', 'mix', {}, { a: 'cement', b: 'pebble', t: ['stones', 'mask'] }],
      ['normal', 'normalFromHeight', { strength: 3 }, { height: ['stones', 'dome'], uv: 'uv' }],
    ], { baseColor: 'color', normal: 'normal' }),
  }),
  // 白灰泥墙：平整、微微有刮痕和斑
  plain('plaster', 'concrete', {
    baseColor: [1, 1, 1, 1], metalness: 0, roughness: 0.9,
    graph: nodeGraph([
      ['uv', 'uv'],
      ['trowel', 'noise', { scale: 5, octaves: 5, roughness: 0.55, seed: 3 }, { uv: 'uv' }],
      ['tone', 'colorRamp', { from: [0.72, 0.71, 0.68], to: [0.86, 0.85, 0.82] }, { t: 'trowel' }],
      ['fine', 'noise', { scale: 90, octaves: 3 }, { uv: 'uv' }],
      ['normal', 'normalFromHeight', { strength: 0.5 }, { height: 'trowel', uv: 'uv' }],
    ], { baseColor: 'tone', normal: 'normal' }),
  }),
  // 拉毛灰泥：满是小疙瘩的外墙
  plain('stucco', 'concrete', {
    baseColor: [1, 1, 1, 1], metalness: 0, roughness: 0.95,
    graph: nodeGraph([
      ['uv', 'uv'],
      ['lumps', 'noise', { scale: 70, octaves: 4, roughness: 0.7 }, { uv: 'uv' }],
      ['tone', 'colorRamp', { from: [0.5, 0.42, 0.3], to: [0.72, 0.64, 0.5] }, { t: 'lumps' }],
      ['normal', 'normalFromHeight', { strength: 2.5 }, { height: 'lumps', uv: 'uv' }],
    ], { baseColor: 'tone', normal: 'normal' }),
  }),
  // 沥青路面：黑的沥青里露着碎石，整体发灰
  plain('asphalt', 'concrete', {
    baseColor: [1, 1, 1, 1], metalness: 0, roughness: 0.92,
    graph: nodeGraph([
      ['uv', 'uv'],
      ['tar', 'noise', { scale: 30, octaves: 4, roughness: 0.6 }, { uv: 'uv' }],
      ['bitumen', 'colorRamp', { from: [0.02, 0.02, 0.022], to: [0.06, 0.06, 0.065] }, { t: 'tar' }],
      ['chips', 'spots', { scale: 80, size: 0.7, variation: 0.8, density: 0.7 }, { uv: 'uv' }],
      ['stone', 'colorRamp', { from: [0.08, 0.08, 0.08], to: [0.32, 0.31, 0.3] }, { t: ['chips', 'id'] }],
      ['color', 'mix', {}, { a: 'bitumen', b: 'stone', t: ['chips', 'mask'] }],
      ['normal', 'normalFromHeight', { strength: 2 }, { height: ['chips', 'dome'], uv: 'uv' }],
    ], { baseColor: 'color', normal: 'normal' }),
  }),
  // 开裂的旧路面：磨得发灰，裂缝里黑、有补过的沥青
  plain('crackedAsphalt', 'concrete', {
    baseColor: [1, 1, 1, 1], metalness: 0, roughness: 0.9,
    graph: nodeGraph([
      ['uv', 'uv'],
      ['chips', 'spots', { scale: 70, size: 0.7, variation: 0.8, density: 0.7 }, { uv: 'uv' }],
      ['worn', 'noise', { scale: 6, octaves: 4, seed: 3 }, { uv: 'uv' }],
      ['bitumen', 'colorRamp', { from: [0.04, 0.04, 0.045], to: [0.2, 0.2, 0.21] }, { t: 'worn' }],
      ['stone', 'colorRamp', { from: [0.1, 0.1, 0.1], to: [0.4, 0.4, 0.38] }, { t: ['chips', 'id'] }],
      ['surface', 'mix', {}, { a: 'bitumen', b: 'stone', t: ['chips', 'mask'] }],
      ['cracks', 'cracks', { scale: 3, width: 0.012, warp: 1.2, seed: 5 }, { uv: 'uv' }],
      ['dark', 'color', { color: [0.008, 0.008, 0.008] }],
      ['color', 'mix', {}, { a: 'surface', b: 'dark', t: ['cracks', 'mask'] }],
      ['relief', 'subtract', {}, { a: ['chips', 'dome'], b: ['cracks', 'mask'] }],
      ['normal', 'normalFromHeight', { strength: 2.5 }, { height: 'relief', uv: 'uv' }],
    ], { baseColor: 'color', normal: 'normal' }),
  }),
  // 混凝土铺路板：一块块方的，缝里有土
  plain('pavingSlabs', 'concrete', {
    baseColor: [1, 1, 1, 1], metalness: 0, roughness: 0.85,
    graph: nodeGraph([
      ['uv', 'uv'],
      ['slabs', 'bricks', { columns: 4, rows: 4, mortar: 0.012, shift: 0 }, { uv: 'uv' }],
      ['tone', 'colorRamp', { from: [0.3, 0.3, 0.29], to: [0.5, 0.49, 0.47] }, { t: ['slabs', 'brick'] }],
      ['grain', 'noise', { scale: 50, octaves: 4 }, { uv: 'uv' }],
      ['speckle', 'colorRamp', { from: [0.86, 0.86, 0.86], to: [1.1, 1.1, 1.1] }, { t: 'grain' }],
      ['surface', 'multiply', {}, { a: 'tone', b: 'speckle' }],
      ['soil', 'color', { color: [0.1, 0.075, 0.05] }],
      ['color', 'mix', {}, { a: 'soil', b: 'surface', t: ['slabs', 'mask'] }],
      ['normal', 'normalFromHeight', { strength: 2 }, { height: ['slabs', 'mask'], uv: 'uv' }],
    ], { baseColor: 'color', normal: 'normal' }),
  }),
  // 开裂的混凝土：浅灰，网状的裂缝
  plain('crackedConcrete', 'concrete', {
    baseColor: [1, 1, 1, 1], metalness: 0, roughness: 0.88,
    graph: nodeGraph([
      ['uv', 'uv'],
      ['grain', 'noise', { scale: 30, octaves: 5, roughness: 0.6 }, { uv: 'uv' }],
      ['stains', 'noise', { scale: 3, octaves: 4, seed: 9 }, { uv: 'uv' }],
      ['tone', 'colorRamp', { from: [0.3, 0.3, 0.28], to: [0.55, 0.54, 0.51] }, { t: 'stains' }],
      ['cracks', 'cracks', { scale: 3, width: 0.01, warp: 1.5, seed: 1 }, { uv: 'uv' }],
      ['dark', 'color', { color: [0.02, 0.02, 0.02] }],
      ['color', 'mix', {}, { a: 'tone', b: 'dark', t: ['cracks', 'mask'] }],
      ['relief', 'subtract', {}, { a: 'grain', b: ['cracks', 'mask'] }],
      ['normal', 'normalFromHeight', { strength: 1.5 }, { height: 'relief', uv: 'uv' }],
    ], { baseColor: 'color', normal: 'normal' }),
  }),
];
