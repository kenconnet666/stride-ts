// BepuSample 的 SceneSelectorComponent：把选中的演示场景作为子场景加载进来，换场景时先卸载上一个。
// Stride 里是 UI 页面上的按钮（Tab 显示、隐藏），UI（P2）做好之前用调试命令：`stride call scenes` 列出场景，
// `stride call scene '"Ropes"'`（名字的一部分或下标）换场景。开始时加载页面地址 `?scene=` 指定的，没有时加载第一个。
import { prop, SyncScript, type SceneInstance, type SceneReference } from '@stride-ts/engine';
import { SCENE_SCRIPTS } from './BepuSampleGame';

export class SceneSelectorComponent extends SyncScript.props({
  /** 子场景挂在哪个场景下；我们的子场景直接加进游戏，用不上（Stride 默认就是自己所在的场景）。 */
  mainScene: prop.asset('scene').optional(),
  sceneList: prop.list(prop.asset('scene')).default([]),
  /** 选场景的 UI 页面所在的实体（P2 做 UI 时用）。 */
  selectorUI: prop.entity().optional(),
}) {
  #current: SceneInstance | undefined;
  #pending: Promise<unknown> = Promise.resolve();

  override start(): void {
    this.disposables.use(this.game.debug.command('scenes', 'the demo scenes (the buttons of the scene select page in Stride)', () => this.sceneList.map((scene) => scene.path)));
    this.disposables.use(this.game.debug.command('scene', 'load a demo scene. args: part of its name, or its index', (args) => this.#select(args)));
    const wanted = new URLSearchParams(location.search).get('scene');
    void this.#select(wanted ?? 0);
  }

  override cancel(): void {
    if (this.#current) this.game.unloadScene(this.#current);
    this.#current = undefined;
  }

  /** 按下标或名字的一部分找场景，卸载当前的子场景、加载它；返回加载的场景路径。 */
  #select(which: unknown): Promise<string> {
    const scene = typeof which === 'number' ? this.sceneList[which] : this.sceneList.find((s) => s.path.toLowerCase().includes(String(which).toLowerCase()));
    if (!scene) return Promise.reject(new Error(`no scene ${JSON.stringify(which)}; the scenes are ${this.sceneList.map((s) => s.path).join(', ')}`));
    const change = this.#pending.catch(() => undefined).then(() => this.#load(scene));
    this.#pending = change;
    return change;
  }

  async #load(scene: SceneReference): Promise<string> {
    if (this.#current) this.game.unloadScene(this.#current);
    this.#current = undefined;
    this.#current = await this.game.loadScene(scene.path, { scripts: SCENE_SCRIPTS });
    return scene.path;
  }
}
