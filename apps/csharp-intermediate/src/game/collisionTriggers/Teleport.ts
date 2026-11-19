// CSharpIntermediate 的 Teleport：按空格把球瞬移回脚本实体的位置，速度清零。
import { prop, Quaternion, SyncScript, Transform } from '@stride-ts/engine';

export class Teleport extends SyncScript.props({
  ball: prop.entity().optional(),
}) {
  override update(): void {
    this.game.debugText.print('Press Space to teleport ball back in the air', [500, 180]);
    if (!this.game.input.isKeyPressed('Space') || this.ball === undefined) return;
    const [x, y, z] = this.entity.require(Transform).world.subarray(12, 15);
    const body = this.game.simulation!.body(this.game.entities.entity(this.ball));
    body.teleport({ x: x!, y: y!, z: z! }, new Quaternion());
    body.linearVelocity = { x: 0, y: 0, z: 0 };
    body.angularVelocity = { x: 0, y: 0, z: 0 };
  }
}
