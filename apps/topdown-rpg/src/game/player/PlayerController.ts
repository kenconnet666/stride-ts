// TopDownRPG 的 PlayerController：收到点击（PlayerInput 广播的目的地）后寻路，沿路径点给角色设 MoveVector（转角和快到时减速，
// 方向平滑），模型子实体转向移动方向；点到箱子时走过去，够近了出拳：出拳的碰撞体（挂在右手上的刚体）加进仿真一会儿，
// 打到箱子的触发器。启动时重建导航网格（同 Stride，重建完成前找不到路径）。
// 和 Stride 不同：移动方向的平滑每帧取 15%（同 Stride，按帧不按时间）；路径点是 Detour 的拐点（Stride 是按步长采样的平滑点）。
import { Body, Character, EventKey, prop, Quaternion, RecastNavigationComponent, SyncScript, Transform, Vector3, type Entity, type GameTime, type ViewOf } from '@stride-ts/engine';
import type { ClickResult } from '../core/ClickResult';
import { worldPosition } from '../core/Utils';
import { MoveDestinationEventKey } from './PlayerInput';

export const RunSpeedEventKey = new EventKey<number>();
export const IsAttackingEventKey = new EventKey<boolean>();

/** 出拳的碰撞体的 Body 设置：从场景里读一次，开关时按它重新加上。 */
type BodySettings = Parameters<typeof Body.with>[0];

export class PlayerController extends SyncScript.props({
  maxRunSpeed: prop.number().default(10),
  destinationThreshold: prop.number().default(0.2),
  cornerSlowdown: prop.number().default(0.6),
  destinationSlowdown: prop.number().default(0.4),
  punchCollision: prop.entity(),
  attackDistance: prop.number().default(1),
  attackCooldown: prop.number().default(0.65),
}, { requires: [() => RecastNavigationComponent] }) {
  #moveDirection = new Vector3();
  #isRunning = false;
  #punchEntity!: Entity;
  #punchSettings!: BodySettings;
  #modelChild!: Entity;
  #navigation!: RecastNavigationComponent;
  #yawOrientation = 0;
  #attackEntity: Entity | undefined;
  #attackCooldown = 0;
  #path: Vector3[] = [];
  #waypointIndex = 0;
  #moveDestination = new Vector3();
  readonly #moveDestinationEvents = this.receive(MoveDestinationEventKey);

  get #reachedDestination(): boolean {
    return this.#waypointIndex >= this.#path.length;
  }

  override start(): void {
    this.#navigation = this.entity.require(RecastNavigationComponent);
    void this.game.navigation!.rebuild();
    if (!this.entity.get(Character)) throw new Error('Please add a Character to the entity containing PlayerController!');
    this.#modelChild = this.entity.require(Transform).children[0]!;
    this.#moveDestination = worldPosition(this.entity);
    // 出拳的碰撞体：动态、不受重力，平时不在仿真里
    this.#punchEntity = this.game.entities.entity(this.punchCollision);
    const body = this.#punchEntity.require(Body);
    this.#punchSettings = {
      collider: body.collider, layer: body.layer, friction: body.friction, kinematic: false, gravity: false,
      trigger: body.trigger, sleepThreshold: body.sleepThreshold, interpolated: body.interpolated,
    };
    this.#setPunchCollision(false);
  }

  override update(time: GameTime): void {
    this.#attack(time.elapsed);
    this.#move(this.maxRunSpeed);
  }

  #character(): ViewOf<typeof Character> {
    return this.entity.require(Character);
  }

  #attack(elapsed: number): void {
    this.#attackCooldown = this.#attackCooldown > 0 ? this.#attackCooldown - elapsed : 0;
    this.#setPunchCollision(this.#attackCooldown > 0);
    if (!this.#attackEntity) return;
    const toTarget = worldPosition(this.#attackEntity).subtract(worldPosition(this.#modelChild));
    toTarget.y = 0;
    if (toTarget.length() <= this.attackDistance) {
      this.#haltMovement();
      this.#attackEntity = undefined;
      this.#attackCooldown = this.attackCooldown;
      this.#setPunchCollision(true);
      IsAttackingEventKey.broadcast(true);
    } else {
      this.#updateDestination(worldPosition(this.#attackEntity));
    }
  }

  #setPunchCollision(enabled: boolean): void {
    const attached = this.#punchEntity.get(Body) !== undefined;
    if (enabled && !attached) this.#punchEntity.add(Body.with(this.#punchSettings));
    else if (!enabled && attached) this.#punchEntity.remove(Body);
  }

  #haltMovement(): void {
    this.#isRunning = false;
    this.#moveDirection.set(0, 0, 0);
    const character = this.#character();
    character.moveX = character.moveY = 0;
    this.#moveDestination = worldPosition(this.#modelChild);
  }

  #updateDestination(destination: Vector3): void {
    // 目的地变了才重新寻路
    if (this.#moveDestination.clone().subtract(destination).length() <= 0.01) return;
    if (!this.#navigation.tryFindPath(destination)) {
      this.#path = [];
      this.#haltMovement();
      return;
    }
    this.#path = this.#navigation.path;
    this.#waypointIndex = 0;
    const position = worldPosition(this.entity);
    while (!this.#reachedDestination && this.#path[this.#waypointIndex]!.clone().subtract(position).length() < 0.25) this.#waypointIndex++;
    if (!this.#reachedDestination) {
      this.#isRunning = true;
      this.#moveDestination = destination.clone();
    }
  }

  #updateMoveTowardsDestination(speed: number): void {
    if (this.#reachedDestination) {
      this.#haltMovement();
      return;
    }
    const position = worldPosition(this.entity);
    const waypoint = this.#path[this.#waypointIndex]!;
    const direction = waypoint.clone().subtract(position);
    const length = direction.length();
    direction.scale(1 / length);
    let advance = false;
    if (this.#path.length > 0 && this.#waypointIndex > 0 && this.#waypointIndex !== this.#path.length - 1) {
      // 越过了这一段的终点（沿这一段的方向投影）就去下一个点
      const segment = waypoint.clone().subtract(this.#path[this.#waypointIndex - 1]!).normalize();
      if (position.dot(segment) > waypoint.dot(segment)) advance = true;
    } else if (length < this.destinationThreshold) {
      advance = true;
    }
    if (advance) {
      this.#waypointIndex++;
      if (this.#reachedDestination) {
        this.#haltMovement();
        return;
      }
    }
    const moveSpeed = Math.min(1, this.#moveDestination.clone().subtract(position).length() * this.destinationSlowdown);
    const cornerSpeedMultiply = Math.max(0, direction.dot(this.#moveDirection)) * this.cornerSlowdown + (1 - this.cornerSlowdown);
    this.#moveDirection.scale(0.85).add(direction.scale(moveSpeed * cornerSpeedMultiply * 0.15));
    const character = this.#character();
    character.moveX = (this.#moveDirection.x * speed) / character.speed;
    character.moveY = (this.#moveDirection.z * speed) / character.speed;
    RunSpeedEventKey.broadcast(this.#moveDirection.length());
    if (this.#moveDirection.length() > 0.001) this.#yawOrientation = Math.atan2(-this.#moveDirection.z, this.#moveDirection.x) + Math.PI / 2;
    const rotation = new Quaternion().setAxisAngle({ x: 0, y: 1, z: 0 }, this.#yawOrientation);
    const model = this.#modelChild.require(Transform).rotation;
    [model.x, model.y, model.z, model.w] = [rotation.x, rotation.y, rotation.z, rotation.w];
  }

  #move(speed: number): void {
    if (this.#attackCooldown > 0) return;
    const click: ClickResult | undefined = this.#moveDestinationEvents.drain().at(-1);
    if (click && click.type !== 'empty') {
      if (click.type === 'ground') {
        this.#attackEntity = undefined;
        this.#updateDestination(click.worldPosition);
      }
      if (click.type === 'lootCrate') {
        this.#attackEntity = click.clickedEntity;
        this.#attack(0);
      }
    }
    if (!this.#isRunning) {
      RunSpeedEventKey.broadcast(0);
      return;
    }
    this.#updateMoveTowardsDestination(speed);
  }
}
