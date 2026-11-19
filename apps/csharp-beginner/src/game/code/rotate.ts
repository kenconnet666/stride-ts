// 教程脚本共用：Stride 的 `Entity.Transform.Rotation *= Quaternion.RotationY(angle)`（先按原来的朝向，再绕世界的 Y 轴转）。
import { Quaternion, Transform, type Entity } from '@stride-ts/engine';

const UP = { x: 0, y: 1, z: 0 };

export function rotateY(entity: Entity, angle: number): void {
  const transform = entity.require(Transform);
  transform.rotation = new Quaternion().setAxisAngle(UP, angle).multiply(transform.rotation);
}
