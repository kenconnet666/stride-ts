// CSharpBeginner 的 RemoveEntitiesDemo：克隆两个实体（一个挂在脚本实体下、一个在场景根），4 秒后移除，2 秒后再克隆，循环。
import { prop, SyncScript, Transform, type Entity } from '@stride-ts/engine';

const EXIST_TIME = 4;
const GONE_TIME = 2;

export class RemoveEntitiesDemo extends SyncScript.props({
  entityToClone: prop.entity().optional(),
}) {
  #clone1: Entity | undefined;
  #clone2: Entity | undefined;
  #timer = 0;
  #currentTimer = 0;
  #entitiesExist = false;

  override start(): void {
    this.#cloneEntities();
  }

  override update(): void {
    this.#timer += this.game.updateTime.elapsed;
    if (this.#timer > this.#currentTimer) {
      if (this.#entitiesExist) {
        // Stride 的 Entity.RemoveChild、Scene.Entities.Remove：我们直接销毁
        this.#clone1?.destroy();
        this.#clone2?.destroy();
        this.#clone1 = this.#clone2 = undefined;
        this.#entitiesExist = false;
        this.#currentTimer = GONE_TIME;
      } else {
        this.#cloneEntities();
        this.#currentTimer = EXIST_TIME;
      }
      this.#timer = 0;
    }
    const print = (text: string, x: number, y: number) => this.game.debugText.print(text, [x, y]);
    print(`For ${EXIST_TIME} seconds: `, 860, 240);
    print('- Clone 1 is a child of the script entity', 860, 260);
    print('- Clone 2 is a child of the scene root', 860, 280);
    print(`For ${GONE_TIME} seconds, the cloned entities are gone`, 860, 300);
    if (this.#entitiesExist) {
      print('Cloned entity 1 is a child of the Script entity', 450, 350);
      print('Cloned entity 2 is in the scene root', 450, 600);
    } else {
      print('Cloned entity 1 and 2 have been removed', 450, 600);
    }
  }

  #cloneEntities(): void {
    if (this.entityToClone === undefined) throw new Error('RemoveEntitiesDemo needs EntityToClone');
    const source = this.game.entities.entity(this.entityToClone);
    // 场景根（Stride 的 Entity.Scene.Entities.Add）：原来的位置往后挪 0.5
    const clone2 = source.clone();
    clone2.scene = this.entity.scene;
    const position = clone2.require(Transform).position;
    clone2.require(Transform).position = { x: position.x, y: position.y, z: position.z - 0.5 };
    // 脚本实体的子实体，放在它的原点
    const clone1 = source.clone();
    clone1.require(Transform).position = { x: 0, y: 0, z: 0 };
    clone1.require(Transform).parent = this.entity;
    this.#clone1 = clone1;
    this.#clone2 = clone2;
    this.#entitiesExist = true;
  }
}
