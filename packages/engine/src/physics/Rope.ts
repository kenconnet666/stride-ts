/**
 * 绳子（Stride 没有）：从这个实体挂到 `end`（另一个实体；没有时往下垂 `length` 米）的一串胶囊，每段一个动态物体，相邻的段在
 * 接头处用球窝约束连着；两头连在锚上——锚的实体有动态 Body 时直接连它（吊着的重物），没有时连一个跟着锚的实体走的运动学的
 * 小物体（拖着锚走，绳子跟着晃）。比两头的距离长时开始垂成 V 形，物理里自己落成弧。
 *
 * 架空的电线这类不动的线用样条的横截面（W3），这里是会晃、能挂东西、能被撞开的绳子、链子、吊索。
 */
import { prop } from '../data/prop';
import { Quaternion, Vector3 } from '../data/vectors';
import type { Entity } from '../engine/Entity';
import { SyncScript } from '../engine/scripts';
import { Transform } from '../engine/transform';
import { Collider } from './Collider';
import { Body } from './components';

const UP = new Vector3(0, 1, 0);

export class Rope extends SyncScript.props('Rope', {
  /** 另一头挂在哪个实体上；没有时绳子从这里往下垂。 */
  end: prop.entity().optional(),
  /** 绳长（米）；挂两头时 0 是两头的距离多 5%。 */
  length: prop.number().min(0).default(0).unit('m'),
  /** 分几段：越多越软、越费。 */
  segments: prop.int().min(2).max(256).default(16),
  radius: prop.number().min(0.002).default(0.03).unit('m'),
  /** 每米多重。 */
  massPerMeter: prop.number().min(0.001).default(1).unit('kg/m'),
  /** 绳子的材质；没有时用默认材质。 */
  material: prop.asset('material').optional(),
  /** 碰撞层，0..31。 */
  layer: prop.int().min(0).max(31).default(0),
}) {
  /** 绳子的段（从这一头到另一头），start 以后才有。 */
  readonly pieces: Entity[] = [];
  readonly #anchors: Entity[] = [];

  override start(): void {
    void this.#build().catch((error: unknown) => this.entity.manager.onError(error));
  }

  async #build(): Promise<void> {
    const simulation = this.game.simulation;
    if (!simulation) throw new Error(`Rope on '${this.entity.name}': the game runs without physics (nativeFeatures: [physics])`);
    const manager = this.entity.manager;
    const from = worldPosition(this.entity);
    const endEntity = this.end !== undefined && manager.isAlive(this.end) ? manager.entity(this.end) : undefined;
    const to = endEntity ? worldPosition(endEntity) : new Vector3(from.x, from.y - this.length, from.z);
    const span = distance(from, to);
    const length = endEntity ? Math.max(this.length > 0 ? this.length : span * 1.05, span) : this.length;
    if (!(length > 0)) throw new Error(`Rope on '${this.entity.name}': give it a length or an end entity`);
    const count = this.segments + (endEntity ? this.segments % 2 : 0);
    const piece = length / count;
    const points = ropePoints(from, to, length, count, endEntity !== undefined);

    // 胶囊两头留一点空，相邻的段在接头处不顶在一起（拉直时）
    const capsule = Math.max(0.001, piece - 3 * this.radius);
    const model = await this.game.content.createProceduralModel({ type: 'capsule', length: capsule, radius: this.radius }, [null], `${this.entity.name} rope`);
    if (!this.attached) return;
    const collider = new Collider([{ type: 'capsule', radius: this.radius, length: capsule, mass: this.massPerMeter * piece }]).id;
    for (let i = 0; i < count; i++) {
      const a = points[i]!, b = points[i + 1]!;
      const direction = b.clone().subtract(a).normalize();
      const segment = manager.create({
        name: `${this.entity.name} rope ${i}`,
        scene: this.entity.scene,
        components: [Transform.with({ position: lerp(a, b, 0.5), rotation: fromUp(direction) }), Body.with({ collider, layer: this.layer })],
      });
      this.game.content.addModel(segment, model, { materials: [this.material ?? null] });
      this.pieces.push(segment);
    }
    for (let i = 0; i + 1 < count; i++) {
      simulation.addConstraint({ type: 'ballSocket', bodyA: this.pieces[i]!, bodyB: this.pieces[i + 1]!, localOffsetA: [0, piece / 2, 0], localOffsetB: [0, -piece / 2, 0] });
    }
    const start = this.#anchor(this.entity);
    simulation.addConstraint({ type: 'ballSocket', bodyA: start, bodyB: this.pieces[0]!, localOffsetB: [0, -piece / 2, 0] });
    // 长程的拉住（long-range attachment）：每段的远端离起点的锚不超过沿绳子量的长度。链子一长、吊的东西比段重得多时求解器
    // 拉不住，绳子会被拉长（8 段吊 12 倍重的东西，3.2 米的绳子拉到 3.7 米）；有了它绳子不伸长
    this.pieces.forEach((segment, i) => {
      simulation.addConstraint({ type: 'distanceLimit', bodyA: start, bodyB: segment, localOffsetB: [0, piece / 2, 0], minimumDistance: 0, maximumDistance: piece * (i + 1), springFrequency: 0 });
    });
    if (endEntity) {
      const end = this.#anchor(endEntity);
      simulation.addConstraint({ type: 'ballSocket', bodyA: end, bodyB: this.pieces[count - 1]!, localOffsetB: [0, piece / 2, 0] });
      simulation.addConstraint({ type: 'distanceLimit', bodyA: start, bodyB: end, minimumDistance: 0, maximumDistance: length, springFrequency: 0 });
    }
  }

  override cancel(): void {
    for (const entity of [...this.pieces, ...this.#anchors]) if (entity.alive) entity.destroy();
    this.pieces.length = 0;
    this.#anchors.length = 0;
  }

  /** 绳子连在 entity 的哪个物体上：它有动态 Body 时是它自己，否则是挂在它下面、跟着它走的运动学小物体（不碰东西）。 */
  #anchor(entity: Entity): Entity {
    if (entity.get(Body)) return entity;
    const anchor = this.entity.manager.create({
      name: `${entity.name} rope anchor`,
      components: [Transform, Body.with({ collider: new Collider([{ type: 'sphere', radius: this.radius }]).id, kinematic: true, trigger: true, layer: this.layer })],
    });
    anchor.require(Transform).parent = entity;
    this.#anchors.push(anchor);
    return anchor;
  }
}

function worldPosition(entity: Entity): Vector3 {
  const world = entity.require(Transform).world;
  return new Vector3(world[12]!, world[13]!, world[14]!);
}

/**
 * 绳子开始时的折线（count + 1 个点，每段一样长）：挂两头时是 V 形——中点往下垂到两半各长 length / 2；只挂一头时直直往下。
 */
export function ropePoints(from: Vector3, to: Vector3, length: number, count: number, hung: boolean): Vector3[] {
  if (!hung) return Array.from({ length: count + 1 }, (_, i) => lerp(from, to, i / count));
  const span = distance(from, to);
  const sag = Math.sqrt(Math.max(0, (length / 2) ** 2 - (span / 2) ** 2));
  const middle = lerp(from, to, 0.5);
  middle.y -= sag;
  const half = count / 2;
  return Array.from({ length: count + 1 }, (_, i) => (i <= half ? lerp(from, middle, i / half) : lerp(middle, to, (i - half) / half)));
}

const lerp = (a: Vector3, b: Vector3, t: number) => new Vector3(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t);
const distance = (a: Vector3, b: Vector3) => Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);

/** 把本地 +Y 转到 direction（单位向量）的旋转。 */
function fromUp(direction: Vector3): Quaternion {
  const cosine = Math.min(1, Math.max(-1, direction.y));
  const axis = UP.clone().cross(direction);
  if (axis.length() < 1e-6) return cosine > 0 ? new Quaternion() : new Quaternion().setAxisAngle({ x: 1, y: 0, z: 0 }, Math.PI);
  return new Quaternion().setAxisAngle(axis.normalize(), Math.acos(cosine));
}
