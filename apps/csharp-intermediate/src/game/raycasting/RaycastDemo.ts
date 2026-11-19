// CSharpIntermediate 的 RaycastDemo：从实体的位置沿 +Z 打一条 4 米的射线，激光（子实体 Laser）伸到命中的地方，
// HitPoint 实体放在命中点上；没命中时激光伸到头。
import { formatFloat, parseCollisionMask, prop, SyncScript, Transform } from '@stride-ts/engine';
import { printVector } from '../utils/print';

const MAX_DISTANCE = 4;

export class RaycastDemo extends SyncScript.props({
  /** Stride 的 CollisionMask：`Everything`，或者 `Layer0, Layer1, …`。 */
  collideWith: prop.string().default('Everything'),
  hitPoint: prop.entity().optional(),
}) {
  override update(): void {
    const print = (text: string, y: number) => this.game.debugText.print(text, [340, y]);
    print('Press Q and E to raise/lower weapons', 80);
    const { position } = this.entity.require(Transform);
    const laser = this.entity.findChild('Laser')?.require(Transform);
    const hitPoint = this.hitPoint === undefined ? undefined : this.game.entities.entity(this.hitPoint).require(Transform);
    const hit = this.game.simulation!.rayCast([position.x, position.y, position.z], [0, 0, 1], MAX_DISTANCE, { mask: parseCollisionMask(this.collideWith) });
    if (hit) {
      if (hitPoint) hitPoint.position = { x: hit.point[0], y: hit.point[1], z: hit.point[2] };
      if (laser) laser.scale.z = hit.distance;
      print('Hit a collider', 120);
      print(`Raycast hit distance: ${formatFloat(hit.distance)}`, 140);
      print(`Raycast hit point: ${printVector({ x: hit.point[0], y: hit.point[1], z: hit.point[2] })}`, 160);
      print(`Raycast hit entity: ${this.game.entities.entity(hit.entity).name}`, 180);
    } else {
      if (hitPoint) hitPoint.position = { x: position.x, y: position.y, z: position.z + MAX_DISTANCE };
      if (laser) laser.scale.z = MAX_DISTANCE;
      print('No collider hit', 120);
    }
  }
}
