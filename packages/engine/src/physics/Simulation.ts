/**
 * 物理仿真（Stride.BepuPhysics 的 BepuSimulation），内核是 stride-native 里的 Jolt：固定步长，每帧最多几步，
 * 插值的物体渲染两步之间的位姿。Game 在"物理前"和"物理后"两组系统之间调用 update：
 *   新出现的 Static、Body、Character 建成物体 → 角色的移动输入交给原生 → 步进 → 插值 → 写回角色的 grounded。
 * 设置（重力、阻尼、步长）在建第一个物体之前改，之后只有步长和每帧步数还能改。
 * 动态刚体（Body）建好以后用 `body(entity)` 控制（Stride 的 BodyComponent 的属性和方法）。接触事件见 contacts.ts：
 * 每一步之后把原生的事件交给两边的处理器。实体销毁（或去掉物理组件）时移除物体（连着的约束一起移除）。
 * 约束用 `addConstraint`（Stride.BepuPhysics 的约束组件的参数，语义照 Bepu；Bepu 的约束都是软的，这里除了伺服、马达和
 * 距离限制都是刚性的）。每个物理步之前调 `onStep` 登记的回调（Stride 的 ISimulationUpdate.SimulationUpdate）。
 */
import type { BodyDesc, BodyId, ConstraintDesc, PhysicsConstraint, PhysicsHull, PhysicsMesh, PhysicsWorld, ShapeDesc, StrideNative, TransformSlot, TransformStore } from '@stride-ts/native';
import { PhysicsHit } from '@stride-ts/native';
import type { Commands } from '../engine/Commands';
import type { EntityId } from '../data/prop';
import type { EntityManager } from '../engine/EntityManager';
import { system } from '../engine/system';
import { Transform } from '../engine/transform';
import type { GameTime } from '../games/GameTime';
import type { Entity } from '../engine/Entity';
import { Vector3, type QuatLike, type Vec3Like } from '../mathematics/vectors';
import { Collider, hullPoints, triangleSoup, type ColliderShape } from './Collider';
import { TriggerHandler, type ContactHandler } from './contacts';
import { Body, Character, PhysicsBody, Static } from './components';

type Vec3 = readonly [number, number, number];

/** 仿真设置，默认值同 Stride 的 BepuSimulation。 */
export interface SimulationSettings {
  gravity: Vec3;
  linearDamping: number;
  angularDamping: number;
  /** 秒。 */
  fixedTimeStep: number;
  maxStepsPerFrame: number;
  /** 碰撞矩阵：collisionMasks[a] 的第 b 位为 1 表示层 a 和层 b 相互碰撞；默认全部碰撞。 */
  collisionMasks?: readonly number[];
}

/** 约束的设置（Stride.BepuPhysics 的约束组件）：A、B 是带物理组件的实体（单体约束只有 A），其余字段照原生的 ConstraintDesc。 */
export type ConstraintSettings = ConstraintDesc extends infer D
  ? D extends { bodyB: BodyId } ? Omit<D, 'bodyA' | 'bodyB'> & { bodyA: Entity | EntityId; bodyB: Entity | EntityId }
    : D extends { bodyA: BodyId } ? Omit<D, 'bodyA'> & { bodyA: Entity | EntityId } : never
  : never;

/** 某种约束的设置，比如 `ConstraintSettingsOf<'oneBodyLinearServo'>`。 */
export type ConstraintSettingsOf<T extends ConstraintSettings['type']> = Extract<ConstraintSettings, { type: T }>;

/** addConstraint 建的约束（Stride 的 ConstraintComponent）。 */
export interface Constraint<S extends ConstraintSettings = ConstraintSettings> {
  /** 现在的设置。 */
  readonly settings: S;
  /** 关掉时约束不起作用（Stride 的 ConstraintComponent.Enabled）。 */
  enabled: boolean;
  /** 改设置（Stride 里改约束组件的属性），比如伺服的目标；内部是移除再加回去。 */
  update(changes: Partial<Omit<S, 'type'>>): void;
  /** 移除约束（物体会唤醒）；移除过的忽略。 */
  remove(): void;
}

export interface SimulationHit {
  /** 沿方向的距离。 */
  readonly distance: number;
  readonly point: Vec3;
  readonly normal: Vec3;
  readonly entity: EntityId;
}

/** Stride 的 MaximumTimeSpanToProcess：一帧最多处理这么长的时间，卡顿后不追赶。 */
const MAX_FRAME_TIME = 0.25;
const ALL_LAYERS = 0xffffffff;

export class Simulation {
  /** 仿真时间相对游戏时间的倍率（Stride 的 BepuSimulation.TimeScale）。 */
  timeScale = 1;
  /** 关掉时不步进（Stride 的 BepuSimulation.Enabled）：物体停在原地，新加的物体照常建好。 */
  enabled = true;
  readonly settings: SimulationSettings = { gravity: [0, -9.8, 0], linearDamping: 0.05, angularDamping: 0.05, fixedTimeStep: 1 / 60, maxStepsPerFrame: 3 };
  readonly #native: StrideNative;
  readonly #transforms: TransformStore;
  readonly #entities: EntityManager;
  readonly #maxBodies: number;
  #world: PhysicsWorld | undefined;
  #remaining = 0;
  /** 物体编号对应的实体。 */
  readonly #bodyEntities: EntityId[] = [];
  /** 网格形状建成的原生三角网格，按网格的 id 组合缓存（同一个模型的碰撞体共用）。 */
  readonly #meshes = new Map<string, PhysicsMesh>();
  /** 凸包形状，按网格的 id 组合加 hull 的变换缓存。 */
  readonly #hulls = new Map<string, PhysicsHull>();
  readonly #stepListeners = new Set<(timeStep: number) => void>();
  /** body(entity) 给出的控制对象，按物体编号。 */
  readonly #controls = new Map<BodyId, BodyControl>();
  /** 接触处理器，按物体编号。 */
  readonly #handlers = new Map<BodyId, ContactHandler>();
  readonly #hit = new PhysicsHit();

  readonly #createStatics = system('Simulation.createStatics', {
    with: { body: Static, transform: Transform },
    without: [PhysicsBody],
    update: ({ body, transform, entities, count }, _time, commands) => {
      const descs = Array.from({ length: count }, (_, i): BodyDesc => ({
        motion: 'static',
        shapes: this.#shapes(body.collider[i]!),
        transform: transform.slot[i]! as TransformSlot,
        layer: body.layer[i]!,
        friction: body.friction[i]!,
        sensor: body.trigger[i] !== 0,
        contactEvents: body.trigger[i] !== 0,
      }));
      this.#addBodies(descs, entities, count, commands, Array.from({ length: count }, (_, i) => body.trigger[i] !== 0));
    },
  });

  readonly #createBodies = system('Simulation.createBodies', {
    with: { body: Body, transform: Transform },
    without: [PhysicsBody],
    update: ({ body: b, transform, entities, count }, _time, commands) => {
      const descs = Array.from({ length: count }, (_, i): BodyDesc => ({
        motion: b.kinematic[i] ? 'kinematic' : 'dynamic',
        shapes: this.#shapes(b.collider[i]!),
        transform: transform.slot[i]! as TransformSlot,
        layer: b.layer[i]!,
        friction: b.friction[i]!,
        interpolated: b.interpolated[i] !== 0,
        gravity: b.gravity[i] !== 0,
        neverSleep: b.sleepThreshold[i]! < 0,
        sensor: b.trigger[i] !== 0,
        contactEvents: b.trigger[i] !== 0,
      }));
      this.#addBodies(descs, entities, count, commands, Array.from({ length: count }, (_, i) => b.trigger[i] !== 0));
    },
  });

  readonly #createCharacters = system('Simulation.createCharacters', {
    with: { character: Character, transform: Transform },
    without: [PhysicsBody],
    update: ({ character: c, transform, entities, count }, _time, commands) => {
      const descs = Array.from({ length: count }, (_, i): BodyDesc => ({
        motion: 'character',
        shapes: this.#shapes(c.collider[i]!),
        transform: transform.slot[i]! as TransformSlot,
        layer: c.layer[i]!,
        friction: c.friction[i]!,
        interpolated: c.interpolated[i] !== 0,
        gravity: c.gravity[i] !== 0,
        character: {
          maximumHorizontalForce: c.maximumHorizontalForce[i]!,
          maximumVerticalForce: c.maximumVerticalForce[i]!,
          jumpVelocity: c.jumpForce[i]!,
          slopeAngle: c.slopeAngle[i]!,
          airControlForceScale: c.airControlForceScale[i]!,
          airControlScale: c.airControlScale[i]!,
        },
      }));
      this.#addBodies(descs, entities, count, commands);
    },
  });

  /** 移动输入：MoveVector · Speed 换到世界的 X、Z（角色的基：右 = up × 前，前 = 右 × up，前是本地 +Z）；起跳请求交给原生后清掉。 */
  readonly #moveCharacters = system('Simulation.moveCharacters', {
    with: { character: Character, transform: Transform, physics: PhysicsBody },
    writes: [Character],
    update: ({ character: c, transform, physics, count }) => {
      const world = this.#world!;
      for (let i = 0; i < count; i++) {
        const w = transform.slot[i]! * 16;
        // 本地 Z 轴的水平分量就是"前"，右 = up × 前 = (z, 0, -x)
        let fx = transform.world[w + 8]!, fz = transform.world[w + 10]!;
        const length = Math.hypot(fx, fz) || 1;
        fx /= length;
        fz /= length;
        const speed = c.speed[i]!, x = c.moveX[i]! * speed, y = c.moveY[i]! * speed;
        world.moveCharacter(physics.body[i]! as BodyId, fz * x + fx * y, -fx * x + fz * y, c.jump[i] !== 0);
        c.jump[i] = 0;
      }
    },
  });

  /** 实体销毁或去掉物理组件时移除物体（加进 EntityManager：只用它的 removed 回调）。 */
  readonly #removeBodies = system('Simulation.removeBodies', {
    with: { physics: PhysicsBody },
    update: () => {},
    removed: (entity) => {
      const body = this.#entities.entity(entity).require(PhysicsBody).body as BodyId;
      this.#world?.removeBodies([body]);
      this.#handlers.delete(body);
      this.#controls.get(body)?.detach();
      this.#controls.delete(body);
      delete this.#bodyEntities[body];
    },
  });

  readonly #readGrounded = system('Simulation.readGrounded', {
    with: { character: Character, physics: PhysicsBody },
    writes: [Character],
    update: ({ character, physics, count }) => {
      for (let i = 0; i < count; i++) character.grounded[i] = this.#world!.isGrounded(physics.body[i]! as BodyId) ? 1 : 0;
    },
  });

  constructor(native: StrideNative, transforms: TransformStore, entities: EntityManager, maxBodies: number) {
    this.#native = native;
    this.#transforms = transforms;
    this.#entities = entities;
    this.#maxBodies = maxBodies;
    entities.addSystems(this.#removeBodies);
  }

  /**
   * 改设置。重力随时能改（Stride 的 PoseGravity；睡着的物体被碰到或唤醒后才受新的重力）；阻尼和碰撞矩阵要在建第一个
   * 物体之前改，之后只能设成和现在一样的值（换场景时场景带的设置常常相同）。
   */
  configure(settings: Partial<SimulationSettings>): void {
    if (this.#world) {
      const fixed = (['linearDamping', 'angularDamping', 'collisionMasks'] as const)
        .filter((key) => settings[key] !== undefined && JSON.stringify(settings[key]) !== JSON.stringify(this.settings[key]));
      if (fixed.length > 0) throw new Error(`Simulation.configure: ${fixed.join(', ')} must be set before the first physics body is created`);
      if (settings.gravity) this.#world.setWorldGravity(settings.gravity);
    }
    Object.assign(this.settings, settings);
  }

  /** 一帧的仿真：建新物体、按固定步长步进（最多 maxStepsPerFrame 步），插值的物体写回两步之间的位姿。 */
  update(time: GameTime): void {
    this.#createPending(time);
    const entities = this.#entities;
    if (!this.#world || !this.enabled) return;
    entities.run(this.#moveCharacters, time);
    const { fixedTimeStep: step, maxStepsPerFrame } = this.settings;
    this.#remaining += Math.min(time.elapsed, MAX_FRAME_TIME) * this.timeScale;
    for (let steps = 0; this.#remaining >= step && steps < maxStepsPerFrame; steps++) {
      for (const listener of this.#stepListeners) listener(step);
      this.#world.step(step);
      this.#remaining -= step;
      this.#dispatchContacts();
    }
    this.#world.interpolate(this.#remaining / step);
    entities.run(this.#readGrounded, time);
  }

  /**
   * 动态刚体的控制（Stride 的 BodyComponent 的属性和方法）。物体还没建（实体这一帧才加上 Body）时先建好，
   * 所以脚本的 start() 里就能用。实体没有 Body 时报错。
   */
  body(entity: Entity | EntityId): BodyControl {
    const id = typeof entity === 'number' ? entity : entity.id;
    if (!this.#entities.hasComponent(id, Body)) throw new Error(`entity ${id} has no Body component`);
    const body = this.#bodyOf(id);
    let control = this.#controls.get(body);
    if (!control) this.#controls.set(body, (control = new BodyControl(this.#world!, body, this.#entities, id)));
    return control;
  }

  /** 碰撞体的接触处理器（场景里 ContactEventHandler 是 Trigger 的是 TriggerHandler）；没有时是 undefined。 */
  contactHandler(entity: Entity | EntityId): ContactHandler | undefined {
    return this.#handlers.get(this.#bodyOf(entity));
  }

  /**
   * 设碰撞体的接触处理器（Stride 的 ContactEventHandler），undefined 取消。handler.noContactResponse 为真时物体变成只检测、
   * 不挡东西。物体还没建时先建好。
   */
  setContactHandler(entity: Entity | EntityId, handler: ContactHandler | undefined): void {
    const body = this.#bodyOf(entity);
    const world = this.#world!;
    world.setContactEvents(body, handler !== undefined);
    world.setSensor(body, handler?.noContactResponse === true);
    if (handler) this.#handlers.set(body, handler);
    else this.#handlers.delete(body);
  }

  /**
   * 加一个约束（Stride 里把约束组件加到实体上）；两个物体还没建时先建好。实体销毁时连着的约束一起移除。
   *
   *   const hinge = simulation.addConstraint({ type: 'hinge', bodyA: cube, bodyB: sphere, localOffsetB: [4, 0, 0], localHingeAxisA: [0, 0, 1], localHingeAxisB: [0, 0, 1] });
   *   hinge.remove();
   */
  addConstraint<S extends ConstraintSettings>(settings: S): Constraint<S> {
    return new ConstraintHandle(settings, (s) => {
      const desc = { ...s, bodyA: this.#bodyOf(s.bodyA), ...('bodyB' in s ? { bodyB: this.#bodyOf(s.bodyB) } : {}) } as ConstraintDesc;
      return this.#world!.addConstraint(desc);
    }, (id) => this.#world?.removeConstraint(id));
  }

  /**
   * 每个物理步之前调 listener(步长)（Stride 的 ISimulationUpdate.SimulationUpdate），返回的 Disposable 取消登记。
   * 物理按固定步长走，一帧可能走几步，也可能一步不走（按仿真时间算的逻辑放在这里）。
   */
  onStep(listener: (timeStep: number) => void): Disposable {
    this.#stepListeners.add(listener);
    return { [Symbol.dispose]: () => void this.#stepListeners.delete(listener) };
  }

  /** 射线（Stride 的 RayCast）：mask 的第 n 位为 1 表示层 n 的物体参与。没命中时返回 undefined。 */
  rayCast(origin: Vec3, direction: Vec3, maxDistance: number, { mask = ALL_LAYERS }: { mask?: number } = {}): SimulationHit | undefined {
    return this.#result(this.#world?.rayCast(origin, direction, maxDistance, { mask, hit: this.#hit }));
  }

  /**
   * 球体扫掠（Stride 的 SweepCast 加 Sphere）。默认从一开始就重叠的物体算距离 0 的命中（同 Bepu）；ignoreInitialOverlap
   * 时跳过它们（第三人称相机用，再配一条射线防止钻进正后方的墙）。
   */
  sphereCast(radius: number, origin: Vec3, direction: Vec3, maxDistance: number, { mask = ALL_LAYERS, ignoreInitialOverlap = false }: { mask?: number; ignoreInitialOverlap?: boolean } = {}): SimulationHit | undefined {
    return this.#result(this.#world?.sphereCast(radius, origin, direction, maxDistance, { mask, hit: this.#hit, ignoreInitialOverlap }));
  }

  destroy(): void {
    this.#world?.destroy();
    this.#world = undefined;
  }

  #result(hit: PhysicsHit | undefined): SimulationHit | undefined {
    if (!hit) return undefined;
    return { distance: hit.distance, point: [...hit.point], normal: [...hit.normal], entity: this.#bodyEntities[hit.body]! };
  }

  #worldOrCreate(): PhysicsWorld {
    const { gravity, linearDamping, angularDamping, collisionMasks } = this.settings;
    return (this.#world ??= this.#native.createPhysicsWorld(this.#maxBodies, {
      transforms: this.#transforms,
      gravity,
      linearDamping,
      angularDamping,
      ...(collisionMasks ? { collisionMasks } : {}),
    }));
  }

  /** 建好物体，记下编号对应的实体；triggers[i] 为真的带一个 TriggerHandler。 */
  #addBodies(descs: BodyDesc[], entities: ArrayLike<EntityId>, count: number, commands: Commands, triggers?: readonly boolean[]): void {
    if (count === 0) return;
    const bodies = this.#worldOrCreate().addBodies(descs);
    for (let i = 0; i < count; i++) {
      this.#bodyEntities[bodies[i]!] = entities[i]!;
      if (triggers?.[i]) this.#handlers.set(bodies[i]!, new TriggerHandler());
      commands.add(entities[i]!, PhysicsBody.with({ body: bodies[i]! }));
    }
  }

  /** 实体的物体编号；物体还没建时先建好。实体没有物理组件时报错。 */
  #bodyOf(entity: Entity | EntityId): BodyId {
    const id = typeof entity === 'number' ? entity : entity.id;
    if (!this.#entities.hasComponent(id, PhysicsBody)) this.#createPending(this.#entities.game.updateTime);
    if (!this.#entities.hasComponent(id, PhysicsBody)) throw new Error(`entity ${id} has no Static, Body or Character component`);
    return this.#entities.entity(id).require(PhysicsBody).body as BodyId;
  }

  /** 一步的接触事件交给两边的处理器（原生只报一次：设了事件的一方在前）。 */
  #dispatchContacts(): void {
    for (const { type, self, other } of this.#world!.contactEvents()) {
      const a = this.#bodyEntities[self], b = this.#bodyEntities[other];
      if (a === undefined || b === undefined) continue;
      for (const [body, entity, otherEntity] of [[self, a, b], [other, b, a]] as const) {
        const handler = this.#handlers.get(body);
        if (type === 'started') handler?.onStartedTouching?.({ entity, other: otherEntity });
        else handler?.onStoppedTouching?.({ entity, other: otherEntity });
      }
    }
  }

  /** 新出现的 Static、Body、Character 建成物体。 */
  #createPending(time: GameTime): void {
    this.#entities.run(this.#createStatics, time);
    this.#entities.run(this.#createBodies, time);
    this.#entities.run(this.#createCharacters, time);
  }

  #shapes(id: number): ShapeDesc[] {
    const collider = Collider.byId(id);
    if (!collider) throw new Error(`physics body refers to collider ${id}, which does not exist`);
    return collider.shapes.map((shape) => this.#shape(shape));
  }

  #shape(shape: ColliderShape): ShapeDesc {
    const local = { ...(shape.position ? { position: shape.position } : {}), ...(shape.rotation ? { rotation: shape.rotation } : {}), mass: shape.mass ?? 1 };
    if (shape.type === 'convexHull') {
      const key = `${shape.meshes.map((mesh) => mesh.id).join(',')}:${JSON.stringify(shape.hull ?? null)}`;
      let hull = this.#hulls.get(key);
      if (hull === undefined) this.#hulls.set(key, (hull = this.#worldOrCreate().createHull(hullPoints(shape.meshes, shape.hull))));
      return { type: 'convexHull', hull, ...local };
    }
    if (shape.type !== 'mesh') return { ...shape, ...local } as ShapeDesc;
    const key = shape.meshes.map((mesh) => mesh.id).join(',');
    let mesh = this.#meshes.get(key);
    if (mesh === undefined) {
      const { positions, indices } = triangleSoup(shape.meshes);
      mesh = this.#worldOrCreate().createMesh(positions, indices);
      this.#meshes.set(key, mesh);
    }
    return { type: 'mesh', mesh, ...local };
  }
}

/** 物体移除后 BodyControl 记着的设置。 */
interface DetachedBody {
  kinematic: boolean;
  gravity: boolean;
  sleepThreshold: number;
}

/**
 * 一个动态刚体的控制（Stride 的 BodyComponent 的属性和方法），用 `game.simulation.body(entity)` 拿到。读写直接作用到原生的物体；
 * kinematic、gravity 也写回 Body 组件的列，组件里看到的总是当前的设置。
 *
 * 物体移除以后（实体销毁，比如换场景时脚本的 cancel 里还在复位物体）同 Stride 的 BodyComponent 离开仿真：设置只记下，
 * 冲量、瞬移忽略，速度是 0，不醒着。
 */
export class BodyControl {
  readonly #world: PhysicsWorld;
  readonly #body: BodyId;
  readonly #entities: EntityManager;
  readonly #entity: EntityId;
  readonly #linear = [0, 0, 0];
  readonly #angular = [0, 0, 0];
  #detached: DetachedBody | undefined;

  /** @internal */
  constructor(world: PhysicsWorld, body: BodyId, entities: EntityManager, entity: EntityId) {
    this.#world = world;
    this.#body = body;
    this.#entities = entities;
    this.#entity = entity;
  }

  /** 运动学：不受力和重力，按速度走（Stride 的 Kinematic）。 */
  get kinematic(): boolean {
    return this.#settings().kinematic;
  }

  set kinematic(value: boolean) {
    if (!this.#detached) this.#world.setKinematic(this.#body, value);
    this.#settings().kinematic = value;
  }

  get gravity(): boolean {
    return this.#settings().gravity;
  }

  set gravity(value: boolean) {
    if (!this.#detached) this.#world.setGravity(this.#body, value);
    this.#settings().gravity = value;
  }

  /** Stride 的 SleepThreshold：负数一直醒着；其余用 Jolt 的全局睡眠阈值（和 Stride 不同：Bepu 按物体设）。 */
  get sleepThreshold(): number {
    return this.#settings().sleepThreshold;
  }

  set sleepThreshold(value: number) {
    if (!this.#detached) this.#world.setNeverSleep(this.#body, value < 0);
    this.#settings().sleepThreshold = value;
  }

  /** 醒着（Stride 的 Awake）；睡着的物体不参与仿真，直到被碰到或唤醒。 */
  get awake(): boolean {
    return !this.#detached && this.#world.isAwake(this.#body);
  }

  set awake(value: boolean) {
    if (!this.#detached) this.#world.setAwake(this.#body, value);
  }

  /** 世界空间的线速度（读的是一份拷贝；改要整个赋值）。 */
  get linearVelocity(): Vector3 {
    this.#readVelocity();
    return new Vector3(this.#linear[0], this.#linear[1], this.#linear[2]);
  }

  set linearVelocity(value: Vec3Like) {
    if (!this.#detached) this.#world.setVelocity(this.#body, [value.x, value.y, value.z]);
  }

  get angularVelocity(): Vector3 {
    this.#readVelocity();
    return new Vector3(this.#angular[0], this.#angular[1], this.#angular[2]);
  }

  set angularVelocity(value: Vec3Like) {
    if (!this.#detached) this.#world.setVelocity(this.#body, undefined, [value.x, value.y, value.z]);
  }

  /** 在质心加冲量（Stride 的 ApplyLinearImpulse）。 */
  applyLinearImpulse(impulse: Vec3Like): void {
    if (!this.#detached) this.#world.applyImpulse(this.#body, [impulse.x, impulse.y, impulse.z]);
  }

  applyAngularImpulse(impulse: Vec3Like): void {
    if (!this.#detached) this.#world.applyImpulse(this.#body, undefined, [impulse.x, impulse.y, impulse.z]);
  }

  /** 瞬移到世界位姿并唤醒（Stride 的 Teleport）；实体的变换立即更新。 */
  teleport(position: Vec3Like, rotation: QuatLike): void {
    if (!this.#detached) this.#world.teleport(this.#body, [position.x, position.y, position.z], [rotation.x, rotation.y, rotation.z, rotation.w]);
  }

  /** @internal 物体移除时（Simulation 调用）：记下设置，之后不再碰原生的物体。 */
  detach(): void {
    const { kinematic, gravity, sleepThreshold } = this.#settings();
    this.#detached = { kinematic, gravity, sleepThreshold };
  }

  /** 设置在 Body 组件的列里；物体移除后在 detach 记下的拷贝里。 */
  #settings(): DetachedBody {
    return this.#detached ?? this.#entities.entity(this.#entity).require(Body);
  }

  #readVelocity(): void {
    if (this.#detached) {
      this.#linear.fill(0);
      this.#angular.fill(0);
    } else {
      this.#world.velocity(this.#body, this.#linear, this.#angular);
    }
  }
}

/** addConstraint 给出的约束：设置留在 TS 这边，关掉、改设置时移除原生的约束，需要时再按新设置加回去。 */
class ConstraintHandle<S extends ConstraintSettings> implements Constraint<S> {
  #settings: S;
  #id: PhysicsConstraint | undefined;
  #removed = false;
  readonly #add: (settings: S) => PhysicsConstraint;
  readonly #remove: (id: PhysicsConstraint) => void;

  constructor(settings: S, add: (settings: S) => PhysicsConstraint, remove: (id: PhysicsConstraint) => void) {
    this.#settings = settings;
    this.#add = add;
    this.#remove = remove;
    this.#id = add(settings);
  }

  get settings(): S {
    return this.#settings;
  }

  get enabled(): boolean {
    return this.#id !== undefined;
  }

  set enabled(value: boolean) {
    if (this.#removed || value === this.enabled) return;
    if (value) this.#id = this.#add(this.#settings);
    else this.#detach();
  }

  update(changes: Partial<Omit<S, 'type'>>): void {
    this.#settings = { ...this.#settings, ...changes };
    if (this.#removed || this.#id === undefined) return;
    this.#detach();
    this.#id = this.#add(this.#settings);
  }

  remove(): void {
    this.#detach();
    this.#removed = true;
  }

  #detach(): void {
    if (this.#id !== undefined) this.#remove(this.#id);
    this.#id = undefined;
  }
}
