/**
 * 路面的标线和铺装（世界模拟的"材质扩充"）：热熔的标线漆（白、黄，磨掉的地方露出沥青）、斑马线、盲道。沥青本身在混凝土那一类。
 * 数值：新的热熔标线白漆的反照率约 0.6～0.7、黄漆约 0.4～0.5（线性），沥青 0.04～0.08（新的黑、旧的发灰），标线漆比沥青光一些。
 */
import { nodeGraph, plain, type LibraryMaterial } from '../define.ts';

/** 标线漆：paint 是漆的颜色（线性）；磨掉的斑露出沥青；stripes 有值时是斑马线（沿 U 方向这么多条）。 */
const marking = (id: string, paint: readonly [number, number, number], stripes?: number): LibraryMaterial => plain(id, 'road', {
  baseColor: [1, 1, 1, 1], metalness: 0, roughness: 0.6,
  graph: nodeGraph([
    ['uv', 'uv'],
    ['wear', 'noise', { tileable: true, scale: 6, octaves: 4, roughness: 0.55, seed: 5 }, { uv: 'uv' }],
    ['fine', 'noise', { tileable: true, scale: 60, octaves: 3, seed: 9 }, { uv: 'uv' }],
    // 漆在噪声高的地方，磨掉的斑边缘过渡很窄
    ['kept', 'levels', { inMin: 0.3, inMax: 0.36 }, { in: 'wear' }],
    ...(stripes ? [
      ['bars', 'wave', { frequency: stripes, shape: 'square' }, { uv: 'uv' }] as const,
      ['cover', 'multiply', {}, { a: 'kept', b: 'bars' }] as const,
    ] : [['cover', 'levels', { inMin: 0, inMax: 1 }, { in: 'kept' }] as const]),
    ['paint', 'color', { color: paint }],
    ['asphalt', 'colorRamp', { from: [0.035, 0.035, 0.035], to: [0.075, 0.073, 0.07] }, { t: 'fine' }],
    ['color', 'mix', {}, { a: 'asphalt', b: 'paint', t: 'cover' }],
    ['paintRough', 'value', { value: 0.55 }],
    ['asphaltRough', 'value', { value: 0.9 }],
    ['rough', 'mix', {}, { a: 'asphaltRough', b: 'paintRough', t: 'cover' }],
    ['normal', 'normalFromHeight', { strength: 0.6 }, { height: 'fine', uv: 'uv' }],
  ], { baseColor: 'color', roughness: 'rough', normal: 'normal' }),
});

export const ROAD_MATERIALS: readonly LibraryMaterial[] = [
  marking('roadMarkingWhite', [0.62, 0.62, 0.6]),
  marking('roadMarkingYellow', [0.68, 0.42, 0.03]),
  // 斑马线：一块 UV 里 4 条白漆
  marking('crosswalk', [0.62, 0.62, 0.6], 4),
  // 盲道：黄色的水泥砖，一排排圆点的凸起
  plain('tactilePaving', 'road', {
    baseColor: [1, 1, 1, 1], metalness: 0, roughness: 0.75,
    graph: nodeGraph([
      ['uv', 'uv'],
      ['domes', 'spots', { tileable: true, scale: 6, size: 0.55, variation: 0, density: 1, seed: 1 }, { uv: 'uv' }],
      ['grain', 'noise', { tileable: true, scale: 50, octaves: 3, seed: 4 }, { uv: 'uv' }],
      ['color', 'colorRamp', { from: [0.42, 0.28, 0.01], to: [0.6, 0.42, 0.03] }, { t: 'grain' }],
      // 凸起是主角，砖面的细麻点只占一点（不然盖过了圆点）
      ['grainScale', 'value', { value: 0.15 }],
      ['fineGrain', 'multiply', {}, { a: 'grain', b: 'grainScale' }],
      ['height', 'add', {}, { a: ['domes', 'dome'], b: 'fineGrain' }],
      ['normal', 'normalFromHeight', { strength: 2.5 }, { height: 'height', uv: 'uv' }],
    ], { baseColor: 'color', normal: 'normal' }),
  }),
];
