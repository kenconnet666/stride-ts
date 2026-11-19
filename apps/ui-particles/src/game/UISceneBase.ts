// UIParticles 的 UISceneBase（同 GameMenu 的）：SplashScript 的基类。UI 的虚拟分辨率跟着窗口大小（页面按真实像素
// 布局），第一次 update 之前建好场景（LoadScene），之后每帧 UpdateScene。Stride 在窗口大小变了的事件里改分辨率，我们每帧比一下。
import { SyncScript, UIComponent, type GameTime } from '@stride-ts/engine';

export abstract class UISceneBase extends SyncScript {
  protected isRunning = false;
  #sceneCreated = false;

  override start(): void {
    this.isRunning = true;
    this.#adjustVirtualResolution();
    this.#createScene();
  }

  override update(_time: GameTime): void {
    this.#adjustVirtualResolution();
    this.updateScene();
  }

  override cancel(): void {
    this.isRunning = false;
    this.#sceneCreated = false;
  }

  protected updateScene(): void {}

  protected abstract loadScene(): void;

  #adjustVirtualResolution(): void {
    const { width, height } = this.game.graphicsDevice.canvas;
    const resolution = this.entity.require(UIComponent).resolution;
    if (resolution.x !== width || resolution.y !== height) resolution.set(width, height, 1000);
  }

  #createScene(): void {
    if (!this.#sceneCreated) this.loadScene();
    this.#sceneCreated = true;
  }
}
