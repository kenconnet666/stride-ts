/**
 * 轮式车（Stride 没有；Jolt 的 VehicleConstraint 加 WheeledVehicleController，原生侧见 fork 的 Physics.h）：挂在带动态 Body 的
 * 实体（车身）上，轮子在属性里写（车身本地空间，按轴成对：0、1 是前轴的左、右，2、3 是后轴的……）。驾驶的脚本每帧写
 * `throttle`、`steering`、`brake`、`handBrake`，车在物理步里开；`state` 是转速、挡位、速度。
 *
 * 轮子的模型：每个轮子可以指一个实体（`wheels[i].model`，车身的子实体），每帧按轮子的位姿摆它——悬挂的上下、转向、滚动。
 * 轮子模型的轮轴沿本地 X（左右两边同一个模型）。
 *
 *   const car = entity.require(Vehicle);
 *   car.throttle = actions.vector('move')[1];
 *   car.steering = actions.vector('move')[0];
 */
import { prop } from '../data/prop';
import { SyncScript } from '../engine/scripts';
import { Transform } from '../engine/transform';
import type { VehicleState } from '@stride-ts/native';
import { Body } from './components';
import type { VehicleHandle } from './Simulation';

const DEGREES = Math.PI / 180;

export class Vehicle extends SyncScript.props('Vehicle', {
  /** 哪根轴驱动。 */
  drive: prop.enum(['rear', 'front', 'all']).default('rear'),
  /** 发动机最大扭矩（牛·米），500 是普通轿车。 */
  maxEngineTorque: prop.number().min(0).default(500).unit('N·m'),
  /** 发动机最高转速。 */
  maxRpm: prop.number().min(1000).default(6000).unit('rpm'),
  /** 每根轴的防倾杆（牛/米）：越大转弯时车身越不歪，0 是没有。 */
  antiRollStiffness: prop.number().min(0).default(1000),
  /** 车身倾斜不超过这个角度，防翻车；180 是不限。 */
  maxTilt: prop.number().min(0).max(180).default(180).unit('deg'),
  /** 轮子，按轴成对（左、右）。 */
  wheels: prop.list(prop.object({
    /** 悬挂的上端（车身本地）；悬挂伸到最长时轮心在它下面 suspensionMax。 */
    position: prop.vec3(),
    radius: prop.number().min(0.01).default(0.35).unit('m'),
    width: prop.number().min(0.01).default(0.25).unit('m'),
    /** 悬挂最短、最长的长度。 */
    suspensionMin: prop.number().min(0).default(0.1).unit('m'),
    suspensionMax: prop.number().min(0).default(0.4).unit('m'),
    /** 悬挂弹簧的频率和阻尼比：1～2 Hz 是轿车，越大越硬。 */
    suspensionFrequency: prop.number().min(0).default(1.5).unit('Hz'),
    suspensionDamping: prop.number().min(0).default(0.5),
    /** 最大转向角，0 是不转向的轮子。 */
    steerAngle: prop.number().min(0).max(90).default(0).unit('deg'),
    brakeTorque: prop.number().min(0).default(1500).unit('N·m'),
    /** 手刹，一般只给后轮。 */
    handBrakeTorque: prop.number().min(0).default(0).unit('N·m'),
    /** 轮子的模型（车身的子实体，轮轴沿本地 X）：每帧按轮子的位姿摆。 */
    model: prop.entity().optional(),
  })),
}, { requires: [() => Body] }) {
  /** 油门 -1..1（负的倒车）。 */
  throttle = 0;
  /** 转向 -1..1（正的向右）。 */
  steering = 0;
  /** 刹车 0..1。 */
  brake = 0;
  /** 手刹 0..1。 */
  handBrake = 0;
  #handle: VehicleHandle | undefined;
  #state: VehicleState | undefined;

  /** 这一帧的转速、挡位、速度（米/秒）、着地的轮子数、各轮子的位姿；还没开始时是 undefined。 */
  get state(): VehicleState | undefined {
    return this.#state;
  }

  override start(): void {
    const simulation = this.game.simulation;
    if (!simulation) throw new Error(`Vehicle on '${this.entity.name}': the game runs without physics (nativeFeatures: [physics])`);
    if (this.wheels.length < 2 || this.wheels.length % 2 !== 0) throw new Error(`Vehicle on '${this.entity.name}': needs an even number of wheels (left, right per axle), has ${this.wheels.length}`);
    this.#handle = simulation.addVehicle(this.entity, {
      drive: this.drive,
      maxEngineTorque: this.maxEngineTorque,
      maxRpm: this.maxRpm,
      antiRollStiffness: this.antiRollStiffness,
      maxPitchRollAngle: this.maxTilt * DEGREES,
      wheels: this.wheels.map((wheel) => ({
        position: [wheel.position.x, wheel.position.y, wheel.position.z],
        radius: wheel.radius,
        width: wheel.width,
        suspensionMin: wheel.suspensionMin,
        suspensionMax: Math.max(wheel.suspensionMin, wheel.suspensionMax),
        suspensionFrequency: wheel.suspensionFrequency,
        suspensionDamping: wheel.suspensionDamping,
        maxSteerAngle: wheel.steerAngle * DEGREES,
        maxBrakeTorque: wheel.brakeTorque,
        maxHandBrakeTorque: wheel.handBrakeTorque,
      })),
    });
  }

  override update(): void {
    const handle = this.#handle;
    if (!handle) return;
    handle.input(this.throttle, this.steering, this.brake, this.handBrake);
    const state = (this.#state = handle.state());
    if (!state) return;
    const manager = this.entity.manager;
    this.wheels.forEach((wheel, i) => {
      const model = wheel.model, pose = state.wheels[i];
      if (model === undefined || !pose || !manager.isAlive(model)) return;
      const transform = manager.entity(model).get(Transform);
      if (!transform) return;
      transform.position = { x: pose.position[0], y: pose.position[1], z: pose.position[2] };
      transform.rotation = { x: pose.rotation[0], y: pose.rotation[1], z: pose.rotation[2], w: pose.rotation[3] };
    });
  }

  override cancel(): void {
    this.#handle?.remove();
    this.#handle = undefined;
    this.#state = undefined;
  }
}
