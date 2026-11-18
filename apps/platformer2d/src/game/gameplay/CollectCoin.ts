// Platformer2D 的 CollectCoin：金币的碰撞体是 Trigger，玩家（带 PlayerController 的实体）碰到后隐藏精灵，3 秒后移出场景。
// 音效（SoundEffect）属于 P2 的音频：场景导入时是 null，这里不声明这个属性，先不放。
import { AsyncScript, prop, Sprite, TriggerHandler } from '@stride-ts/engine';
import { PlayerController } from '../player/PlayerController';

export class CollectCoin extends AsyncScript.props({
  staticColliderComponent: prop.entity(),
}) {
  override async execute(): Promise<void> {
    const trigger = this.game.simulation!.contactHandler(this.staticColliderComponent);
    if (!(trigger instanceof TriggerHandler)) throw new Error(`entity '${this.entity.name}' has no Trigger contact handler`);
    let collected = false;
    this.disposables.use(trigger.onEnter(({ other }) => {
      collected ||= this.game.entities.entity(other).get(PlayerController) !== undefined;
    }));
    while (!collected) await this.nextFrame();
    this.entity.require(Sprite).enabled = false;
    await this.delay(3);
    this.entity.destroy();
  }
}
