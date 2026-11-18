// PhysicsSample 的 Trigger：碰撞体的 Trigger 处理器有角色进出时，广播 triggerEvent（进来是 true，出去是 false）。
import { Character, EventKey, StartupScript, TriggerHandler, type EntityId } from '@stride-ts/engine';

export class Trigger extends StartupScript {
  /** 每个 Trigger 一个（Stride 的 [DataMemberIgnore] 字段）；AutoResetRigidbody 收它。 */
  readonly triggerEvent = new EventKey<boolean>();

  override start(): void {
    const trigger = this.game.simulation!.contactHandler(this.entity);
    if (!(trigger instanceof TriggerHandler)) throw new Error(`entity '${this.entity.name}' has no Trigger contact handler`);
    const isCharacter = (entity: EntityId) => this.game.entities.hasComponent(entity, Character);
    this.disposables.use(trigger.onEnter(({ other }) => isCharacter(other) && this.triggerEvent.broadcast(true)));
    this.disposables.use(trigger.onLeave(({ other }) => isCharacter(other) && this.triggerEvent.broadcast(false)));
  }
}
