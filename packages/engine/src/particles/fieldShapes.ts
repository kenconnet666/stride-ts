/**
 * 力场和碰撞用的形状（Stride 的 Updaters.FieldShapes）和衰减（FieldFalloff）。形状按更新器的世界变换摆放（prepare），
 * distance 给出粒子到中心的相对距离（1 在表面上）和沿轴、绕轴、离开中心三个方向；isPointInside 给出最近的表面点和法线。
 *
 * 和 Stride 不同（改掉的毛病）：衰减在 FalloffStart 到 FalloffEnd 之间线性过渡；Stride 除以的是 FalloffEnd / FalloffStart 而不是
 * 两者的差，过渡区里力几乎不变，到 FalloffEnd 时突然跳到 StrengthOutside。
 */
import type { ParticleModuleFile } from '../content/format';
import { normalize, rotate, type Quat, type Vec3 } from './math';
import { value } from './modules';

const ZERO_TOLERANCE = 1e-6;

/** 力场的衰减：到场中心的相对距离在 FalloffStart 以内是 StrengthInside，FalloffEnd 以外是 StrengthOutside。 */
export class FieldFalloff {
  readonly strengthInside: number;
  readonly falloffStart: number;
  readonly strengthOutside: number;
  readonly falloffEnd: number;

  constructor(file: ParticleModuleFile = {}) {
    this.strengthInside = value(file, 'strengthInside', 1);
    this.falloffStart = value(file, 'falloffStart', 0.1);
    this.strengthOutside = value(file, 'strengthOutside', 0);
    this.falloffEnd = value(file, 'falloffEnd', 0.9);
  }

  strength(distance: number): number {
    if (distance <= this.falloffStart) return this.strengthInside;
    if (distance >= this.falloffEnd) return this.strengthOutside;
    const t = (distance - this.falloffStart) / (this.falloffEnd - this.falloffStart);
    return this.strengthInside + (this.strengthOutside - this.strengthInside) * t;
  }
}

export interface FieldShape {
  /** 按世界的位置、旋转、缩放摆放（每帧一次）。 */
  prepare(position: Readonly<Vec3>, rotation: Readonly<Quat>, size: Readonly<Vec3>): void;
  /** 粒子到中心的相对距离，写出沿轴、绕轴、离开中心的方向。 */
  distance(position: Readonly<Vec3>, along: Vec3, around: Vec3, away: Vec3): number;
  /** 粒子在不在形状里面，写出最近的表面点和朝外的法线。 */
  isPointInside(position: Readonly<Vec3>, surfacePoint: Vec3, surfaceNormal: Vec3): boolean;
}

/** 共同的摆放：位置、旋转、反向旋转、缩放、主轴（本地 Y）。 */
abstract class PlacedShape implements FieldShape {
  protected position: Vec3 = [0, 0, 0];
  protected rotation: Quat = [0, 0, 0, 1];
  protected inverseRotation: Quat = [0, 0, 0, 1];
  protected size: Vec3 = [1, 1, 1];
  protected mainAxis: Vec3 = [0, 1, 0];

  prepare(position: Readonly<Vec3>, rotation: Readonly<Quat>, size: Readonly<Vec3>): void {
    this.position = [...position];
    this.rotation = [...rotation];
    this.size = [...size];
    this.inverseRotation = [-rotation[0], -rotation[1], -rotation[2], rotation[3]];
    this.mainAxis = rotate(rotation, [0, 1, 0]);
  }

  /** 粒子相对中心、转回形状本地的位置（还没除以缩放）。 */
  protected local(position: Readonly<Vec3>): Vec3 {
    return rotate(this.inverseRotation, [position[0] - this.position[0], position[1] - this.position[1], position[2] - this.position[2]]);
  }

  abstract distance(position: Readonly<Vec3>, along: Vec3, around: Vec3, away: Vec3): number;
  abstract isPointInside(position: Readonly<Vec3>, surfacePoint: Vec3, surfaceNormal: Vec3): boolean;
}

/** 把 a × b 写进 out。 */
function crossInto(out: Vec3, a: Readonly<Vec3>, b: Readonly<Vec3>): void {
  out[0] = a[1] * b[2] - a[2] * b[1];
  out[1] = a[2] * b[0] - a[0] * b[2];
  out[2] = a[0] * b[1] - a[1] * b[0];
}

/** 球（Stride 的 FieldShapes.Sphere）。 */
export class FieldShapeSphere extends PlacedShape {
  readonly radius: number;

  constructor(file: ParticleModuleFile = {}) {
    super();
    const radius = value(file, 'radius', 1);
    this.radius = radius > ZERO_TOLERANCE ? radius : ZERO_TOLERANCE;
  }

  distance(position: Readonly<Vec3>, along: Vec3, around: Vec3, away: Vec3): number {
    along.splice(0, 3, ...this.mainAxis);
    away.splice(0, 3, ...normalize<Vec3>([position[0] - this.position[0], position[1] - this.position[1], position[2] - this.position[2]]));
    crossInto(around, along, away);
    const local = this.local(position);
    return Math.hypot(local[0] / this.size[0], local[1] / this.size[1], local[2] / this.size[2]) / this.radius;
  }

  isPointInside(position: Readonly<Vec3>, surfacePoint: Vec3, surfaceNormal: Vec3): boolean {
    const local = this.local(position).map((c, k) => c / this.size[k]!) as Vec3;
    const distance = Math.hypot(...local) / this.radius;
    if (distance <= ZERO_TOLERANCE) {
      surfacePoint.splice(0, 3, ...this.position);
      surfaceNormal.splice(0, 3, 0, 1, 0);
      return true;
    }
    const direction = local.map((c) => c / distance) as Vec3;
    const point = rotate(this.rotation, direction.map((c, k) => c * this.size[k]!) as Vec3);
    surfacePoint.splice(0, 3, point[0] + this.position[0], point[1] + this.position[1], point[2] + this.position[2]);
    surfaceNormal.splice(0, 3, ...normalize(rotate(this.rotation, direction.map((c, k) => c / this.size[k]!) as Vec3)));
    return distance <= 1;
  }
}

/** 圆柱（Stride 的 FieldShapes.Cylinder）：沿本地 Y，半高 HalfHeight、半径 Radius。 */
export class FieldShapeCylinder extends PlacedShape {
  readonly halfHeight: number;
  readonly radius: number;

  constructor(file: ParticleModuleFile = {}) {
    super();
    this.halfHeight = Math.max(value(file, 'halfHeight', 1), ZERO_TOLERANCE);
    this.radius = Math.max(value(file, 'radius', 1), ZERO_TOLERANCE);
  }

  distance(position: Readonly<Vec3>, along: Vec3, around: Vec3, away: Vec3): number {
    along.splice(0, 3, ...this.mainAxis);
    // 离开中心的方向是水平的（离开轴，不是离开一个点）
    away.splice(0, 3, ...normalize<Vec3>([position[0] - this.position[0], 0, position[2] - this.position[2]]));
    crossInto(around, along, away);
    const local = this.local(position).map((c, k) => c / this.size[k]!) as Vec3;
    if (Math.abs(local[1]) >= this.halfHeight) return 1;
    return Math.hypot(local[0] / this.radius, local[2] / this.radius);
  }

  isPointInside(position: Readonly<Vec3>, surfacePoint: Vec3, surfaceNormal: Vec3): boolean {
    const local = this.local(position);
    const distance = Math.hypot(local[0], local[2]);
    const fieldX = this.radius * this.size[0], fieldY = this.halfHeight * this.size[1], fieldZ = this.radius * this.size[2];
    // 侧面上和粒子同方向的点
    const round = normalize<Vec3>([local[0] / fieldX, 0, local[2] / fieldZ]);
    round[0] *= fieldX;
    round[2] *= fieldZ;
    const fieldRadius = Math.hypot(...round);
    const outside = distance > fieldRadius || Math.abs(local[1]) > fieldY;
    const surfaceY = local[1] >= 0 ? fieldY : -fieldY;
    let point: Vec3, normal: Vec3;
    if (Math.abs(distance - fieldRadius) <= Math.abs(local[1] - surfaceY)) {
      point = [round[0], local[1], round[2]];
      normal = [round[0] / fieldX, 0, round[2] / fieldZ];
    } else {
      point = [local[0], surfaceY, local[2]];
      normal = [0, surfaceY > 0 ? 1 : -1, 0];
    }
    if (outside) {
      point[1] = Math.min(Math.max(point[1], -fieldY), fieldY);
      if (Math.abs(point[0]) > Math.abs(round[0])) point[0] = round[0];
      if (Math.abs(point[2]) > Math.abs(round[2])) point[2] = round[2];
    }
    const worldNormal = normalize(rotate(this.rotation, normal.map((c, k) => c / this.size[k]!) as Vec3));
    const worldPoint = rotate(this.rotation, point);
    surfacePoint.splice(0, 3, worldPoint[0] + this.position[0], worldPoint[1] + this.position[1], worldPoint[2] + this.position[2]);
    surfaceNormal.splice(0, 3, ...worldNormal);
    return !outside;
  }
}

/** 文件里的形状（不认识的是 null，同 Stride 的没有形状）。 */
export function createFieldShape(file: ParticleModuleFile | null | undefined): FieldShape | null {
  switch (file?.$type) {
    case 'fieldShapeSphere': return new FieldShapeSphere(file);
    case 'fieldShapeCylinder': return new FieldShapeCylinder(file);
    default: return null;
  }
}
