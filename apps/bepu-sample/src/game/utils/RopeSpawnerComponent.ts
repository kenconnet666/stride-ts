// BepuSample 的 RopeSpawnerComponent：在 A、B 两个刚体之间（各自偏移 aPos、bPos）铺一串 ropePart 预制体（沿本地 Z 长
// ropePartSize），相邻两节用球窝加摆动限位（每节最多摆 0.05π）连起来，两头再用球窝挂到 A、B 上。
// Stride 把这些约束组件加在这个实体上；这里直接加约束，脚本移除时一起移除。和 Stride 不同：约束是刚性的（Bepu 用弹簧）。
import { Body, prop, Quaternion, StartupScript, Transform, Vector3, type Constraint, type ConstraintSettings, type Entity, type EntityId } from '@stride-ts/engine';

const UP = { x: 0, y: 1, z: 0 } as const;

export class RopeSpawnerComponent extends StartupScript.props({
  /** 绳子的一节，沿本地 Z 放。 */
  ropePart: prop.asset('prefab').optional(),
  ropePartSize: prop.number().default(1),
  aEntity: prop.entity().optional(),
  aPos: prop.vec3().default([0.5, 0, 0]),
  bEntity: prop.entity().optional(),
  bPos: prop.vec3().default([-0.5, 0, 0]),
}) {
  readonly #constraints: Constraint[] = [];

  override start(): void {
    const simulation = this.game.simulation;
    const a = this.#body(this.aEntity), b = this.#body(this.bEntity);
    if (!simulation || !this.ropePart || !a || !b) return;
    const start = worldPosition(a).add(this.aPos);
    const end = worldPosition(b).add(this.bPos);
    const segment = end.clone().subtract(start);
    const direction = segment.clone().normalize();
    const count = segment.length() / this.ropePartSize;
    const rotation = Quaternion.lookRotation(direction, UP);
    const parts: Entity[] = [];
    for (let i = 0; i < count; i++) {
      const [part] = this.ropePart.instantiate(this.game.entities);
      if (!part) continue;
      const transform = part.require(Transform);
      transform.position = start.clone().add(direction.clone().scale(this.ropePartSize * i));
      transform.rotation = rotation;
      transform.parent = this.entity;
      parts.push(part);
    }
    if (parts.length === 0) return;
    const half = this.ropePartSize / 2;
    for (let i = 1; i < parts.length; i++) {
      this.#add({ type: 'ballSocket', bodyA: parts[i - 1]!, bodyB: parts[i]!, localOffsetA: [0, 0, half], localOffsetB: [0, 0, -half] });
      this.#add({ type: 'swingLimit', bodyA: parts[i - 1]!, bodyB: parts[i]!, axisLocalA: [0, 0, 1], axisLocalB: [0, 0, 1], maximumSwingAngle: Math.PI * 0.05 });
    }
    const { aPos, bPos } = this;
    this.#add({ type: 'ballSocket', bodyA: a, bodyB: parts[0]!, localOffsetA: [aPos.x, aPos.y, aPos.z], localOffsetB: [0, 0, -half] });
    this.#add({ type: 'ballSocket', bodyA: b, bodyB: parts.at(-1)!, localOffsetA: [bPos.x, bPos.y, bPos.z], localOffsetB: [0, 0, half] });
  }

  override cancel(): void {
    for (const constraint of this.#constraints) constraint.remove();
    this.#constraints.length = 0;
  }

  #add(settings: ConstraintSettings): void {
    this.#constraints.push(this.game.simulation!.addConstraint(settings));
  }

  /** 带刚体的实体（Stride 的 Get<BodyComponent>）。 */
  #body(id: EntityId | undefined): Entity | undefined {
    if (id === undefined || !this.game.entities.isAlive(id)) return undefined;
    const entity = this.game.entities.entity(id);
    return entity.has(Body) ? entity : undefined;
  }
}

/** 世界位置；第一帧的 start 里世界矩阵还没算，先算一下。 */
function worldPosition(entity: Entity): Vector3 {
  const transform = entity.require(Transform);
  transform.updateWorldMatrix();
  return new Vector3(transform.world[12], transform.world[13], transform.world[14]);
}
