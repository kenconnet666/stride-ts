/**
 * 智能物体（Stride 没有；照虚幻 5 的 Smart Objects）：长椅、柜台、售货机这类"人可以用"的东西自己声明有几个位置（槽）、每个能干
 * 什么（activity：sit、buy、lean……），要用的人先占一个空槽、走过去、用完放开：
 *
 *   const claim = game.smartObjects.claim(person, { activity: 'sit', near: position, radius: 20 });
 *   if (claim) { agent.moveTo(claim.position); …; game.smartObjects.release(claim); }
 *
 * 状态树里用 `useSmartObject` 任务（占、走、对着槽的朝向、可选地设 Animator 的参数、待一会儿、放开）。槽的位置、朝向是相对
 * 物体实体的，物体挪了槽跟着走。
 */
import { Matrix } from '../data/Matrix';
import { prop, type EntityId } from '../data/prop';
import { Vector3, type Vec3Like } from '../data/vectors';
import type { Entity } from '../engine/Entity';
import type { Game } from '../engine/Game';
import { SyncScript } from '../engine/scripts';
import { Transform } from '../engine/transform';

/** 挂在长椅、柜台这类东西上：它的槽。 */
export class SmartObject extends SyncScript.props('SmartObject', {
  /** 槽：相对物体的位置、朝向（绕 Y 的角度，0 是物体的 +Z）、能干什么。 */
  slots: prop.list(prop.object({
    position: prop.vec3(),
    yaw: prop.f32().default(0).unit('°'),
    activity: prop.string().default('use'),
  })).default([]),
}) {
  override start(): void {
    this.game.smartObjects.add(this);
  }

  override cancel(): void {
    this.game.smartObjects.remove(this);
  }
}

/** 一个占着的槽。 */
export interface SmartObjectClaim {
  readonly object: SmartObject;
  readonly slot: number;
  readonly user: EntityId;
  readonly activity: string;
  /** 槽的世界位置（占的时候算的）。 */
  readonly position: Vector3;
  /** 槽朝的方向（世界的绕 Y 的角度，弧度；0 是 +Z）。 */
  readonly yaw: number;
}

export interface SmartObjectSearch {
  readonly activity: string;
  /** 在哪附近找（世界坐标）。 */
  readonly near: Vec3Like;
  /** 多远以内（米）。 */
  readonly radius?: number;
}

export class SmartObjectSystem {
  /** 每帧用调试线画出每个槽（绿的空着、红的占着）和它的朝向。 */
  show = false;
  readonly #objects = new Set<SmartObject>();
  /** `<物体实体>:<槽>` → 占着的。 */
  readonly #claims = new Map<string, SmartObjectClaim>();

  /** @internal SmartObject 开始时登记。 */
  add(object: SmartObject): void {
    this.#objects.add(object);
  }

  /** @internal SmartObject 去掉时：它的槽都放开。 */
  remove(object: SmartObject): void {
    this.#objects.delete(object);
    for (const [key, claim] of this.#claims) if (claim.object === object) this.#claims.delete(key);
  }

  /** 有几个物体、几个槽、占着几个。 */
  get stats(): { objects: number; slots: number; claimed: number } {
    let slots = 0;
    for (const object of this.#objects) slots += object.slots.length;
    return { objects: this.#objects.size, slots, claimed: this.#claims.size };
  }

  /** 现在占着的槽。 */
  get claims(): readonly SmartObjectClaim[] {
    return [...this.#claims.values()];
  }

  /** 槽的世界位置和朝向（弧度）。 */
  slotPose(object: SmartObject, slot: number): { position: Vector3; yaw: number } {
    const world = object.entity.require(Transform).world;
    const local = object.slots[slot]!;
    const [x, y, z] = Matrix.transformPoint(world, local.position.x, local.position.y, local.position.z);
    // 物体自己的朝向：本地 +Z 在世界里的水平方向
    const yaw = Math.atan2(world[8]!, world[10]!) + (local.yaw * Math.PI) / 180;
    return { position: new Vector3(x, y, z), yaw };
  }

  /** 找 near 附近 radius 以内能干 activity 的最近的空槽，占上；没有时 undefined。一个人同时只占一个槽（再占先放开旧的）。 */
  claim(user: Entity | EntityId, search: SmartObjectSearch): SmartObjectClaim | undefined {
    const id = typeof user === 'number' ? user : user.id;
    this.releaseAll(id);
    const radius = search.radius ?? 20;
    let best: { object: SmartObject; slot: number; distance: number; position: Vector3; yaw: number } | undefined;
    for (const object of this.#objects) {
      object.slots.forEach((slot, index) => {
        if (slot.activity !== search.activity || this.#claims.has(`${object.entity.id}:${index}`)) return;
        const pose = this.slotPose(object, index);
        const distance = Math.hypot(pose.position.x - search.near.x, pose.position.z - search.near.z);
        if (distance <= radius && (!best || distance < best.distance)) best = { object, slot: index, distance, ...pose };
      });
    }
    if (!best) return undefined;
    const claim: SmartObjectClaim = { object: best.object, slot: best.slot, user: id, activity: search.activity, position: best.position, yaw: best.yaw };
    this.#claims.set(`${best.object.entity.id}:${best.slot}`, claim);
    return claim;
  }

  /** 放开一个槽（已经放开的不管）。 */
  release(claim: SmartObjectClaim): void {
    const key = `${claim.object.entity.id}:${claim.slot}`;
    if (this.#claims.get(key) === claim) this.#claims.delete(key);
  }

  /** 每帧一次（Game 的内置子系统）：show 时画槽。 */
  update(game: Game): void {
    if (!this.show) return;
    for (const object of this.#objects) {
      object.slots.forEach((_, index) => {
        const { position: p, yaw } = this.slotPose(object, index);
        const color: [number, number, number, number] = this.#claims.has(`${object.entity.id}:${index}`) ? [1, 0.25, 0.2, 1] : [0.2, 1, 0.3, 1];
        game.debugDraw.line([p.x, p.y, p.z], [p.x, p.y + 1.2, p.z], color);
        game.debugDraw.line([p.x, p.y + 0.6, p.z], [p.x + Math.sin(yaw) * 0.6, p.y + 0.6, p.z + Math.cos(yaw) * 0.6], color);
      });
    }
  }

  /** 放开 user 占着的所有槽。 */
  releaseAll(user: Entity | EntityId): void {
    const id = typeof user === 'number' ? user : user.id;
    for (const [key, claim] of this.#claims) if (claim.user === id) this.#claims.delete(key);
  }
}
