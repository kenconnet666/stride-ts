/**
 * 可破碎物体的预先切块（`.fracture.json`，Stride 没有）：一个完整的模型按 Voronoi 切成几块，编辑器后端烘成同名的碎块模型
 * （pipeline 的 bakers/fractureModel.ts：原生工具模块的 `fractureMesh` 切，modeling/fracture.ts 分网格）。碎块的外表面沿用原模型
 * 的材质、UV 和法线，切出来的断面用 interiorMaterial。运行时 `Breakable` 脚本挂在完整的物体上，撞得够狠时换成这些碎块。
 * 同一个文件、同一个种子切出来一样。
 */

import { s, type Infer, type InputOf } from '../schema/schema.ts';

export const FRACTURE = s.object({
  name: s.string(),
  model: s.asset('model').describe('the intact model to break into pieces'),
  count: s.integer(2, 256).default(8).describe('how many pieces (Voronoi cells; empty cells are dropped)'),
  seed: s.integer(0, 2 ** 31 - 1).default(1).describe('random seed of the cut'),
  interiorMaterial: s.asset('material').optional().describe('material of the broken faces inside; the material of the first mesh when missing'),
  uvScale: s.number({ min: 0.001, step: 0.05, unit: 'm' }).default(1).describe('metres per texture repeat on the broken faces'),
});

/** 碎块文件的样子（有默认值的可以不写）。 */
export type FractureFile = InputOf<typeof FRACTURE>;
/** 解析以后的（默认值补齐）。 */
export type Fracture = Infer<typeof FRACTURE>;
