// CSharpBeginner 的 InstantiatingPrefabsDemo：把属性里的"一堆箱子"预制体实例化一次；再从内容里按路径加载同一个预制体，实例化后
// 挂到一个新的父实体下（放在 (0, 0, -2)，绕 Y 转 135 度）。实例都放进脚本实体所在的场景（Stride 的 Entity.Scene.Entities.Add）。
// 和 Stride 不同：Stride 的代码写的是 Quaternion.RotationY(135)，参数是弧度，转出来约 175 度，是笔误；这里按 135 度转。
import { prop, Quaternion, SyncScript, Transform } from '@stride-ts/engine';

const UP = { x: 0, y: 1, z: 0 };

export class InstantiatingPrefabsDemo extends SyncScript.props({
  pileOfBoxesPrefab: prop.asset('prefab').optional(),
}) {
  override start(): void {
    const scene = this.entity.scene;
    for (const entity of this.pileOfBoxesPrefab?.instantiate(this.game.entities) ?? []) entity.scene = scene;
    void this.game.content.loadPrefab('CSharpBeginner/Prefabs/Pile of boxes').then((prefab) => {
      // 加载完之前教程已经换走了
      if (!this.attached) return;
      const parent = this.game.entities.create({
        name: 'PileOfBoxes2',
        scene,
        components: [Transform.with({ position: [0, 0, -2], rotation: new Quaternion().setAxisAngle(UP, (135 * Math.PI) / 180) })],
      });
      for (const entity of prefab.instantiate(this.game.entities)) entity.require(Transform).parent = parent;
    });
  }

  override update(): void {
    this.game.debugText.print('The original prefab', [310, 320]);
    this.game.debugText.print('The prefab instance PileOfBoxes', [560, 370]);
    this.game.debugText.print('The prefab instance PileOfBoxes2 with custom parent', [565, 650]);
  }
}
