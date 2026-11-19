// CSharpBeginner 的 TransformPositionDemo：打印本地位置和世界位置。
import { formatVector, SyncScript, Transform } from '@stride-ts/engine';

export class TransformPositionDemo extends SyncScript {
  override update(): void {
    const transform = this.entity.require(Transform);
    const world = transform.world;
    this.game.debugText.print(`${this.entity.name} - local position: ${formatVector(transform.position)}`, [400, 450]);
    this.game.debugText.print(`${this.entity.name} - world position: ${formatVector({ x: world[12]!, y: world[13]!, z: world[14]! })}`, [400, 470]);
  }
}
