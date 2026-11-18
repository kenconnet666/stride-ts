// PhysicsSample 的 NextSceneScript：在三个场景之间换（Raycasting → Constraints → VolumeTrigger → Raycasting）。
// Stride 里用 UI 的 <<、>> 按钮换，UI（P2）做好之前用调试命令 `stride call next-scene`、`stride call previous-scene`。
// 和 Stride 一样，按钮只记下要去的场景，下一帧的 update 里才换根场景。
import { prop, SyncScript, type SceneReference } from '@stride-ts/engine';

export class NextSceneScript extends SyncScript.props({
  nextScene: prop.asset('scene').optional(),
  previousScene: prop.asset('scene').optional(),
}) {
  #target: SceneReference | undefined;

  override start(): void {
    for (const [name, scene] of [['next-scene', this.nextScene], ['previous-scene', this.previousScene]] as const) {
      if (!scene) continue;
      this.disposables.use(this.game.debug.command(name, `switch to ${scene.path} (the ${name === 'next-scene' ? '>>' : '<<'} button in Stride)`, () => {
        this.#target = scene;
        return scene.path;
      }));
    }
  }

  override update(): void {
    if (!this.#target) return;
    const target = this.#target;
    this.#target = undefined;
    this.game.setRootScene(target).catch((error: unknown) => console.error(`[stride] failed to switch to ${target.path}`, error));
  }
}
