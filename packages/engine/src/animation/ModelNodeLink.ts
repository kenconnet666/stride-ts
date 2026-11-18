/**
 * 挂到骨骼节点（Stride 的 ModelNodeLinkComponent 和 ModelNodeTransformLink）：实体的世界矩阵改成
 * 目标模型实体的世界矩阵 × 骨骼节点的模型空间矩阵 × 自己的本地变换，不再看父节点（父子关系不变）。目标是 -1 时用父实体
 * （Stride 的 Target 为 null）。目标没有骨架、或骨架里没有这个节点时，跟着目标实体本身（同 Stride 的回退）。
 *
 * 每帧在动画系统求完姿势之后把节点矩阵交给变换存储的链接（TransformStore.setLink），帧末的变换更新按它算世界矩阵，
 * 所以画出来的是这一帧的姿势。
 */
import type { TransformSlot, TransformStore } from '@stride-ts/native';
import { prop, type EntityId } from '../data/prop';
import { component } from '../engine/component';
import type { EntityManager } from '../engine/EntityManager';
import { system } from '../engine/system';
import { Transform, transformSlot } from '../engine/transform';
import type { AnimationSystem } from './AnimationSystem';

export const ModelNodeLink = component('ModelNodeLink', {
  /** 带模型的实体；-1 是父实体。 */
  target: prop.entity().default(-1 as EntityId),
  /** 骨骼节点的名字（Stride 的 NodeName）。 */
  nodeName: prop.string().default(''),
});

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/** 挂到骨骼节点的系统：Game 在动画系统之后加进 EntityManager。 */
export function modelNodeLinkSystem(entities: EntityManager, transforms: TransformStore, animation: AnimationSystem) {
  return system('ModelNodeLink', {
    with: { link: ModelNodeLink, transform: Transform },
    phase: 'afterPhysics',
    after: [animation.system],
    update: ({ link, transform, entities: ids, count }) => {
      for (let i = 0; i < count; i++) {
        const entity = entities.entity(ids[i]!);
        const targetId = link.target[i]! as EntityId;
        const target = targetId >= 0 ? (entities.isAlive(targetId) ? entities.entity(targetId) : undefined) : entity.require(Transform).parent;
        const slot = transform.slot[i]! as TransformSlot;
        if (!target) {
          transforms.setLink(slot, null);
          continue;
        }
        transforms.setLink(slot, transformSlot(target), animation.nodeMatrix(target, link.nodeName[i]!) ?? IDENTITY);
      }
    },
    removed: (entity) => {
      if (entities.isAlive(entity) && entities.hasComponent(entity, Transform)) transforms.setLink(transformSlot(entities.entity(entity)), null);
    },
  });
}
