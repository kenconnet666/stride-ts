/**
 * 粒子的模块（Stride 的 Spawners、Initializers、Updaters），按导入的 ParticleModuleFile 建，没写的属性取 Stride 的默认值。
 * 现在有的：生成器 PerSecond、PerFrame；初始化器 SizeSeed、PositionSeed、VelocitySeed、3DRotationSeed、ColorSeed；
 * 更新器 ForceField（球形的场）。导入器只留下这些（见 pipeline 的 particles.ts）。
 *
 * 和 Stride 不同（改掉的毛病）：力场的衰减（FieldFalloff）在 FalloffStart 到 FalloffEnd 之间线性过渡；Stride 除以的是
 * FalloffEnd / FalloffStart 而不是两者的差，过渡区里力几乎不变，到 FalloffEnd 时突然跳到 StrengthOutside。
 */
import type { ParticleModuleFile, ParticleValue } from '../content/format';
import { isIdentity, normalize, rotate, slerp, combine, type Quat, type Vec3 } from './math';
import type { ParticleField, ParticlePool } from './ParticlePool';
import { RandomOffset, seedFloat, type RandomSeedGenerator } from './random';

const ZERO_TOLERANCE = 1e-6;

/** 模块文件里的值：没写时取默认值。 */
export function value<T extends ParticleValue>(file: ParticleModuleFile | undefined, key: string, fallback: T): T {
  const found = file?.[key];
  return (found === undefined || found === null ? fallback : found) as T;
}

const vec3 = (file: ParticleModuleFile, key: string, fallback: Vec3): Vec3 => [...value(file, key, fallback)] as Vec3;
const quat = (file: ParticleModuleFile, key: string, fallback: Quat): Quat => [...value(file, key, fallback)] as Quat;

/**
 * 模块自己的变换（Stride 的 ParticleTransform）：相对父变换（发射器所在实体，或者局部模拟时的单位变换）的位置、旋转、缩放，
 * 每帧按父变换算出世界的。
 */
export class ParticleTransform {
  readonly inheritPosition: boolean;
  readonly inheritRotation: boolean;
  readonly inheritScale: boolean;
  readonly position: Vec3;
  readonly rotation: Quat;
  readonly scale: Vec3;
  readonly scaleUniform: number;
  worldPosition: Vec3 = [0, 0, 0];
  worldRotation: Quat = [0, 0, 0, 1];
  worldScale: Vec3 = [1, 1, 1];

  constructor(file: ParticleModuleFile = {}) {
    this.inheritPosition = value(file, 'inheritPosition', true);
    this.inheritRotation = value(file, 'inheritRotation', true);
    this.inheritScale = value(file, 'inheritScale', true);
    this.position = vec3(file, 'position', [0, 0, 0]);
    this.rotation = quat(file, 'rotation', [0, 0, 0, 1]);
    this.scale = vec3(file, 'scale', [1, 1, 1]);
    this.scaleUniform = value(file, 'scaleUniform', 1);
  }

  /** 按父变换算世界变换（Stride 的 SetParentTransform）；parent 是 null 时世界的就是自己的。 */
  setParent(parent: ParticleTransform | null): void {
    const own = this.scale.map((s) => s * this.scaleUniform) as Vec3;
    const parentScale = parent && this.inheritScale ? parent.worldScale[0] : 1;
    this.worldScale = own.map((s) => s * parentScale) as Vec3;
    this.worldRotation = parent && this.inheritRotation ? combine(this.rotation, parent.worldRotation) : [...this.rotation];
    const offset = this.position.map((p) => p * parentScale) as Vec3;
    if (parent && this.inheritRotation) rotate(parent.worldRotation, offset);
    this.worldPosition = parent && this.inheritPosition ? [parent.worldPosition[0] + offset[0], parent.worldPosition[1] + offset[1], parent.worldPosition[2] + offset[2]] : offset;
  }
}

/** 初始化器和更新器的共同部分（Stride 的 ParticleModule）。 */
export abstract class ParticleModule extends ParticleTransform {
  readonly enabled: boolean;
  /** 要粒子池里有的字段。 */
  abstract readonly requiredFields: readonly ParticleField[];

  constructor(file: ParticleModuleFile) {
    super(file);
    this.enabled = value(file, 'enabled', true);
  }
}

// —— 生成器 ——

/** 生成器要的发射器的部分。 */
export interface SpawnTarget {
  readonly seedGenerator: RandomSeedGenerator;
  /** 粒子池的大小要重新算。 */
  markPoolDirty(): void;
  emit(count: number): void;
}

type SpawnerState = 'inactive' | 'rest' | 'active' | 'dead';

/**
 * 生成器（Stride 的 ParticleSpawner）：在 休息（Delay）→ 活跃（Duration）之间循环（LoopCondition：Looping 每次都休息，
 * LoopingNoDelay 只在第一次休息，OneShot 活跃一次后停），活跃时按自己的规则生成粒子。时长在范围里随机，用自己的种子。
 */
export abstract class ParticleSpawner {
  readonly enabled: boolean;
  readonly loopCondition: 'looping' | 'loopingNoDelay' | 'oneShot';
  readonly delay: [number, number];
  readonly duration: [number, number];
  #target: SpawnTarget | undefined;
  #state: SpawnerState = 'inactive';
  #stateDuration = 0;
  #seed = 0;
  #offset = 0;

  constructor(file: ParticleModuleFile) {
    this.enabled = value(file, 'enabled', true);
    this.loopCondition = value(file, 'loopCondition', 'looping') as ParticleSpawner['loopCondition'];
    this.delay = value(file, 'delay', [0, 0]).map((d) => Math.max(d, 0)) as [number, number];
    this.duration = value(file, 'duration', [1, 1]).map((d) => Math.max(d, 0.001)) as [number, number];
  }

  /** 每秒最多生成多少个（发射器按它和寿命定粒子池的大小）。 */
  abstract maxParticlesPerSecond(): number;

  abstract spawn(dt: number, target: SpawnTarget): void;

  resetSimulation(): void {
    this.#state = 'inactive';
    this.#stateDuration = 0;
  }

  /** 走过 dt 秒后的状态（Stride 的 GetUpdatedState）。第一次调用时从发射器取自己的种子。 */
  protected updatedState(dt: number, target: SpawnTarget): SpawnerState {
    if (!this.#target) {
      this.#target = target;
      this.#seed = target.seedGenerator.nextSeed();
      target.markPoolDirty();
    }
    let remaining = dt;
    while (this.#stateDuration <= remaining) {
      remaining -= this.#stateDuration;
      switch (this.#state) {
        case 'inactive': this.#switchTo('rest'); break;
        case 'rest': this.#switchTo('active'); break;
        case 'active': this.#switchTo(this.loopCondition === 'oneShot' ? 'dead' : this.loopCondition === 'looping' ? 'rest' : 'active'); break;
        default: this.#switchTo('dead');
      }
    }
    this.#stateDuration -= remaining;
    return this.#state;
  }

  #switchTo(state: SpawnerState): void {
    this.#state = state;
    const random = () => seedFloat(this.#seed, this.#offset++);
    if (state === 'active') this.#stateDuration = this.duration[0] + (this.duration[1] - this.duration[0]) * random();
    else if (state === 'rest') this.#stateDuration = this.delay[0] + (this.delay[1] - this.delay[0]) * random();
    else this.#stateDuration = 10;
  }
}

/** 每秒生成 SpawnCount 个（Stride 的 SpawnerPerSecond），小数部分累积到下一帧。 */
export class SpawnerPerSecond extends ParticleSpawner {
  readonly spawnCount: number;
  #carryOver = 0;

  constructor(file: ParticleModuleFile) {
    super(file);
    this.spawnCount = value(file, 'spawnCount', 100);
  }

  maxParticlesPerSecond(): number {
    return Math.ceil(this.spawnCount);
  }

  spawn(dt: number, target: SpawnTarget): void {
    if (this.updatedState(dt, target) !== 'active') return;
    const toSpawn = this.spawnCount * dt + this.#carryOver;
    const whole = Math.floor(toSpawn);
    this.#carryOver = toSpawn - whole;
    target.emit(whole);
  }
}

/** 每帧生成 SpawnCount 个（Stride 的 SpawnerPerFrame），和帧率无关；Framerate 只用来估计粒子池的大小。 */
export class SpawnerPerFrame extends ParticleSpawner {
  readonly spawnCount: number;
  readonly framerate: number;
  #carryOver = 0;

  constructor(file: ParticleModuleFile) {
    super(file);
    this.spawnCount = value(file, 'spawnCount', 1);
    this.framerate = value(file, 'framerate', 60);
  }

  maxParticlesPerSecond(): number {
    return Math.ceil(this.spawnCount * this.framerate);
  }

  spawn(dt: number, target: SpawnTarget): void {
    if (this.updatedState(dt, target) !== 'active') return;
    const toSpawn = this.spawnCount + this.#carryOver;
    const whole = Math.floor(toSpawn);
    this.#carryOver = toSpawn - whole;
    target.emit(whole);
  }
}

// —— 初始化器 ——

/** 新生成的粒子是 [start, end)（按 capacity 绕回，同 Stride 的 Initialize 的下标约定）。 */
export interface SpawnedRange {
  readonly start: number;
  readonly end: number;
  readonly capacity: number;
}

export function forEachSpawned({ start, end, capacity }: SpawnedRange, visit: (index: number) => void): void {
  for (let i = start; i !== end; i = (i + 1) % capacity) visit(i);
}

export abstract class ParticleInitializer extends ParticleModule {
  abstract initialize(pool: ParticlePool, range: SpawnedRange): void;
}

/** 大小在 RandomSize 之间随机（Stride 的 InitialSizeSeed），乘上世界缩放。 */
export class InitialSizeSeed extends ParticleInitializer {
  readonly requiredFields = ['size', 'randomSeed'] as const;
  readonly seedOffset: number;
  readonly randomSize: [number, number];

  constructor(file: ParticleModuleFile) {
    super(file);
    this.seedOffset = value(file, 'seedOffset', 0);
    this.randomSize = [...value(file, 'randomSize', [0.5, 1])] as [number, number];
  }

  initialize(pool: ParticlePool, range: SpawnedRange): void {
    const size = pool.field('size');
    if (!size) return;
    const seeds = pool.seeds;
    const min = this.worldScale[0] * this.randomSize[0];
    const gap = this.worldScale[0] * this.randomSize[1] - min;
    forEachSpawned(range, (i) => {
      size[i] = min + gap * seedFloat(seeds[i]!, RandomOffset.offset1A + this.seedOffset);
    });
  }
}

/** 在 min 到 max 的盒子里随机一个向量：盒子按模块的世界缩放、旋转变换（PositionSeed、VelocitySeed 共用）。 */
function randomBox(module: ParticleTransform, min: Readonly<Vec3>, max: Readonly<Vec3>, seedOffset: number, translate: boolean) {
  const scale = module.worldScale;
  const corner: Vec3 = [min[0] * scale[0], min[1] * scale[1], min[2] * scale[2]];
  const axes: Vec3[] = [[max[0] * scale[0] - corner[0], 0, 0], [0, max[1] * scale[1] - corner[1], 0], [0, 0, max[2] * scale[2] - corner[2]]];
  if (!isIdentity(module.worldRotation)) {
    rotate(module.worldRotation, corner);
    for (const axis of axes) rotate(module.worldRotation, axis);
  }
  if (translate) for (let k = 0; k < 3; k++) corner[k]! += module.worldPosition[k]!;
  const offsets = [RandomOffset.offset3A, RandomOffset.offset3B, RandomOffset.offset3C];
  return (seed: number, out: Float32Array, at: number) => {
    const r = offsets.map((offset) => seedFloat(seed, offset + seedOffset));
    for (let k = 0; k < 3; k++) out[at + k] = corner[k]! + axes[0]![k]! * r[0]! + axes[1]![k]! * r[1]! + axes[2]![k]! * r[2]!;
  };
}

/** 位置在 PositionMin 到 PositionMax 的盒子里随机（Stride 的 InitialPositionSeed），旧位置跟着设。没有 Interpolate。 */
export class InitialPositionSeed extends ParticleInitializer {
  readonly requiredFields = ['position', 'randomSeed'] as const;
  readonly seedOffset: number;
  readonly positionMin: Vec3;
  readonly positionMax: Vec3;

  constructor(file: ParticleModuleFile) {
    super(file);
    this.seedOffset = value(file, 'seedOffset', 0);
    this.positionMin = vec3(file, 'positionMin', [-1, 1, -1]);
    this.positionMax = vec3(file, 'positionMax', [1, 1, 1]);
  }

  initialize(pool: ParticlePool, range: SpawnedRange): void {
    const position = pool.field('position');
    if (!position) return;
    const old = pool.field('oldPosition');
    const seeds = pool.seeds;
    const sample = randomBox(this, this.positionMin, this.positionMax, this.seedOffset, true);
    forEachSpawned(range, (i) => {
      sample(seeds[i]!, position, i * 3);
      old?.set(position.subarray(i * 3, i * 3 + 3), i * 3);
    });
  }
}

/** 速度在 VelocityMin 到 VelocityMax 的盒子里随机（Stride 的 InitialVelocitySeed）。 */
export class InitialVelocitySeed extends ParticleInitializer {
  readonly requiredFields = ['velocity', 'randomSeed'] as const;
  readonly seedOffset: number;
  readonly velocityMin: Vec3;
  readonly velocityMax: Vec3;

  constructor(file: ParticleModuleFile) {
    super(file);
    this.seedOffset = value(file, 'seedOffset', 0);
    this.velocityMin = vec3(file, 'velocityMin', [-1, 1, -1]);
    this.velocityMax = vec3(file, 'velocityMax', [1, 1, 1]);
  }

  initialize(pool: ParticlePool, range: SpawnedRange): void {
    const velocity = pool.field('velocity');
    if (!velocity) return;
    const seeds = pool.seeds;
    const sample = randomBox(this, this.velocityMin, this.velocityMax, this.seedOffset, false);
    forEachSpawned(range, (i) => sample(seeds[i]!, velocity, i * 3));
  }
}

/** 朝向在两个四元数之间球面插值（Stride 的 Initial3DRotationSeed），再转上世界旋转。 */
export class Initial3DRotationSeed extends ParticleInitializer {
  readonly requiredFields = ['quaternion', 'randomSeed'] as const;
  readonly seedOffset: number;
  readonly rotationMin: Quat;
  readonly rotationMax: Quat;

  constructor(file: ParticleModuleFile) {
    super(file);
    this.seedOffset = value(file, 'seedOffset', 0);
    this.rotationMin = quat(file, 'rotationQuaternionMin', [0, 0, 0, 1]);
    this.rotationMax = quat(file, 'rotationQuaternionMax', [0, 0, 0, 1]);
  }

  initialize(pool: ParticlePool, range: SpawnedRange): void {
    const quaternion = pool.field('quaternion');
    if (!quaternion) return;
    const seeds = pool.seeds;
    forEachSpawned(range, (i) => {
      const random = normalize(slerp(this.rotationMin, this.rotationMax, seedFloat(seeds[i]!, RandomOffset.offset1A + this.seedOffset)));
      quaternion.set(combine(random, this.worldRotation), i * 4);
    });
  }
}

/** 颜色在 ColorMin 到 ColorMax 之间线性插值（Stride 的 InitialColorSeed），存成预乘 alpha 的。 */
export class InitialColorSeed extends ParticleInitializer {
  readonly requiredFields = ['color', 'randomSeed'] as const;
  readonly seedOffset: number;
  readonly colorMin: [number, number, number, number];
  readonly colorMax: [number, number, number, number];

  constructor(file: ParticleModuleFile) {
    super(file);
    this.seedOffset = value(file, 'seedOffset', 0);
    this.colorMin = [...value(file, 'colorMin', [1, 1, 1, 1])] as [number, number, number, number];
    this.colorMax = [...value(file, 'colorMax', [1, 1, 1, 1])] as [number, number, number, number];
  }

  initialize(pool: ParticlePool, range: SpawnedRange): void {
    const color = pool.field('color');
    if (!color) return;
    const seeds = pool.seeds;
    forEachSpawned(range, (i) => {
      const t = seedFloat(seeds[i]!, RandomOffset.offset1A + this.seedOffset);
      const a = this.colorMin[3] + (this.colorMax[3] - this.colorMin[3]) * t;
      for (let k = 0; k < 3; k++) color[i * 4 + k] = (this.colorMin[k]! + (this.colorMax[k]! - this.colorMin[k]!) * t) * a;
      color[i * 4 + 3] = a;
    });
  }
}

// —— 更新器 ——

export abstract class ParticleUpdater extends ParticleModule {
  /** 生成新粒子之后再跑（Stride 的 IsPostUpdater）。 */
  readonly isPostUpdater: boolean = false;
  abstract update(dt: number, pool: ParticlePool): void;
  /** 按父变换算世界变换（力场还要记下父变换的缩放）。 */
  setParentTransform(parent: ParticleTransform): void {
    this.setParent(parent);
  }
}

/** 力场的衰减（Stride 的 FieldFalloff）：到场中心的相对距离在 FalloffStart 以内是 StrengthInside，FalloffEnd 以外是 StrengthOutside。 */
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
    // 和 Stride 不同：除以区间的长度（Stride 除以 FalloffEnd / FalloffStart，见文件开头）
    const t = (distance - this.falloffStart) / (this.falloffEnd - this.falloffStart);
    return this.strengthInside + (this.strengthOutside - this.strengthInside) * t;
  }
}

/** 球形的场（Stride 的 FieldShapes.Sphere）。 */
export class FieldShapeSphere {
  readonly radius: number;
  #position: Vec3 = [0, 0, 0];
  #inverseRotation: Quat = [0, 0, 0, 1];
  #size: Vec3 = [1, 1, 1];
  #mainAxis: Vec3 = [0, 1, 0];

  constructor(file: ParticleModuleFile = {}) {
    const radius = value(file, 'radius', 1);
    this.radius = radius > ZERO_TOLERANCE ? radius : ZERO_TOLERANCE;
  }

  prepare(position: Readonly<Vec3>, rotation: Readonly<Quat>, size: Readonly<Vec3>): void {
    this.#position = [...position];
    this.#size = [...size];
    this.#inverseRotation = [-rotation[0], -rotation[1], -rotation[2], rotation[3]];
    this.#mainAxis = rotate(rotation, [0, 1, 0]);
  }

  /** 粒子到场中心的相对距离（1 是球面），写出沿轴、绕轴、离开中心的三个方向。 */
  distance(position: Readonly<Vec3>, along: Vec3, around: Vec3, away: Vec3): number {
    along.splice(0, 3, ...this.#mainAxis);
    const local: Vec3 = [position[0] - this.#position[0], position[1] - this.#position[1], position[2] - this.#position[2]];
    away.splice(0, 3, ...normalize([...local]));
    around.splice(0, 3, along[1] * away[2] - along[2] * away[1], along[2] * away[0] - along[0] * away[2], along[0] * away[1] - along[1] * away[0]);
    rotate(this.#inverseRotation, local);
    for (let k = 0; k < 3; k++) local[k]! /= this.#size[k]!;
    return Math.hypot(...local) / this.radius;
  }
}

/**
 * 力场（Stride 的 UpdaterForceField）：沿场的轴（ForceDirected）、绕轴（ForceVortex）、离开中心（ForceRepulsive）和固定方向
 * （ForceFixed）的力，按场的形状和衰减算大小。EnergyConservation 是力加到速度上的比例，其余直接推位置。
 */
export class UpdaterForceField extends ParticleUpdater {
  readonly requiredFields = ['position', 'velocity'] as const;
  readonly fieldShape: FieldShapeSphere | null;
  readonly falloff: FieldFalloff;
  readonly energyConservation: number;
  readonly forceDirected: number;
  readonly forceVortex: number;
  readonly forceRepulsive: number;
  readonly forceFixed: Vec3;
  #parentScale = 1;

  constructor(file: ParticleModuleFile) {
    super(file);
    const shape = file['fieldShape'] as ParticleModuleFile | null | undefined;
    this.fieldShape = shape?.$type === 'fieldShapeSphere' ? new FieldShapeSphere(shape) : null;
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
      if (this.fieldShape) {
        p[0] = position[i * 3]!; p[1] = position[i * 3 + 1]!; p[2] = position[i * 3 + 2]!;
        magnitude = this.falloff.strength(this.fieldShape.distance(p, along, around, away));
      }
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

// —— 按文件建模块 ——

export function createSpawner(file: ParticleModuleFile): ParticleSpawner | undefined {
  switch (file.$type) {
    case 'spawnerPerSecond': return new SpawnerPerSecond(file);
    case 'spawnerPerFrame': return new SpawnerPerFrame(file);
    default: return undefined;
  }
}

export function createInitializer(file: ParticleModuleFile): ParticleInitializer | undefined {
  switch (file.$type) {
    case 'initialSizeSeed': return new InitialSizeSeed(file);
    case 'initialPositionSeed': return new InitialPositionSeed(file);
    case 'initialVelocitySeed': return new InitialVelocitySeed(file);
    case 'initial3DRotationSeed': return new Initial3DRotationSeed(file);
    case 'initialColorSeed': return new InitialColorSeed(file);
    default: return undefined;
  }
}

export function createUpdater(file: ParticleModuleFile): ParticleUpdater | undefined {
  return file.$type === 'updaterForceField' ? new UpdaterForceField(file) : undefined;
}
