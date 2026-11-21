/**
 * 编辑器界面的状态：打开的场景文档和撤销栈、选中的实体、嵌着的游戏页面里的代理（`game.editor`）。各个面板都读它、经它改。
 *
 * 场景文档（SceneDocument，文件是真相）在界面这边；游戏页面里的实体跟着它（EditAgent.open 拿到的是这里的撤销栈）。
 * 视口里拖操纵器改的经撤销栈记下，界面跟着刷新。Vue 的响应式只包在这一层：文档本身不可变，每改一次 version 加一。
 *
 * 预制体的实例：界面和视口看到、改的是展开以后的场景（`expanded`，成员也是实体），修改经 toDocumentEdit 换成文档上的
 * （成员的值成实例的覆盖），见 engine 的 editor/prefabEdits.ts。游戏页面拿到的就是展开好的场景（`#view`），不自己读
 * 预制体文件：这里的预制体换了（单独打开预制体改完保存），场景里的实例马上跟着变。
 *
 * 打开的文档可以是场景，也可以是单独打开的预制体（`openAsset`）：预制体在视口里只有它自己，加上预览用的灯（不在文档里）。
 */
import { setPropertyPath } from '@zerodep-dev/vue-tsx-pro-ui';
import { shallowRef, triggerRef } from 'vue';
import type { PrefabFile, SceneEntityFile, SceneFile, TimelineFile } from '@stride-ts/engine/content-format';
import type { GraphFile } from '@stride-ts/engine/node-graph';
import { encodePng } from '@stride-ts/engine/png';
import { expandPrefabInstances, loadPrefabs } from '@stride-ts/engine/content-prefabs';
import { SceneDocument, UndoStack, type SceneEdit } from '@stride-ts/engine/editor-document';
import { instanceMember, toDocumentEdit, type InstanceMember } from '@stride-ts/engine/editor-prefabs';
import { copyEntities, duplicateEntities, pasteEntities, positionAfter, type PasteTarget } from '@stride-ts/engine/editor-copy';
import { makePrefab } from '@stride-ts/engine/editor-make-prefab';
import { ASSET_FIELDS } from '@stride-ts/engine/editor-fields';
import { freeAssetPath } from '../newAssets';
import type { EditAgent, EditableScene, Game, PaintBrush, PolyEditSession, PolySelection, PolySelectMode, SnapSettings } from '@stride-ts/engine';
import { applyPolyOperation, type PolyEditResult, type PolyOperation } from '@stride-ts/engine/modeling';
import type { PolyMeshFile } from '@stride-ts/engine/content-format';
import { EditorClient } from '../EditorClient.ts';
import type { AssetKind, AssetRecord, MoveRequest, MoveResult, ProjectInfo } from '../protocol.ts';
import { t } from './messages';

/** 出片的预设（引擎 offline/VideoExport.ts 的 RENDER_PRESETS 里常用的几个）。 */
/** 序列帧烘焙的设置（引擎 bake 命令的参数）。 */
export interface FlipbookSettings {
  readonly columns: number;
  readonly rows: number;
  /** 每一格的边长（像素）。 */
  readonly size: number;
  readonly seconds: number;
  readonly start: number;
  readonly view: 'front' | 'side' | 'top';
}

export const EXPORT_PRESETS = ['landscape1080', 'vertical1080', 'square1080'] as const;
export type ExportPreset = (typeof EXPORT_PRESETS)[number];

/** 编辑器里能打开的文档：场景，或者单独打开的预制体。 */
export interface OpenedDocument {
  readonly kind: 'scene' | 'prefab';
  readonly path: string;
}

/** 单独打开预制体时视口里的灯（预制体自己一般不带灯）：方向光加环境光，id 不会和文件里的重。 */
const PREVIEW_LIGHTS: readonly SceneEntityFile[] = [
  { id: 'stride-editor:preview-sun', name: 'Preview light', parent: null, position: [0, 10, 0], rotation: [-0.4247, 0.2185, 0.1047, 0.8728], scale: [1, 1, 1], components: { light: { type: 'directional', color: [1, 1, 1], intensity: 3 } } },
  { id: 'stride-editor:preview-ambient', name: 'Preview ambient', parent: null, position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], components: { light: { type: 'ambient', color: [1, 1, 1], intensity: 0.4 } } },
];

export class EditorSession implements EditableScene {
  readonly client = new EditorClient();
  /** 工程（打开时读；没读到以前是 undefined，资源列表也还没有：界面画骨架屏）。 */
  readonly project = shallowRef<ProjectInfo>();
  /** 内容目录里的资源，后端推送变化时跟着改。 */
  readonly assets = shallowRef<readonly AssetRecord[]>([]);
  /** 选中的实体（文档里的 id）。 */
  readonly selection = shallowRef<readonly string[]>([]);
  /** 文档每改一次（做、撤销、重做、打开）加一：读文档的地方读它，好跟着刷新。 */
  readonly version = shallowRef(0);
  /** 上次保存以后改过。 */
  readonly dirty = shallowRef(false);
  /** 游戏页面里的代理；页面还没起来、重新加载时是 undefined。 */
  readonly agent = shallowRef<EditAgent>();
  /**
   * 视口正在打开编辑状态的游戏页面、还没把场景交给会话（视口管它）：场景树、属性面板、视口画骨架屏。试玩时 agent 也是空的，
   * 但不算在打开。
   */
  readonly opening = shallowRef(true);
  /** 视口上的画幅参考线：画幅的宽高比，0 是不显示（见 Viewport 的 frameGuide）。 */
  readonly frameGuide = shallowRef(0);
  /** 打开的时间轴（资源浏览器里打开的，下面的时间轴面板显示它）：选实体、改场景时一直开着。 */
  readonly timeline = shallowRef<OpenTimeline | undefined>();
  /**
   * 正在视口里编辑的多边形网格（S2）：哪个实体上、哪个 .poly.json，选择模式、选中的东西和现在的网格；没在编辑时是 undefined。
   * 操纵器拖完、工具条上的操作做完存进文件（后端烘成模型、视口热重载）；撤销、重做这时是网格的上一步、下一步。
   */
  readonly polyEditing = shallowRef<{ readonly entity: string; readonly path: string; readonly mode: PolySelectMode; readonly selection: PolySelection; readonly mesh: PolyMeshFile }>();
  /** 多边形编辑的撤销：每一步之前的网格；重做是撤销掉的。 */
  #polyUndo: PolyMeshFile[] = [];
  #polyRedo: PolyMeshFile[] = [];
  /** 正在画的材质层（属性面板里开着的材质的第几层、它的遮罩）；没在画时是 undefined。 */
  readonly painting = shallowRef<{ readonly layer: number; readonly mask: string }>();
  /** 绘制的笔刷（半径、硬度、强度、擦除），换着画别的层时保留。 */
  readonly paintBrush = shallowRef<PaintBrush>({ radius: 0.25, hardness: 0.5, strength: 0.8, erase: false });
  /** 正在烘序列帧（粒子窗口的"烘焙"这时不能点）。 */
  readonly baking = shallowRef(false);
  /** 粒子面板开着时编辑的实体（场景文件里的 id）；没开时是 undefined。 */
  readonly particleEntity = shallowRef<string>();
  /** 节点图面板开着（编辑的是属性面板里正开着的材质的 graph）。 */
  readonly graphOpen = shallowRef(false);
  /** 正在导出的时间轴（名字）；没在导出时是 undefined。 */
  readonly exporting = shallowRef<string>();
  /** 还没存的时间轴修改（连着拖关键帧只存最后一次）。 */
  #timelineSave: { readonly path: string; readonly content: TimelineFile; readonly timer: ReturnType<typeof setTimeout> } | undefined;
  /** 正在编辑的文档（场景或预制体）。 */
  readonly opened = shallowRef<OpenedDocument>();
  /** 最近打开的场景：单独打开预制体以后回到它。 */
  readonly scene = shallowRef<OpenedDocument>();
  /**
   * 复制的实体（copyEntities 的结果）。放在会话里，所以换着打开场景、预制体以后还能粘贴；不进系统剪贴板（别的标签页里的
   * 编辑器拿不到）。
   */
  readonly clipboard = shallowRef<readonly SceneEntityFile[]>();
  /**
   * 操纵器的吸附（步长、一直吸附）。记在会话里：换着打开场景、预制体，试玩回来、页面重新加载以后都还是这个；第一次用游戏
   * 页面里的默认值（不在界面这边引入引擎的值）。
   */
  readonly snap = shallowRef<SnapSettings>();
  /** 最近一次操作做不了的原因（工具条上显示），下一次操作成功时清掉。 */
  readonly notice = shallowRef('');
  /** 最近一次操作做成了什么（工具条上不显眼地显示；有 notice 时让给它）。 */
  readonly status = shallowRef('');
  /**
   * 属性面板正在编辑的资源（资源浏览器里选中的材质、JSON 写的模型）：改了马上存（稍等一下，连着拖只存最后一次），后端推送
   * 变化以后视口里用到它的实体热重载。选了实体时清掉。
   */
  readonly inspected = shallowRef<InspectedAsset | undefined>();
  /** 属性面板里的资源还没存的修改（连着改只存最后一次）。 */
  #inspectedSave: { readonly asset: InspectedAsset; readonly timer: ReturnType<typeof setTimeout> } | undefined;
  #document: SceneDocument | undefined;
  /** 最近一次修改以后游戏页面里的实体跟上了。 */
  #synced: Promise<void> = Promise.resolve();
  #undo: UndoStack<SceneFile> | undefined;
  /** 文档用到的预制体（连嵌套的），打开文档、预制体文件改了时加载。 */
  #prefabs: ReadonlyMap<string, readonly SceneEntityFile[]> = new Map();
  #viewCache: { readonly file: SceneFile; readonly prefabs: ReadonlyMap<string, readonly SceneEntityFile[]>; readonly view: SceneFile } | undefined;
  /** 交给游戏页面的文档：展开好的场景，修改转回这里（修改本来就是对展开的场景说的）。 */
  readonly #view: EditableScene = (() => {
    const session = this;
    return {
      get file(): SceneFile {
        return session.#viewFile();
      },
      apply: (edit: SceneEdit, mergeKey?: string) => session.apply(edit, mergeKey),
      commit: () => session.commit(),
    };
  })();

  async start(): Promise<void> {
    const [project, assets] = await Promise.all([this.client.project(), this.client.assets()]);
    this.project.value = project;
    this.assets.value = assets;
    this.client.onAssetsChanged(({ changed, removed }) => {
      const gone = new Set([...changed, ...removed].map((asset) => `${asset.kind}:${asset.path}`));
      this.assets.value = [...this.assets.value.filter((asset) => !gone.has(`${asset.kind}:${asset.path}`)), ...changed]
        .sort((a, b) => (a.kind === b.kind ? (a.path < b.path ? -1 : 1) : a.kind < b.kind ? -1 : 1));
      // 用到的预制体改了（单独打开它改完保存了，或者在别处改了）：重新加载，实例跟着变
      if ([...changed, ...removed].some((asset) => asset.kind === 'prefab' && this.#prefabs.has(asset.path))) void this.#reloadPrefabs();
      // 别的资源（材质、模型、贴图、UI、声音……）改了：视口里用到它们的实体重建（热重载）
      // 正在画的遮罩是自己刚存的：视口里已经是这个样子，重新加载会让材质换成一张新贴图，后面画的就看不到了
      const painting = this.painting.value?.mask;
      const reloaded = assetsToReload(this.assets.value, changed.filter((asset) => asset.kind !== 'scene' && asset.kind !== 'prefab' && !(asset.kind === 'image' && asset.path === painting)));
      if (reloaded.length > 0) void this.agent.value?.reloadAssets(reloaded).catch((error: unknown) => console.error('reloading assets failed', error));
      void this.#reloadChangedElsewhere(changed);
    });
  }

  /**
   * 游戏页面起来了：打开它加载的根场景（试玩回来、页面重新加载时打开原来在编辑的文档），交给它的代理，之后实体跟着这里
   * 的文档。
   */
  async attach(game: Game): Promise<void> {
    const agent = game.editor;
    if (!agent) throw new Error('the game page is not in edit mode (open it with ?debug&stride-edit)');
    const path = agent.scenePath;
    const document = this.opened.value ?? (path ? { kind: 'scene' as const, path } : undefined);
    if (!document) throw new Error('the game did not load its root scene from a content path; the editor cannot tell which scene file to open');
    agent.onSelectionChanged = (ids) => {
      this.selection.value = ids;
      if (ids.length > 0) this.inspected.value = undefined;
    };
    await this.#open(agent, document);
    // 试玩回来（视口重新打开）：时间轴开着就接着预览
    const timeline = this.timeline.value;
    if (timeline) this.seekTimeline(timeline.time);
  }

  /**
   * 打开着的时间轴、属性面板里的资源在别处改了（agent 经 MCP、别的程序）：没有还没存的修改时从磁盘重读，不然下次在这里改、
   * 导出时会拿旧的那份把别处的修改盖掉。自己刚存的那次回声读出来和手上的一样，不动。
   */
  async #reloadChangedElsewhere(changed: readonly AssetRecord[]): Promise<void> {
    const isChanged = (kind: string, path: string) => changed.some((asset) => asset.kind === kind && asset.path === path);
    const open = this.timeline.value;
    if (open && this.#timelineSave === undefined && isChanged('timeline', open.path)) {
      const content = await this.client.readAsset<TimelineFile>('timeline', open.path);
      const now = this.timeline.value;
      if (now?.path === open.path && this.#timelineSave === undefined && JSON.stringify(content) !== JSON.stringify(now.content)) {
        this.timeline.value = { ...now, content };
        const inspected = this.inspected.value;
        if (inspected?.kind === 'timeline' && inspected.path === now.path) this.inspected.value = { ...inspected, content: content as unknown as Record<string, unknown> };
        this.seekTimeline(now.time);
      }
    }
    const inspected = this.inspected.value;
    if (inspected && inspected.kind !== 'timeline' && this.#inspectedSave === undefined && isChanged(inspected.kind, inspected.path)) {
      const content = await this.client.readAsset<Record<string, unknown>>(inspected.kind, inspected.path);
      const now = this.inspected.value;
      if (now?.kind === inspected.kind && now.path === inspected.path && this.#inspectedSave === undefined && JSON.stringify(content) !== JSON.stringify(now.content)) {
        this.inspected.value = { ...now, content };
      }
    }
  }

  /** 时间轴还有没存的修改时马上存（关时间轴、出片之前；不然最后那一下改动会丢）。 */
  async #flushTimelineSave(): Promise<void> {
    const pending = this.#timelineSave;
    if (!pending) return;
    clearTimeout(pending.timer);
    this.#timelineSave = undefined;
    await this.client.saveAsset('timeline', pending.path, pending.content).catch((error: unknown) => (this.notice.value = (error as Error).message));
  }

  /** 打开时间轴：面板显示它，视口摆成第 0 秒的样子。 */
  async openTimeline(path: string): Promise<void> {
    const inspected = this.inspected.value;
    const content = inspected?.kind === 'timeline' && inspected.path === path ? inspected.content as unknown as TimelineFile : await this.client.readAsset<TimelineFile>('timeline', path);
    this.timeline.value = { path, content, time: 0, throughCamera: false, camera: undefined, subtitle: '' };
    this.seekTimeline(0);
  }

  /**
   * 给属性面板里开着的材质加一个绘制层：一张全黑的遮罩（1024 x 1024 的线性 png，放在材质旁边的 Masks 文件夹），材质层的 blend
   * 采样它的 r，填充是深灰色、粗糙度 0.6（之后在图层栏里改）。返回新层的下标。
   */
  async addPaintLayer(): Promise<number | undefined> {
    const inspected = this.inspected.value;
    if (inspected?.kind !== 'material') return undefined;
    const layers = (inspected.content['layers'] as unknown[] | undefined) ?? [];
    const folder = inspected.path.includes('/') ? inspected.path.slice(0, inspected.path.lastIndexOf('/')) : '';
    const base = inspected.path.slice(inspected.path.lastIndexOf('/') + 1);
    const taken = new Set(this.assets.value.map((asset) => `${asset.kind}:${asset.path}`));
    const mask = freeAssetPath(folder ? `${folder}/Masks` : 'Masks', `${base}Layer${layers.length + 1}`, 'image', taken);
    const size = 1024;
    const rgba = new Uint8Array(size * size * 4);
    for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
    await this.client.saveImage(mask, await encodePng(rgba, size, size));
    this.editInspected(['layers'], [...layers, {
      blend: { $type: 'computeTextureScalar', texture: { texture: mask, encoding: 'png', srgb: false }, channel: 'r' },
      diffuse: { $type: 'computeColor', value: [0.25, 0.25, 0.25, 1] },
      metalness: { $type: 'computeFloat', value: 0 },
      glossiness: { tree: { $type: 'computeFloat', value: 0.6 }, invert: true },
    }]);
    return layers.length;
  }

  /**
   * 在视口里开始画第 layer 层的遮罩：画选中的实体上用这个材质的网格。一笔画完存 png（覆盖遮罩）。层的遮罩要是线性的 png
   * （addPaintLayer 建的那种）。
   */
  async startPainting(layer: number): Promise<void> {
    const inspected = this.inspected.value, agent = this.agent.value;
    const entity = this.selection.value[0];
    if (inspected?.kind !== 'material' || !agent) return;
    if (!entity) {
      this.notice.value = t.paintSelectEntity;
      return;
    }
    const blend = ((inspected.content['layers'] as { blend?: { texture?: { texture?: string } } }[] | undefined) ?? [])[layer]?.blend;
    const mask = blend?.texture?.texture;
    if (!mask) {
      this.notice.value = t.paintNoMask;
      return;
    }
    this.stopPolyEdit();
    // 存过还没刷新的材质先存下来：视口里的材质要有这一层
    await this.#flushInspected();
    await agent.beginPaint(entity, inspected.path, mask, this.paintBrush.value);
    agent.onPaintStroke = (path, image) => {
      void encodePng(image.rgba, image.width, image.height).then((png) => this.client.saveImage(path, png)).catch((error: unknown) => (this.notice.value = (error as Error).message));
    };
    this.painting.value = { layer, mask };
    this.notice.value = '';
  }

  stopPainting(): void {
    this.agent.value?.endPaint();
    this.painting.value = undefined;
  }

  setPaintBrush(brush: PaintBrush): void {
    this.paintBrush.value = brush;
    const paint = this.agent.value?.paint;
    if (paint) paint.brush = brush;
  }

  /** 打开粒子面板，编辑这个实体的粒子系统（底部显示）。 */
  openParticles(entity: string): void {
    this.particleEntity.value = entity;
  }

  closeParticles(): void {
    this.particleEntity.value = undefined;
  }

  /**
   * 把实体的粒子系统烘成序列帧（游戏页面里的 bake 命令，图集存成内容目录里的 `Textures/<名字>Flipbook`），再在它旁边（往 +X 挪
   * 一格的宽度）加一个放这张序列帧的实体，两个并排比较。烘的是游戏页面里现在的粒子系统，没存的修改也算。
   */
  async bakeFlipbook(entityId: string, settings: FlipbookSettings): Promise<void> {
    const agent = this.agent.value, source = this.expanded.find((entity) => entity.id === entityId);
    if (!agent || !source || this.baking.value) return;
    this.baking.value = true;
    this.notice.value = '';
    try {
      const result = await agent.game.debug.run('bake', { entity: entityId, ...settings, path: `Textures/${source.name || 'Particles'}Flipbook` }) as {
        path: string; frames: number; elapsed: number; frameWorldSize: number; component: object;
      };
      const [x, y, z] = source.position;
      const entity: SceneEntityFile = {
        id: crypto.randomUUID(), name: `${source.name} Flipbook`, parent: source.parent,
        position: [x + Math.round(result.frameWorldSize * 100) / 100, y, z], rotation: [0, 0, 0, 1], scale: [1, 1, 1],
        components: { particleSystem: result.component } as SceneEntityFile['components'],
      };
      this.apply(this.#requireDocument().addChild(entity));
      this.commit();
      this.status.value = t.particleBaked(result.path, result.frames, result.elapsed);
    } catch (error) {
      this.notice.value = (error as Error).message;
    } finally {
      this.baking.value = false;
    }
  }

  /** 打开属性面板里那个材质的节点图（还没有图时建一个只有材质输出的空图），面板显示在下面。 */
  openMaterialGraph(): void {
    const inspected = this.inspected.value;
    if (inspected?.kind !== 'material') return;
    if (!inspected.content['graph']) this.editInspected(['graph'], { nodes: [], outputs: {} } satisfies GraphFile);
    this.graphOpen.value = true;
  }

  closeMaterialGraph(): void {
    this.graphOpen.value = false;
  }

  /** 改节点图（整个换掉）：同属性面板的修改，稍等一下存，材质热重载。 */
  editMaterialGraph(change: (graph: GraphFile) => GraphFile): void {
    this.editInspected(['graph'], (previous: unknown) => change((previous as GraphFile | undefined) ?? { nodes: [], outputs: {} }));
  }

  /** 关掉时间轴：视口回到场景文档的样子。 */
  closeTimeline(): void {
    void this.#flushTimelineSave();
    this.agent.value?.endTimelinePreview();
    this.timeline.value = undefined;
  }

  /** 拖到 time 秒：视口按时间轴预览（不改场景文档）。 */
  seekTimeline(time: number): void {
    const open = this.timeline.value;
    if (!open) return;
    const clamped = Math.min(Math.max(time, 0), open.content.duration);
    const state = this.agent.value?.previewTimeline(open.content, clamped, { throughCamera: open.throughCamera });
    this.timeline.value = { ...open, time: clamped, camera: state?.camera, subtitle: state?.subtitle ?? '' };
  }

  /** 从时间轴的相机里看（相机轨道那一刻的相机），或者回到编辑相机。 */
  setTimelineCamera(throughCamera: boolean): void {
    const open = this.timeline.value;
    if (!open) return;
    this.timeline.value = { ...open, throughCamera };
    this.seekTimeline(open.time);
  }

  /** 改时间轴：马上按新的预览，稍等一下再存（连着拖关键帧只存最后一次）；编辑器的 HTTP 接口存，游戏里放的也跟着热重载。 */
  editTimeline(change: (file: TimelineFile) => TimelineFile): void {
    const open = this.timeline.value;
    if (!open) return;
    const content = change(open.content);
    this.timeline.value = { ...open, content };
    // 属性面板正开着同一个时间轴：同一份内容（不然两边各存各的，后存的把先改的盖掉）
    const inspected = this.inspected.value;
    if (inspected?.kind === 'timeline' && inspected.path === open.path) this.inspected.value = { ...inspected, content: content as unknown as Record<string, unknown> };
    this.seekTimeline(open.time);
    clearTimeout(this.#timelineSave?.timer);
    this.#timelineSave = { path: open.path, content, timer: setTimeout(() => void this.#flushTimelineSave(), 250) };
  }

  /**
   * 把打开的时间轴出片（引擎的调试命令 render：编辑状态的页面开一个看不见的试玩页面，从头放这个时间轴、离线渲染），存进
   * 工程的 exports 文件夹。试玩页面读的是磁盘上的文件：先把没存的场景、时间轴存了。
   */
  async exportTimeline(preset: ExportPreset): Promise<void> {
    const open = this.timeline.value, agent = this.agent.value;
    if (!open || !agent || this.exporting.value) return;
    this.exporting.value = open.content.name;
    this.notice.value = '';
    try {
      if (this.dirty.value) await this.save();
      await this.#flushTimelineSave();
      const result = await agent.game.debug.run('render', { timeline: open.content.name, preset, name: `${open.content.name}-${preset}` }) as { path: string; elapsed: number };
      this.status.value = t.timelineExported(result.path, result.elapsed);
    } catch (error) {
      this.notice.value = (error as Error).message;
    } finally {
      this.exporting.value = undefined;
    }
  }

  /** 打开别的场景或预制体：打开着的文档改过就先保存。 */
  async openAsset(document: OpenedDocument): Promise<void> {
    const agent = this.agent.value;
    if (!agent) throw new Error('the game page is not ready yet');
    if (this.dirty.value) await this.save();
    await this.#open(agent, document);
    // 预制体在原点附近，编辑相机原来看着场景里的别处
    if (document.kind === 'prefab') agent.focus(this.file.entities.filter((entity) => entity.parent === null).map((entity) => entity.id));
  }

  /**
   * 移动、改名资源（引用它们的文件跟着改写，见后端的 moveAssets）。改写的是磁盘上的文件，所以先保存打开着的场景；场景文件
   * 被改写了（或者场景自己挪了）就从磁盘重新打开（撤销的历史从这里重新开始）。
   */
  async moveAssets(request: MoveRequest): Promise<MoveResult> {
    if (this.dirty.value) await this.save();
    const result = await this.client.moveAssets(request);
    const agent = this.agent.value, opened = this.opened.value;
    if (agent && opened) {
      const moved = movedPath(request, opened);
      if (moved !== opened.path || result.rewritten.some((asset) => asset.kind === opened.kind && asset.path === moved)) await this.#open(agent, { kind: opened.kind, path: moved });
    }
    return result;
  }

  /** 新建一个 JSON 资源（已经有了报错）；返回它的记录，资源列表也马上带上它（不等后端推送）。 */
  async createAsset(kind: AssetKind, path: string, content: object): Promise<AssetRecord> {
    const record = await this.client.createAsset(kind, path, content);
    if (!this.assets.value.some((asset) => asset.kind === kind && asset.path === path)) this.assets.value = [...this.assets.value, record];
    return record;
  }

  /** 导入拖进来的文件（音频成声音、图片成贴图、模型成模型加材质加贴图）放进 folder；返回新资源（资源列表马上带上），警告记进 notice。 */
  async importFiles(folder: string, files: readonly File[]): Promise<AssetRecord[]> {
    const records: AssetRecord[] = [];
    const warnings: string[] = [];
    for (const file of files) {
      const result = await this.client.importFile(folder, file);
      records.push(result.asset);
      warnings.push(...result.warnings);
    }
    this.notice.value = warnings.join('；');
    const known = new Set(this.assets.value.map((asset) => `${asset.kind}:${asset.path}`));
    this.assets.value = [...this.assets.value, ...records.filter((record) => !known.has(`${record.kind}:${record.path}`))];
    return records;
  }

  /** 在属性面板里编辑这个资源（能编辑的：材质、JSON 写的模型）；别的种类、二进制的模型清掉面板。 */
  async inspectAsset(kind: AssetKind, path: string): Promise<void> {
    if (!isInspectable(kind)) {
      this.inspected.value = undefined;
      return;
    }
    try {
      const open = this.timeline.value;
      const content = kind === 'timeline' && open?.path === path ? open.content as unknown as Record<string, unknown> : await this.client.readAsset<Record<string, unknown>>(kind, path);
      this.inspected.value = { kind, path, content };
    } catch (error) {
      // 二进制的模型（导入的）读不了：面板上不显示，说明一下
      this.inspected.value = undefined;
      this.status.value = (error as Error).message;
    }
  }

  /** 改正在编辑的资源里 path 上的值（ValueUpdate 按现在的值算，undefined 去掉这个键）；稍等一下再存，连着改只存最后一次。 */
  editInspected(path: readonly (string | number)[], value: unknown): void {
    const now = this.inspected.value;
    if (!now) return;
    // 时间轴面板正开着同一个时间轴：改的是同一份（预览跟着变，由它存）
    const open = this.timeline.value;
    if (now.kind === 'timeline' && open?.path === now.path) {
      this.editTimeline((file) => setPropertyPath(file, path, value) as TimelineFile);
      return;
    }
    const edited = { ...now, content: setPropertyPath(now.content, path, value) as Record<string, unknown> };
    this.inspected.value = edited;
    clearTimeout(this.#inspectedSave?.timer);
    this.#inspectedSave = { asset: edited, timer: setTimeout(() => void this.#flushInspected(), INSPECTED_SAVE_DELAY) };
  }

  /** 属性面板里的资源还有没存的修改时马上存（开始画之前：视口里的材质要是改过的样子）。 */
  async #flushInspected(): Promise<void> {
    const pending = this.#inspectedSave;
    if (!pending) return;
    clearTimeout(pending.timer);
    this.#inspectedSave = undefined;
    const { kind, path, content } = pending.asset;
    await this.client.saveAsset(kind, path, content).catch((error: unknown) => (this.notice.value = (error as Error).message));
  }

  /** 删掉一个资源；还有别的资源引用它时报错（错误里列出是谁），force 照删。 */
  async deleteAsset(kind: AssetKind, path: string, force = false): Promise<void> {
    await this.client.deleteAsset(kind, path, { force });
  }

  async #open(agent: EditAgent, document: OpenedDocument): Promise<void> {
    // 预制体文件也是一列实体（名字加实体），当成没有场景设置的场景打开
    const file: SceneFile = await this.client.readAsset<SceneFile | PrefabFile>(document.kind, document.path);
    this.#prefabs = await this.#loadPrefabs(file);
    this.#document = new SceneDocument(file);
    this.#undo = new UndoStack(this.#document);
    this.opened.value = document;
    if (document.kind === 'scene') this.scene.value = document;
    this.dirty.value = false;
    this.selection.value = [];
    await agent.open(this.#view);
    if (this.snap.value) agent.snap = this.snap.value;
    else this.snap.value = agent.snap;
    this.agent.value = agent;
    this.#changed(false);
  }

  #loadPrefabs(file: SceneFile): Promise<Map<string, readonly SceneEntityFile[]>> {
    return loadPrefabs(file.entities, async (prefab) => (await this.client.readAsset<PrefabFile>('prefab', prefab)).entities);
  }

  async #reloadPrefabs(): Promise<void> {
    if (!this.#document) return;
    try {
      this.#prefabs = await this.#loadPrefabs(this.file);
    } catch (error) {
      // 预制体删了、挪了：实例展开不了，等用户改引用；界面照旧显示上一次的
      console.error(`${this.file.name}: reloading prefabs failed`, error);
      return;
    }
    this.#changed(false);
  }

  /** 交给游戏页面的文件：展开好的实体（单独打开预制体时加上预览的灯）；文档和预制体都没变时是同一个对象。 */
  #viewFile(): SceneFile {
    const file = this.file;
    if (this.#viewCache?.file === file && this.#viewCache.prefabs === this.#prefabs) return this.#viewCache.view;
    const entities = this.opened.value?.kind === 'prefab' ? [...this.expanded, ...PREVIEW_LIGHTS] : this.expanded;
    const view = entities === file.entities ? file : { ...file, entities };
    this.#viewCache = { file, prefabs: this.#prefabs, view };
    return view;
  }

  /** 游戏页面要重新加载了（试玩回来、HMR 整页刷新）：代理作废。 */
  detach(): void {
    this.agent.value = undefined;
    // 页面重新加载（试玩、热重载）：页面里的多边形编辑没了，工具条也收起
    this.polyEditing.value = undefined;
  }

  get file(): SceneFile {
    return this.#require().file;
  }

  /** 展开以后的实体（实例换成根和成员，同游戏里的）：场景树、属性面板显示的是它。 */
  get expanded(): readonly SceneEntityFile[] {
    return expandPrefabInstances(this.file.entities, this.#prefabs, (message) => console.warn(`${this.file.name}: ${message}`));
  }

  /** 展开的场景里的实体属于哪个实例（实例的根和成员）；普通实体是 undefined。 */
  instanceMember(id: string): InstanceMember | undefined {
    return instanceMember(this.file, this.#prefabs, id);
  }

  /** 是实例的成员（不是根）：它不在文档里，能改值、删、往下面加实体，不能挪（它跟着预制体）。 */
  isMember(id: string): boolean {
    const member = this.instanceMember(id);
    return member !== undefined && member.instance.id !== id;
  }

  get canUndo(): boolean {
    // 编辑多边形时撤销的是网格的一步（读 polyEditing 让工具条跟着每一步刷新）
    if (this.polyEditing.value) return this.#polyUndo.length > 0;
    return this.#undo?.canUndo ?? false;
  }

  get canRedo(): boolean {
    if (this.polyEditing.value) return this.#polyRedo.length > 0;
    return this.#undo?.canRedo ?? false;
  }

  /**
   * 做一个修改（EditableScene）；mergeKey 相同的连着的修改并成撤销的一步（拖动、连续输入）。修改是对展开的场景说的，
   * 改实例成员的换成实例上的覆盖。
   */
  apply(edit: SceneEdit, mergeKey?: string): void {
    this.status.value = '';
    this.#require().apply(toDocumentEdit(this.file, this.#prefabs, edit), mergeKey);
    this.#changed();
  }

  /** 一次连着的修改结束了（松开鼠标、输入框失去焦点）：下一次修改不再并进来。 */
  commit(): void {
    this.#undo?.commit();
  }

  undo(): void {
    if (this.polyEditing.value) return this.#polyStep(this.#polyUndo, this.#polyRedo);
    if (this.#require().undo()) this.#changed();
  }

  redo(): void {
    if (this.polyEditing.value) return this.#polyStep(this.#polyRedo, this.#polyUndo);
    if (this.#require().redo()) this.#changed();
  }

  /** 模型 modelPath 是不是从多边形网格烘出来的：同一路径有 .poly.json 时是它的路径。 */
  polySourceOf(modelPath: string): string | undefined {
    return this.assets.value.some((asset) => asset.kind === 'poly' && asset.path === modelPath) ? modelPath : undefined;
  }

  /** 在视口里编辑实体 entity 的模型来自的多边形网格 path（选中的实体、点、边、面的选择从面开始）。 */
  async startPolyEdit(entity: string, path: string): Promise<void> {
    const agent = this.agent.value;
    if (!agent) return;
    this.stopPainting();
    const mesh = await this.client.readAsset<PolyMeshFile>('poly', path);
    this.#polyUndo = [];
    this.#polyRedo = [];
    agent.beginPolyEdit(entity, path, mesh);
    agent.onPolyChanged = (edit, commit) => this.#polyChanged(edit, commit);
    this.#polyChanged(agent.polyEdit!, false);
    // 怎么操作写在状态栏（不是出错，不用 notice）
    this.notice.value = '';
    this.status.value = t.polyHint;
  }

  stopPolyEdit(): void {
    this.agent.value?.endPolyEdit();
    if (this.polyEditing.value && this.status.value === t.polyHint) this.status.value = '';
    this.polyEditing.value = undefined;
  }

  /** 换选择模式（点、边、面）；选中的清空。 */
  setPolyMode(mode: PolySelectMode): void {
    const edit = this.agent.value?.polyEdit;
    if (!edit || edit.mode === mode) return;
    edit.mode = mode;
    edit.selection = { vertices: [], edges: [], faces: [] };
    this.#polyChanged(edit, false);
  }

  /** 对选中的东西做一个编辑操作（挤出、倒角……，引擎的 applyPolyOperation）；做不了时（选的不对）在状态栏说为什么。 */
  polyOperation(operation: PolyOperation): void {
    const edit = this.agent.value?.polyEdit;
    if (!edit) return;
    let result: PolyEditResult;
    try {
      result = applyPolyOperation(edit.mesh, operation);
    } catch (error) {
      this.notice.value = (error as Error).message;
      return;
    }
    this.#polyUndo.push(edit.mesh);
    this.#polyRedo = [];
    edit.mesh = result.mesh;
    // 操作之后选中它给的东西（挤出后是挤出的面……）；当前模式没有的换到有的那种
    const mode: PolySelectMode = result.faces.length > 0 ? 'face' : result.edges.length > 0 ? 'edge' : result.vertices.length > 0 ? 'vertex' : edit.mode;
    edit.mode = mode;
    edit.selection = { vertices: mode === 'vertex' ? result.vertices : [], edges: mode === 'edge' ? result.edges : [], faces: mode === 'face' ? result.faces : [] };
    this.notice.value = '';
    this.#savePoly(edit);
    this.#polyChanged(edit, false);
  }

  /** 视口里改了网格、选择或模式：commit（拖完操纵器）时记一步撤销、存文件。 */
  #polyChanged(edit: PolyEditSession, commit: boolean): void {
    if (!this.polyEditing.value) this.#polySaved = edit.mesh;
    // 拖的过程中每帧的网格都写进了 polyEditing：和上一次存的那份比，撤销也回到它（按下之前的样子）
    else if (commit && this.#polySaved && this.#polySaved !== edit.mesh) {
      this.#polyUndo.push(this.#polySaved);
      this.#polyRedo = [];
      this.#savePoly(edit);
    }
    this.polyEditing.value = { entity: edit.entity, path: edit.path, mode: edit.mode, selection: edit.selection, mesh: edit.mesh };
  }

  /** 上一次存进文件的网格（拖之前的样子）。 */
  #polySaved: PolyMeshFile | undefined;

  #savePoly(edit: PolyEditSession): void {
    this.#polySaved = edit.mesh;
    void this.client.saveAsset('poly', edit.path, edit.mesh).catch((error: unknown) => (this.notice.value = (error as Error).message));
  }

  /** 多边形编辑的撤销、重做：换回上一步、下一步的网格，存文件。选中的清空（下标可能不对了）。 */
  #polyStep(from: PolyMeshFile[], to: PolyMeshFile[]): void {
    const edit = this.agent.value?.polyEdit, mesh = from.pop();
    if (!edit || !mesh) return;
    to.push(edit.mesh);
    edit.mesh = mesh;
    edit.selection = { vertices: [], edges: [], faces: [] };
    this.#savePoly(edit);
    this.#polyChanged(edit, false);
  }

  /** 加一个空实体（只有变换），放在 parent 的子实体的最后（null 是最上层），选中它。 */
  async addEntity(parent: string | null): Promise<void> {
    const entity: SceneEntityFile = { id: crypto.randomUUID(), name: 'Entity', parent, position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], components: {} };
    this.apply(this.#requireDocument().addChild(entity));
    this.commit();
    // 游戏页面里建好了实体再选：代理只认场景里有的实体
    await this.#synced;
    this.select([entity.id]);
  }

  /** 删掉选中的实体和它们的后代（一步撤销）；实例的成员记成实例去掉了它。 */
  deleteSelection(): void {
    // 编辑多边形时 Delete 删的是选中的面
    const poly = this.polyEditing.value;
    if (poly) {
      if (poly.selection.faces.length > 0) this.polyOperation({ op: 'delete', faces: poly.selection.faces });
      return;
    }
    // 展开的场景里父实体排在前面：顺着扫一遍收全后代（包括挂在成员下面的文档实体）
    const removing = new Set(this.selection.value);
    const parentOf = new Map<string, string | null>();
    for (const entity of this.expanded) {
      parentOf.set(entity.id, entity.parent);
      if (entity.parent !== null && removing.has(entity.parent)) removing.add(entity.id);
    }
    // 成员只记最上面的那个（去掉的成员连后代）
    const ids = [...removing].filter((id) => parentOf.has(id) && !(this.isMember(id) && removing.has(parentOf.get(id) ?? '')));
    if (ids.length === 0) return;
    this.apply({ type: 'remove', entities: ids });
    this.commit();
    this.select([]);
  }

  /** 改吸附设置（一项或几项），游戏页面里的操纵器马上用上。 */
  setSnap(change: Partial<SnapSettings>): void {
    const current = this.snap.value;
    if (!current) return;
    this.snap.value = { ...current, ...change };
    const agent = this.agent.value;
    if (agent) agent.snap = this.snap.value;
  }

  /** 复制选中的实体（连同后代、组件）。 */
  copySelection(): void {
    if (this.selection.value.length === 0) return;
    this.clipboard.value = copyEntities(this.file, this.#prefabs, this.selection.value);
    this.notice.value = '';
  }

  /**
   * 粘贴复制的实体（新 id，一步撤销），选中粘贴出来的。默认粘贴成选中的最后一个实体的兄弟，紧跟在它后面；asChild 时粘贴成
   * 它的最后的子实体；没选中时放在最上层的最后。
   */
  async paste(asChild = false): Promise<void> {
    const copied = this.clipboard.value;
    if (!copied) return;
    // 别的文档里复制来的实例可能用到这里还没加载的预制体
    const missing = await this.#loadPrefabs({ ...this.file, entities: copied.filter((entity) => entity.prefab && !this.#prefabs.has(entity.prefab.path)) });
    if (missing.size > 0) this.#prefabs = new Map([...this.#prefabs, ...missing]);
    await this.#insert(() => pasteEntities(this.file, copied, this.#pasteTarget(asChild)));
  }

  /** 复制一份选中的实体（Ctrl+D）：每个放在原来的后面，一步撤销，选中复制出来的。 */
  async duplicateSelection(): Promise<void> {
    if (this.selection.value.length === 0) return;
    await this.#insert(() => duplicateEntities(this.file, this.#prefabs, this.selection.value));
  }

  #pasteTarget(asChild: boolean): PasteTarget {
    const selected = new Set(this.selection.value);
    const anchor = this.expanded.findLast((entity) => selected.has(entity.id));
    if (!anchor) return { parent: null, position: Infinity };
    return asChild ? { parent: anchor.id, position: Infinity } : { parent: anchor.parent, position: positionAfter(this.file, anchor) };
  }

  /** 做一次加实体的修改，选中加出来的根；做不了（例如要放进实例的成员下面）时记进 notice。 */
  async #insert(make: () => { edit: SceneEdit; roots: string[] }): Promise<void> {
    let made: { edit: SceneEdit; roots: string[] };
    try {
      made = make();
    } catch (error) {
      this.notice.value = (error as Error).message;
      return;
    }
    this.notice.value = '';
    this.apply(made.edit);
    this.commit();
    await this.#synced;
    this.select(made.roots);
  }

  /**
   * 选中的一个实体连同后代做成预制体（存到 Prefabs/<名字>，重名的加数字），场景里原地换成它的实例，一步撤销（预制体文件留着）。
   * 做不了（选中的是实例、实例的成员）时记进 notice。
   */
  async makePrefabFromSelection(): Promise<void> {
    const [id] = this.selection.value;
    if (this.selection.value.length !== 1 || id === undefined) return;
    const root = this.file.entities.find((entity) => entity.id === id);
    const name = (root?.name ?? '').replace(/[^A-Za-z0-9_-]+/g, '') || 'Prefab';
    const path = freeAssetPath('Prefabs', name, 'prefab', new Set(this.assets.value.map((asset) => `${asset.kind}:${asset.path}`)));
    let made: ReturnType<typeof makePrefab>;
    try {
      made = makePrefab(this.file, id, path);
    } catch (error) {
      this.notice.value = (error as Error).message;
      return;
    }
    await this.createAsset('prefab', path, made.prefab);
    this.#prefabs = new Map([...this.#prefabs, [path, made.prefab.entities]]);
    this.apply(made.edit);
    this.commit();
    await this.#synced;
    this.select([id]);
    this.notice.value = '';
    this.status.value = t.prefabMade(path);
  }

  /** 把实体连同后代挪到 parent 下面（null 是最上层），排在新的兄弟里的第 position 个。 */
  moveEntity(id: string, parent: string | null, position: number): void {
    this.apply(this.#requireDocument().moveSubtree(id, parent, position));
    this.commit();
  }

  select(ids: readonly string[]): void {
    this.selection.value = ids;
    if (ids.length > 0) this.inspected.value = undefined;
    const agent = this.agent.value;
    if (agent) agent.selection = ids;
  }

  /** 保存；有脚本的必填属性没设时照样保存，在 notice 里列出来（试玩时这些脚本不挂）。 */
  async save(): Promise<void> {
    const opened = this.opened.value;
    if (!opened) return;
    await this.client.saveAsset(opened.kind, opened.path, this.file);
    this.dirty.value = false;
    const missing = this.missingRequiredProps();
    this.notice.value = missing.length === 0 ? '' : t.savedWithMissing(missing.length, missing.slice(0, 3), missing.length > 3);
  }

  /** 展开的场景里，脚本的必填属性（没有默认值的）没设或者是 null 的地方：`实体名 脚本类名.属性`。游戏里没有的脚本不查。 */
  missingRequiredProps(): string[] {
    const agent = this.agent.value;
    if (!agent) return [];
    return this.expanded.flatMap((entity) => (entity.components.scripts ?? []).flatMap((script) => {
      const fields = agent.scriptFields(script.type) ?? [];
      const props = script.props as Readonly<Record<string, unknown>>;
      const name = script.type.slice(Math.max(script.type.lastIndexOf('.'), script.type.lastIndexOf('#')) + 1);
      return fields.filter((field) => !field.optional && props[field.name] == null).map((field) => `${entity.name || entity.id} ${name}.${field.name}`);
    }));
  }

  #changed(dirty = true): void {
    if (dirty) this.dirty.value = true;
    this.version.value++;
    triggerRef(this.version);
    // 游戏页面里的实体跟上；操纵器拖动时代理自己也会 sync，重复的没有开销（没变的组件不重建）
    this.#synced = this.agent.value?.sync() ?? Promise.resolve();
  }

  #requireDocument(): SceneDocument {
    if (!this.#document) throw new Error('no scene is open in the editor yet');
    return this.#document;
  }

  #require(): UndoStack<SceneFile> {
    if (!this.#undo) throw new Error('no scene is open in the editor yet');
    return this.#undo;
  }
}

/** 这次移动以后打开着的文档在哪（没挪它就是原样）。 */
function movedPath(request: MoveRequest, { kind, path }: OpenedDocument): string {
  if ('folder' in request) return path.startsWith(`${request.folder}/`) ? request.to + path.slice(request.folder.length) : path;
  return request.assets.find((move) => move.kind === kind && move.from === path)?.to ?? path;
}

/**
 * 热重载要重新加载的内容路径：改了的资源，加上直接、间接引用它们的（材质改了，引用它的模型、模型的贴图……一路往上），场景和
 * 预制体除外（它们是文档，另有一套跟上的办法）。
 */
export function assetsToReload(assets: readonly AssetRecord[], changed: readonly AssetRecord[]): string[] {
  const reload = new Set(changed.map((asset) => asset.path));
  const pending = [...changed];
  while (pending.length > 0) {
    const asset = pending.pop()!;
    for (const referrer of assets) {
      if (referrer.kind === 'scene' || referrer.kind === 'prefab' || reload.has(referrer.path)) continue;
      if (!referrer.references.some((ref) => ref.kind === asset.kind && ref.path === asset.path)) continue;
      reload.add(referrer.path);
      pending.push(referrer);
    }
  }
  return [...reload];
}

/** 属性面板能编辑的资源种类（引擎的 ASSET_FIELDS）。 */
export type InspectableKind = keyof typeof ASSET_FIELDS;

/** 属性面板正在编辑的资源和它现在的内容。 */
export interface InspectedAsset {
  readonly kind: InspectableKind;
  readonly path: string;
  readonly content: Record<string, unknown>;
}

const isInspectable = (kind: AssetKind): kind is InspectableKind => Object.hasOwn(ASSET_FIELDS, kind);

/** 资源改了以后等这么久（毫秒）再存：拖数字、取色时不每一下都写文件。 */
const INSPECTED_SAVE_DELAY = 250;

/** 打开着的时间轴：内容（改了就是新对象）、预览到的时刻、是不是从时间轴的相机里看，那一刻的相机（场景文件里的 id）和字幕。 */
export interface OpenTimeline {
  readonly path: string;
  readonly content: TimelineFile;
  readonly time: number;
  readonly throughCamera: boolean;
  readonly camera: string | undefined;
  readonly subtitle: string;
}
