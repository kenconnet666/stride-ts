// CSharpBeginner 的 ChildEntitiesDemo：打印自己、子实体和孙实体的名字，一层缩进一格。
import { SyncScript, Transform, type Entity } from '@stride-ts/engine';

export class ChildEntitiesDemo extends SyncScript {
  override start(): void {
    // Stride 的 GetChild(0)、GetChild(1)：没有这么多子实体时报错
    const children = this.#children(this.entity);
    if (children.length < 2) throw new Error(`ChildEntitiesDemo: '${this.entity.name}' needs two children`);
  }

  override update(): void {
    const drawX = 350, increment = 70;
    let drawY = 230;
    this.game.debugText.print(this.entity.name, [drawX, drawY]);
    for (const child of this.#children(this.entity)) {
      drawY += increment;
      this.game.debugText.print(child.name, [drawX + increment, drawY]);
      for (const subChild of this.#children(child)) {
        drawY += increment;
        this.game.debugText.print(subChild.name, [drawX + increment * 2, drawY]);
      }
    }
  }

  #children(entity: Entity): readonly Entity[] {
    return entity.require(Transform).children;
  }
}
