// CSharpBeginner 的 GettingTheEntityDemo：打印自己和父实体的名字。
import { SyncScript, Transform } from '@stride-ts/engine';

export class GettingTheEntityDemo extends SyncScript {
  #name = '';
  #parentName = '';

  override start(): void {
    this.#name = this.entity.name;
    this.#parentName = this.entity.require(Transform).parent?.name ?? '';
  }

  override update(): void {
    this.game.debugText.print(this.#parentName, [580, 580]);
    this.game.debugText.print(this.#name, [800, 580]);
  }
}
