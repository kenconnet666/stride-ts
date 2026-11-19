// ParticlesSample 的 LaserOrientationScript：激光（实体的 Z 轴）每帧朝向 Target，按距离把 Z（或整体）缩放成激光的长度。
import { AsyncScript, Matrix, prop, Transform } from '@stride-ts/engine';

export class LaserOrientationScript extends AsyncScript.props({
  target: prop.entity().optional(),
  doNotScale: prop.bool().default(false),
  scaleOnlyZ: prop.bool().default(true),
}) {
  override async execute(): Promise<void> {
    while (this.attached) {
      this.#update();
      await this.nextFrame();
    }
  }

  #update(): void {
    const target = this.target === undefined ? undefined : this.game.entities.entity(this.target).require(Transform).world;
    const targetPosition = target ? [target[12]!, target[13]!, target[14]!] : [0, 0, 0];
    const transform = this.entity.require(Transform);
    const eye = [transform.world[12]!, transform.world[13]!, transform.world[14]!];
    // Z 轴从目标指向自己，X = up × Z，Y = Z × X（同 Stride 的 LookAt 写法）
    const z = eye.map((e, i) => e - targetPosition[i]!);
    const length = Math.hypot(...z);
    const zn = z.map((c) => c / (length || 1));
    let x = [zn[2]!, 0, -zn[0]!];
    const xl = Math.hypot(...x) || 1;
    x = x.map((c) => c / xl);
    const y = [zn[1]! * x[2]! - zn[2]! * x[1]!, zn[2]! * x[0]! - zn[0]! * x[2]!, zn[0]! * x[1]! - zn[1]! * x[0]!];
    const rotation = Matrix.decompose(new Float32Array([x[0]!, x[1]!, x[2]!, 0, y[0]!, y[1]!, y[2]!, 0, zn[0]!, zn[1]!, zn[2]!, 0, 0, 0, 0, 1])).rotation;
    Object.assign(transform.rotation, { x: rotation[0], y: rotation[1], z: rotation[2], w: rotation[3] });
    if (this.doNotScale) return;
    if (this.scaleOnlyZ) transform.scale.z = length;
    else Object.assign(transform.scale, { x: length, y: length, z: length });
  }
}
