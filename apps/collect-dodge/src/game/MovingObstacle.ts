// 会动的障碍：运动学刚体（Body 的 kinematic），在起点和起点加 offset 之间平滑地来回走；撞到玩家就发 PlayerHit。
import { Body, Character, prop, SyncScript, Transform, Vector3, type GameTime } from '@stride-ts/engine';
import { PlayerHitEventKey } from './events';

export class MovingObstacle extends SyncScript.props({
  /** 走到的另一头相对起点的位置。 */
  offset: prop.vec3().default([4, 0, 0]),
  /** 走一个来回的秒数。 */
  period: prop.number().min(0.1).default(3).unit('s'),
  /** 起步时在来回里的进度（0..1），几个障碍错开走。 */
  phase: prop.number().min(0).max(1).default(0),
}, { requires: [() => Body] }) {
  readonly #start = new Vector3();
  #time = 0;

  override start(): void {
    this.#start.copy(this.entity.require(Transform).position);
    this.#time = this.phase * this.period;
    const simulation = this.game.simulation!;
    simulation.body(this.entity).kinematic = true;
    simulation.setContactHandler(this.entity, {
      onStartedTouching: ({ other }) => {
        if (this.game.entities.hasComponent(other, Character)) PlayerHitEventKey.broadcast();
      },
    });
  }

  override update(time: GameTime): void {
    const dt = time.elapsed;
    if (dt <= 0) return;
    this.#time += dt;
    // 按下一帧该到的位置定速度（不积分速度，误差不会累积）
    const target = this.#positionAt(this.#time + dt);
    const velocity = target.subtract(this.entity.require(Transform).position).scale(1 / dt);
    this.game.simulation!.body(this.entity).linearVelocity = velocity;
  }

  #positionAt(t: number): Vector3 {
    const s = 0.5 - 0.5 * Math.cos((2 * Math.PI * t) / this.period);
    return new Vector3().copy(this.#start).addScaled(this.offset, s);
  }
}
