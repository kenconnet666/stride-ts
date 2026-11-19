// CSharpIntermediate 的 RaycastPenetratingDemo：从实体的位置沿 -Z 打一条 3 米的穿透射线，把穿过的物体都列出来。
import { parseCollisionMask, prop, SyncScript, Transform } from '@stride-ts/engine';

const MAX_DISTANCE = 3;

export class RaycastPenetratingDemo extends SyncScript.props({
  /** Stride 的 CollisionMask：`Everything`，或者 `Layer0, Layer1, …`。 */
  collideWith: prop.string().default('Everything'),
}) {
  override update(): void {
    let y = 80;
    const print = (text: string) => this.game.debugText.print(text, [700, y]);
    print('Raycast penetration demo');
    const transform = this.entity.require(Transform);
    const laser = transform.children.find((child) => child.name === 'Laser')?.require(Transform);
    if (laser) laser.scale.z = MAX_DISTANCE;
    const { x, y: height, z } = transform.position;
    const hits = this.game.simulation!.rayCastPenetrating([x, height, z], [0, 0, -1], MAX_DISTANCE, { mask: parseCollisionMask(this.collideWith) });
    y += 40;
    if (hits.length === 0) {
      print('No collider hit');
      return;
    }
    print(`Raycast has hit ${hits.length} object(s)`);
    for (const hit of hits) {
      y += 20;
      print(`- Raycast has hit: ${this.game.entities.entity(hit.entity).name}`);
    }
  }
}
