// Platformer2D 的 CoinRotation：每 1/12 秒换到精灵表的下一帧，12 帧一圈。
import { prop, Sprite, SyncScript, type GameTime } from '@stride-ts/engine';

const ANIMATION_INTERVAL = 1 / 12;
const COIN_FRAMES_END = 12;

export class CoinRotation extends SyncScript.props({
  sprite: prop.entity(),
}) {
  #animationTimer = 0;

  override update(time: GameTime): void {
    this.#animationTimer += time.elapsed;
    if (this.#animationTimer < ANIMATION_INTERVAL) return;
    this.#animationTimer -= ANIMATION_INTERVAL;
    const sprite = this.game.entities.entity(this.sprite).require(Sprite);
    sprite.frame = (sprite.frame + 1) % COIN_FRAMES_END;
  }
}
