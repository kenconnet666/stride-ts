/**
 * greybox 的编辑器扩展，示范怎么给工程加一种自己的资源："柱子"（`.pillar.json`）——高度、半径、边数和材质，编辑器后端烘成同名的
 * 模型（JSON 写的圆柱，引擎的 content/modelFile.ts），场景照常引用那个模型。资源浏览器"新建 → 柱子"，属性面板里改了马上重烘、
 * 视口热重载；挪、删柱子时模型跟着走，挪材质时柱子文件里的引用跟着改写。还登记了工程自己的材质节点（src/materialNodes.ts 的
 * "警示条纹"）。工程清单 `stride.project.json` 的 `extension` 指向这里。
 *
 * 顶层只放数据和纯函数：界面（浏览器）也加载这个模块，烘焙在后端（Node）跑。
 */
import { defineAssetKind, defineEditorExtension } from '@stride-ts/editor/extension';
import { asset, fields, integer, nullable, number, string } from '@stride-ts/engine/editor-fields';
import type { AssetKind } from '@stride-ts/engine';
import { GREYBOX_MATERIAL_NODES } from '../src/materialNodes.ts';

/** 柱子的文件。 */
export interface PillarFile {
  readonly name: string;
  /** 高（米）。 */
  readonly height: number;
  /** 半径（米）。 */
  readonly radius: number;
  /** 一圈几条边：6 是六棱柱，32 看着就是圆的。 */
  readonly sides: number;
  /** 材质（内容路径），null 是默认材质。 */
  readonly material: string | null;
}

// AssetKind 认得 'pillar'，references、bake 拿到的文件是 PillarFile
declare module '@stride-ts/engine' {
  interface CustomAssetKinds {
    pillar: PillarFile;
  }
}

const pillar = defineAssetKind<PillarFile>({
  // satisfies：声明合并生效了，AssetKind 认得它（种类名写错时过不了类型检查）
  kind: 'pillar' satisfies AssetKind,
  extension: '.pillar.json',
  label: { 'zh-CN': '柱子', en: 'Pillar' },
  references: (file, refs) => {
    if (file.material !== null) refs.add('material', file, 'material');
  },
  fields: fields<PillarFile>({
    name: string,
    height: { type: number({ min: 0.01, unit: 'm' }), description: 'height' },
    radius: { type: number({ min: 0.01, unit: 'm' }), description: 'radius' },
    sides: { type: integer(3, 64), description: 'sides around (6 is a hexagonal pillar, 32 looks round)' },
    material: nullable(asset('material')),
  }),
  template: { name: 'NewPillar', content: (name) => ({ name, height: 3, radius: 0.3, sides: 8, material: null }) },
  bake: (file, { assetPath, where }) => {
    if (!(file.height > 0) || !(file.radius > 0)) throw new Error(`${where}: height and radius must be positive`);
    if (!Number.isInteger(file.sides) || file.sides < 3) throw new Error(`${where}: sides must be an integer of at least 3`);
    // 圆柱的原点在中心：往上挪半个高，柱子站在地上
    const model = { format: 1, procedural: { type: 'cylinder', height: file.height, radius: file.radius, tessellation: file.sides, localOffset: [0, file.height / 2, 0] }, materials: [file.material] };
    return [{ path: `${assetPath}.model`, bytes: JSON.stringify(model, null, 1) }];
  },
});

export default defineEditorExtension({ assetKinds: [pillar], materialNodes: GREYBOX_MATERIAL_NODES });
