// 终点：玩家（Character）进了它的触发器就发 GoalReached（算不算赢由 GameRules 定）。
import { Character, Static, StartupScript } from '@stride-ts/engine';
import { GoalReachedEventKey } from './events';

export class Goal extends StartupScript.props({}, { requires: [() => Static] }) {
  override start(): void {
    const trigger = this.game.simulation!.trigger(this.entity);
    this.disposables.use(trigger.onEnter(({ other }) => {
      if (this.game.entities.hasComponent(other, Character)) GoalReachedEventKey.broadcast();
    }));
  }
}
