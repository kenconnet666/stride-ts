/**
 * 编辑器"新建"出来的资源的初始内容（前端的资源浏览器用；只有数据，没有 Node 的依赖）。都是最小的合法文件，建出来以后在
 * 编辑器里接着改：场景是空的、材质是浅灰的、基本形状是 JSON 写的模型（content/modelFile.ts）、UI 页面是一块全屏的 Canvas。
 */
import { PROCEDURAL_SHAPES, type BuildingFile, type CityFile, type WaterFile, type BrushFile, type SdfFile, type PolyMeshFile, type MaterialFile, type ProceduralModelFile, type SceneFile, type SoundFile, type SpriteSheetFile, type TextModelFile, type TimelineFile, type UIFile, type WorldFile, type SplineFile, type TerrainFile, type ScatterFile, type TreeFile } from '@stride-ts/engine/content-format';
import { SOUND_PRESETS, seededRandom } from '@stride-ts/engine/audio-synth';
import { polyCube } from '@stride-ts/engine/modeling';
import type { AssetKind } from './protocol.ts';

export type ProceduralShapeType = (typeof PROCEDURAL_SHAPES)[number];

/** "新建"菜单里的一项：建出的资源的种类、默认的名字、内容（菜单里的文字在界面的翻译表里，按 id 和 shape 取）。 */
export interface NewAssetOption {
  readonly id: 'scene' | 'world' | 'terrain' | 'scatter' | 'tree' | 'building' | 'city' | 'water' | 'material' | 'ui' | 'timeline' | 'brush' | 'sdf' | 'poly' | 'spriteSheet' | 'sound' | 'text' | 'spline' | `model:${ProceduralShapeType}`;
  readonly kind: AssetKind;
  /** 基本形状的模型是哪种形状。 */
  readonly shape?: ProceduralShapeType;
  /** 默认的名字（同一个文件夹里重了就加数字）。 */
  readonly name: string;
  /** 内容；existing 是工程里已有的资源（3D 文字拿它挑一个字体）。 */
  readonly content: (name: string, existing: readonly { readonly kind: AssetKind; readonly path: string }[]) => object;
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
  // 大世界：256 米的格子、一个图层，还没有格子（打开以后在常驻场景里摆好东西、选中后"放进世界"；常驻场景在属性里设）
  { id: 'world', kind: 'world', name: 'NewWorld', content: (name): WorldFile => ({ name, cellSize: 256, layers: [{ name: 'default', loadRadius: 512 }], cells: {} }) },
  // 矢量地形：起伏几百米的山地（侵蚀、一点山脊），场景里给一个实体加 Terrain 组件引用它
  { id: 'terrain', kind: 'terrain', name: 'NewTerrain', content: (name): TerrainFile => ({ name, noise: { seed: 1, octaves: 8, scale: 1500, height: 250, erosion: 0.4, ridged: 0.25, warp: 200 } }) },
  // 参数化的树：一棵三层的阔叶树（材质槽空着用默认材质：树皮、叶片各挑一个材质）
  {
    id: 'tree', kind: 'tree', name: 'NewTree', content: (name): TreeFile => ({
      name, materials: [null, null], seed: 1,
      levels: [{ length: 6, radius: 0.25, children: 6, sections: 8, segments: 8 }, { length: 4, radius: 0.5, angle: 50, start: 0.4, children: 4, sections: 6, segments: 5 }, { length: 1.5, radius: 0.5, angle: 40, start: 0.2, sections: 4, segments: 3 }],
      leaves: { count: 6, size: 1 }, growth: { direction: [0, 1, 0], strength: 0.002 },
    }),
  },
  // 程序化建筑：三层的小楼（底层店面、上面两层窗户，平顶加女儿墙），材质槽空着用默认材质
  {
    id: 'building', kind: 'building', name: 'NewBuilding', content: (name): BuildingFile => ({
      name, materials: [null, null, null, null],
      masses: [{ footprint: { rect: [12, 9] }, floors: 3, floorHeight: 3.2, facade: 'Main', roof: { kind: 'flat', parapet: 0.8 } }],
      facades: { Main: { floors: [{ where: 'ground', pattern: 'Pillar Shop* Pillar' }, { pattern: 'Pillar Window* Pillar', ledge: { height: 0.25, depth: 0.15 } }] } },
      modules: {
        Pillar: { kind: 'pillar', width: 0.6, depth: 0.2 },
        Window: { kind: 'window', width: 2.2, sill: 0.9, head: 0.5, mullions: 1 },
        Shop: { kind: 'window', width: 3.5, sill: 0.3, head: 0.6, margin: 0.2, mullions: 2 },
      },
    }),
  },
  // 城市：先沿工程里的第一条样条摆、楼用工程里的第一个模型（属性面板里再换、加），场景里给一个实体加 City 组件引用它
  { id: 'city', kind: 'city', name: 'NewCity', content: (name, existing): CityFile => ({
    name, seed: 1, roads: [existing.find((asset) => asset.kind === 'spline')?.path ?? ''].filter(Boolean),
    buildings: [{ model: existing.find((asset) => asset.kind === 'building')?.path ?? existing.find((asset) => asset.kind === 'model')?.path ?? '' }],
  }) },
  // 水体：一片 200 米见方的湖（岸线在属性面板里按 JSON 改），场景里给一个实体加 Water 组件、放到水面的高度
  { id: 'water', kind: 'water', name: 'NewWater', content: (name): WaterFile => ({ name, outline: [[-100, -100], [100, -100], [100, 100], [-100, 100]], clarity: 4, waves: { height: 0.2, length: 8 } }) },
  // 程序化摆放：还没有层；在属性面板里加层（模型、密度、坡度……），地形实体加 Scatter 组件引用它
  { id: 'scatter', kind: 'scatter', name: 'NewScatter', content: (name): ScatterFile => ({ name, seed: 1, layers: [] }) },
  // 精灵表：空的，在精灵表面板里选一张贴图开始切
  { id: 'spriteSheet', kind: 'spriteSheet', name: 'NewSprites', content: (name): SpriteSheetFile => ({ name, sprites: [] }) },
  // 3D 文字：先用工程里的第一个字体（属性面板里再换）；没有字体时烘不出来，报错叫人先导入一个
  { id: 'text', kind: 'text', name: 'NewText', content: (name, existing): TextModelFile => ({
    name, text: 'OPEN', font: existing.find((asset) => asset.kind === 'font')?.path ?? '', size: 0.5, depth: 0.05, materials: [null],
  }) },
  // 合成的音效：随机一个"拾取"，在属性面板的音效生成器里接着换、变、调
  { id: 'sound', kind: 'sound', name: 'NewSound', content: (name): SoundFile => ({ name, encoding: 'synth', streamFromDisk: false, spatialized: false, synth: SOUND_PRESETS.pickup(seededRandom(Date.now())) }) },
  // 样条：一段弯的 6 米宽的路（控制点在属性面板里按 JSON 改；横截面换成管子、轨道、围栏、电线）
  { id: 'spline', kind: 'spline', name: 'NewSpline', content: (name): SplineFile => ({
    name, materials: [null], profile: { type: 'road', width: 6 },
    points: [{ position: [-20, 0, 0] }, { position: [0, 0, -8] }, { position: [20, 0, 0] }],
  }) },
  // 白盒：一块 8 x 8 米的地板，在上面接着搭
  { id: 'brush', kind: 'brush', name: 'NewGreybox', content: (name): BrushFile => ({ name, materials: [null], brushes: [{ name: 'Floor', kind: 'box', operation: 'add', position: [0, -0.25, 0], size: [8, 0.5, 8] }] }) },
  { id: 'poly', kind: 'poly', name: 'NewMesh', content: (name): PolyMeshFile => polyCube(name) },
  // 椭球的身子上平滑地融一个球做头：一看就知道是"液态"的融合
  { id: 'sdf', kind: 'sdf', name: 'NewBlob', content: (name): SdfFile => ({ name, materials: [null], shapes: [
    { name: 'Body', kind: 'ellipsoid', operation: 'add', position: [0, 0.5, 0], radii: [0.4, 0.5, 0.4] },
    { name: 'Head', kind: 'sphere', operation: 'add', smoothness: 0.2, position: [0, 1.15, 0], radius: 0.3 },
  ] }) },
];

/** folder 里给 name 找一个没被占的内容路径：name、name2、name3……（taken 是已有的 `种类:路径`）。 */
export function freeAssetPath(folder: string, name: string, kind: AssetKind, taken: ReadonlySet<string>): string {
  const at = (suffix: string) => (folder ? `${folder}/${name}${suffix}` : `${name}${suffix}`);
  for (let n = 1; ; n++) {
    const candidate = at(n === 1 ? '' : String(n));
    if (!taken.has(`${kind}:${candidate}`)) return candidate;
  }
}
