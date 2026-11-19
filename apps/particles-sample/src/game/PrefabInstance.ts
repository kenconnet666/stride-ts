// ParticlesSample 的 PrefabInstance：Animation 的第一个动画放到 TimeDelay 秒时（每圈一次）实例化 Source 预制体，Following 时挂在
// 这个实体下面跟着走，否则放在实体当时的位置；InstanceTimeout 秒后移除。
import { AnimationComponent, AsyncScript, Matrix, prop, Transform, type Entity } from '@stride-ts/engine';

export class PrefabInstance extends AsyncScript.props({
  sourcePrefab: prop.asset('prefab').optional(),
  following: prop.bool().default(true),
  instanceTimeout: prop.number().default(3),
  timeDelay: prop.number().default(0),
  animation: prop.component(() => AnimationComponent).optional(),
}) {
  #canTrigger = true;
  #lastTime = 0;

  override async execute(): Promise<void> {
    while (this.attached) {
      await this.nextFrame();
      if (this.#isTriggered()) this.#spawn();
    }
  }

  /** 动画的时间绕回开头时重新可以触发，走过 TimeDelay 时触发一次。 */
  #isTriggered(): boolean {
    const time = this.animation?.playingAnimations[0]?.currentTime ?? 0;
    if (time < this.#lastTime) this.#canTrigger = true;
    const triggered = this.#canTrigger && this.timeDelay <= time;
    this.#lastTime = time;
    if (triggered) this.#canTrigger = false;
    return triggered;
  }

  #spawn(): void {
    const prefab = this.sourcePrefab;
    if (!prefab) return;
    const spawned = prefab.instantiate(this.game.entities);
    for (const entity of spawned) {
      const transform = entity.require(Transform);
      if (transform.parent) continue;
      if (this.following) transform.parent = this.entity;
      else place(entity, Matrix.multiply(new Float32Array(16), this.entity.require(Transform).world, transform.localMatrix()));
    }
    void (async () => {
      for (let remaining = this.instanceTimeout; remaining > 0; remaining -= this.game.updateTime.elapsed) await this.nextFrame();
      for (const entity of spawned) if (this.game.entities.isAlive(entity.id)) entity.destroy();
    })();
  }
}

/** 把实体的本地变换设成 world（实体没有父实体时就是世界变换）。 */
function place(entity: Entity, world: Float32Array): void {
  entity.require(Transform).setLocalMatrix(world);
}
