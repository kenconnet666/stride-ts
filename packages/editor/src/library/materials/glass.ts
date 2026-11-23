/** 玻璃、水、冰、亚克力：折射的透射（后面的东西偏开、被粗糙度糊开，厚的带吸收的颜色）和薄的玻璃。 */
import { nodeGraph, plain, type LibraryMaterial } from '../define.ts';

/** 有色的薄玻璃：透射加一点吸收（走 distance 米后剩下 tint）。 */
const tinted = (id: string, tint: readonly [number, number, number], distance = 0.03) => plain(id, 'glass', {
  baseColor: [1, 1, 1, 1], metalness: 0, roughness: 0.02,
  transmission: { factor: 1, ior: 1.5, thickness: 0.01, attenuationColor: tint, attenuationDistance: distance },
});

export const GLASS_MATERIALS: readonly LibraryMaterial[] = [
  // 玻璃：漫反射的颜色只当透过去的颜色（不算漫反射光照），同 Stride 的薄玻璃
  plain('clearGlass', 'glass', { baseColor: [0.92, 0.96, 0.96, 1], metalness: 0, roughness: 0.03, glass: { refractiveIndex: 1.5 }, diffuseShading: false }),
  // 透射（折射后面的东西）：磨砂玻璃是薄的面、按粗糙度糊；水晶是实心的，偏得多，带一点蓝绿的吸收
  plain('frostedGlass', 'glass', { baseColor: [1, 1, 1, 1], metalness: 0, roughness: 0.35, transmission: { factor: 1, ior: 1.5 } }),
  plain('crystal', 'glass', { baseColor: [1, 1, 1, 1], metalness: 0, roughness: 0.02, transmission: { factor: 1, ior: 1.6, thickness: 0.5, attenuationColor: [0.75, 0.92, 0.95], attenuationDistance: 0.6 } }),
  tinted('greenGlass', [0.45, 0.8, 0.55]),
  tinted('bronzeGlass', [0.65, 0.45, 0.3]),
  tinted('blueGlass', [0.4, 0.6, 0.9]),
  // 酒瓶的深绿玻璃：很厚的色
  tinted('bottleGlass', [0.1, 0.32, 0.14], 0.012),
  // 亚克力：比玻璃折射得少，无色或带色
  plain('clearAcrylic', 'glass', { baseColor: [1, 1, 1, 1], metalness: 0, roughness: 0.05, transmission: { factor: 1, ior: 1.49, thickness: 0.01 } }),
  tinted('redAcrylic', [0.9, 0.08, 0.06], 0.02),
  // 水：折射率 1.33，淡淡的蓝绿，深了吸红光
  plain('water', 'glass', { baseColor: [1, 1, 1, 1], metalness: 0, roughness: 0.01, transmission: { factor: 1, ior: 1.33, thickness: 0.5, attenuationColor: [0.7, 0.88, 0.95], attenuationDistance: 2 } }),
  // 冰：糊一点，里面有裂纹和气泡（法线上的细纹）
  plain('ice', 'glass', {
    baseColor: [1, 1, 1, 1], metalness: 0, roughness: 0.12,
    transmission: { factor: 1, ior: 1.31, thickness: 0.25, attenuationColor: [0.72, 0.9, 1], attenuationDistance: 0.4 },
    graph: nodeGraph([
      ['uv', 'uv'],
      ['cracks', 'cracks', { scale: 4, width: 0.02, warp: 0.8, seed: 3 }, { uv: 'uv' }],
      ['bubbles', 'spots', { scale: 18, size: 0.3, variation: 0.9, density: 0.4 }, { uv: 'uv' }],
      ['relief', 'add', {}, { a: ['cracks', 'mask'], b: ['bubbles', 'dome'] }],
      ['rough', 'colorRamp', { from: [0.06, 0.06, 0.06], to: [0.4, 0.4, 0.4] }, { t: ['cracks', 'mask'] }],
      ['normal', 'normalFromHeight', { strength: 1.5 }, { height: 'relief', uv: 'uv' }],
    ], { roughness: 'rough', normal: 'normal' }),
  }),
  // 肥皂泡：薄的玻璃，膜很薄，薄膜干涉出彩虹色
  plain('soapBubble', 'glass', {
    baseColor: [1, 1, 1, 1], metalness: 0, roughness: 0.02, glass: { refractiveIndex: 1.33 }, diffuseShading: false,
    iridescence: { factor: 1, ior: 1.33, thickness: 380 },
  }),
  // 压花玻璃（卫生间的磨砂条纹）：平的，法线上一条条的波
  plain('rippledGlass', 'glass', {
    baseColor: [1, 1, 1, 1], metalness: 0, roughness: 0.08, transmission: { factor: 1, ior: 1.5, thickness: 0.01 },
    graph: nodeGraph([
      ['uv', 'uv'],
      ['ripple', 'wave', { frequency: 36, angle: 0, shape: 'sine' }, { uv: 'uv' }],
      ['normal', 'normalFromHeight', { strength: 5 }, { height: 'ripple', uv: 'uv' }],
    ], { normal: 'normal' }),
  }),
  // 彩色玻璃窗：Voronoi 的每一块一个颜色，块之间是黑的铅条
  plain('stainedGlass', 'glass', {
    baseColor: [1, 1, 1, 1], metalness: 0, roughness: 0.03,
    transmission: { factor: 1, ior: 1.5, thickness: 0.01 },
    graph: nodeGraph([
      ['uv', 'uv'],
      ['cells', 'voronoi', { scale: 6 }, { uv: 'uv' }],
      ['glass', 'colorRamp', {
        from: [0.7, 0.05, 0.04], to: [0.9, 0.5, 0.05],
        colorStops: [{ position: 0.25, color: [0.05, 0.2, 0.7] }, { position: 0.5, color: [0.05, 0.5, 0.2] }, { position: 0.75, color: [0.6, 0.15, 0.55] }],
        interpolation: 'constant',
      }, { t: ['cells', 'cell'] }],
      ['lead', 'levels', { inMin: 0.02, inMax: 0.05 }, { in: ['cells', 'edge'] }],
      ['dark', 'color', { color: [0.02, 0.02, 0.02] }],
      ['color', 'mix', {}, { a: 'dark', b: 'glass', t: 'lead' }],
      ['normal', 'normalFromHeight', { strength: 1 }, { height: 'lead', uv: 'uv' }],
    ], { baseColor: 'color', normal: 'normal' }),
  }),
];
