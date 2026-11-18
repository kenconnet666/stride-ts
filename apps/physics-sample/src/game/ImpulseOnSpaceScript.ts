// PhysicsSample 的 ImpulseOnSpaceScript：按住空格时每帧给刚体一个向上的冲量。
import { SyncScript } from '@stride-ts/engine';

export class ImpulseOnSpaceScript extends SyncScript {
  override update(): void {
    if (!this.game.input.isKeyDown('Space')) return;
    const body = this.game.simulation!.body(this.entity);
    body.awake = true;
    body.applyLinearImpulse({ x: 0, y: 1, z: 0 });
  }
}
