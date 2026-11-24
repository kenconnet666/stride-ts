/**
 * 用输入开车（Stride 没有）：挂在有 Vehicle 的车身上，每帧按输入的动作（`game.input.actions`）写油门、转向、刹车、手刹。
 * 动作：`drive`（axis2：x 转向，正的向右；y 油门，正的往前）、`handBrake`（button）；名字可以改。controls 给了输入映射时开车期间
 * 加上它（优先级 10，盖掉走路那张同名的动作），脚本移除或停用时拿掉——上车 `add` 这个脚本或启用，下车移除或停用。
 * 油门和车走的方向相反时先刹车，快停下了才挂倒挡（同常见的驾驶游戏），不用单独的刹车键；不踩油门、几乎停着时踩住刹车（停在坡上
 * 不溜）。
 *
 *   car.add({ script: VehicleDriver, init: { controls: await game.content.loadInputMap('Input/Driving') } });
 */
import { prop } from '../data/prop';
import { SyncScript } from '../engine/scripts';
import { Vehicle } from './Vehicle';

/** 比这慢（米/秒）算停下了：反向的油门从刹车换成倒车（或者往前）。 */
const STOPPED = 1;

export class VehicleDriver extends SyncScript.props('VehicleDriver', {
  /** 开车的输入映射；没有时用已经开着的映射里的动作。 */
  controls: prop.asset('input').optional(),
  /** 油门和转向的动作（axis2）。 */
  driveAction: prop.string().default('drive'),
  /** 手刹的动作（button）。 */
  handBrakeAction: prop.string().default('handBrake'),
}, { requires: [() => Vehicle] }) {
  #controls: Disposable | undefined;

  override start(): void {
    this.#attach();
  }

  override cancel(): void {
    this.#detach();
  }

  protected override onEnabledChanged(): void {
    if (this.enabled) this.#attach();
    else {
      this.#detach();
      const vehicle = this.entity.get(Vehicle);
      if (vehicle) Object.assign(vehicle, { throttle: 0, steering: 0, brake: 0, handBrake: 0 });
    }
  }

  override update(): void {
    const actions = this.game.input.actions;
    const vehicle = this.entity.require(Vehicle);
    const [steer, pedal] = actions.vector(this.driveAction);
    const speed = vehicle.state?.speed ?? 0;
    const reversing = pedal * speed < 0 && Math.abs(speed) > STOPPED;
    const holding = pedal === 0 && Math.abs(speed) < STOPPED;
    vehicle.throttle = reversing ? 0 : pedal;
    vehicle.brake = reversing ? Math.abs(pedal) : holding ? 1 : 0;
    vehicle.steering = steer;
    vehicle.handBrake = actions.down(this.handBrakeAction) ? 1 : 0;
  }

  #attach(): void {
    if (this.controls && !this.#controls && this.game) this.#controls = this.game.input.actions.add(this.controls, 10);
  }

  #detach(): void {
    this.#controls?.[Symbol.dispose]();
    this.#controls = undefined;
  }
}
