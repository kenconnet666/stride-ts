// BepuSample 的 FindAndAttachCameraComponent：子场景里没有相机，让主场景的相机每帧快速追到这个实体的世界位姿。
// Stride 的 CameraComponent 属性在样例的场景里都没设，这里不声明，总是去找。
import { Camera, Matrix, Quaternion, SyncScript, Transform, Vector3, type GameTime, type TransformView } from '@stride-ts/engine';

export class FindAndAttachCameraComponent extends SyncScript {
  #camera: TransformView | undefined;
  readonly #rotation = new Quaternion();
  readonly #position = new Vector3();

  override start(): void {
    // Stride 在场景实例的所有实体（含子实体）里找第一个相机
    const owner = this.game.entities.ids().map((id) => this.game.entities.entity(id)).find((e) => e.has(Camera));
    this.#camera = owner?.require(Transform);
  }

  override update(time: GameTime): void {
    const camera = this.#camera;
    if (!camera) return;
    const lerp = 1 - Math.exp(-100 * time.elapsed);
    const { translation, rotation } = Matrix.decompose(this.entity.require(Transform).world);
    camera.position = this.#position.copy(camera.position).lerp({ x: translation[0], y: translation[1], z: translation[2] }, lerp);
    camera.rotation = this.#rotation.copy(camera.rotation).slerp({ x: rotation[0], y: rotation[1], z: rotation[2], w: rotation[3] }, lerp);
  }
}
