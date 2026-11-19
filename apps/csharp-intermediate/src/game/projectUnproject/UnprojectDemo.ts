// CSharpIntermediate 的 UnprojectDemo：点左键时把鼠标的位置反投影成一条从近平面到远平面的射线（挂在相机实体上），
// 射线打到东西就在命中点克隆一个球。
import { prop, screenToWorldRaySegment, SyncScript, Transform } from '@stride-ts/engine';

export class UnprojectDemo extends SyncScript.props({
  sphereToClone: prop.entity().optional(),
}) {
  override update(): void {
    const input = this.game.input;
    if (!input.isMouseButtonPressed('left') || this.sphereToClone === undefined) return;
    const { start, end } = screenToWorldRaySegment(this.game, this.entity, input.mousePosition[0], input.mousePosition[1]);
    const direction = end.clone().subtract(start);
    const distance = direction.length();
    const hit = this.game.simulation!.rayCast([start.x, start.y, start.z], [direction.x / distance, direction.y / distance, direction.z / distance], distance);
    if (!hit) return;
    const clone = this.game.entities.entity(this.sphereToClone).clone();
    clone.require(Transform).position = { x: hit.point[0], y: hit.point[1], z: hit.point[2] };
    // Stride 的 Entity.Scene.Entities.Add：换教程时跟着销毁
    clone.scene = this.entity.scene;
  }
}
