// CSharpBeginner 的 AddingAComponentDemo：加一个 AmmoComponent，再全部移除，最后用"取，没有就加"拿一个。
// 和 Stride 不同：一个实体上同一种脚本只能有一个，Stride 这里先加了两个再 RemoveAll。
import { SyncScript } from '@stride-ts/engine';
import { AmmoComponent } from './AmmoComponent';

export class AddingAComponentDemo extends SyncScript {
  #ammoComponent!: AmmoComponent;

  override start(): void {
    this.entity.add(AmmoComponent);
    this.entity.remove(AmmoComponent);
    // Stride 的 GetOrCreate
    this.#ammoComponent = this.entity.get(AmmoComponent) ?? this.entity.add(AmmoComponent).require(AmmoComponent);
  }

  override update(): void {
    this.game.debugText.print(`Remaining ammo: ${this.#ammoComponent.getRemainingAmmo()}`, [440, 200]);
  }
}
