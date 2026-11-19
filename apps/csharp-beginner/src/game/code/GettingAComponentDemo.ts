// CSharpBeginner 的 GettingAComponentDemo：取实体上的 AmmoComponent 读弹药，移除后再取就没有了，最后加回去。
// 和 Stride 不同：加回去的是新的一个（我们的脚本组件不能拿下来再挂回去），值一样。
import { SyncScript } from '@stride-ts/engine';
import { AmmoComponent } from './AmmoComponent';

export class GettingAComponentDemo extends SyncScript {
  #ammoCount1 = 0;
  #ammoCount2 = 0;

  override start(): void {
    this.#ammoCount1 = this.entity.require(AmmoComponent).getRemainingAmmo();
    this.entity.remove(AmmoComponent);
    // 移除以后取不到了
    this.#ammoCount2 = this.entity.get(AmmoComponent)?.getRemainingAmmo() ?? 0;
    this.entity.add(AmmoComponent);
  }

  override update(): void {
    this.game.debugText.print(`Ammo count 1: ${this.#ammoCount1}`, [300, 200]);
    this.game.debugText.print(`Ammo count 2: ${this.#ammoCount2}`, [300, 220]);
  }
}
