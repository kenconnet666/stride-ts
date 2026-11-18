/**
 * 物理仿真（Stride.BepuPhysics 的 BepuSimulation），内核是 stride-native 里的 Jolt：固定步长，每帧最多几步，
 * 插值的物体渲染两步之间的位姿。Game 在"物理前"和"物理后"两组系统之间调用 update：
 *   新出现的 Static、Character 建成物体 → 角色的移动输入交给原生 → 步进 → 插值 → 写回角色的 grounded。
 * 设置（重力、阻尼、步长）在建第一个物体之前改，之后只有步长和每帧步数还能改。
 *
 * 还没做：实体销毁时移除物体（原生侧还没有移除接口），动态物体组件（BodyComponent）、触发器、接触事件。
 */
import type { BodyDesc, BodyId, PhysicsMesh, PhysicsWorld, ShapeDesc, StrideNative, TransformSlot, TransformStore } from '@stride-ts/native';
import { PhysicsHit } from '@stride-ts/native';
import type { Commands } from '../engine/Commands';
import type { EntityId } from '../data/prop';
import type { EntityManager } from '../engine/EntityManager';
import { system } from '../engine/system';
import { Transform } from '../engine/transform';
import type { GameTime } from '../games/GameTime';
import { Collider, triangleSoup, type ColliderShape } from './Collider';
import { Character, PhysicsBody, Static } from './components';

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
      }));
      this.#addBodies(descs, entities, count, commands);
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
  }

  /** 改设置；重力、阻尼和碰撞矩阵要在建第一个物体之前改。 */
  configure(settings: Partial<SimulationSettings>): void {
    if (this.#world && (settings.gravity || settings.linearDamping !== undefined || settings.angularDamping !== undefined || settings.collisionMasks)) {
      throw new Error('Simulation.configure: gravity, damping and collisionMasks must be set before the first physics body is created');
    }
    Object.assign(this.settings, settings);
  }

  /** 一帧的仿真：建新物体、按固定步长步进（最多 maxStepsPerFrame 步），插值的物体写回两步之间的位姿。 */
  update(time: GameTime): void {
    const entities = this.#entities;
    entities.run(this.#createStatics, time);
    entities.run(this.#createCharacters, time);
    if (!this.#world) return;
    entities.run(this.#moveCharacters, time);
    const { fixedTimeStep: step, maxStepsPerFrame } = this.settings;
    this.#remaining += Math.min(time.elapsed, MAX_FRAME_TIME);
    for (let steps = 0; this.#remaining >= step && steps < maxStepsPerFrame; steps++) {
      this.#world.step(step);
      this.#remaining -= step;
    }
    this.#world.interpolate(this.#remaining / step);
    entities.run(this.#readGrounded, time);
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

  #addBodies(descs: BodyDesc[], entities: ArrayLike<EntityId>, count: number, commands: Commands): void {
    if (count === 0) return;
    const bodies = this.#worldOrCreate().addBodies(descs);
    for (let i = 0; i < count; i++) {
      this.#bodyEntities[bodies[i]!] = entities[i]!;
      commands.add(entities[i]!, PhysicsBody.with({ body: bodies[i]! }));
    }
  }

  #shapes(id: number): ShapeDesc[] {
    const collider = Collider.byId(id);
    if (!collider) throw new Error(`physics body refers to collider ${id}, which does not exist`);
    return collider.shapes.map((shape) => this.#shape(shape));
  }

  #shape(shape: ColliderShape): ShapeDesc {
    const local = { ...(shape.position ? { position: shape.position } : {}), ...(shape.rotation ? { rotation: shape.rotation } : {}), mass: shape.mass ?? 1 };
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
