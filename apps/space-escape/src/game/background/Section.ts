// SpaceEscape 的 Section：一段关卡。根实体下面挂一块背景和几个障碍物；长度是背景模型沿 z 的长度；记下障碍物的包围盒和地上的洞。
import { Mesh, Model, Transform, type Bounds, type Entity, type EntityManager } from '@stride-ts/engine';
import type { BackgroundInfo } from './BackgroundInfo';

export type Hole = BackgroundInfo['holes'][number];

/** 障碍物和它的包围盒（模型空间，碰撞时加上障碍物的世界位置）。 */
export interface Obstacle {
  readonly entity: Entity;
  readonly boundingBoxes: readonly Bounds[];
}

export class Section {
  readonly rootEntity: Entity;
  readonly collidableObstacles: Obstacle[] = [];
  readonly holes: Hole[] = [];
  length = 0;

  constructor(entities: EntityManager) {
    this.rootEntity = entities.create({ name: 'Section', components: [Transform] });
  }

  get positionZ(): number {
    return this.rootEntity.require(Transform).position.z;
  }

  set positionZ(value: number) {
    this.rootEntity.require(Transform).position.z = value;
  }

  addBackgroundEntity(background: Entity): this {
    background.require(Transform).parent = this.rootEntity;
    const { min, max } = modelBounds(background);
    this.length += max[2] - min[2];
    return this;
  }

  /** useSubBoundingBoxes：每个网格一个包围盒（Stride 把网格的包围盒沿节点层级变到模型空间；我们的网格顶点已经在模型空间里）。 */
  addObstacleEntity(obstacle: Entity, useSubBoundingBoxes: boolean): this {
    obstacle.require(Transform).parent = this.rootEntity;
    const boundingBoxes = useSubBoundingBoxes ? modelMeshes(obstacle).map((mesh) => mesh.bounds) : [modelBounds(obstacle)];
    this.collidableObstacles.push({ entity: obstacle, boundingBoxes });
    return this;
  }

  addHoleRange(holes: readonly Hole[]): this {
    this.holes.push(...holes);
    return this;
  }
}

/**
 * 实体上的模型的网格：实体自己的 Model，加上挂成子实体的其余网格（内容管理把多网格的模型拆成"实体名/网格名"的子实体）。
 */
export function modelMeshes(entity: Entity): Mesh[] {
  const parts = [entity, ...entity.require(Transform).children.filter((child) => child.name.startsWith(`${entity.name}/`))];
  return parts.flatMap((part) => {
    const mesh = Mesh.byId(part.get(Model)?.mesh ?? 0);
    return mesh ? [mesh] : [];
  });
}

/** 模型的包围盒（Stride 的 Model.BoundingBox）：各个网格的包围盒合起来。 */
export function modelBounds(entity: Entity): Bounds {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const { bounds } of modelMeshes(entity)) {
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i]!, bounds.min[i]!);
      max[i] = Math.max(max[i]!, bounds.max[i]!);
    }
  }
  return { min: min as [number, number, number], max: max as [number, number, number] };
}
