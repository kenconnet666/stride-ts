/** 地面：沙、土、泥、草地、碎石、雪、林地、龟裂的泥地和高山地形（按坡度、高度混）。 */
import { nodeGraph, plain, type LibraryMaterial } from '../define.ts';

export const TERRAIN_MATERIALS: readonly LibraryMaterial[] = [
  // 地形（W2 的材质规则）：按世界坐标铺（每 20 米重复一次），平处是草、陡过 32° 是岩石、180 米以上较平的地方积雪；
  // 遮罩是节点图的坡度、高度遮罩，换地形、挪地形都对
  plain('alpineTerrain', 'terrain', {
    baseColor: [1, 1, 1, 1], metalness: 0, roughness: 0.9,
    graph: nodeGraph([
      ['uv', 'worldUv', { scale: 0.05 }],
      ['patches', 'noise', { scale: 6, octaves: 4, roughness: 0.55 }, { uv: 'uv' }],
      ['grass', 'colorRamp', { from: [0.1, 0.17, 0.05], to: [0.24, 0.33, 0.11] }, { t: 'patches' }],
      ['strata', 'noise', { scale: 14, octaves: 5, roughness: 0.6, seed: 3 }, { uv: 'uv' }],
      ['rock', 'colorRamp', { from: [0.13, 0.12, 0.11], to: [0.3, 0.28, 0.25] }, { t: 'strata' }],
      ['steep', 'slopeMask', { minAngle: 32, maxAngle: 90, blend: 10 }],
      ['ground', 'mix', {}, { a: 'grass', b: 'rock', t: 'steep' }],
      ['high', 'heightMask', { minHeight: 180, maxHeight: 100000, blend: 60 }],
      ['flat', 'slopeMask', { minAngle: 0, maxAngle: 38, blend: 12 }],
      ['snowCover', 'multiply', {}, { a: 'high', b: 'flat' }],
      ['snow', 'color', { color: [0.86, 0.89, 0.93] }],
      ['color', 'mix', {}, { a: 'ground', b: 'snow', t: 'snowCover' }],
    ], { baseColor: 'color' }),
  }),
  // 沙：细的沙粒闪着，风吹出的细波纹
  plain('sand', 'terrain', {
    baseColor: [1, 1, 1, 1], metalness: 0, roughness: 0.98,
    graph: nodeGraph([
      ['uv', 'uv'],
      ['grains', 'noise', { tileable: true, scale: 300, octaves: 2, roughness: 0.8 }, { uv: 'uv' }],
      ['ripples', 'wave', { frequency: 22, angle: 20, shape: 'sine' }, { uv: 'uv' }],
      ['drift', 'noise', { tileable: true, scale: 4, octaves: 4, seed: 4 }, { uv: 'uv' }],
      ['tone', 'colorRamp', { from: [0.42, 0.3, 0.16], to: [0.72, 0.58, 0.36] }, { t: 'drift' }],
      ['sparkle', 'colorRamp', { from: [0.88, 0.88, 0.88], to: [1.12, 1.1, 1.05] }, { t: 'grains' }],
      ['shade', 'colorRamp', { from: [0.82, 0.82, 0.82], to: [1.05, 1.05, 1.05] }, { t: 'ripples' }],
      ['lit', 'multiply', {}, { a: 'tone', b: 'sparkle' }],
      ['color', 'multiply', {}, { a: 'lit', b: 'shade' }],
      ['relief', 'add', {}, { a: 'ripples', b: 'grains' }],
      ['normal', 'normalFromHeight', { strength: 1.2 }, { height: 'relief', uv: 'uv' }],
    ], { baseColor: 'color', normal: 'normal' }),
  }),
  // 泥土：深褐，夹着小石子和草根
  plain('dirt', 'terrain', {
    baseColor: [1, 1, 1, 1], metalness: 0, roughness: 1,
    graph: nodeGraph([
      ['uv', 'uv'],
      ['clods', 'noise', { tileable: true, scale: 18, octaves: 6, roughness: 0.6, seed: 2 }, { uv: 'uv' }],
      ['soil', 'colorRamp', { from: [0.05, 0.03, 0.02], to: [0.2, 0.13, 0.08] }, { t: 'clods' }],
      ['stones', 'spots', { tileable: true, scale: 30, size: 0.5, variation: 0.9, density: 0.18, seed: 3 }, { uv: 'uv' }],
      ['pebble', 'colorRamp', { from: [0.18, 0.16, 0.13], to: [0.45, 0.42, 0.36] }, { t: ['stones', 'id'] }],
      ['color', 'mix', {}, { a: 'soil', b: 'pebble', t: ['stones', 'mask'] }],
      ['relief', 'add', {}, { a: 'clods', b: ['stones', 'dome'] }],
      ['normal', 'normalFromHeight', { strength: 2 }, { height: 'relief', uv: 'uv' }],
    ], { baseColor: 'color', normal: 'normal' }),
  }),
  // 烂泥：湿的、很深的褐，低洼的地方积着水（粗糙度低、亮）
  plain('mud', 'terrain', {
    baseColor: [1, 1, 1, 1], metalness: 0, roughness: 0.4,
    graph: nodeGraph([
      ['uv', 'uv'],
      ['lumps', 'noise', { tileable: true, scale: 8, octaves: 5, roughness: 0.6, seed: 9 }, { uv: 'uv' }],
      ['puddles', 'levels', { inMin: 0.35, inMax: 0.5, outMin: 1, outMax: 0 }, { in: 'lumps' }],
      ['wet', 'colorRamp', { from: [0.025, 0.017, 0.012], to: [0.09, 0.06, 0.04] }, { t: 'lumps' }],
      ['soaked', 'color', { color: [0.012, 0.009, 0.007] }],
      ['color', 'mix', {}, { a: 'wet', b: 'soaked', t: 'puddles' }],
      ['dry', 'value', { value: 0.75 }],
      ['water', 'value', { value: 0.05 }],
      ['roughness', 'mix', {}, { a: 'dry', b: 'water', t: 'puddles' }],
      ['normal', 'normalFromHeight', { strength: 2 }, { height: 'lumps', uv: 'uv' }],
    ], { baseColor: 'color', roughness: 'roughness', normal: 'normal' }),
  }),
  // 草地：细密的叶片，深浅不一的绿，夹一点黄
  plain('meadow', 'terrain', {
    baseColor: [1, 1, 1, 1], metalness: 0, roughness: 0.9, sheen: { color: [0.1, 0.18, 0.04], roughness: 0.6 },
    graph: nodeGraph([
      ['uv', 'uv'],
      ['blades', 'noise', { tileable: true, scale: 120, octaves: 4, roughness: 0.7 }, { uv: 'uv' }],
      ['patches', 'noise', { tileable: true, scale: 5, octaves: 4, seed: 3 }, { uv: 'uv' }],
      ['tone', 'colorRamp', { from: [0.03, 0.1, 0.012], to: [0.16, 0.32, 0.05], colorStops: [{ position: 0.8, color: [0.3, 0.34, 0.07] }] }, { t: 'patches' }],
      ['detail', 'colorRamp', { from: [0.6, 0.65, 0.6], to: [1.25, 1.2, 1.1] }, { t: 'blades' }],
      ['color', 'multiply', {}, { a: 'tone', b: 'detail' }],
      ['normal', 'normalFromHeight', { strength: 1.8 }, { height: 'blades', uv: 'uv' }],
    ], { baseColor: 'color', normal: 'normal' }),
  }),
  // 碎石：一粒粒圆的石子，各种灰褐色，缝里暗
  plain('gravel', 'terrain', {
    baseColor: [1, 1, 1, 1], metalness: 0, roughness: 0.85,
    graph: nodeGraph([
      ['uv', 'uv'],
      ['stones', 'spots', { tileable: true, scale: 22, size: 1, variation: 0.5, density: 1, seed: 2 }, { uv: 'uv' }],
      ['pebble', 'colorRamp', { from: [0.08, 0.07, 0.06], to: [0.42, 0.36, 0.28], colorStops: [{ position: 0.5, color: [0.25, 0.24, 0.23] }] }, { t: ['stones', 'id'] }],
      ['gap', 'color', { color: [0.02, 0.018, 0.016] }],
      ['color', 'mix', {}, { a: 'gap', b: 'pebble', t: ['stones', 'mask'] }],
      ['normal', 'normalFromHeight', { strength: 4 }, { height: ['stones', 'dome'], uv: 'uv' }],
    ], { baseColor: 'color', normal: 'normal' }),
  }),
  // 雪：很白、微微发蓝，一点点晶体的闪烁
  plain('snow', 'terrain', {
    baseColor: [1, 1, 1, 1], metalness: 0, roughness: 0.65, diffuseTransmission: { factor: 0.2, color: [0.8, 0.9, 1] },
    graph: nodeGraph([
      ['uv', 'uv'],
      ['drift', 'noise', { tileable: true, scale: 6, octaves: 5, roughness: 0.5, seed: 4 }, { uv: 'uv' }],
      ['tone', 'colorRamp', { from: [0.72, 0.78, 0.88], to: [0.92, 0.94, 0.97] }, { t: 'drift' }],
      ['crystals', 'noise', { tileable: true, scale: 260, octaves: 2 }, { uv: 'uv' }],
      ['glint', 'colorRamp', { from: [0.95, 0.95, 0.95], to: [1.1, 1.1, 1.1] }, { t: 'crystals' }],
      ['color', 'multiply', {}, { a: 'tone', b: 'glint' }],
      ['normal', 'normalFromHeight', { strength: 0.8 }, { height: 'drift', uv: 'uv' }],
    ], { baseColor: 'color', normal: 'normal' }),
  }),
  // 林地：落叶、松针、泥土、一点青苔
  plain('forestFloor', 'terrain', {
    baseColor: [1, 1, 1, 1], metalness: 0, roughness: 0.95,
    graph: nodeGraph([
      ['uv', 'uv'],
      ['litter', 'voronoi', { tileable: true, scale: 30, randomness: 1 }, { uv: 'uv' }],
      ['leaves', 'colorRamp', {
        from: [0.3, 0.1, 0.02], to: [0.12, 0.07, 0.03],
        colorStops: [{ position: 0.35, color: [0.45, 0.22, 0.04] }, { position: 0.65, color: [0.06, 0.1, 0.02] }],
        interpolation: 'constant',
      }, { t: ['litter', 'cell'] }],
      ['patches', 'noise', { tileable: true, scale: 7, octaves: 5, seed: 8 }, { uv: 'uv' }],
      ['soil', 'colorRamp', { from: [0.02, 0.015, 0.01], to: [0.14, 0.1, 0.06] }, { t: 'patches' }],
      ['seam', 'levels', { inMin: 0.02, inMax: 0.08 }, { in: ['litter', 'edge'] }],
      ['color', 'mix', {}, { a: 'soil', b: 'leaves', t: 'seam' }],
      ['normal', 'normalFromHeight', { strength: 2.5 }, { height: 'seam', uv: 'uv' }],
    ], { baseColor: 'color', normal: 'normal' }),
  }),
  // 龟裂的泥地（旱地）：一块块翘起的泥片，缝里深
  plain('crackedEarth', 'terrain', {
    baseColor: [1, 1, 1, 1], metalness: 0, roughness: 0.95,
    graph: nodeGraph([
      ['uv', 'uv'],
      ['cracks', 'cracks', { tileable: true, scale: 5, width: 0.035, warp: 0.5, seed: 4 }, { uv: 'uv' }],
      ['dust', 'noise', { tileable: true, scale: 20, octaves: 5, seed: 2 }, { uv: 'uv' }],
      ['clay', 'colorRamp', { from: [0.3, 0.2, 0.1], to: [0.58, 0.44, 0.27] }, { t: 'dust' }],
      ['deep', 'color', { color: [0.04, 0.025, 0.012] }],
      ['color', 'mix', {}, { a: 'clay', b: 'deep', t: ['cracks', 'mask'] }],
      ['normal', 'normalFromHeight', { strength: 4 }, { height: ['cracks', 'height'], uv: 'uv' }],
    ], { baseColor: 'color', normal: 'normal' }),
  }),
];
