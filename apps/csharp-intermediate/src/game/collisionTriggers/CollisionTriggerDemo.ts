// CSharpIntermediate 的 CollisionTriggerDemo：实体的静态碰撞体是触发器（Trigger 处理器），有物体进出时记下来，
// 把现在在里面的物体和最近一次进出打印出来。
import { SyncScript, type EntityId } from '@stride-ts/engine';

export class CollisionTriggerDemo extends SyncScript {
  #collisionStatus = '';
  readonly #inside = new Set<EntityId>();

  override start(): void {
    const trigger = this.game.simulation!.trigger(this.entity);
    const name = (entity: EntityId) => this.game.entities.entity(entity).name;
    // 脚本移除时一起取消（Stride 在 Cancel 里 -= 掉）
    this.disposables.use(trigger.onEnter(({ other }) => {
      this.#inside.add(other);
      this.#collisionStatus = `${name(other)} entered ${this.entity.name}`;
    }));
    this.disposables.use(trigger.onLeave(({ other }) => {
      this.#inside.delete(other);
      this.#collisionStatus = `${name(other)} left ${this.entity.name}`;
    }));
  }

  override update(): void {
    let y = 300;
    for (const entity of this.#inside) {
      // 在里面的时候被销毁的物体收不到"离开"，这里顺手去掉
      if (!this.game.entities.isAlive(entity)) this.#inside.delete(entity);
      else this.game.debugText.print(`Inside the trigger: ${this.game.entities.entity(entity).name}`, [500, (y += 20)]);
    }
    this.game.debugText.print(this.#collisionStatus, [500, 400]);
  }
}
