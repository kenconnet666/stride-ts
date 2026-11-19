// CSharpIntermediate 的 LoadScene：按下指定的键，把根场景换成 sceneToLoad（旧的根场景连同它的子场景一起卸载）。
import { prop, SyncScript } from '@stride-ts/engine';

export class LoadScene extends SyncScript.props({
  sceneToLoad: prop.asset('scene').optional(),
  drawY: prop.int().default(20),
  info: prop.string().default('Info text'),
  /** Stride 的 Keys 的名字。 */
  keyToPress: prop.string().default('None'),
}) {
  override update(): void {
    this.game.debugText.print(`${this.info}: ${this.keyToPress}`, [20, this.drawY]);
    if (this.sceneToLoad && this.game.input.isKeyPressed(this.keyToPress)) void this.game.setRootScene(this.sceneToLoad);
  }
}
