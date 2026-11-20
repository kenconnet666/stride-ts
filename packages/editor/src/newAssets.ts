/**
 * 编辑器"新建"出来的资源的初始内容（前端的资源浏览器用；只有数据，没有 Node 的依赖）。都是最小的合法文件，建出来以后在
 * 编辑器里接着改：场景是空的、材质是浅灰的、基本形状是 JSON 写的模型（content/modelFile.ts）、UI 页面是一块全屏的 Canvas。
 */
import { PROCEDURAL_SHAPES, type BrushFile, type MaterialFile, type ProceduralModelFile, type SceneFile, type TimelineFile, type UIFile } from '@stride-ts/engine/content-format';
import type { AssetKind } from './protocol.ts';

export type ProceduralShapeType = (typeof PROCEDURAL_SHAPES)[number];

/** "新建"菜单里的一项：建出的资源的种类、默认的名字、内容（菜单里的文字在界面的翻译表里，按 id 和 shape 取）。 */
export interface NewAssetOption {
  readonly id: 'scene' | 'material' | 'ui' | 'timeline' | 'brush' | `model:${ProceduralShapeType}`;
  readonly kind: AssetKind;
  /** 基本形状的模型是哪种形状。 */
  readonly shape?: ProceduralShapeType;
  /** 默认的名字（同一个文件夹里重了就加数字）。 */
  readonly name: string;
  readonly content: (name: string) => object;
}

export const NEW_ASSET_OPTIONS: readonly NewAssetOption[] = [
  { id: 'scene', kind: 'scene', name: 'NewScene', content: (name): SceneFile => ({ name, entities: [] }) },
  { id: 'material', kind: 'material', name: 'NewMaterial', content: (name): MaterialFile => ({ name, baseColor: [0.8, 0.8, 0.8, 1], metalness: 0, roughness: 0.5 }) },
  ...PROCEDURAL_SHAPES.map((type): NewAssetOption => ({
    id: `model:${type}`,
    kind: 'model',
    shape: type,
    name: type[0]!.toUpperCase() + type.slice(1),
    content: (): ProceduralModelFile => ({ format: 1, procedural: { type } as ProceduralModelFile['procedural'], materials: [] }),
  })),
  {
    id: 'ui',
    kind: 'ui',
    name: 'NewPage',
    content: (name): UIFile => ({ name, designResolution: [1280, 720], root: 0, elements: [{ type: 'Canvas', props: {} }] }),
  },
  { id: 'timeline', kind: 'timeline', name: 'NewTimeline', content: (name): TimelineFile => ({ name, duration: 5, tracks: [] }) },
  // 白盒：一块 8 x 8 米的地板，在上面接着搭
  { id: 'brush', kind: 'brush', name: 'NewGreybox', content: (name): BrushFile => ({ name, materials: [null], brushes: [{ name: 'Floor', kind: 'box', operation: 'add', position: [0, -0.25, 0], size: [8, 0.5, 8] }] }) },
];

/** folder 里给 name 找一个没被占的内容路径：name、name2、name3……（taken 是已有的 `种类:路径`）。 */
export function freeAssetPath(folder: string, name: string, kind: AssetKind, taken: ReadonlySet<string>): string {
  const at = (suffix: string) => (folder ? `${folder}/${name}${suffix}` : `${name}${suffix}`);
  for (let n = 1; ; n++) {
    const candidate = at(n === 1 ? '' : String(n));
    if (!taken.has(`${kind}:${candidate}`)) return candidate;
  }
}
