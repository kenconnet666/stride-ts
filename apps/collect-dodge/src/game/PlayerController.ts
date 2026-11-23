// 玩家：按输入映射（Input/Player.input.jsonc：WASD、方向键或左摇杆，空格或手柄 A）的 move 按相机的朝向走、jump 起跳（站稳时才跳）。
// 被障碍撞到、掉出关卡时回到出生点。
import { Character, prop, SyncScript, Transform, Vector3 } from '@stride-ts/engine';
import { PlayerHitEventKey } from './events';

const UP = new Vector3(0, 1, 0);

export class PlayerController extends SyncScript.props({
  /** 决定"前"是哪个方向的相机；没有时前是世界的 -Z。 */
  camera: prop.entity().optional(),
  /** 操作的映射：动作 move（二维）、jump（按钮）。 */
  controls: prop.asset('input'),
  speed: prop.number().min(0).default(6).unit('m/s'),
  /** 低于这个高度算掉出关卡。 */
  fallHeight: prop.number().default(-10).unit('m'),
}, { requires: [() => Character] }) {
  readonly #spawn = new Vector3();
  readonly #hits = this.receive(PlayerHitEventKey);

  override start(): void {
    this.#spawn.copy(this.entity.require(Transform).position);
    this.disposables.use(this.game.input.actions.add(this.controls));
  }

  override update(): void {
    const actions = this.game.input.actions;
    const character = this.entity.require(Character);
    const [right, forward] = actions.vector('move');
    const move = this.#toWorld(right, forward);
    const length = move.length();
    if (length > 1) move.scale(1 / length);
    character.speed = this.speed;
    // 角色不转，它的右方、前方就是世界的 X、Z
    character.moveX = move.x;
    character.moveY = move.z;
    if (actions.pressed('jump')) character.jump = true;

    const hit = this.#hits.drain().length > 0;
    if (hit || this.entity.require(Transform).position.y < this.fallHeight) this.respawn();
  }

  /** 回到出生点，速度清零。 */
  respawn(): void {
    const body = this.game.simulation!.body(this.entity);
    body.teleport(this.#spawn, { x: 0, y: 0, z: 0, w: 1 });
    body.linearVelocity = { x: 0, y: 0, z: 0 };
  }

  /** 输入的右、前换到世界的水平方向：前 = 上 × 相机的右方（相机低头时也是水平的）。 */
  #toWorld(right: number, forward: number): Vector3 {
    if (this.camera === undefined) return new Vector3(right, 0, -forward);
    const world = this.game.entities.entity(this.camera).require(Transform).world;
    const cameraRight = new Vector3(world[0], world[1], world[2]);
    const front = new Vector3().copy(UP).cross(cameraRight).normalize();
    const side = new Vector3().copy(front).cross(UP);
    return front.scale(forward).addScaled(side, right);
  }
}
