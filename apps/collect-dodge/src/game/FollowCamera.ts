// 跟随相机：待在目标（玩家）后上方的固定偏移处，平滑地跟过去，一直看着目标。
import { prop, Quaternion, SyncScript, Transform, Vector3, type GameTime } from '@stride-ts/engine';

export class FollowCamera extends SyncScript.props({
  target: prop.entity(),
  /** 相机相对目标的位置（世界空间）。 */
  offset: prop.vec3().default([0, 6, 9]),
  /** 每秒靠近剩余距离的比例（越大跟得越紧）。 */
  stiffness: prop.number().min(0).default(6),
}) {
  readonly #position = new Vector3();
  readonly #back = new Vector3();

  override start(): void {
    this.#position.copy(this.#targetPosition()).add(this.offset);
    this.#apply();
  }

  override update(time: GameTime): void {
    const desired = this.#targetPosition().add(this.offset);
    this.#position.lerp(desired, 1 - Math.exp(-this.stiffness * time.elapsed));
    this.#apply();
  }

  #targetPosition(): Vector3 {
    const world = this.game.entities.entity(this.target).require(Transform).world;
    return new Vector3(world[12], world[13], world[14]);
  }

  /** 放到 #position，朝向目标：相机看的是本地 -Z，所以让 +Z 朝背离目标的方向。 */
  #apply(): void {
    const transform = this.entity.require(Transform);
    transform.position = this.#position;
    transform.rotation = Quaternion.lookRotation(this.#back.copy(this.#position).subtract(this.#targetPosition()), UP);
  }
}

const UP = new Vector3(0, 1, 0);
