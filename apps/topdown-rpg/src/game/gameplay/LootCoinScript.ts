// TopDownRPG 的 LootCoinScript：箱子打碎后掉出来的金币（预制体 LootGoldCoin 的子实体，父实体是带刚体的圆柱）。角色碰到后
// 放拿金币的特效和音效、缩没，3 秒后连父实体一起移除。
import { Matrix, prop, SyncScript, Transform, type EventReceiver, type GameTime, type SoundInstance } from '@stride-ts/engine';
import { spawnPrefabInstance, worldPosition } from '../core/Utils';
import { Trigger } from './Trigger';

export class LootCoinScript extends SyncScript.props({
  coinGetEffect: prop.asset('prefab').optional(),
  soundEffect: prop.asset('sound').optional(),
  trigger: prop.component(() => Trigger).optional(),
}) {
  /** 被碰到时放的那一声（没配音效时是 undefined）。 */
  sfxInstance: SoundInstance | undefined;
  #triggered: EventReceiver<boolean> | undefined;
  #activated = false;
  #animationTime = (Math.PI * 3) / 2;

  override start(): void {
    this.#triggered = this.trigger && this.receive(this.trigger.triggerEvent);
    this.sfxInstance = this.soundEffect?.createInstance();
  }

  override update(time: GameTime): void {
    if (!this.#activated && this.#triggered?.tryReceive() !== undefined) this.#collisionStarted();
    if (!this.#activated) return;
    this.#animationTime += time.elapsed * 5;
    if (this.#animationTime > Math.PI * 3) {
      const scale = this.entity.require(Transform).scale;
      scale.x = scale.y = scale.z = 0;
    }
  }

  #collisionStarted(): void {
    this.#activated = true;
    this.sfxInstance?.play();
    const at = worldPosition(this.entity);
    spawnPrefabInstance(this, this.coinGetEffect, undefined, 3, Matrix.compose(Matrix.identity(), [at.x, at.y, at.z], [0, 0, 0, 1], [1, 1, 1]));
    void this.delay(3).then(() => (this.entity.require(Transform).parent ?? this.entity).destroy(), () => undefined);
  }
}
