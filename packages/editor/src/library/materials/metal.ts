/** 金属：纯参数的（基础色是 F0，取自常见的实测值：Filament、glTF 样例的金属表）和节点图做的（锈、镀锌的花纹、波纹板、凿花的铜）。 */
import { nodeGraph, plain, type LibraryMaterial } from '../define.ts';

export const METAL_MATERIALS: readonly LibraryMaterial[] = [
  plain('gold', 'metal', { baseColor: [1, 0.766, 0.336, 1], metalness: 1, roughness: 0.25 }),
  plain('copper', 'metal', { baseColor: [0.955, 0.638, 0.538, 1], metalness: 1, roughness: 0.3 }),
  plain('chrome', 'metal', { baseColor: [0.55, 0.556, 0.554, 1], metalness: 1, roughness: 0.05 }),
  plain('brushedSteel', 'metal', { baseColor: [0.56, 0.57, 0.58, 1], metalness: 1, roughness: 0.35, anisotropy: { strength: 0.8 } }),
  plain('silver', 'metal', { baseColor: [0.972, 0.96, 0.915, 1], metalness: 1, roughness: 0.15 }),
  plain('roseGold', 'metal', { baseColor: [0.96, 0.66, 0.6, 1], metalness: 1, roughness: 0.2 }),
  plain('brass', 'metal', { baseColor: [0.91, 0.78, 0.42, 1], metalness: 1, roughness: 0.3 }),
  plain('aluminium', 'metal', { baseColor: [0.913, 0.922, 0.924, 1], metalness: 1, roughness: 0.35, anisotropy: { strength: 0.3 } }),
  plain('titanium', 'metal', { baseColor: [0.542, 0.497, 0.449, 1], metalness: 1, roughness: 0.4 }),
  plain('gunmetal', 'metal', { baseColor: [0.2, 0.21, 0.23, 1], metalness: 1, roughness: 0.45 }),
  // 镜子：银镀层，没有一点粗糙
  plain('mirror', 'metal', { baseColor: [0.96, 0.96, 0.95, 1], metalness: 1, roughness: 0 }),
  // 阳极氧化的钛：氧化膜的厚度让反射随视角变色（薄膜干涉）
  plain('anodizedTitanium', 'metal', { baseColor: [0.542, 0.497, 0.449, 1], metalness: 1, roughness: 0.3, iridescence: { factor: 1, ior: 2.2, thickness: 320 } }),
  // 铸铁：深灰、粗糙，表面细小的砂眼和起伏
  plain('castIron', 'metal', {
    baseColor: [1, 1, 1, 1], metalness: 1, roughness: 0.7,
    graph: nodeGraph([
      ['uv', 'uv'],
      ['grain', 'noise', { tileable: true, scale: 60, octaves: 4, roughness: 0.6 }, { uv: 'uv' }],
      ['pits', 'spots', { tileable: true, scale: 40, size: 0.4, variation: 0.8, density: 0.5, seed: 2 }, { uv: 'uv' }],
      ['tone', 'colorRamp', { from: [0.1, 0.1, 0.11], to: [0.22, 0.22, 0.23] }, { t: 'grain' }],
      ['dark', 'color', { color: [0.03, 0.03, 0.03] }],
      ['color', 'mix', {}, { a: 'tone', b: 'dark', t: ['pits', 'mask'] }],
      ['rough', 'colorRamp', { from: [0.55, 0.55, 0.55], to: [0.85, 0.85, 0.85] }, { t: 'grain' }],
      ['normal', 'normalFromHeight', { strength: 0.8 }, { height: 'grain', uv: 'uv' }],
    ], { baseColor: 'color', roughness: 'rough', normal: 'normal' }),
  }),
  // 生锈的铁：成片的锈（噪声的阈值）加锈蚀的小坑；锈的地方不是金属、粗糙，没锈的地方是亮钢
  plain('rustedIron', 'metal', {
    baseColor: [1, 1, 1, 1], metalness: 1, roughness: 0.5,
    graph: nodeGraph([
      ['uv', 'uv'],
      ['patches', 'noise', { tileable: true, scale: 5, octaves: 5, roughness: 0.6, seed: 3 }, { uv: 'uv' }],
      ['fine', 'noise', { tileable: true, scale: 40, octaves: 4, seed: 7 }, { uv: 'uv' }],
      ['pits', 'spots', { tileable: true, scale: 30, size: 0.5, variation: 0.7, density: 0.6 }, { uv: 'uv' }],
      ['cover', 'levels', { inMin: 0.4, inMax: 0.58 }, { in: 'patches' }],
      ['rust', 'add', {}, { a: 'cover', b: ['pits', 'mask'] }],
      ['rustTone', 'colorRamp', { from: [0.16, 0.045, 0.012], to: [0.45, 0.17, 0.06] }, { t: 'fine' }],
      ['steel', 'color', { color: [0.5, 0.5, 0.52] }],
      ['color', 'mix', {}, { a: 'steel', b: 'rustTone', t: 'rust' }],
      ['bright', 'value', { value: 1 }],
      ['dull', 'value', { value: 0.1 }],
      ['metalness', 'mix', {}, { a: 'bright', b: 'dull', t: 'rust' }],
      ['smooth', 'value', { value: 0.4 }],
      ['coarse', 'value', { value: 0.92 }],
      ['roughness', 'mix', {}, { a: 'smooth', b: 'coarse', t: 'rust' }],
      ['normal', 'normalFromHeight', { strength: 1.2 }, { height: 'fine', uv: 'uv' }],
    ], { baseColor: 'color', metalness: 'metalness', roughness: 'roughness', normal: 'normal' }),
  }),
  // 镀锌钢板：锌花（一块块不同亮度的晶粒）
  plain('galvanizedSteel', 'metal', {
    baseColor: [1, 1, 1, 1], metalness: 1, roughness: 0.4,
    graph: nodeGraph([
      ['uv', 'uv'],
      ['spangle', 'voronoi', { tileable: true, scale: 14 }, { uv: 'uv' }],
      ['tone', 'colorRamp', { from: [0.42, 0.44, 0.46], to: [0.72, 0.74, 0.76] }, { t: ['spangle', 'cell'] }],
      ['sheen', 'noise', { tileable: true, scale: 90, octaves: 3 }, { uv: 'uv' }],
      ['fine', 'colorRamp', { from: [0.92, 0.92, 0.92], to: [1.06, 1.06, 1.06] }, { t: 'sheen' }],
      ['color', 'multiply', {}, { a: 'tone', b: 'fine' }],
      ['rough', 'colorRamp', { from: [0.3, 0.3, 0.3], to: [0.5, 0.5, 0.5] }, { t: ['spangle', 'cell'] }],
    ], { baseColor: 'color', roughness: 'rough' }),
  }),
  // 波纹板：正弦的波，法线从波高算
  plain('corrugatedMetal', 'metal', {
    baseColor: [1, 1, 1, 1], metalness: 1, roughness: 0.45,
    graph: nodeGraph([
      ['uv', 'uv'],
      ['ribs', 'wave', { frequency: 12, angle: 0, shape: 'sine' }, { uv: 'uv' }],
      ['wear', 'noise', { tileable: true, scale: 6, octaves: 4, seed: 5 }, { uv: 'uv' }],
      ['tone', 'colorRamp', { from: [0.5, 0.52, 0.54], to: [0.74, 0.76, 0.78] }, { t: 'wear' }],
      ['normal', 'normalFromHeight', { strength: 6 }, { height: 'ribs', uv: 'uv' }],
    ], { baseColor: 'tone', normal: 'normal' }),
  }),
  // 花纹钢板（防滑）：菱形的凸条，旋转 45° 的棋盘格当高度
  plain('diamondPlate', 'metal', {
    baseColor: [1, 1, 1, 1], metalness: 1, roughness: 0.4,
    graph: nodeGraph([
      ['uv', 'uvTransform', { scale: [1, 1], rotation: 45 }],
      ['ribs', 'checker', { scale: 14 }, { uv: 'uv' }],
      ['scuff', 'noise', { tileable: true, scale: 20, octaves: 4, seed: 9 }, { uv: 'uv' }],
      ['tone', 'colorRamp', { from: [0.45, 0.47, 0.49], to: [0.7, 0.72, 0.74] }, { t: 'scuff' }],
      ['normal', 'normalFromHeight', { strength: 3 }, { height: 'ribs', uv: 'uv' }],
    ], { baseColor: 'tone', normal: 'normal' }),
  }),
  // 冲孔板：圆孔阵列，孔里是黑的
  plain('perforatedSteel', 'metal', {
    baseColor: [1, 1, 1, 1], metalness: 1, roughness: 0.35,
    graph: nodeGraph([
      ['uv', 'uv'],
      ['holes', 'circle', { radius: 0.3, softness: 0.015, repeat: 10 }, { uv: 'uv' }],
      ['steel', 'color', { color: [0.56, 0.57, 0.58] }],
      ['void', 'color', { color: [0.005, 0.005, 0.005] }],
      ['color', 'mix', {}, { a: 'steel', b: 'void', t: 'holes' }],
      ['normal', 'normalFromHeight', { strength: 2 }, { height: ['holes', 'mask'], uv: 'uv' }],
    ], { baseColor: 'color', normal: 'normal' }),
  }),
  // 锤纹铜：一个个小凹坑（Voronoi 的距离当高度）
  plain('hammeredCopper', 'metal', {
    baseColor: [1, 1, 1, 1], metalness: 1, roughness: 0.32,
    graph: nodeGraph([
      ['uv', 'uv'],
      ['dimples', 'voronoi', { tileable: true, scale: 9 }, { uv: 'uv' }],
      ['tone', 'colorRamp', { from: [0.75, 0.45, 0.38], to: [0.97, 0.66, 0.56] }, { t: ['dimples', 'distance'] }],
      ['normal', 'normalFromHeight', { strength: 4 }, { height: ['dimples', 'distance'], uv: 'uv' }],
    ], { baseColor: 'tone', normal: 'normal' }),
  }),
  // 铜绿：铜在缝里、背风的地方（遮蔽）长出绿色的锈，成片的噪声打散
  plain('patinaCopper', 'smart', {
    baseColor: [1, 1, 1, 1], metalness: 1, roughness: 0.4,
    graph: nodeGraph([
      ['uv', 'uv'],
      ['blotch', 'noise', { tileable: true, scale: 7, octaves: 5, roughness: 0.6, seed: 4 }, { uv: 'uv' }],
      ['shadowed', 'occlusionMask', { from: 0.05, to: 0.5 }],
      ['corners', 'curvatureMask', { from: 0.05, to: 0.3 }],
      ['damp', 'add', {}, { a: 'shadowed', b: ['corners', 'cavities'] }],
      ['spread', 'multiply', {}, { a: 'damp', b: 'blotch' }],
      ['cover', 'levels', { inMin: 0.12, inMax: 0.4 }, { in: 'spread' }],
      ['grain', 'noise', { tileable: true, scale: 50, octaves: 4, seed: 1 }, { uv: 'uv' }],
      ['verdigris', 'colorRamp', { from: [0.06, 0.28, 0.2], to: [0.2, 0.55, 0.42] }, { t: 'grain' }],
      ['copper', 'color', { color: [0.82, 0.48, 0.38] }],
      ['color', 'mix', {}, { a: 'copper', b: 'verdigris', t: 'cover' }],
      ['bright', 'value', { value: 1 }],
      ['dull', 'value', { value: 0 }],
      ['metalness', 'mix', {}, { a: 'bright', b: 'dull', t: 'cover' }],
      ['smooth', 'value', { value: 0.35 }],
      ['coarse', 'value', { value: 0.85 }],
      ['roughness', 'mix', {}, { a: 'smooth', b: 'coarse', t: 'cover' }],
      ['normal', 'normalFromHeight', { strength: 0.8 }, { height: 'grain', uv: 'uv' }],
    ], { baseColor: 'color', metalness: 'metalness', roughness: 'roughness', normal: 'normal' }),
  }),
];
