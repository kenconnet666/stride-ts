// BepuSample 的 _Spawner：SpawnerComponent、ThrowerComponent 的基类。实例化预制体的第一个根实体，放到 position，有 Instance 时
// 让它画 instancing 主实体的模型，挂在这个实体下面（同 Stride 的 Entity.AddChild：位置当本地位置），有刚体时给一个冲量。
import { Body, Instance, prop, SyncScript, Transform, type EntityId, type Vec3Like } from '@stride-ts/engine';

export abstract class Spawner extends SyncScript.props({
  spawnPrefab: prop.asset('prefab').optional(),
  /** 带 Instancing 的实体（Stride 里引用的是它的 InstancingComponent）。 */
  instancing: prop.entity().optional(),
}) {
  protected spawn(position: Vec3Like, impulse: Vec3Like): void {
    if (!this.spawnPrefab) return;
    const [entity] = this.spawnPrefab.instantiate(this.game.entities);
    if (!entity) return;
    const transform = entity.require(Transform);
    transform.position = position;
    if (entity.has(Instance)) entity.require(Instance).master = this.instancing ?? (-1 as EntityId);
    transform.parent = this.entity;
    if (!entity.has(Body) || !this.game.simulation) return;
    // 刚体按世界位姿建：先算出这一帧的世界矩阵
    transform.updateWorldMatrix();
    this.game.simulation.body(entity).applyLinearImpulse(impulse);
  }
}
