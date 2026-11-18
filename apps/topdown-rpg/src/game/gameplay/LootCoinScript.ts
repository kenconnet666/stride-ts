// TopDownRPG 的 LootCoinScript：箱子打碎后掉出来的金币（预制体 LootGoldCoin 的子实体，父实体是带刚体的圆柱）。角色碰到后
// 放拿金币的特效、缩没，3 秒后连父实体一起移除。音效（SoundEffect）属于 P2，场景导入时是 null，这里不声明。
import { Matrix, prop, SyncScript, Transform, type EventReceiver, type GameTime } from '@stride-ts/engine';
import { spawnPrefabInstance, worldPosition } from '../core/Utils';
import { Trigger } from './Trigger';

export class LootCoinScript extends SyncScript.props({
  coinGetEffect: prop.asset('prefab').optional(),
  trigger: prop.component(() => Trigger).optional(),
}) {
  #triggered: EventReceiver<boolean> | undefined;
  #activated = false;
  #animationTime = (Math.PI * 3) / 2;

  override start(): void {
    this.#triggered = this.trigger && this.receive(this.trigger.triggerEvent);
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
    const at = worldPosition(this.entity);
    spawnPrefabInstance(this, this.coinGetEffect, undefined, 3, Matrix.compose(Matrix.identity(), [at.x, at.y, at.z], [0, 0, 0, 1], [1, 1, 1]));
    void this.delay(3).then(() => (this.entity.require(Transform).parent ?? this.entity).destroy(), () => undefined);
  }
}
