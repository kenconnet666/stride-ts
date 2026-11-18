// BepuSample 的 GravityGunComponent：按住鼠标左键时从相机正前方打一条 25 米的射线，打中刚体就用单体线性伺服把抓住的点
// 拉到相机前方同样的距离、单体角度伺服让它保持抓住时相对相机的朝向；滚轮调距离，K 把它沿视线扔出去，松开左键放下。
import { Body, Matrix, prop, Quaternion, SyncScript, Transform, Vector3, type Constraint, type ConstraintSettingsOf, type EntityId, type SimulationHit } from '@stride-ts/engine';

/** Stride 的 ServoSettings：最大力 1000（最大速度、基础速度 Jolt 的马达用不上）。 */
const SERVO_MAXIMUM_FORCE = 1000;
const REACH = 25;

export class GravityGunComponent extends SyncScript.props({
  cameraEntity: prop.entity().optional(),
  /** Stride 可以有多个仿真；我们只有一个，这里只能是 0。 */
  simIndex: prop.int().default(0),
}) {
  #body: EntityId | undefined;
  #linear: Constraint<ConstraintSettingsOf<'oneBodyLinearServo'>> | undefined;
  #angular: Constraint<ConstraintSettingsOf<'oneBodyAngularServo'>> | undefined;
  #distance = 0;
  readonly #localGrabPoint = new Vector3();
  readonly #targetOrientation = new Quaternion();

  override update(): void {
    const camera = this.#camera();
    const simulation = this.game.simulation;
    if (!camera || !simulation) return;
    const input = this.game.input;
    if (this.#body === undefined) {
      if (!input.isMouseButtonDown('left')) return;
      const hit = simulation.rayCast([camera.position.x, camera.position.y, camera.position.z], [camera.forward.x, camera.forward.y, camera.forward.z], REACH);
      if (hit) {
        this.#setActive(hit, camera.rotation);
        this.game.debugText.print(`${hit.entity} at ${hit.distance.toFixed(2)}`, [20, 500]);
      }
      return;
    }
    if (!this.game.entities.isAlive(this.#body)) return this.#unsetActive();
    this.#distance += input.mouseWheelDelta;
    const target = camera.position.clone().add(camera.forward.clone().scale(this.#distance));
    this.game.debugText.print(`object should go at ${target.x.toFixed(2)}, ${target.y.toFixed(2)}, ${target.z.toFixed(2)}`, [20, 600]);
    if (input.isKeyDown('K')) {
      simulation.body(this.#body).applyLinearImpulse(camera.forward.clone().scale(100));
      return this.#unsetActive();
    }
    if (!input.isMouseButtonDown('left')) return this.#unsetActive();
    this.#linear!.update({ localOffset: [this.#localGrabPoint.x, this.#localGrabPoint.y, this.#localGrabPoint.z], target: [target.x, target.y, target.z] });
    // Stride 的 _targetOrientation * 相机朝向：先保持抓住时的相对朝向，再跟着相机转
    const orientation = camera.rotation.clone().multiply(this.#targetOrientation);
    this.#angular!.update({ targetOrientation: [orientation.x, orientation.y, orientation.z, orientation.w] });
  }

  override cancel(): void {
    this.#unsetActive();
  }

  #setActive(hit: SimulationHit, cameraRotation: Quaternion): void {
    if (!this.game.entities.hasComponent(hit.entity, Body)) return;
    const simulation = this.game.simulation!;
    const pose = Matrix.decompose(this.game.entities.entity(hit.entity).require(Transform).world);
    const bodyRotation = new Quaternion(...pose.rotation);
    // 抓住的点换到物体的本地空间
    const inverse = new Quaternion(-bodyRotation.x, -bodyRotation.y, -bodyRotation.z, bodyRotation.w);
    this.#localGrabPoint.set(hit.point[0] - pose.translation[0], hit.point[1] - pose.translation[1], hit.point[2] - pose.translation[2]).rotate(inverse);
    // Stride 的 物体朝向 * Invert(相机朝向)：抓住时物体相对相机的朝向
    this.#targetOrientation.set(-cameraRotation.x, -cameraRotation.y, -cameraRotation.z, cameraRotation.w).multiply(bodyRotation);
    this.#distance = hit.distance;
    this.#body = hit.entity;
    const local = [this.#localGrabPoint.x, this.#localGrabPoint.y, this.#localGrabPoint.z] as const;
    // 先关着，第一次 update 时按目标打开（同 Stride）
    this.#linear = simulation.addConstraint({ type: 'oneBodyLinearServo', bodyA: hit.entity, localOffset: local, target: [...hit.point], servoMaximumForce: SERVO_MAXIMUM_FORCE });
    this.#angular = simulation.addConstraint({ type: 'oneBodyAngularServo', bodyA: hit.entity, targetOrientation: [...pose.rotation], servoMaximumForce: SERVO_MAXIMUM_FORCE });
  }

  #unsetActive(): void {
    this.#linear?.remove();
    this.#angular?.remove();
    this.#linear = this.#angular = this.#body = undefined;
  }

  /** 相机的世界位置、朝向和正前方（-Z）。 */
  #camera(): { position: Vector3; rotation: Quaternion; forward: Vector3 } | undefined {
    if (this.cameraEntity === undefined || !this.game.entities.isAlive(this.cameraEntity)) return undefined;
    const { translation, rotation } = Matrix.decompose(this.game.entities.entity(this.cameraEntity).require(Transform).world);
    const quaternion = new Quaternion(...rotation);
    return { position: new Vector3(...translation), rotation: quaternion, forward: new Vector3(0, 0, -1).rotate(quaternion) };
  }
}
