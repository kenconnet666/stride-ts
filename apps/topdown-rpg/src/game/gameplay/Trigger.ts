// TopDownRPG 的 Trigger：实体的碰撞体是 Trigger，有东西进来（或出去，按 triggerCondition）时广播 triggerEvent。
import { EventKey, prop, StartupScript } from '@stride-ts/engine';

export class Trigger extends StartupScript.props({
  /** Stride 的 CollisionEventType：StartOnly、EndOnly、StartAndEnd。 */
  triggerCondition: prop.enum(['StartOnly', 'EndOnly', 'StartAndEnd']).default('StartOnly'),
}) {
  /** 每个 Trigger 一个（Stride 的 [DataMemberIgnore] 字段）：进来是 true，出去是 false。 */
  readonly triggerEvent = new EventKey<boolean>();

  override start(): void {
    const trigger = this.game.simulation!.trigger(this.entity);
    if (this.triggerCondition !== 'EndOnly') this.disposables.use(trigger.onEnter(() => this.triggerEvent.broadcast(true)));
    if (this.triggerCondition !== 'StartOnly') this.disposables.use(trigger.onLeave(() => this.triggerEvent.broadcast(false)));
  }
}
