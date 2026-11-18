// FirstPersonShooter 的 FpsCamera：按 PlayerInput 广播的转动量改偏航和俯仰（俯仰限制在 ±90°），直接设相机实体的旋转。
import { AsyncScript, Camera, prop, Quaternion, Transform } from '@stride-ts/engine';
import { CameraDirectionEventKey } from './player/PlayerInput';

export class FpsCamera extends AsyncScript.props({
  rotationSpeed: prop.number().default(2.355),
  invertX: prop.bool().default(false),
  invertY: prop.bool().default(false),
}) {
  #yaw = 0;
  #pitch = 0;
  readonly #cameraDirectionEvents = this.receive(CameraDirectionEventKey);

  override async execute(): Promise<void> {
    this.reset();
    for (;;) {
      this.#updateCamera();
      await this.nextFrame();
    }
  }

  /** 偏航和俯仰从实体现在的旋转算出来（同 Stride 的公式）。 */
  reset(): void {
    const { x, y, z, w } = this.entity.require(Transform).rotation;
    this.#yaw = Math.asin(2 * x * y + 2 * z * w);
    this.#pitch = Math.atan2(2 * x * w - 2 * y * z, 1 - 2 * x * x - 2 * z * z);
  }

  #updateCamera(): void {
    let [dx, dy] = this.#cameraDirectionEvents.drain().at(-1) ?? [0, 0];
    if (this.invertY) dy = -dy;
    if (this.invertX) dx = -dx;
    this.#yaw -= dx * this.rotationSpeed;
    this.#pitch = Math.min(Math.PI / 2, Math.max(-Math.PI / 2, this.#pitch + dy * this.rotationSpeed));
    if (!this.entity.get(Camera)) return;
    const rotation = new Quaternion().setYawPitchRoll(this.#yaw, this.#pitch, 0);
    const transform = this.entity.require(Transform).rotation;
    [transform.x, transform.y, transform.z, transform.w] = [rotation.x, rotation.y, rotation.z, rotation.w];
  }
}
