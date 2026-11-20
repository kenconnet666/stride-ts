/**
 * 编辑器"新建"出来的资源的初始内容（前端的资源浏览器用；只有数据，没有 Node 的依赖）。都是最小的合法文件，建出来以后在
 * 编辑器里接着改：场景是空的、材质是浅灰的、基本形状是 JSON 写的模型（content/modelFile.ts）、UI 页面是一块全屏的 Canvas。
 */
import { PROCEDURAL_SHAPES, type MaterialFile, type ProceduralModelFile, type SceneFile, type UIFile } from '@stride-ts/engine/content-format';
import type { AssetKind } from './protocol.ts';

export type ProceduralShapeType = (typeof PROCEDURAL_SHAPES)[number];

/** "新建"菜单里的一项：建出的资源的种类、默认的名字、内容。 */
export interface NewAssetOption {
  readonly id: string;
  readonly label: string;
  readonly kind: AssetKind;
  /** 默认的名字（同一个文件夹里重了就加数字）。 */
  readonly name: string;
  readonly content: (name: string) => object;
}

const SHAPE_LABELS: Readonly<Record<ProceduralShapeType, string>> = {
  cube: '立方体', plane: '平面', sphere: '球', geoSphere: '测地球', capsule: '胶囊', cylinder: '圆柱', torus: '圆环', cone: '圆锥', teapot: '茶壶',
};

export const NEW_ASSET_OPTIONS: readonly NewAssetOption[] = [
  { id: 'scene', label: '场景', kind: 'scene', name: 'NewScene', content: (name): SceneFile => ({ name, entities: [] }) },
  { id: 'material', label: '材质', kind: 'material', name: 'NewMaterial', content: (name): MaterialFile => ({ name, baseColor: [0.8, 0.8, 0.8, 1], metalness: 0, roughness: 0.5 }) },
  ...PROCEDURAL_SHAPES.map((type): NewAssetOption => ({
    id: `model:${type}`,
    label: `基本形状：${SHAPE_LABELS[type]}`,
    kind: 'model',
    name: type[0]!.toUpperCase() + type.slice(1),
    content: (): ProceduralModelFile => ({ format: 1, procedural: { type } as ProceduralModelFile['procedural'], materials: [] }),
  })),
  {
    id: 'ui',
    label: 'UI 页面',
    kind: 'ui',
    name: 'NewPage',
    content: (name): UIFile => ({ name, designResolution: [1280, 720], root: 0, elements: [{ type: 'Canvas', props: {} }] }),
  },
];

/** folder 里给 name 找一个没被占的内容路径：name、name2、name3……（taken 是已有的 `种类:路径`）。 */
export function freeAssetPath(folder: string, name: string, kind: AssetKind, taken: ReadonlySet<string>): string {
  const at = (suffix: string) => (folder ? `${folder}/${name}${suffix}` : `${name}${suffix}`);
  for (let n = 1; ; n++) {
    const candidate = at(n === 1 ? '' : String(n));
    if (!taken.has(`${kind}:${candidate}`)) return candidate;
  }
}
