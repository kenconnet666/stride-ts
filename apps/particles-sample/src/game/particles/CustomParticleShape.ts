// ParticlesSample 的 CustomParticleShape：正对相机的矩形，两条边按 RectangleXY 缩放、按粒子的转角转；FixYAxis 时竖边总朝世界的上方
// （只绕 Y 轴对着相机）。
import {
  particleModuleValue, ParticleShapeBuilder,
  type CameraAxes, type ParticleEmitter, type ParticleModuleFile, type VertexWriter,
} from '@stride-ts/engine';
import { RectangleXY } from './CustomParticleFields';

export class CustomParticleShape extends ParticleShapeBuilder {
  readonly fixYAxis: boolean;

  constructor(file: ParticleModuleFile) {
    super();
    this.fixYAxis = particleModuleValue(file, 'fixYAxis', false);
  }

  build(emitter: ParticleEmitter, camera: CameraAxes, order: readonly number[], out: VertexWriter): void {
    const pool = emitter.pool;
    const position = pool.field('position'), size = pool.field('size'), angle = pool.field('rotation'), rectangle = pool.field(RectangleXY);
    if (!position) return;
    let [rx, ry, rz] = camera.right, [ux, uy, uz] = camera.up;
    if (this.fixYAxis) {
      [ux, uy, uz] = [0, 1, 0];
      const length = Math.hypot(rx, rz) || 1;
      [rx, ry, rz] = [rx / length, 0, rz / length];
    }
    const space = emitter.drawTransform, local = emitter.simulationSpace === 'local';
    const [qx, qy, qz, qw] = space.worldRotation;
    for (const i of order) {
      let cx = position[i * 3]!, cy = position[i * 3 + 1]!, cz = position[i * 3 + 2]!;
      let particleSize = size ? size[i]! : 1;
      if (local) {
        // 局部模拟的粒子按粒子系统的变换换到世界
        const tx = 2 * (qy * cz - qz * cy), ty = 2 * (qz * cx - qx * cz), tz = 2 * (qx * cy - qy * cx);
        const scale = space.worldScale[0];
        [cx, cy, cz] = [
          (cx + qw * tx + qy * tz - qz * ty) * scale + space.worldPosition[0],
          (cy + qw * ty + qz * tx - qx * tz) * scale + space.worldPosition[1],
          (cz + qw * tz + qx * ty - qy * tx) * scale + space.worldPosition[2],
        ];
        particleSize *= scale;
      }
      let sx = particleSize, sy = particleSize;
      if (rectangle) {
        sx *= rectangle[i * 2]!;
        sy *= rectangle[i * 2 + 1]!;
      }
      let ax = rx * sx, ay = ry * sx, az = rz * sx, bx = ux * sy, by = uy * sy, bz = uz * sy;
      // 粒子的转角，正的是顺时针
      if (angle) {
        const cos = Math.cos(angle[i]!), sin = Math.sin(angle[i]!);
        [ax, ay, az, bx, by, bz] = [ax * cos - bx * sin, ay * cos - by * sin, az * cos - bz * sin, bx * cos + ax * sin, by * cos + ay * sin, bz * cos + az * sin];
      }
      out.particle(i);
      out.vertex(cx - ax + bx, cy - ay + by, cz - az + bz, 0, 0);
      out.vertex(cx + ax + bx, cy + ay + by, cz + az + bz, 1, 0);
      out.vertex(cx + ax - bx, cy + ay - by, cz + az - bz, 1, 1);
      out.vertex(cx - ax - bx, cy - ay - by, cz - az - bz, 0, 1);
    }
  }
}
