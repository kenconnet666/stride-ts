// Third Person Platformer 的 PlayerInput：把键盘、鼠标、手柄的输入换成三个事件——世界空间的移动方向（按相机的朝向）、
// 屏幕空间的镜头转动量、起跳。属性的默认值是 TPP 场景里的值。
import { EventKey, GamePadButton, prop, SyncScript, Transform, Vector3, type GameTime, type InputManager } from '@stride-ts/engine';

/** 世界空间的移动方向，长度 0..1（摇杆的推动程度）。 */
export const MoveDirectionEventKey = new EventKey<Vector3>();
/** 镜头转动量：x 水平、y 竖直，鼠标是归一化的移动量，摇杆已经乘过这一帧的时间。 */
export const CameraDirectionEventKey = new EventKey<readonly [number, number]>();
export const JumpEventKey = new EventKey<boolean>();

const UP = new Vector3(0, 1, 0);

export class PlayerInput extends SyncScript.props({
  deadZone: prop.number().default(0.25),
  /** 决定"前"是哪个方向的相机实体；没有时移动方向就是世界的 X、Z。 */
  camera: prop.entity().optional(),
  mouseSensitivity: prop.number().default(1),
}) {
  // Stride 里是可编辑的按键列表；这里是 TPP 场景里的值（KeyboardEvent.code）
  keysLeft = ['KeyA', 'ArrowLeft'];
  keysRight = ['KeyD', 'ArrowRight'];
  keysUp = ['KeyW', 'ArrowUp'];
  keysDown = ['KeyS', 'ArrowDown'];
  keysJump = ['Space'];
  #jumpButtonDown = false;

  override update(time: GameTime): void {
    const input = this.game.input;

    // 移动：按相机的朝向换到世界空间
    const move = thumbAny(input, 'leftThumb', this.deadZone);
    if (this.keysLeft.some((key) => input.isKeyDown(key))) move[0] -= 1;
    if (this.keysRight.some((key) => input.isKeyDown(key))) move[0] += 1;
    if (this.keysUp.some((key) => input.isKeyDown(key))) move[1] += 1;
    if (this.keysDown.some((key) => input.isKeyDown(key))) move[1] -= 1;
    const world = this.camera !== undefined ? this.#logicToWorld(move[0], move[1]) : new Vector3(move[0], 0, move[1]);
    let length = Math.hypot(move[0], move[1]);
    if (length < this.deadZone) {
      world.set(0, 0, 0);
    } else {
      length = length > 1 ? 1 : (length - this.deadZone) / (1 - this.deadZone);
      world.scale(length);
    }
    MoveDirectionEventKey.broadcast(world);

    // 镜头：右摇杆（乘这一帧的时间），锁定鼠标后加上鼠标的移动量；点画布锁定，Esc 解锁
    const camera = thumbAny(input, 'rightThumb', this.deadZone);
    const cameraLength = Math.hypot(camera[0], camera[1]);
    // 摇杆只取方向，转动速度按这一帧的时间算（鼠标的移动量本身就和时间有关）
    const stick = cameraLength < this.deadZone ? 0 : time.elapsed / cameraLength;
    camera[0] *= stick;
    camera[1] *= stick;
    if (input.isMouseButtonDown('left')) input.lockMousePosition();
    if (input.isKeyPressed('Escape')) input.unlockMousePosition();
    if (input.isMousePositionLocked) {
      camera[0] += input.mouseDelta[0] * this.mouseSensitivity;
      camera[1] -= input.mouseDelta[1] * this.mouseSensitivity;
    }
    CameraDirectionEventKey.broadcast(camera);

    // 起跳：手柄 A 刚按下，或者跳跃键刚按下
    const jumpDown = input.isGamePadButtonDownAny(GamePadButton.a);
    let didJump = !this.#jumpButtonDown && jumpDown;
    this.#jumpButtonDown = jumpDown;
    didJump ||= this.keysJump.some((key) => input.isKeyPressed(key));
    JumpEventKey.broadcast(didJump);
  }

  /** TPP 的 Utils.LogicDirectionToWorldDirection：前 = up × 相机的右方，右 = 前 × up，结果归一化。 */
  #logicToWorld(x: number, y: number): Vector3 {
    const world = this.game.entities.entity(this.camera!).require(Transform).world;
    const right = new Vector3(world[0], world[1], world[2]);
    const forward = new Vector3().copy(UP).cross(right).normalize();
    const side = new Vector3().copy(forward).cross(UP);
    return forward.scale(y).addScaled(side, x).normalize();
  }
}

/** TPP 的 GetLeftThumbAny / GetRightThumbAny：超过死区的摇杆取平均。 */
function thumbAny(input: InputManager, thumb: 'leftThumb' | 'rightThumb', deadZone: number): [number, number] {
  let count = 0, x = 0, y = 0;
  for (const pad of input.gamePads) {
    const [px, py] = pad[thumb];
    if (Math.hypot(px, py) < deadZone) continue;
    count++;
    x += px;
    y += py;
  }
  return count > 1 ? [x / count, y / count] : [x, y];
}
