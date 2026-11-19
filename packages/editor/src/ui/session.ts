/**
 * 编辑器界面的状态：打开的场景文档和撤销栈、选中的实体、嵌着的游戏页面里的代理（`game.editor`）。各个面板都读它、经它改。
 *
 * 场景文档（SceneDocument，文件是真相）在界面这边；游戏页面里的实体跟着它（EditAgent.open 拿到的是这里的撤销栈）。
 * 视口里拖操纵器改的经撤销栈记下，界面跟着刷新。Vue 的响应式只包在这一层：文档本身不可变，每改一次 version 加一。
 */
import { shallowRef, triggerRef } from 'vue';
import type { SceneEntityFile, SceneFile } from '@stride-ts/engine/content-format';
import { SceneDocument, UndoStack, type SceneEdit } from '@stride-ts/engine/editor-document';
import type { EditAgent, EditableScene, Game } from '@stride-ts/engine';
import { EditorClient } from '../client/EditorClient.ts';
import type { AssetKind, AssetRecord, MoveRequest, MoveResult, ProjectInfo } from '../protocol.ts';

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
  /** 正在编辑的场景的内容路径。 */
  readonly scenePath = shallowRef<string>();
  #document: SceneDocument | undefined;
  /** 最近一次修改以后游戏页面里的实体跟上了。 */
  #synced: Promise<void> = Promise.resolve();
  #undo: UndoStack<SceneFile> | undefined;

  async start(): Promise<void> {
    const [project, assets] = await Promise.all([this.client.project(), this.client.assets()]);
    this.project.value = project;
    this.assets.value = assets;
    this.client.onAssetsChanged(({ changed, removed }) => {
      const gone = new Set([...changed, ...removed].map((asset) => `${asset.kind}:${asset.path}`));
      this.assets.value = [...this.assets.value.filter((asset) => !gone.has(`${asset.kind}:${asset.path}`)), ...changed]
        .sort((a, b) => (a.kind === b.kind ? (a.path < b.path ? -1 : 1) : a.kind < b.kind ? -1 : 1));
    });
  }

  /** 游戏页面起来了：读它加载的根场景，交给它的代理，之后实体跟着这里的文档。 */
  async attach(game: Game): Promise<void> {
    const agent = game.editor;
    if (!agent) throw new Error('the game page is not in edit mode (open it with ?debug&stride-edit)');
    const path = agent.scenePath;
    if (!path) throw new Error('the game did not load its root scene from a content path; the editor cannot tell which scene file to open');
    agent.onSelectionChanged = (ids) => (this.selection.value = ids);
    await this.#open(agent, path);
  }

  /**
   * 移动、改名资源（引用它们的文件跟着改写，见后端的 moveAssets）。改写的是磁盘上的文件，所以先保存打开着的场景；场景文件
   * 被改写了（或者场景自己挪了）就从磁盘重新打开（撤销的历史从这里重新开始）。
   */
  async moveAssets(request: MoveRequest): Promise<MoveResult> {
    if (this.dirty.value) await this.save();
    const result = await this.client.moveAssets(request);
    const agent = this.agent.value, path = this.scenePath.value;
    if (agent && path) {
      const moved = movedPath(request, path);
      if (moved !== path || result.rewritten.some((asset) => asset.kind === 'scene' && asset.path === moved)) await this.#open(agent, moved);
    }
    return result;
  }

  /** 删掉一个资源；还有别的资源引用它时报错（错误里列出是谁），force 照删。 */
  async deleteAsset(kind: AssetKind, path: string, force = false): Promise<void> {
    await this.client.deleteAsset(kind, path, { force });
  }

  async #open(agent: EditAgent, path: string): Promise<void> {
    this.#document = new SceneDocument(await this.client.readAsset<SceneFile>('scene', path));
    this.#undo = new UndoStack(this.#document);
    this.scenePath.value = path;
    this.dirty.value = false;
    this.selection.value = [];
    await agent.open(this);
    this.agent.value = agent;
    this.#changed(false);
  }

  /** 游戏页面要重新加载了（试玩回来、HMR 整页刷新）：代理作废。 */
  detach(): void {
    this.agent.value = undefined;
  }

  get file(): SceneFile {
    return this.#require().file;
  }

  get canUndo(): boolean {
    return this.#undo?.canUndo ?? false;
  }

  get canRedo(): boolean {
    return this.#undo?.canRedo ?? false;
  }

  /** 做一个修改（EditableScene）；mergeKey 相同的连着的修改并成撤销的一步（拖动、连续输入）。 */
  apply(edit: SceneEdit, mergeKey?: string): void {
    this.#require().apply(edit, mergeKey);
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

  /** 删掉选中的实体和它们的后代（一步撤销）。 */
  deleteSelection(): void {
    const document = this.#requireDocument();
    const selected = new Set(this.selection.value);
    // 祖先也选中了的不用单独删：删祖先时一起删了
    const roots = [...selected].filter((id) => {
      for (let parent = document.entity(id)?.parent ?? null; parent !== null; parent = document.entity(parent)?.parent ?? null) if (selected.has(parent)) return false;
      return document.entity(id) !== undefined;
    });
    if (roots.length === 0) return;
    this.apply({ type: 'batch', edits: roots.map((id) => document.removeSubtree(id)) });
    this.commit();
    this.select([]);
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

  async save(): Promise<void> {
    const path = this.scenePath.value;
    if (!path) return;
    await this.client.saveAsset('scene', path, this.file);
    this.dirty.value = false;
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

/** 这次移动以后场景 path 在哪（没挪它就是原样）。 */
function movedPath(request: MoveRequest, path: string): string {
  if ('folder' in request) return path.startsWith(`${request.folder}/`) ? request.to + path.slice(request.folder.length) : path;
  return request.assets.find((move) => move.kind === 'scene' && move.from === path)?.to ?? path;
}
