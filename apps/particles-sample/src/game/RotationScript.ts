// ParticlesSample 的 RotationScript：实体绕自己的 X 轴每秒转一圈（乘 TimeFactor），从 0.6 秒处开始。
// 和 Stride 不同（写法）：Stride 用代码建一个动画剪辑（旋转的四元数曲线，0、90、180、270、360 度五个关键帧，线性插值，无限循环）
// 放在 AnimationComponent 上；关键帧均匀，插出来就是匀速转，这里直接按时间算角度（我们的动画系统只放骨骼动画）。
import { prop, Quaternion, SyncScript, Transform, Vector3, type GameTime } from '@stride-ts/engine';

const X_AXIS = new Vector3(1, 0, 0);
const START = 0.6;

export class RotationScript extends SyncScript.props({
  timeFactor: prop.number().default(1),
}) {
  #time = START;
  readonly #rotation = new Quaternion();

  override update(time: GameTime): void {
    this.#time = (this.#time + time.elapsed * this.timeFactor) % 1;
    this.#rotation.setAxisAngle(X_AXIS, this.#time * 2 * Math.PI);
    Object.assign(this.entity.require(Transform).rotation, { x: this.#rotation.x, y: this.#rotation.y, z: this.#rotation.z, w: this.#rotation.w });
  }
}
