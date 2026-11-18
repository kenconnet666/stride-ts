// BepuSample 的 SceneDescriptionComponent：在屏幕右上方印出场景的说明（game.debugText，渲染在 P2）。
import { prop, SyncScript } from '@stride-ts/engine';

export class SceneDescriptionComponent extends SyncScript.props({
  description: prop.string().default(''),
}) {
  override update(): void {
    this.game.debugText.print(this.description, [this.game.graphicsDevice.canvas.width - 900, 10]);
  }
}
