// ParticlesSample 的 CameraOrbitScript：相机绕原点转，指针拖动给左右、上下的转速，松开后按摩擦慢慢停下（按 1/60 秒一步，同 Stride）。
import { AsyncScript, Quaternion, Transform, Vector3 } from '@stride-ts/engine';

const LOOK_FROM_DISTANCE = 8;
const MINIMUM_HEIGHT = 0;
const MAXIMUM_HEIGHT = 50;
const MAX_SPEED_X = 5;
const MAX_SPEED_Y = 2;
const FRICTION = 0.9;
const FRAME_TIME = 1 / 60;
const DEGREES = Math.PI / 180;
const X_AXIS = new Vector3(1, 0, 0);
const Y_AXIS = new Vector3(0, 1, 0);

export class CameraOrbitScript extends AsyncScript {
  #angle = 90;
  #angleY = 10;
  #timeToProcess = 0;
  #speedX = 0;
  #speedY = 0;
  #touching = false;

  override async execute(): Promise<void> {
    while (this.attached) {
      const input = this.game.input;
      // 同 Stride：Math.Max（不是 Min），时间至少 1 秒，松开时一帧最多补 60 步
      this.#timeToProcess = Math.max(this.#timeToProcess + this.game.updateTime.elapsed, 1);
      const events = input.pointerEvents;
      // Stride 的 Pointer.DownPointers.Any(IsDown)：最后一个事件之后还有没有按着的指针
      if (events.length > 0) this.#touching = events.at(-1)!.isDown;
      if (this.#touching) {
        const dx = events.reduce((sum, event) => sum + event.deltaPosition[0], 0), dy = events.reduce((sum, event) => sum + event.deltaPosition[1], 0);
        this.#speedX = clamp(this.#speedX - MAX_SPEED_X * dx, MAX_SPEED_X);
        this.#speedY = clamp(this.#speedY + MAX_SPEED_Y * dy, MAX_SPEED_Y);
        this.#timeToProcess %= FRAME_TIME;
        this.#updatePosition(this.#speedX * 2, this.#speedY * 2);
      } else {
        while (this.#timeToProcess >= FRAME_TIME) {
          this.#timeToProcess -= FRAME_TIME;
          const previousX = this.#speedX, previousY = this.#speedY;
          this.#speedX *= FRICTION ** FRAME_TIME;
          this.#speedY *= FRICTION ** FRAME_TIME;
          this.#updatePosition(previousX + this.#speedX, previousY + this.#speedY);
        }
      }
      await this.nextFrame();
    }
  }

  #updatePosition(speedX: number, speedY: number): void {
    this.#angle += speedX * 7.5 * FRAME_TIME;
    this.#angleY = Math.min(Math.max(this.#angleY + speedY * 1.5 * FRAME_TIME, MINIMUM_HEIGHT), MAXIMUM_HEIGHT);
    const maxDistance = LOOK_FROM_DISTANCE * (1 + Math.sin(this.#angleY * DEGREES));
    const distance = maxDistance * Math.cos(this.#angleY * DEGREES);
    const transform = this.entity.require(Transform);
    transform.position.x = Math.sin(this.#angle * DEGREES) * distance;
    transform.position.z = Math.cos(this.#angle * DEGREES) * distance;
    transform.position.y = maxDistance * Math.sin(this.#angleY * DEGREES);
    // Stride 的 RotationAxis(X, -俯角) * RotationAxis(Y, 方位角)：先绕 X，再绕 Y
    const pitch = new Quaternion().setAxisAngle(X_AXIS, -this.#angleY * DEGREES);
    const yaw = new Quaternion().setAxisAngle(Y_AXIS, this.#angle * DEGREES);
    const rotation = yaw.multiply(pitch);
    Object.assign(transform.rotation, { x: rotation.x, y: rotation.y, z: rotation.z, w: rotation.w });
  }
}

function clamp(speed: number, max: number): number {
  return Math.abs(speed) > max ? max * Math.sign(speed) : speed;
}
