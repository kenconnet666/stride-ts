// CSharpIntermediate 的 LoadChildScene：按 C 把 childSceneToLoad 作为脚本所在场景的子场景加载进来，再按一次卸载；
// 每加载一次往上抬 0.5（场景的偏移）。
// 和 Stride 不同：加载是异步的（Content.Load 是同步的），加载完之前再按 C 不起作用。
import { prop, SyncScript, type SceneInstance } from '@stride-ts/engine';

export class LoadChildScene extends SyncScript.props({
  childSceneToLoad: prop.asset('scene').optional(),
}) {
  #loaded = 0;
  #child: SceneInstance | undefined;
  #loading = false;

  override update(): void {
    this.game.debugText.print('Press C to load/unload child scene', [20, 60]);
    if (!this.game.input.isKeyPressed('C') || this.#loading || !this.childSceneToLoad) return;
    if (this.#child) {
      this.game.unloadScene(this.#child);
      this.#child = undefined;
      return;
    }
    this.#loading = true;
    void this.game.loadScene(this.childSceneToLoad, { parent: this.entity.scene, offset: [0, 0.5 * this.#loaded++, 0] }).then((scene) => {
      this.#loading = false;
      // 加载完之前根场景已经换走了：父场景卸载过了，这个子场景没人管，自己卸载
      if (this.attached) this.#child = scene;
      else this.game.unloadScene(scene);
    });
  }
}
