// ParticlesSample 的 RotateEntity（同 AnimatedModel 的）：指针（鼠标、手指）横向移动时给实体一个绕 Y 轴的转速，之后每帧衰减。
import { AsyncScript, Quaternion, Transform, Vector3 } from '@stride-ts/engine';

const UP = new Vector3(0, 1, 0);
/** 每帧（按 Stride 的写法，不随帧率换算）保留的转速比例。 */
const DAMPING = 0.93;

export class RotateEntity extends AsyncScript {
  override async execute(): Promise<void> {
    let rotationSpeed = 0;
    const turn = new Quaternion();
    while (this.attached) {
      await this.nextFrame();
      const events = this.game.input.pointerEvents;
      if (events.length > 0) rotationSpeed = 200 * events.reduce((sum, event) => sum + event.deltaPosition[0], 0);
      rotationSpeed *= DAMPING;
      // Stride 的 Rotation *= RotationY(角度)：先按原来的朝向，再绕世界的 Y 轴转
      const rotation = this.entity.require(Transform).rotation;
      turn.setAxisAngle(UP, rotationSpeed * this.game.updateTime.elapsed).multiply(rotation);
      rotation.x = turn.x;
      rotation.y = turn.y;
      rotation.z = turn.z;
      rotation.w = turn.w;
    }
  }
}
