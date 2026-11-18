// TopDownRPG 的 Utils：生成预制体（特效、掉落的金币）、屏幕上的点打射线找地面和箱子。
// 和 Stride 不同：射线只取最近的命中（Stride 用 RayCastPenetrating 取全部命中再找最近的静态体）；第 6、7 层只有静态体，结果一样。
import { Body, Matrix, Static, Transform, Vector3, screenToWorldRaySegment, type Entity, type Game, type Matrix4, type Prefab, type ScriptComponent, type Vec3Like } from '@stride-ts/engine';
import type { ClickResult } from './ClickResult';

/** 地面在第 6 层，箱子在第 7 层（场景里的 CollisionLayer）。 */
const GROUND_LAYER = 6;
const LOOT_CRATE_LAYER = 7;

/** 预制体的实体按 matrix 摆好（实体原来的本地变换之后再做 matrix），挂在 attach 下或放进场景。 */
function place(entities: readonly Entity[], attach: Entity | undefined, matrix: Readonly<Matrix4>): void {
  for (const entity of entities) {
    const transform = entity.require(Transform);
    const local = transform.localMatrix();
    transform.setLocalMatrix(Matrix.multiply(local, matrix, local));
    if (attach) transform.parent = attach;
  }
}

/** 生成预制体（Stride 的 SpawnPrefabModel），带刚体的给一个冲量。 */
export function spawnPrefabModel(script: ScriptComponent, source: Prefab | undefined, attach: Entity | undefined, matrix: Readonly<Matrix4>, impulse: Vec3Like): void {
  if (!source) return;
  const entities = source.instantiate(script.game.entities);
  place(entities, attach, matrix);
  for (const entity of entities) {
    if (entity.get(Body)) script.game.simulation!.body(entity).applyLinearImpulse(impulse);
  }
}

/** 生成预制体（Stride 的 SpawnPrefabInstance，特效），timeout 秒后移除。 */
export function spawnPrefabInstance(script: ScriptComponent, source: Prefab | undefined, attach: Entity | undefined, timeout: number, matrix: Readonly<Matrix4>): void {
  if (!source) return;
  const entities = source.instantiate(script.game.entities);
  place(entities, attach, matrix);
  void script.delay(timeout).then(() => {
    for (const entity of entities) if (entity.alive) entity.destroy();
  }, () => undefined);
}

/**
 * 屏幕上的点（0..1，y 向下）从相机打一条射线（Stride 的 ScreenPositionToWorldPositionRaycast）：最近的第 6 层静态体是地面，
 * 第 7 层的是箱子；都不是时 type 是 empty。
 */
export function screenPositionToWorldPositionRaycast(game: Game, screen: readonly [number, number], camera: Entity): ClickResult {
  const result: ClickResult = { worldPosition: new Vector3(), clickedEntity: undefined, type: 'empty', normal: new Vector3(0, 1, 0) };
  const { start, end } = screenToWorldRaySegment(game, camera, screen[0], screen[1]);
  const direction = end.clone().subtract(start);
  const length = direction.length();
  const hit = game.simulation!.rayCast([start.x, start.y, start.z], [direction.x / length, direction.y / length, direction.z / length], length, { mask: (1 << GROUND_LAYER) | (1 << LOOT_CRATE_LAYER) });
  if (!hit) return result;
  const entity = game.entities.entity(hit.entity);
  const layer = entity.get(Static)?.layer;
  if (layer !== GROUND_LAYER && layer !== LOOT_CRATE_LAYER) return result;
  result.type = layer === GROUND_LAYER ? 'ground' : 'lootCrate';
  result.worldPosition.set(hit.point[0]!, hit.point[1]!, hit.point[2]!);
  result.normal.set(hit.normal[0]!, hit.normal[1]!, hit.normal[2]!);
  result.clickedEntity = entity;
  return result;
}

/** 实体的世界位置。 */
export function worldPosition(entity: Entity): Vector3 {
  const world = entity.require(Transform).world;
  return new Vector3(world[12]!, world[13]!, world[14]!);
}
