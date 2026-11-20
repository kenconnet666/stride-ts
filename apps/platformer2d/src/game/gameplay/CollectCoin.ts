// Platformer2D 的 CollectCoin：金币的碰撞体是 Trigger，玩家（带 PlayerController 的实体）碰到后隐藏精灵、放音效，3 秒后移出场景。
import { AsyncScript, prop, Sprite, type SoundInstance } from '@stride-ts/engine';
import { PlayerController } from '../player/PlayerController';

export class CollectCoin extends AsyncScript.props({
  staticColliderComponent: prop.entity(),
  soundEffect: prop.asset('sound').optional(),
}) {
  /** 拿到金币时放的那一声（拿到之前是 undefined）。 */
  sfxInstance: SoundInstance | undefined;

  override async execute(): Promise<void> {
    const trigger = this.game.simulation!.trigger(this.staticColliderComponent);
    let collected = false;
    this.disposables.use(trigger.onEnter(({ other }) => {
      collected ||= this.game.entities.entity(other).get(PlayerController) !== undefined;
    }));
    while (!collected) await this.nextFrame();
    this.entity.require(Sprite).enabled = false;
    this.sfxInstance = this.soundEffect?.createInstance();
    this.sfxInstance?.play();
    await this.delay(3);
    this.entity.destroy();
  }
}
