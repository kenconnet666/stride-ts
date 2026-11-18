// FirstPersonShooter 的 TriggerScript：一组按名字找的事件（TriggerGroup），每个事件生成一个预制体（特效），挂在给定的实体下或
// 放进场景，Duration 秒后移除。Stride 里 TriggerGroup、TriggerEvent 是两个数据类，这里是脚本属性的嵌套对象。
import { AsyncScript, Matrix, prop, Transform, type Entity, type Matrix4 } from '@stride-ts/engine';

const triggerEvent = prop.object({
  name: prop.string().default(''),
  sourcePrefab: prop.asset('prefab').optional(),
  /** Stride 里也没有用到。 */
  followEntity: prop.bool().default(false),
  duration: prop.number().default(3),
  position: prop.vec3(),
  rotation: prop.quat(),
  scale: prop.vec3().default([1, 1, 1]),
});

export abstract class TriggerScript extends AsyncScript.props({
  triggerGroup: prop.object({
    name: prop.string().default('NewTriggerGroup'),
    triggerEvents: prop.list(triggerEvent),
  }),
}) {
  /** 生成名为 eventName 的事件的预制体：事件自己的本地变换之后再做 matrix。 */
  protected spawnEvent(eventName: string, attach: Entity | undefined, matrix: Readonly<Matrix4>): void {
    const event = this.triggerGroup.triggerEvents.find((e) => e.name === eventName);
    if (!event) throw new Error(`Trigger event ${eventName} was not found!`);
    if (!event.sourcePrefab) return;
    const { position: p, rotation: r, scale: s } = event;
    const local = Matrix.compose(Matrix.identity(), [p.x, p.y, p.z], [r.x, r.y, r.z, r.w], [s.x, s.y, s.z]);
    const entities = event.sourcePrefab.instantiate(this.game.entities);
    for (const entity of entities) {
      const transform = entity.require(Transform);
      // Stride 的 own * local * matrix（行向量），列向量里反过来乘
      const own = transform.localMatrix();
      transform.setLocalMatrix(Matrix.multiply(own, matrix, Matrix.multiply(own, local, own)));
      if (attach) transform.parent = attach;
    }
    void this.delay(event.duration).then(() => {
      for (const entity of entities) if (entity.alive) entity.destroy();
    }, () => undefined);
  }
}
