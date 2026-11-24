/**
 * 车辆（世界模拟的"材质扩充"）：车漆用清漆层（材质的 coat：Physically Based 数据库的车漆就是底漆加一层 F0 0.04 的清漆）——金属漆的
 * 底漆里有细小的金属片（半金属、闪），纯色漆的底漆不是金属，亚光漆没有清漆；车窗的贴膜玻璃；车灯罩是聚碳酸酯（折射率 1.585，
 * 同数据库的 Plastic (PC)）。轮胎在塑料那一类（tireRubber，数据库的 Tire 反照率 0.023）。
 */
import { nodeGraph, plain, type LibraryMaterial } from '../define.ts';

/** 清漆：光亮、自己的粗糙度很小。 */
const COAT = { factor: 1, roughness: 0.03 } as const;

export const VEHICLE_MATERIALS: readonly LibraryMaterial[] = [
  // 金属漆：底漆里撒着细小的金属片（亮度、粗糙度一点点不一样，近看闪），上面一层清漆
  plain('metallicCarPaint', 'vehicle', {
    baseColor: [1, 1, 1, 1], metalness: 0.65, roughness: 0.35, coat: COAT,
    graph: nodeGraph([
      ['uv', 'uv'],
      ['flakes', 'noise', { tileable: true, scale: 600, octaves: 1, seed: 7 }, { uv: 'uv' }],
      ['color', 'colorRamp', { from: [0.02, 0.05, 0.2], to: [0.06, 0.14, 0.42] }, { t: 'flakes' }],
      ['rough', 'colorRamp', { from: [0.25, 0.25, 0.25], to: [0.45, 0.45, 0.45] }, { t: 'flakes' }],
    ], { baseColor: 'color', roughness: 'rough' }),
  }),
  // 纯色漆：不是金属的底漆，清漆让它像镜子一样映出周围
  plain('solidCarPaint', 'vehicle', { baseColor: [0.85, 0.85, 0.83, 1], metalness: 0, roughness: 0.4, coat: COAT }),
  // 亚光漆：没有清漆，半金属、粗糙
  plain('matteCarPaint', 'vehicle', { baseColor: [0.05, 0.05, 0.055, 1], metalness: 0.3, roughness: 0.55 }),
  // 车窗的贴膜玻璃：透过去的光大半被吸收，外面看是深色的、映着天
  plain('tintedCarGlass', 'vehicle', {
    baseColor: [1, 1, 1, 1], metalness: 0, roughness: 0.02,
    transmission: { factor: 1, ior: 1.52, thickness: 0.005, attenuationColor: [0.18, 0.2, 0.2], attenuationDistance: 0.004 },
  }),
  // 车灯罩：透明的聚碳酸酯
  plain('headlightLens', 'vehicle', { baseColor: [1, 1, 1, 1], metalness: 0, roughness: 0.04, transmission: { factor: 1, ior: 1.585, thickness: 0.004 } }),
  // 尾灯罩：红色的聚碳酸酯
  plain('tailLightLens', 'vehicle', {
    baseColor: [1, 1, 1, 1], metalness: 0, roughness: 0.05,
    transmission: { factor: 1, ior: 1.585, thickness: 0.005, attenuationColor: [0.9, 0.06, 0.04], attenuationDistance: 0.003 },
  }),
];
