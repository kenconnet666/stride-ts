// FirstPersonShooter 的 WeaponScript：收到开枪就沿相机的前方打射线（不打第 2 层，玩家自己在那一层），打到动态刚体给一个冲量和
// 一个转动的冲量；每发之间有冷却，9 发打完或按换弹键换弹（换弹也是一段冷却），枪上的子弹数精灵跟着换帧。结果广播给
// AnimationController 和 EffectController。
import { Body, EventKey, prop, Sprite, SyncScript, Transform, Vector3, type GameTime, type SimulationHit } from '@stride-ts/engine';
import { ReloadEventKey, ShootEventKey } from './PlayerInput';

export interface WeaponFiredResult {
  readonly didFire: boolean;
  readonly didHit: boolean;
  readonly hitResult: SimulationHit | undefined;
}

export const WeaponFired = new EventKey<WeaponFiredResult>();
export const IsReloading = new EventKey<boolean>();

const MAGAZINE = 9;
const PLAYER_LAYER = 2;

export class WeaponScript extends SyncScript.props({
  maxShootDistance: prop.number().default(100),
  shootImpulse: prop.number().default(5),
  cooldown: prop.number().default(0.3),
  reloadCooldown: prop.number().default(2),
  /** 显示剩下几发的精灵（精灵表的第 n 帧是数字 n）。 */
  remainingBullets: prop.component(() => Sprite).optional(),
}) {
  #cooldownRemaining = 0;
  /** 一开始是空的：第一次开枪先换弹（同 Stride）。 */
  #remainingBullets = 0;
  readonly #shootEvents = this.receive(ShootEventKey);
  readonly #reloadEvents = this.receive(ReloadEventKey);

  override update(time: GameTime): void {
    const didShoot = this.#shootEvents.drain().at(-1) ?? false;
    const didReload = this.#reloadEvents.drain().at(-1) ?? false;
    this.#cooldownRemaining = this.#cooldownRemaining > 0 ? this.#cooldownRemaining - time.elapsed : 0;
    if (this.#cooldownRemaining > 0) return;
    if ((this.#remainingBullets === 0 && didShoot) || (this.#remainingBullets < MAGAZINE && didReload)) {
      void this.#reload().catch(() => undefined);
      return;
    }
    if (!didShoot) return;
    this.#remainingBullets--;
    this.#updateBulletsLed();
    this.#cooldownRemaining = this.cooldown;
    this.#shoot();
  }

  #shoot(): void {
    const world = this.entity.require(Transform).world;
    const start: [number, number, number] = [world[12]!, world[13]!, world[14]!];
    const forward = new Vector3(-world[8]!, -world[9]!, -world[10]!).normalize();
    const simulation = this.game.simulation!;
    const hit = simulation.rayCast(start, [forward.x, forward.y, forward.z], this.maxShootDistance, { mask: ~(1 << PLAYER_LAYER) >>> 0 });
    if (hit && this.game.entities.entity(hit.entity).get(Body)?.kinematic === false) {
      const body = simulation.body(hit.entity);
      body.awake = true;
      body.applyLinearImpulse(forward.clone().scale(this.shootImpulse));
      body.applyAngularImpulse(forward.clone().scale(this.shootImpulse).add({ x: 0, y: 1, z: 0 }));
    }
    WeaponFired.broadcast({ didFire: true, didHit: hit !== undefined, hitResult: hit });
  }

  async #reload(): Promise<void> {
    IsReloading.broadcast(true);
    this.#cooldownRemaining = this.reloadCooldown;
    await this.delay(this.reloadCooldown);
    this.#remainingBullets = MAGAZINE;
    this.#updateBulletsLed();
  }

  #updateBulletsLed(): void {
    if (this.remainingBullets) this.remainingBullets.frame = this.#remainingBullets;
  }
}
