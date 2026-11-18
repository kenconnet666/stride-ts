// FirstPersonShooter 的 PlayerController：按 PlayerInput 广播的移动方向给角色设 MoveVector，再广播跑速给 AnimationController。
import { Character, EventKey, prop, SyncScript } from '@stride-ts/engine';
import { MoveDirectionEventKey } from './PlayerInput';

export const RunSpeedEventKey = new EventKey<number>();

export class PlayerController extends SyncScript.props({
  maxRunSpeed: prop.number().default(5),
}) {
  readonly #moveDirectionEvents = this.receive(MoveDirectionEventKey);

  override start(): void {
    if (!this.entity.get(Character)) throw new Error('Please add a Character to the entity containing PlayerController!');
  }

  override update(): void {
    const direction = this.#moveDirectionEvents.drain().at(-1);
    const character = this.entity.require(Character);
    character.speed = this.maxRunSpeed;
    character.moveX = direction?.x ?? 0;
    character.moveY = direction?.z ?? 0;
    RunSpeedEventKey.broadcast(direction?.length() ?? 0);
  }
}
