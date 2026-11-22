/**
 * 粒子的更新器（Stride 的 Updaters）：每帧改活着的粒子。普通的在生成新粒子之前跑，后置的（IsPostUpdater）在之后。
 * 现在有的：力场、重力、按寿命改大小、颜色、转角，速度方向、碰撞；Stride 没有的：风、按深度表面碰撞（只在 GPU 上）。
 */
import type { ParticleModuleFile } from '../content/formats/format';
import { curveSampler, type CurveSampler } from './curves';
import { createFieldShape, FieldFalloff, type FieldShape } from './fieldShapes';
import type { Vec3 } from './math';
import { ParticleModule, value, type ParticleModuleKind, type ParticleTransform } from './modules';
import type { AnyParticleField, ParticlePool } from './ParticlePool';
import { RandomOffset, seedFloat } from './random';
import type { WindField } from '../world/WindField';
import type { GpuDepthSurface } from '../rendering/DepthSurface';

const ZERO_TOLERANCE = 1e-6;
const DEGREES = Math.PI / 180;

const vec3 = (file: ParticleModuleFile, key: string, fallback: Vec3): Vec3 => [...value(file, key, fallback)] as Vec3;

export abstract class ParticleUpdater extends ParticleModule {
  /** Registry 按它认出粒子模块。 */
  static readonly particleModuleKind: ParticleModuleKind = 'updater';

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

  /** 力乘的父缩放（GPU 的内核打包用）。 */
  get parentScale(): number {
    return this.#parentScale;
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
  readonly requiredFields: readonly AnyParticleField[];
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
  readonly requiredFields: readonly AnyParticleField[];
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
  readonly requiredFields: readonly AnyParticleField[];
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

/**
 * 风（Stride 没有）：速度往 风速 + terminalVelocity 靠，像空气阻力：v += (风 + 终端速度 - v) · min(1, drag · dt)。终端速度是
 * 风吹不动的那部分（雨、雪的下落速度），没有时是 0。风取 `game.wind`（ParticleSystems 每帧把它交给 field），按粒子的世界位置取；
 * 局部模拟的发射器的粒子位置是相对发射器的，取到的风会偏（雨雪这类用世界模拟）。
 */
export class UpdaterWind extends ParticleUpdater {
  readonly requiredFields = ['position', 'velocity'] as const;
  /** 往风速靠的快慢，每秒。 */
  readonly drag: number;
  /** 风吹不动的速度，米每秒。 */
  readonly terminalVelocity: Vec3;
  /** @internal 风场（ParticleSystems 每帧给）；没有时不动。 */
  field: WindField | undefined;
  readonly #wind: Vec3 = [0, 0, 0];

  constructor(file: ParticleModuleFile) {
    super(file);
    this.drag = value(file, 'drag', 1);
    this.terminalVelocity = vec3(file, 'terminalVelocity', [0, 0, 0]);
  }

  update(dt: number, pool: ParticlePool): void {
    const position = pool.field('position'), velocity = pool.field('velocity'), field = this.field;
    if (!position || !velocity || !field) return;
    const k = Math.min(1, this.drag * dt), wind = this.#wind;
    for (let i = 0; i < pool.living; i++) {
      field.sample(position[i * 3]!, position[i * 3 + 1]!, position[i * 3 + 2]!, wind);
      for (let c = 0; c < 3; c++) velocity[i * 3 + c]! += (wind[c]! + this.terminalVelocity[c]! - velocity[i * 3 + c]!) * k;
    }
  }
}

/**
 * 按深度表面碰撞（Stride 没有；Godot 的高度场碰撞、Unity VFX Graph 的按深度缓冲碰撞，后置）：surface 是 'sky' 时撞天空遮挡
 * （从上往下的高度场，屏幕外也有），'view' 时撞主视图上一帧的深度（只有看得见的表面）。粒子落到表面后面（沿视线不超过
 * thickness 米）就沿法线推回表面，速度同 UpdaterCollider：法向的按 restitution 反弹、切向的按 friction 减速，再按 spread 往切向
 * 随机散开；killParticles 时直接死；第一次撞上时剩下的寿命最多 bounceLifetime 秒（0 是不变，溅起的水花用）。
 *
 * 只在 GPU 上：深度表面在 GPU 上，CPU 的模拟里它什么都不做（有它的发射器 auto 时总是放到 GPU 上）。
 */
export class UpdaterDepthCollision extends ParticleUpdater {
  readonly requiredFields = ['position', 'velocity', 'life'] as const;
  readonly surface: 'sky' | 'view';
  readonly restitution: number;
  readonly friction: number;
  readonly killParticles: boolean;
  /** 在表面后面多深以内算撞上，米（再深的是在物体后面）。 */
  readonly thickness: number;
  /** 反弹以后往切向随机散开，按速度的比例。 */
  readonly spread: number;
  /** 第一次撞上以后最多再活几秒；0 是不变。 */
  readonly bounceLifetime: number;
  /** @internal 深度表面（ParticleSystems 每帧给）；没有时不碰撞。 */
  depthSurface: GpuDepthSurface | undefined;

  constructor(file: ParticleModuleFile) {
    super(file);
    this.surface = value(file, 'surface', 'view') as 'sky' | 'view';
    this.restitution = value(file, 'restitution', 0.5);
    this.friction = value(file, 'friction', 0.1);
    this.killParticles = value(file, 'killParticles', false);
    this.thickness = value(file, 'thickness', 0.5);
    this.spread = value(file, 'spread', 0);
    this.bounceLifetime = value(file, 'bounceLifetime', 0);
  }

  override get isPostUpdater(): boolean {
    return true;
  }

  update(): void {}
}

export function createUpdater(file: ParticleModuleFile): ParticleUpdater | undefined {
  switch (file.$type) {
    case 'updaterWind': return new UpdaterWind(file);
    case 'updaterForceField': return new UpdaterForceField(file);
    case 'updaterGravity': return new UpdaterGravity(file);
    case 'updaterSizeOverTime': return new UpdaterSizeOverTime(file);
    case 'updaterColorOverTime': return new UpdaterColorOverTime(file);
    case 'updaterRotationOverTime': return new UpdaterRotationOverTime(file);
    case 'updaterSpeedToDirection': return new UpdaterSpeedToDirection(file);
    case 'updaterCollider': return new UpdaterCollider(file);
    case 'updaterDepthCollision': return new UpdaterDepthCollision(file);
    default: return undefined;
  }
}
