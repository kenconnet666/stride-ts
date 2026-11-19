/**
 * 编辑器界面的状态：打开的场景文档和撤销栈、选中的实体、嵌着的游戏页面里的代理（`game.editor`）。各个面板都读它、经它改。
 *
 * 场景文档（SceneDocument，文件是真相）在界面这边；游戏页面里的实体跟着它（EditAgent.open 拿到的是这里的撤销栈）。
 * 视口里拖操纵器改的经撤销栈记下，界面跟着刷新。Vue 的响应式只包在这一层：文档本身不可变，每改一次 version 加一。
 */
import { shallowRef, triggerRef } from 'vue';
import type { SceneFile } from '@stride-ts/engine/content-format';
import { SceneDocument, UndoStack, type SceneEdit } from '@stride-ts/engine/editor-document';
import type { EditAgent, EditableScene, Game } from '@stride-ts/engine';
import { EditorClient } from '../client/EditorClient.ts';
import type { AssetRecord, ProjectInfo } from '../protocol.ts';

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
    this.#undo = new UndoStack(new SceneDocument(await this.client.readAsset<SceneFile>('scene', path)));
    this.scenePath.value = path;
    this.dirty.value = false;
    this.selection.value = [];
    agent.onSelectionChanged = (ids) => (this.selection.value = ids);
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
    void this.agent.value?.sync();
  }

  #require(): UndoStack<SceneFile> {
    if (!this.#undo) throw new Error('no scene is open in the editor yet');
    return this.#undo;
  }
}
