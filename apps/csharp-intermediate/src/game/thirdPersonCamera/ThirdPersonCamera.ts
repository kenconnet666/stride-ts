// CSharpIntermediate 的 ThirdPersonCamera：鼠标左右转角色，上下转第一人称的支点（子实体 FirstPersonPivot）；相机挂在它下面的
// ThirdPersonPivot 上，平时在支点后面 cameraOffset 处。从第一人称支点往相机打一条射线，中间有东西挡着就把相机拉到挡住的地方前面，
// 近到不足 minimumCameraDistance 时直接退回第一人称的位置。
// 和 Stride 不同：
// - 鼠标的锁定见 utils/mouseLock.ts；
// - 射线只跳过角色自己。Stride 的脚本跳过角色所在的整个碰撞层，而场景里的墙和角色同在 Layer0，相机退到墙边时会穿到墙后面去。
import { prop, Quaternion, SyncScript, Transform, Vector3, type Entity } from '@stride-ts/engine';
import { updateMouseLock } from '../utils/mouseLock';

const AXIS_X = { x: 1, y: 0, z: 0 }, AXIS_Y = { x: 0, y: 1, z: 0 };
const RADIANS = Math.PI / 180;
/** 相机离挡住它的表面留的距离。 */
const HIT_MARGIN = 0.1;

export class ThirdPersonCamera extends SyncScript.props({
  invertMouseY: prop.bool().default(false),
  /** 左右、上下的鼠标速度。 */
  mouseSpeed: prop.list(prop.number()).default([0.6, 0.5]),
  maxLookUpAngle: prop.f32().default(-40),
  maxLookDownAngle: prop.f32().default(40),
  minimumCameraDistance: prop.f32().default(1.5),
  cameraOffset: prop.vec3().default([0, 0, -3]),
}) {
  #firstPersonPivot!: Entity;
  #thirdPersonPivot!: Entity;
  #rotation = new Vector3();

  override start(): void {
    this.#firstPersonPivot = this.#child(this.entity, 'FirstPersonPivot');
    this.#thirdPersonPivot = this.#child(this.#firstPersonPivot, 'ThirdPersonPivot');
    this.#rotation = new Quaternion().copy(this.entity.require(Transform).rotation).toEulerXYZ();
  }

  override update(): void {
    if (!updateMouseLock(this.game)) return;
    const [dx, dy] = this.game.input.mouseDelta;
    this.#rotation.y -= dx * this.mouseSpeed[0]!;
    this.#rotation.x += (this.invertMouseY ? -dy : dy) * this.mouseSpeed[1]!;
    this.#rotation.x = Math.min(Math.max(this.#rotation.x, this.maxLookUpAngle * RADIANS), this.maxLookDownAngle * RADIANS);

    const simulation = this.game.simulation!;
    simulation.body(this.entity).setOrientation(new Quaternion().setAxisAngle(AXIS_Y, this.#rotation.y));
    const firstPerson = this.#firstPersonPivot.require(Transform), thirdPerson = this.#thirdPersonPivot.require(Transform);
    firstPerson.rotation = new Quaternion().setAxisAngle(AXIS_X, this.#rotation.x);

    // 先把相机放到不被挡时的位置，算出它的世界位置（世界矩阵平时在这一帧的 update 之后才算）
    thirdPerson.position = this.cameraOffset;
    thirdPerson.updateWorldMatrix();
    const start = firstPerson.world.subarray(12, 15), end = thirdPerson.world.subarray(12, 15);
    const direction = new Vector3(end[0]! - start[0]!, end[1]! - start[1]!, end[2]! - start[2]!);
    const distance = direction.length();
    if (distance === 0) return;

    // 射线从角色体内出发：用穿透的射线，取第一个不是角色自己的命中
    const hits = simulation.rayCastPenetrating([start[0]!, start[1]!, start[2]!], [direction.x / distance, direction.y / distance, direction.z / distance], distance);
    const hit = hits.find(({ entity }) => entity !== this.entity.id);
    if (!hit) return;
    if (hit.distance >= this.minimumCameraDistance) thirdPerson.position.z = -(hit.distance - HIT_MARGIN);
    else thirdPerson.position = { x: 0, y: 0, z: 0 };
  }

  override cancel(): void {
    this.game.input.unlockMousePosition();
  }

  #child(parent: Entity, name: string): Entity {
    const child = parent.findChild(name);
    if (!child) throw new Error(`ThirdPersonCamera: '${parent.name}' needs a child entity named '${name}'`);
    return child;
  }
}
