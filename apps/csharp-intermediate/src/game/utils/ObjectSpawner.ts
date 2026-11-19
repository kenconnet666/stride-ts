// CSharpIntermediate 的 ObjectSpawner：按 S 把预制体的球放到脚本实体的位置（第一次按时实例化，之后把同一个球瞬移回来、速度清零）。
import { prop, Quaternion, SyncScript, Transform, type Entity } from '@stride-ts/engine';

export class ObjectSpawner extends SyncScript.props({
  objectToSpawn: prop.asset('prefab').optional(),
}) {
  #clone: Entity | undefined;

  override update(): void {
    this.game.debugText.print('Press S to spawn ball', [300, 180]);
    if (!this.game.input.isKeyPressed('S') || !this.objectToSpawn) return;
    if (!this.#clone?.alive) {
      [this.#clone] = this.objectToSpawn.instantiate(this.game.entities);
      // 放进脚本实体所在的场景（Stride 的 Entity.Scene.Entities.Add），换教程时跟着销毁
      this.#clone!.scene = this.entity.scene;
    }
    const transform = this.entity.require(Transform);
    transform.updateWorldMatrix();
    const [x, y, z] = transform.world.subarray(12, 15);
    // 球是物理在带着走：瞬移刚体、停下来、唤醒
    const body = this.game.simulation!.body(this.#clone!);
    body.teleport({ x: x!, y: y!, z: z! }, new Quaternion());
    body.linearVelocity = { x: 0, y: 0, z: 0 };
    body.angularVelocity = { x: 0, y: 0, z: 0 };
    body.awake = true;
  }

  override cancel(): void {
    if (this.#clone?.alive) this.#clone.destroy();
    this.#clone = undefined;
  }
}
