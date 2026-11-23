/** 塑料、橡胶和漆。 */
import { nodeGraph, plain, type LibraryMaterial } from '../define.ts';

export const PLASTIC_MATERIALS: readonly LibraryMaterial[] = [
  plain('carPaint', 'plastic', { baseColor: [0.45, 0.01, 0.015, 1], metalness: 0, roughness: 0.2 }),
  plain('glossyPlastic', 'plastic', { baseColor: [0.03, 0.25, 0.75, 1], metalness: 0, roughness: 0.25 }),
  plain('mattePlastic', 'plastic', { baseColor: [0.75, 0.75, 0.72, 1], metalness: 0, roughness: 0.7 }),
  plain('rubber', 'plastic', { baseColor: [0.02, 0.02, 0.02, 1], metalness: 0, roughness: 0.9 }),
  // 钢琴漆黑：很亮的黑
  plain('glossyBlack', 'plastic', { baseColor: [0.012, 0.012, 0.014, 1], metalness: 0, roughness: 0.08 }),
  // 白色家电的外壳
  plain('whiteGloss', 'plastic', { baseColor: [0.85, 0.85, 0.83, 1], metalness: 0, roughness: 0.2 }),
  // 珠光漆：深紫的底，薄膜干涉的一点彩虹闪色
  plain('pearlescentPaint', 'plastic', { baseColor: [0.06, 0.02, 0.12, 1], metalness: 0, roughness: 0.15, iridescence: { factor: 0.6, ior: 1.6, thickness: 350 } }),
  // 牛奶桶、半透明的塑料：背光时透光
  plain('milkPlastic', 'plastic', { baseColor: [0.85, 0.85, 0.8, 1], metalness: 0, roughness: 0.45, diffuseTransmission: { factor: 0.5, color: [0.95, 0.95, 0.9] } }),
  // 硅胶：软、半透明，一点点透光
  plain('silicone', 'plastic', { baseColor: [0.8, 0.12, 0.08, 1], metalness: 0, roughness: 0.5, diffuseTransmission: { factor: 0.3, color: [1, 0.25, 0.15] } }),
  // ABS 外壳：哑黑，表面压了一层细的皮纹
  plain('abs', 'plastic', {
    baseColor: [1, 1, 1, 1], metalness: 0, roughness: 0.55,
    graph: nodeGraph([
      ['uv', 'uv'],
      ['grain', 'noise', { scale: 120, octaves: 3, roughness: 0.7 }, { uv: 'uv' }],
      ['tone', 'colorRamp', { from: [0.025, 0.025, 0.027], to: [0.05, 0.05, 0.055] }, { t: 'grain' }],
      ['normal', 'normalFromHeight', { strength: 0.5 }, { height: 'grain', uv: 'uv' }],
    ], { baseColor: 'tone', normal: 'normal' }),
  }),
  // 软触感涂层：很粗糙、一点布料似的光泽
  plain('softTouch', 'plastic', {
    baseColor: [0.05, 0.05, 0.06, 1], metalness: 0, roughness: 0.85, sheen: { color: [0.18, 0.18, 0.2], roughness: 0.6 },
  }),
  // 轮胎橡胶：很黑、很粗糙，细小的颗粒
  plain('tireRubber', 'plastic', {
    baseColor: [1, 1, 1, 1], metalness: 0, roughness: 0.95,
    graph: nodeGraph([
      ['uv', 'uv'],
      ['grain', 'noise', { scale: 90, octaves: 4, roughness: 0.65 }, { uv: 'uv' }],
      ['pits', 'spots', { scale: 50, size: 0.35, variation: 0.8, density: 0.5 }, { uv: 'uv' }],
      ['tone', 'colorRamp', { from: [0.012, 0.012, 0.012], to: [0.05, 0.05, 0.05] }, { t: 'grain' }],
      ['normal', 'normalFromHeight', { strength: 0.7 }, { height: ['pits', 'dome'], uv: 'uv' }],
    ], { baseColor: 'tone', normal: 'normal' }),
  }),
  // EVA 泡棉：亮色、无光，满是小气孔
  plain('foam', 'plastic', {
    baseColor: [1, 1, 1, 1], metalness: 0, roughness: 0.95,
    graph: nodeGraph([
      ['uv', 'uv'],
      ['pores', 'spots', { scale: 70, size: 0.6, variation: 0.8, density: 0.7 }, { uv: 'uv' }],
      ['body', 'color', { color: [0.05, 0.33, 0.8] }],
      ['hollow', 'color', { color: [0.02, 0.15, 0.4] }],
      ['color', 'mix', {}, { a: 'body', b: 'hollow', t: ['pores', 'mask'] }],
      ['normal', 'normalFromHeight', { strength: 1.5 }, { height: ['pores', 'dome'], uv: 'uv' }],
    ], { baseColor: 'color', normal: 'normal' }),
  }),
];
