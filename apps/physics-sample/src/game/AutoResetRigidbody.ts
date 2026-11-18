// PhysicsSample 的 AutoResetRigidbody：触发器里有角色时，运动学的刚体变成动态、落下；角色出去后变回运动学，回到原位。
import { AsyncScript, Matrix, prop, Quaternion, Transform, Vector3 } from '@stride-ts/engine';
import { Trigger } from './Trigger';

export class AutoResetRigidbody extends AsyncScript.props({
  triggerEntity: prop.entity(),
}) {
  override async execute(): Promise<void> {
    // 瞬移放的是世界位姿：箱子是别的实体的子实体；第一帧时世界矩阵还没算，先算出来
    const transform = this.entity.require(Transform);
    transform.updateWorldMatrix();
    const { translation, rotation } = Matrix.decompose(transform.world);
    const startLocation = new Vector3(...translation), startRotation = new Quaternion(...rotation);
    const body = this.game.simulation!.body(this.entity);
    const receiver = this.receive(this.game.entities.entity(this.triggerEntity).require(Trigger).triggerEvent);
    while (this.attached) {
      const inside = await receiver.receive(this.signal);
      if (inside) {
        body.kinematic = false;
        body.awake = true;
      } else {
        body.kinematic = true;
        body.teleport(startLocation, startRotation);
        body.linearVelocity = new Vector3();
        body.angularVelocity = new Vector3();
      }
    }
  }
}
