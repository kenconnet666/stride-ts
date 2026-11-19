// CSharpIntermediate 的 ProjectDemo：把两个球的世界位置投影到画面上，在那里各打印一个名字（挂在相机实体上）。
// 和 Stride 不同：球在相机后面时不打印（Stride 的 Vector3.Project 照样除以 w，字出现在镜像过去的地方）。
import { prop, SyncScript, Transform, worldToScreen, type EntityId } from '@stride-ts/engine';

export class ProjectDemo extends SyncScript.props({
  projectSphere: prop.entity().optional(),
  projectSphereChild: prop.entity().optional(),
}) {
  override update(): void {
    this.#label('Parent', this.projectSphere);
    this.#label('Child', this.projectSphereChild);
  }

  #label(text: string, target: EntityId | undefined): void {
    if (target === undefined) return;
    const [x, y, z] = this.game.entities.entity(target).require(Transform).world.subarray(12, 15);
    const screen = worldToScreen(this.game, this.entity, { x: x!, y: y!, z: z! });
    if (!screen) return;
    // Stride 的 new Int2(…)：截掉小数
    const [px, py] = this.game.debugText.fromScreen([screen.x, screen.y]);
    this.game.debugText.print(text, [Math.trunc(px), Math.trunc(py)]);
  }
}
