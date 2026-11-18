// PhysicsSample 的 Player：A/D（或方向键、按住屏幕左右半边）左右走，速度 15。
import { Character, SyncScript } from '@stride-ts/engine';

const SPEED = 15;

export class Player extends SyncScript {
  #pointerX = 0;

  override update(): void {
    const input = this.game.input;
    let move = 0;
    if (input.isKeyDown('KeyA') || input.isKeyDown('ArrowLeft')) move = -1;
    if (input.isKeyDown('KeyD') || input.isKeyDown('ArrowRight')) move = 1;
    for (const event of input.pointerEvents) {
      if (event.eventType === 'pressed') this.#pointerX = event.position[0] < 0.5 ? -1 : 1;
      else if (event.eventType === 'released' || event.eventType === 'canceled') this.#pointerX = 0;
    }
    if (this.#pointerX !== 0) move = this.#pointerX;
    // 移动向量相对角色（角色不转），是 speed 的倍数
    const character = this.entity.require(Character);
    character.moveX = (move * SPEED) / character.speed;
    character.moveY = 0;
  }
}
