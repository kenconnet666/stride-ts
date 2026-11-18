// BepuSample 的 BasicCameraControllerComponent（Stride 模板里的 BasicCameraController）：W、S（或 Z）前后，A（或 Q）、D 左右，
// 左 Ctrl、左 Alt 下上，Shift 加速；按住鼠标右键转视角（锁住指针）；Gamepad 打开时也用手柄的两个摇杆和扳机。
// 俯仰限制在 ±0.99·90°，水平绕世界的上方向转。还没有的：触摸手势（Stride 在非桌面平台上用拖动和缩放）。
import { GamePadButton, prop, Quaternion, SyncScript, Transform, Vector3, type GameTime } from '@stride-ts/engine';

const MAXIMUM_PITCH = (Math.PI / 2) * 0.99;
const UP = { x: 0, y: 1, z: 0 } as const;

export class BasicCameraControllerComponent extends SyncScript.props({
  gamepad: prop.bool().default(false),
  keyboardMovementSpeed: prop.vec3().default([10, 10, 10]),
  speedFactor: prop.number().default(5),
  keyboardRotationSpeed: prop.list(prop.number()).default([5, 5]),
  mouseRotationSpeed: prop.list(prop.number()).default([1, 1]),
  /** 触摸手势用（还没做手势，见文件开头）。 */
  touchMovementSpeed: prop.vec3().default([0.7, 0.7, 0.3]),
  touchRotationSpeed: prop.list(prop.number()).default([1, 0.7]),
}) {
  readonly #translation = new Vector3();
  #yaw = 0;
  #pitch = 0;

  override update(time: GameTime): void {
    this.#processInput(time.elapsed);
    this.#updateTransform();
  }

  #processInput(deltaTime: number): void {
    const input = this.game.input;
    this.#translation.set(0, 0, 0);
    this.#yaw = 0;
    this.#pitch = 0;

    // 键盘和手柄移动：一秒一个单位，再乘速度
    let speed = deltaTime;
    const dir = new Vector3();
    const pad = this.gamepad ? input.gamePads[0] : undefined;
    if (pad) {
      dir.z += pad.leftThumb[1];
      dir.x += pad.leftThumb[0];
      dir.y += pad.rightTrigger - pad.leftTrigger;
      if ((pad.buttons & (GamePadButton.a | GamePadButton.leftShoulder | GamePadButton.rightShoulder)) !== 0) speed *= this.speedFactor;
    }
    if (input.isKeyDown('W') || input.isKeyDown('Z')) dir.z += 1;
    if (input.isKeyDown('S')) dir.z -= 1;
    if (input.isKeyDown('A') || input.isKeyDown('Q')) dir.x -= 1;
    if (input.isKeyDown('D')) dir.x += 1;
    if (input.isKeyDown('LeftCtrl')) dir.y -= 1;
    if (input.isKeyDown('LeftAlt')) dir.y += 1;
    if (input.isKeyDown('LeftShift') || input.isKeyDown('RightShift')) speed *= this.speedFactor;
    if (dir.length() > 1) dir.normalize();
    const move = this.keyboardMovementSpeed;
    this.#translation.set(dir.x * move.x * speed, dir.y * move.y * speed, dir.z * move.z * speed);

    // 手柄转动
    if (pad) {
      this.#pitch += pad.rightThumb[1] * this.keyboardRotationSpeed[0]! * deltaTime;
      this.#yaw += -pad.rightThumb[0] * this.keyboardRotationSpeed[1]! * deltaTime;
    }

    // 鼠标：移动量本来就和帧率无关，不乘 deltaTime
    if (input.isMouseButtonDown('right')) {
      input.lockMousePosition();
      this.#yaw -= input.mouseDelta[0] * this.mouseRotationSpeed[0]!;
      this.#pitch -= input.mouseDelta[1] * this.mouseRotationSpeed[1]!;
    } else if (input.isMousePositionLocked) {
      input.unlockMousePosition();
    }
  }

  #updateTransform(): void {
    const transform = this.entity.require(Transform);
    const rotation = new Quaternion().copy(transform.rotation);
    // 本地坐标系；右方向按世界的上方向重新算（不让相机侧倾）
    const forward = new Vector3(0, 0, -1).rotate(rotation);
    const right = forward.clone().cross(UP).normalize();
    // 俯仰不超过朝上、朝下
    const currentPitch = Math.PI / 2 - Math.acos(Math.min(1, Math.max(-1, forward.dot(UP))));
    const pitch = Math.min(Math.max(currentPitch + this.#pitch, -MAXIMUM_PITCH), MAXIMUM_PITCH) - currentPitch;
    // 在本地坐标里移动（-Z 是前）
    const move = new Vector3(this.#translation.x, this.#translation.y, -this.#translation.z).rotate(rotation);
    transform.position = new Vector3().copy(transform.position).add(move);
    // Stride 的 Rotation *= RotationAxis(right, pitch) * RotationAxis(up, yaw)：先原来的旋转，再绕右方向俯仰，再绕世界上方向水平转
    const pitchRotation = new Quaternion().setAxisAngle(right, pitch);
    const yawRotation = new Quaternion().setAxisAngle(UP, this.#yaw);
    transform.rotation = yawRotation.multiply(pitchRotation).multiply(rotation).normalize();
  }
}
