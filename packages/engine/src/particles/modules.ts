/**
 * 粒子的模块（Stride 的 Spawners、Initializers），按导入的 ParticleModuleFile 建，没写的属性取 Stride 的默认值。
 * 现在有的：生成器 PerSecond、PerFrame；初始化器 SizeSeed、PositionSeed、PositionArc、VelocitySeed、DirectionSeed、
 * RotationSeed、3DRotationSeed、ColorSeed、SpawnOrder。更新器见 updaters.ts，力场和碰撞的形状见 fieldShapes.ts。导入器只留下
 * 运行时认识的（见 pipeline 的 particles.ts）。
 */
import type { ParticleModuleFile, ParticleValue } from '../content/format';
import type { MaterialContext } from './material';
import { isIdentity, normalize, rotate, slerp, combine, type Quat, type Vec3 } from './math';
import type { AnyParticleField, ParticlePool } from './ParticlePool';
import { RandomOffset, seedFloat, type RandomSeedGenerator } from './random';

const DEGREES = Math.PI / 180;

/** 粒子模块的种类：游戏的模块类继承对应的基类（ParticleSpawner、ParticleInitializer、ParticleUpdater、ParticleShapeBuilder、ParticleMaterial）。 */
export type ParticleModuleKind = 'spawner' | 'initializer' | 'updater' | 'shape' | 'material';

/** 游戏登记的粒子模块类：构造参数是场景里的属性。 */
export interface ParticleModuleClass {
  readonly particleModuleKind: ParticleModuleKind;
  new (file: ParticleModuleFile): object;
}

/** 建模块时要的外部东西：贴图和着色器类（材质用）、场景里实体的世界位置（InitialPositionArc 的 Target 用）、游戏登记的模块。 */
export interface ParticleContext extends MaterialContext {
  /** 场景里的实体（id 同场景文件）现在的世界位置；不在场景里时是 undefined。 */
  readonly entityPosition: (id: string) => Readonly<Vec3> | undefined;
  /** 按类型名（场景文件里的 $type）找游戏登记的模块类（见 Registry.particleModule）。 */
  readonly module: (type: string) => ParticleModuleClass | undefined;
}

export const NO_CONTEXT: ParticleContext = { texture: () => undefined, shaderClass: () => undefined, entityPosition: () => undefined, module: () => undefined };

/** 模块文件里的值：没写时取默认值。 */
export function value<T extends ParticleValue>(file: ParticleModuleFile | undefined, key: string, fallback: T): T {
  const found = file?.[key];
  return (found === undefined || found === null ? fallback : found) as T;
}

export const vec3 = (file: ParticleModuleFile, key: string, fallback: Vec3): Vec3 => [...value(file, key, fallback)] as Vec3;
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
  abstract readonly requiredFields: readonly AnyParticleField[];

  constructor(file: ParticleModuleFile) {
    super(file);
    this.enabled = value(file, 'enabled', true);
  }
}

// —— 生成器 ——

/** 生成器要的发射器的部分。 */
export interface SpawnTarget {
  readonly seedGenerator: RandomSeedGenerator;
  /** 粒子系统现在的位置（Stride 的 CachedParticleSystem.Translation）。 */
  readonly systemTranslation: Readonly<Vec3>;
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
  /** Registry 按它认出粒子模块。 */
  static readonly particleModuleKind: ParticleModuleKind = 'spawner';
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

  /** 状态换了（Stride 的 NotifyStateSwitch）。 */
  protected onStateSwitch(_state: SpawnerState): void {}

  #switchTo(state: SpawnerState): void {
    this.#state = state;
    this.onStateSwitch(state);
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

/** 每次进入活跃状态时一次生成 SpawnCount 个（Stride 的 SpawnerBurst，枪口火焰、弹孔）。 */
export class SpawnerBurst extends ParticleSpawner {
  readonly spawnCount: number;
  #hasBursted = false;

  constructor(file: ParticleModuleFile) {
    super(file);
    this.spawnCount = Math.max(1, value(file, 'spawnCount', 100));
  }

  maxParticlesPerSecond(): number {
    const delay = Math.min(...this.delay) + Math.min(...this.duration);
    const times = Math.max(1, delay <= 0.01 ? 100 : 1 / delay);
    return Math.ceil(this.spawnCount * times);
  }

  spawn(dt: number, target: SpawnTarget): void {
    if (this.updatedState(dt, target) !== 'active') {
      this.#hasBursted = false;
      return;
    }
    if (this.#hasBursted) return;
    this.#hasBursted = true;
    target.emit(this.spawnCount);
  }

  protected override onStateSwitch(state: SpawnerState): void {
    if (state !== 'active') this.#hasBursted = false;
  }

  override resetSimulation(): void {
    super.resetSimulation();
    this.#hasBursted = false;
  }
}

/** 粒子系统每移动一米生成 SpawnCount 个（Stride 的 SpawnerFromDistance，受击的拖尾），小数部分累积；刚活跃的那一帧只记下位置。 */
export class SpawnerFromDistance extends ParticleSpawner {
  readonly spawnCount: number;
  #carryOver = 0;
  #hasBegun = false;
  readonly #oldPosition: Vec3 = [0, 0, 0];

  constructor(file: ParticleModuleFile) {
    super(file);
    this.spawnCount = value(file, 'spawnCount', 100);
  }

  maxParticlesPerSecond(): number {
    return Math.ceil(this.spawnCount);
  }

  spawn(dt: number, target: SpawnTarget): void {
    if (this.updatedState(dt, target) !== 'active') {
      this.#hasBegun = false;
      return;
    }
    const [x, y, z] = target.systemTranslation;
    const [ox, oy, oz] = this.#oldPosition;
    this.#oldPosition[0] = x;
    this.#oldPosition[1] = y;
    this.#oldPosition[2] = z;
    if (!this.#hasBegun) {
      this.#hasBegun = true;
      return;
    }
    const toSpawn = this.spawnCount * Math.hypot(x - ox, y - oy, z - oz) + this.#carryOver;
    const whole = Math.floor(toSpawn);
    this.#carryOver = toSpawn - whole;
    target.emit(whole);
  }

  override resetSimulation(): void {
    super.resetSimulation();
    this.#hasBegun = false;
    this.#carryOver = 0;
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
  /** Registry 按它认出粒子模块。 */
  static readonly particleModuleKind: ParticleModuleKind = 'initializer';

  abstract initialize(pool: ParticlePool, range: SpawnedRange): void;

  /** 重新开始模拟时清掉自己的状态（Stride 的 ResetSimulation）。 */
  resetSimulation(): void {}
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

/**
 * min 到 max 的盒子按模块的世界缩放、旋转（translate 时再加位置）变换以后：一个角和三条边。盒子里的随机点是
 * 角 + 边 · 随机数（randomBox；GPU 的粒子把角和边打包给着色器）。
 */
export function boxFrame(module: ParticleTransform, min: Readonly<Vec3>, max: Readonly<Vec3>, translate: boolean): { corner: Vec3; axes: [Vec3, Vec3, Vec3] } {
  const scale = module.worldScale;
  const corner: Vec3 = [min[0] * scale[0], min[1] * scale[1], min[2] * scale[2]];
  const axes: [Vec3, Vec3, Vec3] = [[max[0] * scale[0] - corner[0], 0, 0], [0, max[1] * scale[1] - corner[1], 0], [0, 0, max[2] * scale[2] - corner[2]]];
  if (!isIdentity(module.worldRotation)) {
    rotate(module.worldRotation, corner);
    for (const axis of axes) rotate(module.worldRotation, axis);
  }
  if (translate) for (let k = 0; k < 3; k++) corner[k]! += module.worldPosition[k]!;
  return { corner, axes };
}

/** 在 min 到 max 的盒子里随机一个向量：盒子按模块的世界缩放、旋转变换（PositionSeed、VelocitySeed 共用）。 */
export function randomBox(module: ParticleTransform, min: Readonly<Vec3>, max: Readonly<Vec3>, seedOffset: number, translate: boolean) {
  const { corner, axes } = boxFrame(module, min, max, translate);
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

/**
 * 位置在发射器到目标的弧线上（Stride 的 InitialPositionArc，激光用）：目标是场景里的实体（Target，没有时 FallbackTarget 是相对
 * 发射器的位置），弧线在中间抬高 ArcHeight（沿模块的上方），再加上 PositionMin 到 PositionMax 的随机偏移（两头为 0、中间最大）。
 * Sequential 时这一批新粒子沿弧线均匀排开（FixedLength 大于 0 时按粒子池的下标模 FixedLength 排），否则随机。
 */
export class InitialPositionArc extends ParticleInitializer {
  readonly requiredFields = ['position', 'randomSeed'] as const;
  readonly seedOffset: number;
  readonly target: string | undefined;
  readonly fallbackTarget: Vec3;
  readonly arcHeight: number;
  readonly sequential: boolean;
  readonly fixedLength: number;
  readonly positionMin: Vec3;
  readonly positionMax: Vec3;
  readonly #entityPosition: ParticleContext['entityPosition'];

  constructor(file: ParticleModuleFile, context: ParticleContext) {
    super(file);
    this.seedOffset = value(file, 'seedOffset', 0);
    const target = file['target'] as { readonly $entity?: string } | null | undefined;
    this.target = target?.$entity;
    this.fallbackTarget = vec3(file, 'fallbackTarget', [0, 0, -1]);
    this.arcHeight = value(file, 'arcHeight', 1);
    this.sequential = value(file, 'sequential', true);
    this.fixedLength = value(file, 'fixedLength', 0);
    this.positionMin = vec3(file, 'positionMin', [-0.3, -0.3, -0.3]);
    this.positionMax = vec3(file, 'positionMax', [0.3, 0.3, 0.3]);
    this.#entityPosition = context.entityPosition;
  }

  initialize(pool: ParticlePool, range: SpawnedRange): void {
    const position = pool.field('position');
    if (!position) return;
    const seeds = pool.seeds;
    const arc = rotate(this.worldRotation, [0, this.arcHeight, 0]);
    const sample = randomBox(this, this.positionMin, this.positionMax, this.seedOffset, false);
    const targetPosition = this.target === undefined ? undefined : this.#entityPosition(this.target);
    const toTarget: Vec3 = targetPosition ? [0, 1, 2].map((k) => targetPosition[k]! - this.worldPosition[k]!) as Vec3 : [...this.fallbackTarget];
    const { start, end, capacity } = range;
    const lessOne = this.fixedLength > 0 ? this.fixedLength - 1 : start < end ? end - start - 1 : end - start + capacity - 1;
    const stepSize = lessOne > 1 ? 1 / lessOne : 1;
    let step = -stepSize;
    const offset = new Float32Array(3);
    forEachSpawned(range, (i) => {
      const seed = seeds[i]!;
      if (!this.sequential) step = seedFloat(seed, RandomOffset.offset1A + this.seedOffset);
      else step = this.fixedLength > 0 ? (i % this.fixedLength) * stepSize : step + stepSize;
      // 弧线的抬高和随机偏移都按 sin(π · step)：两头为 0
      const bulge = Math.sin(step * Math.PI);
      sample(seed, offset, 0);
      for (let k = 0; k < 3; k++) position[i * 3 + k] = offset[k]! * bulge + toTarget[k]! * step + arc[k]! * bulge + this.worldPosition[k]!;
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

/** 方向在 DirectionMin 到 DirectionMax 的盒子里随机（Stride 的 InitialDirectionSeed，Trail 按它定宽度）。 */
export class InitialDirectionSeed extends ParticleInitializer {
  readonly requiredFields = ['direction', 'randomSeed'] as const;
  readonly seedOffset: number;
  readonly directionMin: Vec3;
  readonly directionMax: Vec3;

  constructor(file: ParticleModuleFile) {
    super(file);
    this.seedOffset = value(file, 'seedOffset', 0);
    this.directionMin = vec3(file, 'directionMin', [-1, 1, -1]);
    this.directionMax = vec3(file, 'directionMax', [1, 1, 1]);
  }

  initialize(pool: ParticlePool, range: SpawnedRange): void {
    const direction = pool.field('direction');
    if (!direction) return;
    const seeds = pool.seeds;
    const sample = randomBox(this, this.directionMin, this.directionMax, this.seedOffset, false);
    forEachSpawned(range, (i) => sample(seeds[i]!, direction, i * 3));
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

/** 平面内的转角在 AngularRotation（度）之间随机（Stride 的 InitialRotationSeed，Billboard、Hexagon 按它转）。 */
export class InitialRotationSeed extends ParticleInitializer {
  readonly requiredFields = ['rotation', 'randomSeed'] as const;
  readonly seedOffset: number;
  readonly angularRotation: [number, number];

  constructor(file: ParticleModuleFile) {
    super(file);
    this.seedOffset = value(file, 'seedOffset', 0);
    this.angularRotation = [...value(file, 'angularRotation', [-60, 60])] as [number, number];
  }

  initialize(pool: ParticlePool, range: SpawnedRange): void {
    const rotation = pool.field('rotation');
    if (!rotation) return;
    const seeds = pool.seeds;
    const start = this.angularRotation[0] * DEGREES, step = (this.angularRotation[1] - this.angularRotation[0]) * DEGREES;
    forEachSpawned(range, (i) => {
      rotation[i] = start + step * seedFloat(seeds[i]!, RandomOffset.offset1A + this.seedOffset);
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

/**
 * 生成的顺序（Stride 的 InitialSpawnOrder）：每个新粒子取下一个序号（重新开始模拟时从 0 起）。飘带和拖尾按它连起来，
 * 所以这种发射器的 SortingPolicy 一般是 ByOrder。
 */
export class InitialSpawnOrder extends ParticleInitializer {
  readonly requiredFields = ['order'] as const;
  #next = 0;

  initialize(pool: ParticlePool, range: SpawnedRange): void {
    const order = pool.integers('order');
    if (!order) return;
    const childOrder = pool.integers('childOrder');
    forEachSpawned(range, (i) => {
      order[i] = this.#next;
      this.#next = (this.#next + 1) >>> 0;
      if (childOrder) childOrder[i] = 0;
    });
  }

  override resetSimulation(): void {
    this.#next = 0;
  }
}

// —— 按文件建模块 ——

export function createSpawner(file: ParticleModuleFile): ParticleSpawner | undefined {
  switch (file.$type) {
    case 'spawnerPerSecond': return new SpawnerPerSecond(file);
    case 'spawnerPerFrame': return new SpawnerPerFrame(file);
    case 'spawnerBurst': return new SpawnerBurst(file);
    case 'spawnerFromDistance': return new SpawnerFromDistance(file);
    default: return undefined;
  }
}

export function createInitializer(file: ParticleModuleFile, context: ParticleContext): ParticleInitializer | undefined {
  switch (file.$type) {
    case 'initialSizeSeed': return new InitialSizeSeed(file);
    case 'initialPositionSeed': return new InitialPositionSeed(file);
    case 'initialPositionArc': return new InitialPositionArc(file, context);
    case 'initialVelocitySeed': return new InitialVelocitySeed(file);
    case 'initialDirectionSeed': return new InitialDirectionSeed(file);
    case 'initialSpawnOrder': return new InitialSpawnOrder(file);
    case 'initialRotationSeed': return new InitialRotationSeed(file);
    case 'initial3DRotationSeed': return new Initial3DRotationSeed(file);
    case 'initialColorSeed': return new InitialColorSeed(file);
    default: return undefined;
  }
}
