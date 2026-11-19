/**
 * 编辑器视口的相机：绕着一个注视点转（环绕）、平移、推拉，或者原地转头加 WASD 飞行，F 把选中的东西放到画面中间。
 * 操作照 Stride Game Studio 和常见的 DCC 工具：
 * - 按住右键拖：转头（眼睛不动）；这时 W/S/A/D 前后左右飞，Q/E 下降上升，Shift 加速；
 * - 按住中键拖：平移（注视点跟着走）；
 * - Alt 加左键拖：绕注视点转；
 * - 滚轮：推拉（离注视点越近每格走得越少，永远到不了注视点上）。
 *
 * EditorCameraState 只有状态和算术（注视点、偏航、俯仰、距离），可以单测、也可以不经输入直接驱动（聚焦、动画）；
 * EditorCameraController 是挂在相机实体上的脚本，每帧读输入、改状态、写回 Transform。
 */
import { prop } from '../data/prop';
import { SyncScript } from '../engine/scripts';
import { Transform } from '../engine/transform';
import type { GameTime } from '../games/GameTime';
import { Camera } from '../rendering/components';
import { Quaternion, Vector3, type Vec3Like } from '../mathematics/vectors';

/** 俯仰不到正上、正下：留一点，朝向才不会翻过去。 */
const MAX_PITCH = Math.PI / 2 - 0.001;

export class EditorCameraState {
  /** 注视点：环绕的中心。 */
  readonly target = new Vector3();
  /** 偏航（绕世界 Y，弧度）：0 时看向 -Z，正的往左转。 */
  yaw = 0;
  /** 俯仰（弧度）：正的往上看。 */
  pitch = 0;
  /** 眼睛到注视点的距离。 */
  distance = 10;
  /** 距离的下限：推拉不会穿过注视点。 */
  minDistance = 0.01;

  /** 相机的朝向（看向本地 -Z）。 */
  get rotation(): Quaternion {
    return new Quaternion().setYawPitchRoll(this.yaw, this.pitch, 0);
  }

  /** 看的方向（单位向量）。 */
  get forward(): Vector3 {
    return new Vector3(0, 0, -1).rotate(this.rotation);
  }

  /** 眼睛的位置：从注视点沿看的方向退 distance。 */
  get position(): Vector3 {
    return this.target.clone().addScaled(this.forward, -this.distance);
  }

  /** 绕注视点转：注视点和距离不变，眼睛在球面上走。 */
  orbit(deltaYaw: number, deltaPitch: number): void {
    this.yaw += deltaYaw;
    this.pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, this.pitch + deltaPitch));
  }

  /** 原地转头：眼睛不动，注视点跟着朝向转。 */
  look(deltaYaw: number, deltaPitch: number): void {
    const eye = this.position;
    this.orbit(deltaYaw, deltaPitch);
    this.target.copy(eye).addScaled(this.forward, this.distance);
  }

  /** 沿相机的右、上方向平移（世界单位），注视点一起走。 */
  pan(right: number, up: number): void {
    const rotation = this.rotation;
    this.target.addScaled(new Vector3(1, 0, 0).rotate(rotation), right).addScaled(new Vector3(0, 1, 0).rotate(rotation), up);
  }

  /** 沿相机的右、上、前方向飞（世界单位）：眼睛和注视点一起走。 */
  fly(right: number, up: number, forward: number): void {
    this.pan(right, up);
    this.target.addScaled(this.forward, forward);
  }

  /** 推拉：steps 是滚轮的格数，往前滚（正的）拉近。每格把距离乘一个固定的比例，所以离得越近走得越慢。 */
  dolly(steps: number, ratio = 0.85): void {
    this.distance = Math.max(this.minDistance, this.distance * ratio ** steps);
  }

  /** 把一个球（中心、半径）放到画面中间、正好装下：朝向不变，退到竖直视场角 fovY（弧度）看得全的距离。 */
  focus(center: Readonly<Vec3Like>, radius: number, fovY: number): void {
    this.target.copy(center);
    this.distance = Math.max(this.minDistance, Math.max(radius, 1e-3) / Math.sin(Math.min(fovY, Math.PI - 0.01) / 2));
  }

  /** 从眼睛的位置和朝向设状态（接手一台已经摆好的相机）：注视点在正前方 distance 处。 */
  setFromPose(position: Readonly<Vec3Like>, forward: Readonly<Vec3Like>, distance = this.distance): void {
    const f = new Vector3().copy(forward).normalize();
    this.pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, Math.asin(Math.max(-1, Math.min(1, f.y)))));
    // 0 偏航看向 -Z，正的往左（+X 的反方向）
    this.yaw = Math.atan2(-f.x, -f.z);
    this.distance = distance;
    this.target.copy(position).addScaled(this.forward, distance);
  }
}

export class EditorCameraController extends SyncScript.props({
  /** 拖一个画布高度转多少弧度。 */
  rotateSpeed: prop.number().default(Math.PI),
  /** 飞行的速度（每秒，世界单位）；按住 Shift 乘 boost。 */
  flySpeed: prop.number().default(5),
  boost: prop.number().default(4),
}) {
  static override scriptName = 'EditorCameraController';

  readonly state = new EditorCameraState();

  override start(): void {
    // 接手相机现在的位姿（刚建的实体世界矩阵还没算过：先算）
    const transform = this.entity.require(Transform);
    transform.updateWorldMatrix();
    const world = transform.world;
    this.state.setFromPose({ x: world[12]!, y: world[13]!, z: world[14]! }, { x: -world[8]!, y: -world[9]!, z: -world[10]! });
  }

  override update(time: GameTime): void {
    const input = this.game.input, state = this.state;
    const canvas = this.game.graphicsDevice.canvas;
    const aspect = (canvas.clientWidth || 1) / (canvas.clientHeight || 1);
    // mouseDelta 按画布的宽、高各自归一：换成"画布高度"的倍数
    const dx = input.mouseDelta[0] * aspect, dy = input.mouseDelta[1];
    const alt = input.isKeyDown('AltLeft') || input.isKeyDown('AltRight');
    if (input.isMouseButtonDown('right')) {
      state.look(-dx * this.rotateSpeed, -dy * this.rotateSpeed);
      const speed = this.flySpeed * (input.isKeyDown('ShiftLeft') || input.isKeyDown('ShiftRight') ? this.boost : 1) * time.elapsed;
      const axis = (positive: string, negative: string) => (input.isKeyDown(positive) ? 1 : 0) - (input.isKeyDown(negative) ? 1 : 0);
      state.fly(axis('KeyD', 'KeyA') * speed, axis('KeyE', 'KeyQ') * speed, axis('KeyW', 'KeyS') * speed);
    } else if (input.isMouseButtonDown('middle')) {
      // 拖多少画面就挪多少
      const height = this.#viewHeight();
      state.pan(-dx * height, dy * height);
    } else if (alt && input.isMouseButtonDown('left')) {
      state.orbit(-dx * this.rotateSpeed, -dy * this.rotateSpeed);
    }
    if (input.mouseWheelDelta !== 0) this.#zoom(input.mouseWheelDelta);
    this.apply();
  }

  /** 实体上的相机组件；没有时按默认的（45 度的透视）算。 */
  get #fovY(): number {
    return (this.entity.get(Camera)?.verticalFieldOfView ?? 45) * Math.PI / 180;
  }

  /** 注视点那个深度上，一个画布高度是多少世界单位。 */
  #viewHeight(): number {
    const camera = this.entity.get(Camera);
    return camera?.projection === 'orthographic' ? camera.orthographicSize : 2 * this.state.distance * Math.tan(this.#fovY / 2);
  }

  /** 推拉；正交相机离得远近画面一样大，改的是看到的高度。 */
  #zoom(steps: number): void {
    const before = this.state.distance;
    this.state.dolly(steps);
    const camera = this.entity.get(Camera);
    if (camera?.projection === 'orthographic') camera.orthographicSize *= this.state.distance / before;
  }

  /** 把状态写到相机实体的 Transform 上（相机没有父实体，或者父实体没有变换时才对）。 */
  apply(): void {
    const transform = this.entity.require(Transform);
    const { x, y, z } = this.state.position, rotation = this.state.rotation;
    Object.assign(transform.position, { x, y, z });
    Object.assign(transform.rotation, { x: rotation.x, y: rotation.y, z: rotation.z, w: rotation.w });
  }

  /** 把一个球放到画面中间、正好装下（F 键聚焦选中的东西）。 */
  focus(center: Readonly<Vec3Like>, radius: number): void {
    this.state.focus(center, radius, this.#fovY);
    const camera = this.entity.get(Camera);
    if (camera?.projection === 'orthographic') camera.orthographicSize = 2 * Math.max(radius, 1e-3);
    this.apply();
  }
}
