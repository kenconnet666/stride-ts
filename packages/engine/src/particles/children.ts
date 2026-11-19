/**
 * 子粒子（Stride 的 SpawnerFromParent 和 ParticleChildInitializer）：一个发射器按名字（ParentName）认同一个粒子系统里的另一个
 * 发射器（也可以是自己）做父发射器，父粒子触发时生成子粒子，子粒子的位置、颜色、速度、顺序从父粒子继承。
 *
 * 父发射器要多存的字段由子发射器的模块在连接时加上（Stride 的 AddRequiredField）：SpawnerFromParent 按 ParentControlFlag
 * 选的一组生成控制（这一帧每个父粒子要生成几个子粒子），触发器要的字段，InitialOrderParent 的 ChildOrder。有 SpawnerFromParent
 * 的父发射器把寿命到了的粒子多留一帧（Stride 的 DelayParticleDeath），死亡触发才看得到。
 *
 * 父粒子和新的子粒子怎么对应：父发射器有生成控制时按顺序，每个父粒子分到它这一帧要生成的个数（分完了剩下的新粒子不再初始化，
 * 同 Stride）；没有时每个子粒子随机挑一个父粒子。父发射器是局部模拟时，继承来的位置、速度按子模块的世界变换换过来。
 */
import type { ParticleModuleFile } from '../content/format';
import type { Vec3 } from './math';
import { forEachSpawned, ParticleInitializer, ParticleSpawner, randomBox, value, vec3, type SpawnedRange, type SpawnTarget } from './modules';
import { CHILDREN_FIELDS, type ParticleField, type ParticlePool } from './ParticlePool';
import { RandomOffset, seedFloat } from './random';

const ZERO_TOLERANCE = 1e-6;
/** 生成顺序的两种分法（Stride 的 SpawnOrderConst）：有 ChildOrder 时父粒子的序号占高 16 位，没有时占高 12 位。 */
const GROUP_BIT_OFFSET = 16, GROUP_BIT_MASK = 0xffff0000, AUXILIARY_BIT_MASK = 0x0000ffff;
const LARGE_GROUP_BIT_OFFSET = 20, LARGE_GROUP_BIT_MASK = 0xfff00000, LARGE_AUXILIARY_BIT_MASK = 0x000fffff;

/** 子模块看到的父发射器。 */
export interface ParentEmitter {
  readonly name: string;
  readonly pool: ParticlePool;
  readonly simulationSpace: 'world' | 'local';
  /** 父粒子要多存的字段。 */
  requireField(field: ParticleField): void;
  /** 寿命到了的粒子多留一帧（有子粒子生成器连着时加一）。 */
  delayParticleDeath: number;
}

/** 连着父发射器的模块：发射器建好以后，粒子系统按 parentName 找到父发射器交给它。 */
export interface ChildModule {
  readonly parentName: string;
  linkParent(parent: ParentEmitter | undefined): void;
}

export function isChildModule(module: object): module is ChildModule {
  return 'linkParent' in module;
}

/** ParentControlFlag：Group00 到 Group03 是生成控制的哪一组，None 是不用。 */
function controlGroup(file: ParticleModuleFile): number | undefined {
  const flag = value(file, 'parentControlFlag', 'group00');
  const group = /^group0(\d)$/.exec(flag)?.[1];
  return group === undefined ? undefined : Number(group);
}

// —— 生成子粒子 ——

/** 父粒子什么时候生成子粒子（Stride 的 ParticleSpawnTrigger）：返回生成个数的倍数，0 是不生成。 */
interface SpawnTrigger {
  readonly parentFields: readonly ParticleField[];
  triggered(pool: ParticlePool, i: number): number;
}

function createTrigger(file: ParticleModuleFile | null | undefined): SpawnTrigger | undefined {
  switch (file?.$type) {
    case 'particleSpawnTriggerLifetime': {
      // 走过的寿命在 [下限, 上限] 里时触发；下限比上限大时是这个区间以外
      const lower = value(file, 'lifetimeLowerLimit', 0), upper = value(file, 'lifetimeUpperLimit', 1);
      const inOrder = lower <= upper;
      return {
        parentFields: ['life'],
        triggered: (pool, i) => {
          const age = 1 - pool.field('life')![i]!;
          return ((age >= lower) !== (age <= upper)) !== inOrder ? 1 : 0;
        },
      };
    }
    case 'particleSpawnTriggerDeath':
      return { parentFields: ['life'], triggered: (pool, i) => (pool.field('life')![i]! <= ZERO_TOLERANCE ? 1 : 0) };
    case 'particleSpawnTriggerCollision':
      // 父发射器要有碰撞（UpdaterCollider 写 collision 字段）
      return { parentFields: [], triggered: (pool, i) => (pool.field('collision')?.[i] ? 1 : 0) };
    case 'particleSpawnTriggerDistance':
      // 按这一帧走过的距离成比例地生成
      return {
        parentFields: ['position', 'oldPosition'],
        triggered: (pool, i) => {
          const position = pool.field('position')!, old = pool.field('oldPosition')!;
          return Math.hypot(position[i * 3]! - old[i * 3]!, position[i * 3 + 1]! - old[i * 3 + 1]!, position[i * 3 + 2]! - old[i * 3 + 2]!);
        },
      };
    default:
      return undefined;
  }
}

/**
 * 从父粒子生成（Stride 的 SpawnerFromParent）：父粒子触发时生成 SpawnCount（在范围里按父粒子的种子取，0 到 250）乘触发倍数个，
 * 小数部分按父粒子累积。个数记在父粒子的生成控制里，子初始化器按它对应父粒子。
 */
export class SpawnerFromParent extends ParticleSpawner implements ChildModule {
  readonly parentName: string;
  readonly controlGroup: number | undefined;
  readonly trigger: SpawnTrigger | undefined;
  readonly spawnCount: [number, number];
  #parent: ParentEmitter | undefined;

  constructor(file: ParticleModuleFile) {
    super(file);
    this.parentName = value(file, 'parentName', '');
    this.controlGroup = controlGroup(file);
    this.trigger = createTrigger(file['particleSpawnTrigger'] as ParticleModuleFile | null | undefined);
    this.spawnCount = value(file, 'spawnCount', [2, 5]).map((count) => Math.min(Math.max(count, 0), 250)) as [number, number];
  }

  linkParent(parent: ParentEmitter | undefined): void {
    this.#parent = parent;
    if (!parent) return;
    for (const field of this.trigger?.parentFields ?? []) parent.requireField(field);
    if (this.controlGroup === undefined) return;
    parent.requireField(CHILDREN_FIELDS[this.controlGroup]!);
    parent.delayParticleDeath++;
  }

  maxParticlesPerSecond(): number {
    return Math.ceil(Math.max(...this.spawnCount));
  }

  spawn(dt: number, target: SpawnTarget): void {
    if (this.updatedState(dt, target) !== 'active') return;
    const pool = this.#parent?.pool;
    if (!pool || pool.living === 0 || this.controlGroup === undefined) return;
    const control = pool.field(CHILDREN_FIELDS[this.controlGroup]!);
    if (!control) return;
    const seeds = pool.seeds;
    const [min, max] = this.spawnCount;
    let total = 0;
    for (let i = 0; i < pool.living; i++) {
      let toEmit = 0, carryOver = control[i * 2 + 1]!;
      const triggered = this.trigger?.triggered(pool, i) ?? 0;
      if (triggered > 0) {
        const count = (min + (max - min) * seedFloat(seeds[i]!, 0)) * triggered;
        toEmit = Math.floor(count + carryOver);
        carryOver += count - toEmit;
      }
      control[i * 2] = Math.min(toEmit, 255);
      control[i * 2 + 1] = carryOver;
      total += toEmit;
    }
    target.emit(total);
  }
}

// —— 从父粒子继承 ——

/** 从父粒子继承的初始化器（Stride 的 ParticleChildInitializer）。 */
abstract class ParticleChildInitializer extends ParticleInitializer implements ChildModule {
  readonly parentName: string;
  readonly parentSeedOffset: number;
  readonly controlGroup: number | undefined;
  protected parent: ParentEmitter | undefined;
  /** 要从父粒子读的字段（父发射器没有时不继承）。 */
  protected abstract readonly parentField: ParticleField;

  constructor(file: ParticleModuleFile) {
    super(file);
    this.parentName = value(file, 'parentName', '');
    this.parentSeedOffset = value(file, 'parentSeedOffset', 0);
    this.controlGroup = controlGroup(file);
  }

  linkParent(parent: ParentEmitter | undefined): void {
    this.parent = parent;
  }

  /**
   * 按顺序遍历新粒子，visit 收到新粒子和它对应的父粒子（父发射器没有活着的粒子或者没有要读的字段时是 -1）。父粒子按生成控制
   * 分完了就停（剩下的新粒子不初始化，同 Stride）。onNextParent 在按顺序换到下一个父粒子时调用，带上它要生成的个数。
   */
  protected forEachWithParent(pool: ParticlePool, range: SpawnedRange, visit: (i: number, parent: number) => void, onNextParent?: (parent: number, children: number) => void): void {
    const parentPool = this.parent?.pool;
    const living = parentPool && parentPool.has(this.parentField) ? parentPool.living : 0;
    const control = living > 0 && this.controlGroup !== undefined ? parentPool!.field(CHILDREN_FIELDS[this.controlGroup]!) : undefined;
    const seeds = pool.seeds;
    let nextParent = 0, remaining = 0, parent = -1;
    const { start, end, capacity } = range;
    for (let i = start; i !== end; i = (i + 1) % capacity) {
      if (living > 0 && control) {
        while (remaining === 0) {
          if (nextParent >= living) return;
          parent = nextParent++;
          remaining = control[parent * 2]!;
          onNextParent?.(parent, remaining);
        }
        remaining--;
      } else if (living > 0) {
        parent = Math.trunc(living * seedFloat(seeds[i]!, RandomOffset.offset1A + this.parentSeedOffset));
      }
      visit(i, living > 0 ? parent : -1);
    }
  }

  /** 父发射器是局部模拟时，把它的向量按这个模块的世界旋转、缩放（point 时再加上位置）换到世界。 */
  protected toWorld(v: Vec3, point: boolean): void {
    if (this.parent?.simulationSpace !== 'local') return;
    const [qx, qy, qz, qw] = this.worldRotation;
    const tx = 2 * (qy * v[2] - qz * v[1]), ty = 2 * (qz * v[0] - qx * v[2]), tz = 2 * (qx * v[1] - qy * v[0]);
    const rx = v[0] + qw * tx + qy * tz - qz * ty, ry = v[1] + qw * ty + qz * tx - qx * tz, rz = v[2] + qw * tz + qx * ty - qy * tx;
    const scale = this.worldScale[0];
    v[0] = rx * scale + (point ? this.worldPosition[0] : 0);
    v[1] = ry * scale + (point ? this.worldPosition[1] : 0);
    v[2] = rz * scale + (point ? this.worldPosition[2] : 0);
  }
}

/**
 * 位置从父粒子继承（Stride 的 InitialPositionParent）：父粒子的位置加上 PositionMin 到 PositionMax 的随机偏移；没有父粒子时
 * 在模块的位置附近。按顺序对应时，同一个父粒子的子粒子沿它这一帧走过的路均匀排开（父粒子有 OldPosition 时）。
 */
export class InitialPositionParent extends ParticleChildInitializer {
  readonly requiredFields = ['position', 'randomSeed'] as const;
  protected readonly parentField = 'position';
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
    const old = pool.field('oldPosition'), seeds = pool.seeds;
    const parentPool = this.parent?.pool;
    const parentPosition = parentPool?.field('position'), parentOld = parentPool?.field('oldPosition');
    const hasParents = !!parentPosition && parentPool!.living > 0;
    const sample = randomBox(this, this.positionMin, this.positionMax, this.seedOffset, !hasParents);
    let step = 0, travelled = 0;
    const back: Vec3 = [0, 0, 0], p: Vec3 = [0, 0, 0];
    this.forEachWithParent(pool, range, (i, parent) => {
      sample(seeds[i]!, position, i * 3);
      if (parent >= 0) {
        for (let k = 0; k < 3; k++) p[k] = parentPosition![parent * 3 + k]!;
        if (this.controlGroup !== undefined && parentPool!.field(CHILDREN_FIELDS[this.controlGroup]!)) {
          for (let k = 0; k < 3; k++) p[k]! += back[k]! * travelled;
          travelled += step;
        }
        this.toWorld(p, true);
        for (let k = 0; k < 3; k++) position[i * 3 + k]! += p[k]!;
      }
      old?.set(position.subarray(i * 3, i * 3 + 3), i * 3);
    }, (parent, children) => {
      if (!parentOld) return;
      step = children > 0 ? 1 / children : 1;
      travelled = 0;
      for (let k = 0; k < 3; k++) back[k] = parentOld[parent * 3 + k]! - parentPosition![parent * 3 + k]!;
    });
  }
}

/** 颜色从父粒子继承（Stride 的 InitialColorParent）：ColorMin 到 ColorMax 之间随机，乘上父粒子的颜色，存成预乘 alpha 的。 */
export class InitialColorParent extends ParticleChildInitializer {
  readonly requiredFields = ['color', 'randomSeed'] as const;
  protected readonly parentField = 'color';
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
    const seeds = pool.seeds, parentColor = this.parent?.pool.field('color');
    this.forEachWithParent(pool, range, (i, parent) => {
      const t = seedFloat(seeds[i]!, RandomOffset.offset1A + this.seedOffset);
      const c = this.colorMin.map((min, k) => min + (this.colorMax[k]! - min) * t);
      // 父粒子的颜色是预乘过的，照 Stride 直接相乘
      if (parent >= 0) for (let k = 0; k < 4; k++) c[k]! *= parentColor![parent * 4 + k]!;
      const a = c[3]!;
      color.set([c[0]! * a, c[1]! * a, c[2]! * a, a], i * 4);
    });
  }
}

/** 速度从父粒子继承（Stride 的 InitialVelocityParent）：VelocityMin 到 VelocityMax 之间随机，加上父粒子的速度乘 ParentVelocityFactor。 */
export class InitialVelocityParent extends ParticleChildInitializer {
  readonly requiredFields = ['velocity', 'randomSeed'] as const;
  protected readonly parentField = 'velocity';
  readonly seedOffset: number;
  readonly velocityMin: Vec3;
  readonly velocityMax: Vec3;
  readonly parentVelocityFactor: number;

  constructor(file: ParticleModuleFile) {
    super(file);
    this.seedOffset = value(file, 'seedOffset', 0);
    this.velocityMin = vec3(file, 'velocityMin', [-1, 1, -1]);
    this.velocityMax = vec3(file, 'velocityMax', [1, 1, 1]);
    this.parentVelocityFactor = value(file, 'parentVelocityFactor', 0.5);
  }

  initialize(pool: ParticlePool, range: SpawnedRange): void {
    const velocity = pool.field('velocity');
    if (!velocity) return;
    const seeds = pool.seeds, parentVelocity = this.parent?.pool.field('velocity');
    const sample = randomBox(this, this.velocityMin, this.velocityMax, this.seedOffset, false);
    const v: Vec3 = [0, 0, 0];
    this.forEachWithParent(pool, range, (i, parent) => {
      sample(seeds[i]!, velocity, i * 3);
      if (parent < 0) return;
      for (let k = 0; k < 3; k++) v[k] = parentVelocity![parent * 3 + k]!;
      this.toWorld(v, false);
      for (let k = 0; k < 3; k++) velocity[i * 3 + k]! += v[k]! * this.parentVelocityFactor;
    });
  }
}

/**
 * 生成顺序从父粒子继承（Stride 的 InitialOrderParent）：父粒子的序号放在高位，同一个父粒子的子粒子就成了一组（飘带按组断开）；
 * 父发射器有 ChildOrder 时低位是这个父粒子的第几个子粒子，没有时是这个模块自己的计数。
 */
export class InitialOrderParent extends ParticleChildInitializer {
  readonly requiredFields = ['order', 'randomSeed'] as const;
  protected readonly parentField = 'order';
  #next = 0;

  override linkParent(parent: ParentEmitter | undefined): void {
    super.linkParent(parent);
    parent?.requireField('childOrder');
  }

  initialize(pool: ParticlePool, range: SpawnedRange): void {
    const order = pool.integers('order');
    if (!order) return;
    const parentOrder = this.parent?.pool.integers('order'), childOrder = this.parent?.pool.integers('childOrder');
    this.forEachWithParent(pool, range, (i, parent) => {
      let own = this.#next;
      this.#next = (this.#next + 1) >>> 0;
      if (parent >= 0) {
        const group = parentOrder![parent]!;
        if (childOrder) {
          own = childOrder[parent]!;
          childOrder[parent] = (own + 1) >>> 0;
          own = ((own & AUXILIARY_BIT_MASK) | ((group << GROUP_BIT_OFFSET) & GROUP_BIT_MASK)) >>> 0;
        } else {
          own = ((own & LARGE_AUXILIARY_BIT_MASK) | ((group << LARGE_GROUP_BIT_OFFSET) & LARGE_GROUP_BIT_MASK)) >>> 0;
        }
      }
      order[i] = own;
    });
  }

  override resetSimulation(): void {
    this.#next = 0;
  }
}

export function createChildSpawner(file: ParticleModuleFile): ParticleSpawner | undefined {
  return file.$type === 'spawnerFromParent' ? new SpawnerFromParent(file) : undefined;
}

export function createChildInitializer(file: ParticleModuleFile): ParticleInitializer | undefined {
  switch (file.$type) {
    case 'initialPositionParent': return new InitialPositionParent(file);
    case 'initialColorParent': return new InitialColorParent(file);
    case 'initialVelocityParent': return new InitialVelocityParent(file);
    case 'initialOrderParent': return new InitialOrderParent(file);
    default: return undefined;
  }
}

/** 把 range 里新粒子的子粒子控制清零（新粒子的槽可能是删掉的粒子留下的）。 */
export function clearChildren(pool: ParticlePool, range: SpawnedRange): void {
  for (const name of CHILDREN_FIELDS) {
    const control = pool.field(name);
    if (control) forEachSpawned(range, (i) => control.fill(0, i * 2, i * 2 + 2));
  }
}
