// Third Person Platformer 的 ThirdPersonCamera：挂在相机实体上，相机是目标实体（父实体）的子实体。按输入转动父实体
// （绕 X 是俯仰、绕 Y 是水平），相机沿父实体的 +Z 放在 defaultDistance 处；中间有墙时把相机拉近。属性的默认值是 TPP 场景里的值。
// 和 Stride 不同的两处：
// - 挡相机的检测：Stride 用半径 coneRadius 的球体扫掠，起点就和球重叠的物体算距离 0，角色贴着旁边的箱子时相机会被拉到最近。
//   这里扫掠忽略起点重叠的物体，再沿同一方向打一条射线（防止相机钻进正后方的墙），取两者较近的；
// - 平滑：Stride 每帧向目标靠 25%，帧率越高转得越快；这里按时间换算，60 fps 时和 Stride 一样。
import { prop, SyncScript, Transform, Vector3, type Entity, type GameTime, type QuatLike } from '@stride-ts/engine';
import { CameraDirectionEventKey } from '../player/PlayerInput';

/** 只有默认层（Layer0）的物体挡相机：玩家（Layer2）和柱子（Layer1）不挡。 */
const BLOCKING = 1 << 0;
const DEGREES = Math.PI / 180;
/** Stride 每帧（按 60 fps）向目标靠的比例。 */
const FOLLOW_PER_FRAME = 0.25;

export class ThirdPersonCamera extends SyncScript.props({
  defaultDistance: prop.number().default(6),
  minimumDistance: prop.number().default(0.4),
  /** 扫掠用的球半径；0 时用射线。 */
  coneRadius: prop.number().default(1.25),
  invertX: prop.bool().default(false),
  minVerticalAngle: prop.number().default(-20),
  maxVerticalAngle: prop.number().default(70),
  invertY: prop.bool().default(false),
  /** 度：鼠标横着划过整个画布转多少。 */
  rotationSpeed: prop.number().default(360),
  verticalSpeed: prop.number().default(45),
}) {
  // 欧拉角（度），x 俯仰、y 水平；当前值每帧向目标值靠 25%
  #rotation = new Vector3(-20, 45, 0);
  #target = new Vector3(-20, 45, 0);
  #parent!: Entity;
  readonly #cameraEvents = this.receive(CameraDirectionEventKey);
  readonly #direction = new Vector3();

  override start(): void {
    const parent = this.entity.require(Transform).parent;
    if (!parent) throw new Error('ThirdPersonCamera should be placed as a child entity of its target entity');
    this.#parent = parent;
  }

  override update(time: GameTime): void {
    this.#updateDistance();
    this.#updateOrientation(time);
  }

  /** 从目标沿它的 +Z 找最近的挡住相机的物体，相机放在那里（不小于 minimumDistance）。 */
  #updateDistance(): void {
    const parent = this.#parent.require(Transform);
    const direction = this.#direction.set(0, 0, 1).rotate(parent.rotation);
    const world = parent.world;
    const start = [world[12]!, world[13]!, world[14]!] as const;
    const toward = [direction.x, direction.y, direction.z] as const;
    const simulation = this.game.simulation!;
    let distance = simulation.rayCast(start, toward, this.defaultDistance, { mask: BLOCKING })?.distance ?? this.defaultDistance;
    if (this.coneRadius > 0) {
      const swept = simulation.sphereCast(this.coneRadius, start, toward, this.defaultDistance, { mask: BLOCKING, ignoreInitialOverlap: true });
      if (swept) distance = Math.min(distance, swept.distance);
    }
    distance = Math.max(distance, this.minimumDistance);
    this.entity.require(Transform).position.z = distance;
  }

  #updateOrientation(time: GameTime): void {
    // 这一帧收到的转动量全部加上（帧率高于输入时不积压）
    let x = 0, y = 0;
    for (const [dx, dy] of this.#cameraEvents.drain()) {
      x += dx;
      y += dy;
    }
    if (this.invertY) y = -y;
    this.#target.x = Math.min(Math.max(this.#target.x + y * this.verticalSpeed, -this.maxVerticalAngle), -this.minVerticalAngle);
    if (this.invertX) x = -x;
    this.#target.y -= x * this.rotationSpeed;
    this.#rotation.lerp(this.#target, 1 - (1 - FOLLOW_PER_FRAME) ** (time.elapsed * 60));
    setEulerXY(this.#parent.require(Transform).rotation, this.#rotation.x * DEGREES, this.#rotation.y * DEGREES);
  }
}

/** Stride 的 TransformComponent.RotationEulerXYZ（z 为 0）：先绕 X 再绕 Y。 */
function setEulerXY(rotation: QuatLike, x: number, y: number): void {
  const sx = Math.sin(x / 2), cx = Math.cos(x / 2), sy = Math.sin(y / 2), cy = Math.cos(y / 2);
  rotation.x = sx * cy;
  rotation.y = sy * cx;
  rotation.z = -sx * sy;
  rotation.w = cx * cy;
}
