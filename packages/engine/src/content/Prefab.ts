/**
 * 预制体（Stride 的 Prefab）：ContentManager.loadPrefab 加载，引用的资源已经加载好，`instantiate` 时才建实体。
 *
 *   const cube = await game.content.loadPrefab('BepuSample/Prefabs/Bepu/BepuInstancedCube');
 *   const [root] = cube.instantiate(game.entities);
 *   root.require(Transform).position = { x: 0, y: 10, z: 0 };
 */
import type { Entity } from '../engine/Entity';
import type { EntityManager } from '../engine/EntityManager';

export class Prefab {
  readonly name: string;
  readonly #instantiate: (entities: EntityManager) => readonly Entity[];

  /** @internal ContentManager 建。 */
  constructor(name: string, instantiate: (entities: EntityManager) => readonly Entity[]) {
    this.name = name;
    this.#instantiate = instantiate;
  }

  /**
   * 建出预制体的实体（Stride 的 Prefab.Instantiate），返回根实体（按预制体里的顺序）。和 Stride 不同：实体建出来就在游戏里，
   * 不用再加进场景；脚本下一帧启动。
   */
  instantiate(entities: EntityManager): readonly Entity[] {
    return this.#instantiate(entities);
  }
}
