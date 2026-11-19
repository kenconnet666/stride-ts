// CSharpIntermediate 的 FirstPersonCamera：鼠标左右转角色（物理的朝向），上下转相机的支点（子实体 CameraPivot），
// 抬头低头各有上限。
// 和 Stride 不同：浏览器里锁鼠标要用户先点一下画布，Esc 由浏览器解锁；所以是"点左键锁定、锁着时才转视角"，
// 不是一启动就锁、Esc 来回切换。
import { prop, Quaternion, SyncScript, Transform, Vector3, type Entity } from '@stride-ts/engine';
import { updateMouseLock } from '../utils/mouseLock';

const AXIS_X = { x: 1, y: 0, z: 0 }, AXIS_Y = { x: 0, y: 1, z: 0 };
const RADIANS = Math.PI / 180;

export class FirstPersonCamera extends SyncScript.props({
  mouseSpeed: prop.f32().default(0.6),
  maxLookUpAngle: prop.f32().default(-50),
  maxLookDownAngle: prop.f32().default(50),
  invertMouseY: prop.bool().default(false),
}) {
  #pivot!: Entity;
  #rotation = new Vector3();

  override start(): void {
    const pivot = this.entity.findChild('CameraPivot');
    if (!pivot) throw new Error(`FirstPersonCamera: '${this.entity.name}' needs a child entity named 'CameraPivot'`);
    this.#pivot = pivot;
    // 从角色现在的朝向接着转
    this.#rotation = new Quaternion().copy(this.entity.require(Transform).rotation).toEulerXYZ();
  }

  override update(): void {
    if (!updateMouseLock(this.game)) return;
    const [dx, dy] = this.game.input.mouseDelta;
    this.#rotation.y -= dx * this.mouseSpeed;
    this.#rotation.x += (this.invertMouseY ? -dy : dy) * this.mouseSpeed;
    this.#rotation.x = Math.min(Math.max(this.#rotation.x, this.maxLookUpAngle * RADIANS), this.maxLookDownAngle * RADIANS);

    // 绕 Y 的转动给角色：只改物理物体的朝向，位置的插值不受影响
    this.game.simulation!.body(this.entity).setOrientation(new Quaternion().setAxisAngle(AXIS_Y, this.#rotation.y));
    // 绕 X 的转动给相机的支点
    this.#pivot.require(Transform).rotation = new Quaternion().setAxisAngle(AXIS_X, this.#rotation.x);
  }

  override cancel(): void {
    this.game.input.unlockMousePosition();
  }
}
