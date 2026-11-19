// BepuSample 的 SceneSelectorComponent：把选中的演示场景作为子场景加载进来，换场景时先卸载上一个。
// 选场景的页面上每个场景一个按钮（UI 库的 TextButton，字是场景的地址），Tab 显示、隐藏页面。调试命令也能换：
// `stride call scenes` 列出场景，`stride call scene '"Ropes"'`（名字的一部分或下标）。
// 和 Stride 不同：开始时就加载页面地址 `?scene=` 指定的场景，没有时加载第一个（Stride 开始时什么都不加载，点了按钮才有）。
import { Button, prop, StackPanel, SyncScript, TextBlock, UIComponent, type SceneInstance, type SceneReference } from '@stride-ts/engine';
import { SCENE_SCRIPTS } from './BepuSampleGame';

export class SceneSelectorComponent extends SyncScript.props({
  /** 子场景挂在哪个场景下；我们的子场景直接加进游戏，用不上（Stride 默认就是自己所在的场景）。 */
  mainScene: prop.asset('scene').optional(),
  sceneList: prop.list(prop.asset('scene')).default([]),
  /** 按钮的模板（TextButton）所在的 UI 库。 */
  library: prop.asset('uiLibrary').optional(),
  /** 选场景的 UI 页面所在的实体。 */
  selectorUI: prop.entity().optional(),
}) {
  #current: SceneInstance | undefined;
  #pending: Promise<unknown> = Promise.resolve();

  override start(): void {
    this.disposables.use(this.game.debug.command('scenes', 'the demo scenes (the buttons of the scene select page in Stride)', () => this.sceneList.map((scene) => scene.path)));
    this.disposables.use(this.game.debug.command('scene', 'load a demo scene. args: part of its name, or its index', (args) => this.#select(args)));
    this.#initializeUI();
    const wanted = new URLSearchParams(location.search).get('scene');
    void this.#select(wanted ?? 0);
  }

  override update(): void {
    const ui = this.#ui;
    if (ui && this.game.input.isKeyPressed('Tab')) ui.enabled = !ui.enabled;
  }

  get #ui(): UIComponent | undefined {
    return this.selectorUI === undefined ? undefined : this.game.entities.entity(this.selectorUI).get(UIComponent);
  }

  #initializeUI(): void {
    const panel = this.#ui?.page?.rootElement?.find(StackPanel, 'SceneStackPanel');
    if (!panel || !this.library) return;
    this.sceneList.forEach((scene, index) => {
      const button = this.library!.instantiateElement('TextButton', Button);
      // 同 Stride 的 UrlReference.Url：不带包名
      button.find(TextBlock)!.text = scene.path.slice(scene.path.indexOf('/') + 1);
      button.onClick(() => void this.#select(index));
      panel.children.add(button);
    });
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
