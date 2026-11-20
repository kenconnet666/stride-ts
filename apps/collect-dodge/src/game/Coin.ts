// 金币：绕竖直轴转；玩家（Character）进了它的触发器就发 CoinCollected，金币消失。
import { Character, prop, Quaternion, Static, SyncScript, Transform, Vector3, type GameTime } from '@stride-ts/engine';
import { CoinCollectedEventKey } from './events';

export class Coin extends SyncScript.props({
  spinSpeed: prop.number().default(180).unit('deg/s'),
}, { requires: [() => Static] }) {
  #angle = 0;
  #collected = false;

  override start(): void {
    const trigger = this.game.simulation!.trigger(this.entity);
    this.disposables.use(trigger.onEnter(({ other }) => {
      if (this.#collected || !this.game.entities.hasComponent(other, Character)) return;
      // 在接触回调里只做标记：实体（连着物体）在仿真步进当中不能删，下一次 update 里再删
      this.#collected = true;
      CoinCollectedEventKey.broadcast();
    }));
  }

  override update(time: GameTime): void {
    if (this.#collected) {
      this.entity.destroy();
      return;
    }
    this.#angle += (this.spinSpeed * Math.PI / 180) * time.elapsed;
    // 只转模型：触发器是球，转不转一样
    this.entity.require(Transform).rotation = SPIN.setAxisAngle(UP, this.#angle);
  }
}

const UP = new Vector3(0, 1, 0);
const SPIN = new Quaternion();
