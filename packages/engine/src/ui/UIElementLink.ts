/**
 * 跟着 UI 元素走（Stride 的 UIElementLinkComponent 和 UIElementTransformLink）：实体的世界矩阵改成 UI 元素在世界里的矩阵
 * × 自己的本地变换，不再看父节点（父子关系不变）。目标是 -1 时用父实体（Stride 的 Target 为 null）。找不到元素、或者 UI
 * 上一帧没画时，跟着 UI 实体本身（同 Stride 的回退）。元素在世界里的位置见 UISystem.elementWorldMatrix。
 *
 * 和 Stride 不同：面向相机的 UI 按它实际画的相机（主相机）算朝向，不用组件上的 Camera（Stride 的 Camera 没设、或者设的
 * 不是画 UI 的相机时，跟着走的实体和 UI 对不上）。
 *
 * 和 Stride 不同（更好）：先把 UI 布局好再算，元素这一帧挪了，跟着走的实体这一帧就跟上（Stride 用上一帧的布局，晚一帧）。
 * 面向相机的 UI 的朝向还是上一帧画的时候的相机。
 */
import type { TransformSlot, TransformStore } from '@stride-ts/native';
import { prop, type EntityId } from '../data/prop';
import { component } from '../engine/component';
import type { EntityManager } from '../engine/EntityManager';
import { system } from '../engine/system';
import { Transform, transformSlot } from '../engine/transform';
import { Matrix } from '../mathematics/Matrix';
import { UIComponent } from './UIComponent';
import type { UIElement } from './UIElement';
import type { UISystem } from './UISystem';

export const UIElementLink = component('UIElementLink', {
  /** 带 UIComponent 的实体；-1 是父实体。 */
  target: prop.entity().default(-1 as EntityId),
  /** 跟着的元素的名字（Stride 的 NodeName）。 */
  nodeName: prop.string().default(''),
});

const IDENTITY = Matrix.identity();

/** 跟着 UI 元素走的系统：Game 在物理之后加进 EntityManager，帧末的变换更新按它设的链接算世界矩阵。 */
export function uiElementLinkSystem(entities: EntityManager, transforms: TransformStore, ui: UISystem) {
  // 按实体缓存找到的元素：根元素和名字没变就不重新找（同 Stride）
  const found = new Map<EntityId, { root: UIElement; name: string; element: UIElement | null }>();
  const elementWorld = new Float32Array(16), inverseUiWorld = new Float32Array(16), link = new Float32Array(16);
  return system('UIElementLink', {
    with: { link: UIElementLink, transform: Transform },
    phase: 'afterPhysics',
    update: ({ link: links, transform, entities: ids, count }) => {
      if (count > 0) ui.layout(entities.game);
      for (let i = 0; i < count; i++) {
        const id = ids[i]! as EntityId;
        const entity = entities.entity(id);
        const targetId = links.target[i]! as EntityId;
        const target = targetId >= 0 ? (entities.isAlive(targetId) ? entities.entity(targetId) : undefined) : entity.require(Transform).parent;
        const slot = transform.slot[i]! as TransformSlot;
        const uiComponent = target?.get(UIComponent);
        if (!target || !uiComponent) {
          transforms.setLink(slot, null);
          continue;
        }
        const root = uiComponent.page?.rootElement;
        const name = links.nodeName[i]!;
        let cached = found.get(id);
        if (root && (cached?.root !== root || cached.name !== name)) found.set(id, (cached = { root, name, element: root.findName(name) }));
        const element = root ? cached!.element : null;
        // 链接是 UI 实体的世界矩阵 × matrix：要的世界矩阵左乘 UI 实体世界矩阵的逆
        if (!element || !ui.elementWorldMatrix(elementWorld, uiComponent, element) || !Matrix.invert(inverseUiWorld, target.require(Transform).world)) {
          transforms.setLink(slot, transformSlot(target), IDENTITY);
          continue;
        }
        transforms.setLink(slot, transformSlot(target), Matrix.multiply(link, inverseUiWorld, elementWorld));
      }
    },
    removed: (entity) => {
      found.delete(entity);
      if (entities.isAlive(entity) && entities.hasComponent(entity, Transform)) transforms.setLink(transformSlot(entities.entity(entity)), null);
    },
  });
}
