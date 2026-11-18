// TopDownRPG 的 CoinScript：金币一直转；角色碰到（Trigger 广播）后转得更快、跳一下、缩没，放拿金币的特效，3 秒后移除。
// 音效（SoundEffect）属于 P2 的音频，场景导入时是 null，这里不声明。
import { prop, Quaternion, SyncScript, Transform, Matrix, type EventReceiver, type GameTime } from '@stride-ts/engine';
import { spawnPrefabInstance, worldPosition } from '../core/Utils';
import { Trigger } from './Trigger';

export class CoinScript extends SyncScript.props({
  coinGetEffect: prop.asset('prefab').optional(),
  trigger: prop.component(() => Trigger).optional(),
}) {
  #triggered: EventReceiver<boolean> | undefined;
  #spinSpeed = 1;
  #activated = false;
  #animationTime = (Math.PI * 3) / 2;

  override start(): void {
    this.#triggered = this.trigger && this.receive(this.trigger.triggerEvent);
  }

  override update(time: GameTime): void {
    if (!this.#activated && this.#triggered?.tryReceive() !== undefined) this.#collisionStarted();
    const dt = time.elapsed;
    const transform = this.entity.require(Transform);
    const spin = new Quaternion().setAxisAngle({ x: 0, y: 1, z: 0 }, this.#spinSpeed * dt * Math.PI);
    const rotation = new Quaternion(transform.rotation.x, transform.rotation.y, transform.rotation.z, transform.rotation.w).multiply(spin);
    [transform.rotation.x, transform.rotation.y, transform.rotation.z, transform.rotation.w] = [rotation.x, rotation.y, rotation.z, rotation.w];
    if (!this.#activated) return;
    this.#spinSpeed = Math.min(10, this.#spinSpeed + dt * 15);
    this.#animationTime += dt * 5;
    transform.position.y = 1 + Math.max(0, Math.sin(this.#animationTime));
    if (this.#animationTime > Math.PI * 3) transform.scale.x = transform.scale.y = transform.scale.z = 0;
  }

  #collisionStarted(): void {
    this.#activated = true;
    const at = worldPosition(this.entity);
    spawnPrefabInstance(this, this.coinGetEffect, undefined, 3, Matrix.compose(Matrix.identity(), [at.x, at.y, at.z], [0, 0, 0, 1], [1, 1, 1]));
    void this.delay(3).then(() => this.entity.destroy(), () => undefined);
  }
}
