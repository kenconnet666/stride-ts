// FirstPersonShooter 的 PlayerInput：把键盘、鼠标、手柄的输入换成四个事件——世界空间的移动方向（按相机的朝向）、镜头转动量、
// 开枪、换弹。点画面锁定鼠标（同时也开枪，同 Stride），Esc 解锁。
// 和 Stride 不同：Stride 的 Priority = -1000 让它在别的脚本之前跑；我们的脚本按挂上的顺序跑，收事件的脚本晚一帧拿到，
// 每帧一个值，效果一样。
import { EventKey, GamePadButton, prop, SyncScript, Transform, Vector3, type GameTime } from '@stride-ts/engine';

/** 世界空间的移动方向，单位长度或 0。 */
export const MoveDirectionEventKey = new EventKey<Vector3>();
/** 镜头转动量：x 水平、y 竖直，鼠标是归一化的移动量乘灵敏度，摇杆已经乘过这一帧的时间。 */
export const CameraDirectionEventKey = new EventKey<readonly [number, number]>();
export const ShootEventKey = new EventKey<boolean>();
export const ReloadEventKey = new EventKey<boolean>();

const UP = new Vector3(0, 1, 0);

export class PlayerInput extends SyncScript.props({
  deadZone: prop.number().default(0.25),
  /** 决定"前"是哪个方向的相机实体；没有时移动方向就是世界的 X、Z。 */
  camera: prop.entity().optional(),
  mouseSensitivity: prop.number().default(100),
  // 按键：KeyboardEvent.code 或 Stride 的 Keys 名字（场景里存的是后者）
  keysLeft: prop.list(prop.string()),
  keysRight: prop.list(prop.string()),
  keysUp: prop.list(prop.string()),
  keysDown: prop.list(prop.string()),
  keysReload: prop.list(prop.string()),
}) {
  override update(time: GameTime): void {
    const input = this.game.input;
    const anyDown = (keys: readonly string[]) => keys.some((key) => input.isKeyDown(key));

    const move = input.thumbAny('leftThumb', this.deadZone);
    normalizeOutsideDeadZone(move, this.deadZone);
    if (anyDown(this.keysLeft)) move[0] -= 1;
    if (anyDown(this.keysRight)) move[0] += 1;
    if (anyDown(this.keysUp)) move[1] += 1;
    if (anyDown(this.keysDown)) move[1] -= 1;
    MoveDirectionEventKey.broadcast(this.camera !== undefined ? this.#logicToWorld(move[0], move[1]) : new Vector3(move[0], 0, move[1]));

    const camera = input.thumbAny('rightThumb', this.deadZone);
    normalizeOutsideDeadZone(camera, this.deadZone);
    camera[0] *= time.elapsed;
    camera[1] *= time.elapsed;
    if (input.isMouseButtonDown('left')) input.lockMousePosition();
    if (input.isKeyPressed('Escape')) input.unlockMousePosition();
    if (input.isMousePositionLocked) {
      camera[0] += input.mouseDelta[0] * this.mouseSensitivity;
      camera[1] -= input.mouseDelta[1] * this.mouseSensitivity;
    }
    CameraDirectionEventKey.broadcast(camera);

    // 扳机、点击和按着鼠标左键都算开枪（按着能连射）
    const didShoot = input.triggerAny('rightTrigger', 0.2) > 0.2 || input.pointerEvents.some((event) => event.eventType === 'pressed') || input.isMouseButtonDown('left');
    ShootEventKey.broadcast(didShoot);
    ReloadEventKey.broadcast(input.isGamePadButtonDownAny(GamePadButton.x) || anyDown(this.keysReload));
  }

  /** Stride 模板的 Utils.LogicDirectionToWorldDirection：前 = up × 相机的右方，右 = 前 × up，结果归一化。 */
  #logicToWorld(x: number, y: number): Vector3 {
    const world = this.game.entities.entity(this.camera!).require(Transform).world;
    const right = new Vector3(world[0], world[1], world[2]);
    const forward = new Vector3().copy(UP).cross(right).normalize();
    const side = new Vector3().copy(forward).cross(UP);
    return forward.scale(y).addScaled(side, x).normalize();
  }
}

/** 死区里的摇杆值清零，外面的只取方向。 */
function normalizeOutsideDeadZone(value: [number, number], deadZone: number): void {
  const length = Math.hypot(value[0], value[1]);
  const scale = length < deadZone ? 0 : 1 / length;
  value[0] *= scale;
  value[1] *= scale;
}
