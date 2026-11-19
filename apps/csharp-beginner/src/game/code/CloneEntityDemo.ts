// CSharpBeginner 的 CloneEntityDemo：克隆 MasterSword 几次，放在不同的地方（场景根、脚本实体的子实体），改位置和缩放。
// 和 Stride 不同：克隆出来就在游戏里（entity.clone()），没有"克隆了不加进场景就看不见"这回事，所以 clone0 克隆完就销毁，那行字也跟着改了。
import { prop, SyncScript, Transform, type Entity } from '@stride-ts/engine';

export class CloneEntityDemo extends SyncScript.props({
  masterSword: prop.entity().optional(),
}) {
  override start(): void {
    if (this.masterSword === undefined) throw new Error('CloneEntityDemo needs MasterSword');
    const master = this.game.entities.entity(this.masterSword);
    const clone = () => master.clone();
    const move = (entity: Entity, dx: number, dy: number, dz: number) => {
      const transform = entity.require(Transform);
      const { x, y, z } = transform.position;
      transform.position = { x: x + dx, y: y + dy, z: z + dz };
    };
    clone().destroy();
    // clone1 放进脚本实体所在的场景（Stride 的 Entity.Scene.Entities.Add），场景卸载时跟着销毁：和 MasterSword 同样的位置，往左挪、缩小一点
    const clone1 = clone();
    clone1.scene = this.entity.scene;
    move(clone1, -1, 0, 0);
    const scale = clone1.require(Transform).scale;
    clone1.require(Transform).scale = { x: scale.x * 0.8, y: scale.y * 0.8, z: scale.z * 0.8 };
    // clone2、clone3 是脚本实体的子实体（Stride 的 Entity.AddChild、Transform.Parent），本地位置还是 MasterSword 的值
    const clone2 = clone();
    clone2.require(Transform).parent = this.entity;
    move(clone2, 1, 0, 0);
    clone2.require(Transform).scale = { x: 0.6, y: 0.6, z: 0.6 };
    const clone3 = clone();
    clone3.require(Transform).parent = this.entity;
    move(clone3, 0, 0, -0.5);
    clone3.require(Transform).scale = { x: 0.4, y: 0.4, z: 0.4 };
  }

  override update(): void {
    const print = (text: string, x: number, y: number) => this.game.debugText.print(text, [x, y]);
    print('This is the MasterSword, with a Z of 1', 500, 320);
    print('Clone 0 was destroyed again: a clone is in the game as soon as it is made', 600, 250);
    print('Clone 1 is placed in the same scene as the entity with the script', 700, 600);
    print("Clone 1 got the same world position as the 'MasterSword'...", 700, 620);
    print('... and was then moved to the right', 700, 640);
    print("Clone 2 and 3 are a child of 'MasterSword'.", 330, 600);
  }
}
