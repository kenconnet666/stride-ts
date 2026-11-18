// TopDownRPG 的 CrateScript：箱子被打到（Trigger 广播，出拳的碰撞体进来）后跳一下缩没，放尘土特效，掉出 3 到 6 个金币
// （带冲量往外飞），1.5 秒后移除。音效（SoundEffect）属于 P2，场景导入时是 null，这里不声明。
import { Matrix, prop, SyncScript, Transform, Vector3, type EventReceiver, type GameTime } from '@stride-ts/engine';
import { spawnPrefabInstance, spawnPrefabModel, worldPosition } from '../core/Utils';
import { Trigger } from './Trigger';

export class CrateScript extends SyncScript.props({
  coinGetEffect: prop.asset('prefab').optional(),
  coinSpawnModel: prop.asset('prefab').optional(),
  trigger: prop.component(() => Trigger).optional(),
}) {
  #triggered: EventReceiver<boolean> | undefined;
  #activated = false;
  #animationTime = 0;

  override start(): void {
    this.#triggered = this.trigger && this.receive(this.trigger.triggerEvent);
  }

  override update(time: GameTime): void {
    if (!this.#activated && this.#triggered?.tryReceive() !== undefined) this.#collisionStarted();
    if (!this.#activated) return;
    this.#animationTime += time.elapsed * 8;
    const transform = this.entity.require(Transform);
    transform.position.y = 1 + Math.max(0, Math.sin(this.#animationTime));
    const scale = Math.max(0, Math.min(1, (2 * Math.PI - this.#animationTime) / Math.PI));
    transform.scale.x = transform.scale.y = transform.scale.z = scale;
  }

  #collisionStarted(): void {
    this.#activated = true;
    const at = worldPosition(this.entity);
    spawnPrefabInstance(this, this.coinGetEffect, undefined, 1.8, Matrix.compose(Matrix.identity(), [at.x, at.y, at.z], [0, 0, 0, 1], [1, 1, 1]));
    void this.delay(1.5).then(() => this.entity.destroy(), () => undefined);
    const coins = 3 + Math.floor(Math.random() * 4);
    for (let i = 0; i < coins; i++) {
      const offset = new Vector3(Math.random() - 0.5, Math.random(), Math.random() - 0.5);
      const position = offset.clone().scale(2).add(at);
      const size = 0.7 + Math.random() * 0.3;
      spawnPrefabModel(this, this.coinSpawnModel, undefined, Matrix.compose(Matrix.identity(), [position.x, position.y, position.z], [0, 0, 0, 1], [size, size, size]),
        offset.scale(3 + Math.random() * 3));
    }
  }
}
