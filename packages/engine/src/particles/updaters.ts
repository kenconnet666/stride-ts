/**
 * 粒子的更新器（Stride 的 Updaters）：每帧改活着的粒子。普通的在生成新粒子之前跑，后置的（IsPostUpdater）在之后。
 * 现在有的：力场、重力、按寿命改大小、颜色、转角，速度方向、碰撞。
 */
import type { ParticleModuleFile } from '../content/format';
import { curveSampler, type CurveSampler } from './curves';
import { createFieldShape, FieldFalloff, type FieldShape } from './fieldShapes';
import type { Vec3 } from './math';
import { ParticleModule, value, type ParticleTransform } from './modules';
import type { ParticleField, ParticlePool } from './ParticlePool';
import { RandomOffset, seedFloat } from './random';

const ZERO_TOLERANCE = 1e-6;
const DEGREES = Math.PI / 180;

const vec3 = (file: ParticleModuleFile, key: string, fallback: Vec3): Vec3 => [...value(file, key, fallback)] as Vec3;

export abstract class ParticleUpdater extends ParticleModule {
  /** 生成新粒子之后再跑（Stride 的 IsPostUpdater）。 */
  get isPostUpdater(): boolean {
    return false;
  }

  abstract update(dt: number, pool: ParticlePool): void;

  /** 按父变换算世界变换（力场还要记下父变换的缩放）。 */
  setParentTransform(parent: ParticleTransform): void {
    this.setParent(parent);
  }
}

/** 读第 i 个粒子的三维字段。 */
function read(column: Float32Array, i: number, out: Vec3): Vec3 {
  out[0] = column[i * 3]!; out[1] = column[i * 3 + 1]!; out[2] = column[i * 3 + 2]!;
  return out;
}

/**
 * 力场（Stride 的 UpdaterForceField）：沿场的轴（ForceDirected）、绕轴（ForceVortex）、离开中心（ForceRepulsive）和固定方向
 * （ForceFixed）的力，按场的形状和衰减算大小。EnergyConservation 是力加到速度上的比例，其余直接推位置。
 */
export class UpdaterForceField extends ParticleUpdater {
  readonly requiredFields = ['position', 'velocity'] as const;
  readonly fieldShape: FieldShape | null;
  readonly falloff: FieldFalloff;
  readonly energyConservation: number;
  readonly forceDirected: number;
  readonly forceVortex: number;
  readonly forceRepulsive: number;
  readonly forceFixed: Vec3;
  #parentScale = 1;

  constructor(file: ParticleModuleFile) {
    super(file);
    this.fieldShape = createFieldShape(file['fieldShape'] as ParticleModuleFile | null | undefined);
    this.falloff = new FieldFalloff((file['fieldFalloff'] as ParticleModuleFile | undefined) ?? {});
    this.energyConservation = value(file, 'energyConservation', 0);
    this.forceDirected = value(file, 'forceDirected', 0);
    this.forceVortex = value(file, 'forceVortex', 1);
    this.forceRepulsive = value(file, 'forceRepulsive', 1);
    this.forceFixed = vec3(file, 'forceFixed', [0, 0, 0]);
  }

  override setParentTransform(parent: ParticleTransform): void {
    super.setParentTransform(parent);
    this.#parentScale = this.inheritScale ? parent.worldScale[0] : 1;
  }

  update(dt: number, pool: ParticlePool): void {
    const position = pool.field('position'), velocity = pool.field('velocity');
    if (!position || !velocity) return;
    const toPosition = 1 - this.energyConservation;
    this.fieldShape?.prepare(this.worldPosition, this.worldRotation, this.worldScale);
    const along: Vec3 = [0, 1, 0], around: Vec3 = [1, 0, 0], away: Vec3 = [0, 0, 1];
    const p: Vec3 = [0, 0, 0];
    for (let i = 0; i < pool.living; i++) {
      let magnitude = 1;
      if (this.fieldShape) magnitude = this.falloff.strength(this.fieldShape.distance(read(position, i, p), along, around, away));
      magnitude *= dt * this.#parentScale;
      for (let k = 0; k < 3; k++) {
        const force = (this.forceFixed[k]! + along[k]! * this.forceDirected + around[k]! * this.forceVortex + away[k]! * this.forceRepulsive) * magnitude;
        const toVelocity = force * this.energyConservation;
        velocity[i * 3 + k]! += toVelocity;
        position[i * 3 + k]! += toVelocity * dt * 0.5 + force * toPosition;
      }
    }
  }
}

/** 重力（Stride 的 UpdaterGravity）：速度加 g · dt，位置多走 g · dt² / 2。 */
export class UpdaterGravity extends ParticleUpdater {
  readonly requiredFields = ['position', 'velocity'] as const;
  readonly acceleration: Vec3;

  constructor(file: ParticleModuleFile) {
    super(file);
    this.acceleration = vec3(file, 'gravitationalAcceleration', [0, -9.80665, 0]);
  }

  update(dt: number, pool: ParticlePool): void {
    const position = pool.field('position'), velocity = pool.field('velocity');
    if (!position || !velocity) return;
    for (let i = 0; i < pool.living; i++) {
      for (let k = 0; k < 3; k++) {
        const dv = this.acceleration[k]! * dt;
        position[i * 3 + k]! += dv * dt * 0.5;
        velocity[i * 3 + k]! += dv;
      }
    }
  }
}

/** 按寿命取曲线的值：有第二条曲线时两条之间按粒子的随机数插值（SizeOverTime、ColorOverTime、RotationOverTime 共用）。 */
class OverTime {
  readonly main: CurveSampler | undefined;
  readonly optional: CurveSampler | undefined;
  readonly seedOffset: number;

  constructor(file: ParticleModuleFile) {
    this.main = curveSampler(file['samplerMain'] as ParticleModuleFile | null | undefined);
    this.optional = curveSampler(file['samplerOptional'] as ParticleModuleFile | null | undefined);
    this.seedOffset = value(file, 'seedOffset', 0);
  }

  /** 粒子 i 的值（main 存在时才调用）。 */
  evaluate(pool: ParticlePool, i: number, age: number): number[] {
    const main = this.main!.evaluate(age);
    if (!this.optional) return main;
    const t = seedFloat(pool.seeds[i]!, RandomOffset.offset1A + this.seedOffset);
    const optional = this.optional.evaluate(age);
    return main.map((value, k) => value + (optional[k]! - value) * t);
  }
}

/**
 * 按寿命改大小（Stride 的 UpdaterSizeOverTime，后置）：大小 = 世界缩放 · 曲线（走过的寿命）；有第二条曲线时两条之间按粒子
 * 的随机数插值。
 */
export class UpdaterSizeOverTime extends ParticleUpdater {
  readonly requiredFields: readonly ParticleField[];
  readonly curves: OverTime;

  constructor(file: ParticleModuleFile) {
    super(file);
    this.curves = new OverTime(file);
    this.requiredFields = this.curves.optional ? ['size', 'randomSeed'] : ['size'];
  }

  override get isPostUpdater(): boolean {
    return true;
  }

  update(_dt: number, pool: ParticlePool): void {
    const size = pool.field('size'), life = pool.field('life');
    if (!size || !life || !this.curves.main) return;
    const scale = this.worldScale[0];
    for (let i = 0; i < pool.living; i++) size[i] = scale * this.curves.evaluate(pool, i, 1 - life[i]!)[0]!;
  }
}

/** 按寿命改颜色（Stride 的 UpdaterColorOverTime，后置）：颜色 = 曲线（走过的寿命），存成预乘 alpha 的。 */
export class UpdaterColorOverTime extends ParticleUpdater {
  readonly requiredFields: readonly ParticleField[];
  readonly curves: OverTime;

  constructor(file: ParticleModuleFile) {
    super(file);
    this.curves = new OverTime(file);
    this.requiredFields = this.curves.optional ? ['color', 'randomSeed'] : ['color'];
  }

  override get isPostUpdater(): boolean {
    return true;
  }

  update(_dt: number, pool: ParticlePool): void {
    const color = pool.field('color'), life = pool.field('life');
    if (!color || !life || !this.curves.main) return;
    for (let i = 0; i < pool.living; i++) {
      const [r, g, b, a] = this.curves.evaluate(pool, i, 1 - life[i]!);
      color[i * 4] = r! * a!; color[i * 4 + 1] = g! * a!; color[i * 4 + 2] = b! * a!; color[i * 4 + 3] = a!;
    }
  }
}

/** 按寿命改转角（Stride 的 UpdaterRotationOverTime，后置）：转角 = 曲线（走过的寿命）的度数。 */
export class UpdaterRotationOverTime extends ParticleUpdater {
  readonly requiredFields: readonly ParticleField[];
  readonly curves: OverTime;

  constructor(file: ParticleModuleFile) {
    super(file);
    this.curves = new OverTime(file);
    this.requiredFields = this.curves.optional ? ['rotation', 'randomSeed'] : ['rotation'];
  }

  override get isPostUpdater(): boolean {
    return true;
  }

  update(_dt: number, pool: ParticlePool): void {
    const rotation = pool.field('rotation'), life = pool.field('life');
    if (!rotation || !life || !this.curves.main) return;
    for (let i = 0; i < pool.living; i++) rotation[i] = this.curves.evaluate(pool, i, 1 - life[i]!)[0]! * DEGREES;
  }
}

/** 速度方向（Stride 的 UpdaterSpeedToDirection，后置）：方向 = 这一帧走过的位移 / dt（OrientedQuad 按它拉长）。 */
export class UpdaterSpeedToDirection extends ParticleUpdater {
  readonly requiredFields = ['position', 'oldPosition', 'direction'] as const;

  override get isPostUpdater(): boolean {
    return true;
  }

  update(dt: number, pool: ParticlePool): void {
    const position = pool.field('position'), old = pool.field('oldPosition'), direction = pool.field('direction');
    if (dt <= ZERO_TOLERANCE || !position || !old || !direction) return;
    for (let i = 0; i < pool.living * 3; i++) direction[i] = (position[i]! - old[i]!) / dt;
  }
}

/**
 * 碰撞（Stride 的 UpdaterCollider，后置）：粒子进到形状里（IsHollow 时是出到外面）就放回表面，速度分成垂直、水平两部分，
 * 垂直的按 Restitution 反弹、水平的按 Friction 减速；KillParticles 时直接结束寿命。碰过的这一帧在 collision 字段记 1
 * （子粒子的碰撞触发用）。
 */
export class UpdaterCollider extends ParticleUpdater {
  readonly requiredFields = ['position', 'velocity', 'life', 'collision'] as const;
  readonly fieldShape: FieldShape | null;
  readonly isHollow: boolean;
  readonly killParticles: boolean;
  readonly restitution: number;
  readonly friction: number;

  constructor(file: ParticleModuleFile) {
    super(file);
    this.fieldShape = createFieldShape(file['fieldShape'] as ParticleModuleFile | null | undefined);
    this.isHollow = value(file, 'isHollow', false);
    this.killParticles = value(file, 'killParticles', false);
    this.restitution = value(file, 'restitution', 0.5);
    this.friction = value(file, 'friction', 0.1);
  }

  override get isPostUpdater(): boolean {
    return true;
  }

  update(_dt: number, pool: ParticlePool): void {
    const position = pool.field('position'), velocity = pool.field('velocity'), life = pool.field('life'), collision = pool.field('collision');
    if (!position || !velocity || !collision) return;
    this.fieldShape?.prepare(this.worldPosition, this.worldRotation, this.worldScale);
    const p: Vec3 = [0, 0, 0], v: Vec3 = [0, 0, 0], point: Vec3 = [0, 0, 0], normal: Vec3 = [0, 1, 0];
    for (let i = 0; i < pool.living; i++) {
      collision[i] = 0;
      point[0] = point[1] = point[2] = 0;
      normal[0] = 0; normal[1] = 1; normal[2] = 0;
      const inside = this.fieldShape ? this.fieldShape.isPointInside(read(position, i, p), point, normal) : false;
      if (this.isHollow === inside) continue;
      if (this.isHollow) for (let k = 0; k < 3; k++) normal[k] = -normal[k]!;
      position.set(point, i * 3);
      read(velocity, i, v);
      const vertical = normal[0] * v[0] + normal[1] * v[1] + normal[2] * v[2];
      const bounce = vertical > 0 ? this.restitution : -this.restitution;
      for (let k = 0; k < 3; k++) {
        const along = normal[k]! * vertical;
        velocity[i * 3 + k] = (v[k]! - along) * (1 - this.friction) + along * bounce;
      }
      collision[i] = 1;
      if (this.killParticles && life) life[i] = ZERO_TOLERANCE;
    }
  }
}

export function createUpdater(file: ParticleModuleFile): ParticleUpdater | undefined {
  switch (file.$type) {
    case 'updaterForceField': return new UpdaterForceField(file);
    case 'updaterGravity': return new UpdaterGravity(file);
    case 'updaterSizeOverTime': return new UpdaterSizeOverTime(file);
    case 'updaterColorOverTime': return new UpdaterColorOverTime(file);
    case 'updaterRotationOverTime': return new UpdaterRotationOverTime(file);
    case 'updaterSpeedToDirection': return new UpdaterSpeedToDirection(file);
    case 'updaterCollider': return new UpdaterCollider(file);
    default: return undefined;
  }
}
