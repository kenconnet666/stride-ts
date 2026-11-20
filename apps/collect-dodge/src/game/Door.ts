// 门：运动学刚体，收到 DoorOpen 后在 openTime 秒里升起 openHeight 米，让出去终点的路。
import { Body, prop, SyncScript, Transform, type GameTime } from '@stride-ts/engine';
import { DoorOpenEventKey } from './events';

export class Door extends SyncScript.props({
  openHeight: prop.number().default(4).unit('m'),
  openTime: prop.number().min(0.1).default(1.5).unit('s'),
}, { requires: [() => Body] }) {
  readonly #open = this.receive(DoorOpenEventKey);
  #closedY = 0;
  #opening = false;

  /** 门在打开（或开着）。 */
  get isOpen(): boolean {
    return this.#opening;
  }

  override start(): void {
    this.#closedY = this.entity.require(Transform).position.y;
    this.game.simulation!.body(this.entity).kinematic = true;
  }

  override update(time: GameTime): void {
    if (this.#open.drain().length > 0) this.#opening = true;
    if (!this.#opening || time.elapsed <= 0) return;
    const y = this.entity.require(Transform).position.y;
    const remaining = this.#closedY + this.openHeight - y;
    const speed = this.openHeight / this.openTime;
    // 最后一段按剩下的距离走，正好停在顶上
    const vy = Math.max(0, Math.min(speed, remaining / time.elapsed));
    this.game.simulation!.body(this.entity).linearVelocity = { x: 0, y: vy, z: 0 };
  }
}
