// Third Person Platformer 的 PlayerController：按输入事件驱动角色（Character 组件），模型子实体转向移动方向；
// 起跳有一小段宽限（刚走下平台的一会儿还能跳）。广播是否着地和跑速，给动画用。
// 和 Stride 不同的几处（都是帧率或事件积压带来的问题）：
// - 移动方向的平滑按时间换算，60 fps 时和 Stride 的每帧 15% 一样；
// - 起跳宽限按这一帧的时间减，Stride 减的是仿真步长，帧率高时宽限变短；
// - 每帧把输入事件取完（移动取最新的，起跳只要有一次），Stride 每帧取一个：悬空时没取的起跳会积到落地后才触发。
import { Character, EventKey, prop, SyncScript, Transform, Vector3, type Entity, type GameTime, type ViewOf } from '@stride-ts/engine';
import { JumpEventKey, MoveDirectionEventKey } from './PlayerInput';

export const IsGroundedEventKey = new EventKey<boolean>();
export const RunSpeedEventKey = new EventKey<number>();

/** Stride 每帧（按 60 fps）向新方向靠的比例。 */
const FOLLOW_PER_FRAME = 0.15;

export class PlayerController extends SyncScript.props({
  /** Stride 的 MaxRunSpeed（场景里是 8.5）。 */
  maxRunSpeed: prop.number().min(0).default(8.5),
  /** Stride 的 JumpReactionThreshold：离开地面后这么多秒内还能起跳。 */
  jumpReactionThreshold: prop.number().min(0).default(0.15),
}) {
  #moveDirection = new Vector3();
  #yawOrientation = 0;
  #jumpReactionRemaining = 0;
  #model: Entity | undefined;
  readonly #moveEvents = this.receive(MoveDirectionEventKey);
  readonly #jumpEvents = this.receive(JumpEventKey);

  override start(): void {
    this.#jumpReactionRemaining = this.jumpReactionThreshold;
    if (!this.entity.get(Character)) throw new Error('PlayerController needs a Character on the same entity');
    this.#model = this.entity.require(Transform).children[0];
  }

  override update(time: GameTime): void {
    const character = this.entity.require(Character);
    const moves = this.#moveEvents.drain();
    const jumpPressed = this.#jumpEvents.drain().includes(true);
    this.#move(character, moves[moves.length - 1] ?? ZERO, time.elapsed);
    this.#jump(character, jumpPressed, time.elapsed);
  }

  #jump(character: ViewOf<typeof Character>, jumpPressed: boolean, dt: number): void {
    if (this.jumpReactionThreshold <= 0) {
      if (!character.grounded) {
        IsGroundedEventKey.broadcast(false);
        return;
      }
    } else {
      if (this.#jumpReactionRemaining > 0) this.#jumpReactionRemaining -= dt;
      if (character.grounded) this.#jumpReactionRemaining = this.jumpReactionThreshold;
      if (this.#jumpReactionRemaining <= 0) {
        IsGroundedEventKey.broadcast(character.grounded);
        return;
      }
    }
    if (!jumpPressed) {
      IsGroundedEventKey.broadcast(true);
      return;
    }
    this.#jumpReactionRemaining = 0;
    character.jump = true;
    IsGroundedEventKey.broadcast(false);
  }

  #move(character: ViewOf<typeof Character>, target: Vector3, dt: number): void {
    const follow = 1 - (1 - FOLLOW_PER_FRAME) ** (dt * 60);
    this.#moveDirection.scale(1 - follow).addScaled(target, follow);
    character.speed = this.maxRunSpeed;
    character.moveX = this.#moveDirection.x;
    character.moveY = this.#moveDirection.z;
    const length = this.#moveDirection.length();
    RunSpeedEventKey.broadcast(length);
    // 模型朝向移动方向（Stride 的 atan2(-z, x) + π/2，绕 Y 轴）
    if (length > 0.001) this.#yawOrientation = Math.atan2(-this.#moveDirection.z, this.#moveDirection.x) + Math.PI / 2;
    const rotation = this.#model?.require(Transform).rotation;
    if (rotation) {
      rotation.x = rotation.z = 0;
      rotation.y = Math.sin(this.#yawOrientation / 2);
      rotation.w = Math.cos(this.#yawOrientation / 2);
    }
  }
}

const ZERO = new Vector3();
