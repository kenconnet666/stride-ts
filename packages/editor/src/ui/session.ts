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
import { shallowRef, triggerRef } from 'vue';
import type { PrefabFile, SceneEntityFile, SceneFile } from '@stride-ts/engine/content-format';
import { expandPrefabInstances, loadPrefabs } from '@stride-ts/engine/content-prefabs';
import { SceneDocument, UndoStack, type SceneEdit } from '@stride-ts/engine/editor-document';
import { instanceMember, toDocumentEdit, type InstanceMember } from '@stride-ts/engine/editor-prefabs';
import { copyEntities, duplicateEntities, pasteEntities, positionAfter, type PasteTarget } from '@stride-ts/engine/editor-copy';
import { makePrefab } from '@stride-ts/engine/editor-make-prefab';
import { freeAssetPath } from '../newAssets';
import type { EditAgent, EditableScene, Game, SnapSettings } from '@stride-ts/engine';
import { EditorClient } from '../EditorClient.ts';
import type { AssetKind, AssetRecord, MoveRequest, MoveResult, ProjectInfo } from '../protocol.ts';

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
  /** 工程（打开时读）。 */
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
    agent.onSelectionChanged = (ids) => (this.selection.value = ids);
    await this.#open(agent, document);
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
    return this.#undo?.canUndo ?? false;
  }

  get canRedo(): boolean {
    return this.#undo?.canRedo ?? false;
  }

  /**
   * 做一个修改（EditableScene）；mergeKey 相同的连着的修改并成撤销的一步（拖动、连续输入）。修改是对展开的场景说的，
   * 改实例成员的换成实例上的覆盖。
   */
  apply(edit: SceneEdit, mergeKey?: string): void {
    this.#require().apply(toDocumentEdit(this.file, this.#prefabs, edit), mergeKey);
    this.#changed();
  }

  /** 一次连着的修改结束了（松开鼠标、输入框失去焦点）：下一次修改不再并进来。 */
  commit(): void {
    this.#undo?.commit();
  }

  undo(): void {
    if (this.#require().undo()) this.#changed();
  }

  redo(): void {
    if (this.#require().redo()) this.#changed();
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
    this.notice.value = `做成了预制体 ${path}，场景里换成了它的实例（保存场景以后生效）`;
  }

  /** 把实体连同后代挪到 parent 下面（null 是最上层），排在新的兄弟里的第 position 个。 */
  moveEntity(id: string, parent: string | null, position: number): void {
    this.apply(this.#requireDocument().moveSubtree(id, parent, position));
    this.commit();
  }

  select(ids: readonly string[]): void {
    this.selection.value = ids;
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
    this.notice.value = missing.length === 0 ? '' : `已保存；${missing.length} 处脚本的必填属性没设，试玩时这些脚本不挂：${missing.slice(0, 3).join('、')}${missing.length > 3 ? '……' : ''}`;
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
