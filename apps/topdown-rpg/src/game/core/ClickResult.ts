// TopDownRPG 的 ClickResult：屏幕上点到了什么（地面、可以打的箱子，或什么都没有）。
import type { Entity, Vector3 } from '@stride-ts/engine';

export type ClickType = 'empty' | 'ground' | 'lootCrate';

export interface ClickResult {
  worldPosition: Vector3;
  clickedEntity: Entity | undefined;
  type: ClickType;
  /** 命中点的法线（点击特效按它摆）。 */
  normal: Vector3;
}
