/**
 * 发射器（Stride 的 ParticleEmitter）：一个粒子池，按生成器生成、初始化器设初值、更新器每帧改。每帧（Update）：
 * 第一次时按 RandomSeedMethod 建种子序列 → 算模块的世界变换 → 按需要调粒子池的大小 → 按寿命删掉死了的、按速度移动 →
 * 更新器 → 生成新粒子并初始化 → 后置的更新器。顺序同 Stride，固定种子时结果一样。
 *
 * 形状（ShapeBuilder）和材质（Material）是画的时候用的：形状读成 ShapeSettings，材质编译成着色器（material.ts），见粒子的渲染。
 * 子粒子的模块按名字连到同一个粒子系统里的父发射器（children.ts）。
 */
import type { ParticleModuleFile } from '../content/format';
import { compileMaterial, type MaterialProgram } from './material';
import { SHAPES, ShapeSettings } from './shapes';
import { createInitializer, createSpawner, NO_CONTEXT, ParticleTransform, value, type ParticleContext, type ParticleInitializer, type ParticleSpawner, type SpawnedRange } from './modules';
import { createUpdater, type ParticleUpdater } from './updaters';
import { clearChildren, createChildInitializer, createChildSpawner, isChildModule, type ParentEmitter } from './children';
import { ParticlePool, type IntegerField, type ParticleField } from './ParticlePool';
import { RandomOffset, RandomSeedGenerator, seedFloat } from './random';
import type { Quat, Vec3 } from './math';

const ZERO_TOLERANCE = 1e-6;

export type SimulationSpace = 'world' | 'local';
export type RandomSeedMethod = 'time' | 'fixed' | 'position';
export type SortingPolicy = 'none' | 'byDepth' | 'byAge' | 'byOrder';

/** 发射器所在的粒子系统的世界变换（Stride 的 ParticleSystem.Translation、Rotation、UniformScale）。 */
export interface EmitterParent {
  readonly translation: Readonly<Vec3>;
  readonly rotation: Readonly<Quat>;
  readonly uniformScale: number;
}

export class ParticleEmitter implements ParentEmitter {
  readonly name: string;
  enabled: boolean;
  /** 能不能生成新粒子（Stride 的 CanEmitParticles；粒子系统的 Timeout、StopEmitters 关掉）。 */
  canEmitParticles = true;
  readonly maxParticlesOverride: number;
  /** 寿命的范围，秒。 */
  readonly particleLifetime: [number, number];
  readonly simulationSpace: SimulationSpace;
  #randomSeedMethod: RandomSeedMethod;
  readonly sortingPolicy: SortingPolicy;
  readonly drawPriority: number;
  /** 画的时候用：形状和材质（null 是不画）。 */
  readonly shapeBuilder: ParticleModuleFile | null;
  readonly material: ParticleModuleFile | null;
  /** 形状的设置；形状是 null 或者还不认识时 undefined（不画）。 */
  readonly shape: ShapeSettings | undefined;
  /** 材质编译出来的着色器；材质是 null 时 undefined（不画）。 */
  readonly program: MaterialProgram | undefined;
  readonly spawners: readonly ParticleSpawner[];
  readonly initializers: readonly ParticleInitializer[];
  readonly updaters: readonly ParticleUpdater[];
  readonly pool: ParticlePool;
  /** 粒子系统的变换（画局部模拟的粒子时要）。 */
  readonly drawTransform = new ParticleTransform();
  /** 寿命到了的粒子多留一帧（Stride 的 DelayParticleDeath）：连着的子粒子生成器的个数，死亡触发要看到它们。 */
  delayParticleDeath = 0;
  #seedGenerator: RandomSeedGenerator | undefined;
  #initialized = false;
  #poolDirty = true;
  #toSpawn = 0;
  readonly #identity = new ParticleTransform();
  /** 新粒子的默认位置、旋转、大小（Stride 的 InitialDefaultFields）。 */
  #defaults = { position: [0, 0, 0] as Vec3, rotation: [0, 0, 0, 1] as Quat, scale: 1 };

  /** context 给出贴图和场景里的实体（ContentManager 在加载场景时备好）。 */
  constructor(file: ParticleModuleFile, context: ParticleContext = NO_CONTEXT) {
    this.name = value(file, 'emitterName', '');
    this.enabled = value(file, 'enabled', true);
    this.maxParticlesOverride = value(file, 'maxParticlesOverride', 0);
    const lifetime = value(file, 'particleLifetime', [1, 1]);
    // Stride 的 setter 不接受 X <= 0 或 Y < X，保留默认值
    this.particleLifetime = lifetime[0]! > 0 && lifetime[1]! >= lifetime[0]! ? [lifetime[0]!, lifetime[1]!] : [1, 1];
    this.simulationSpace = value(file, 'simulationSpace', 'world') as SimulationSpace;
    this.#randomSeedMethod = value(file, 'randomSeedMethod', 'time') as RandomSeedMethod;
    this.sortingPolicy = value(file, 'sortingPolicy', 'none') as SortingPolicy;
    this.drawPriority = value(file, 'drawPriority', 0);
    this.shapeBuilder = file['shapeBuilder'] === undefined ? { $type: 'shapeBuilderBillboard' } : (file['shapeBuilder'] as ParticleModuleFile | null);
    this.material = file['material'] === undefined ? { $type: 'particleMaterialComputeColor' } : (file['material'] as ParticleModuleFile | null);
    this.shape = this.shapeBuilder && SHAPES.has(String(this.shapeBuilder.$type)) ? new ShapeSettings(this.shapeBuilder) : undefined;
    this.program = this.material ? compileMaterial(this.material, context.texture) : undefined;
    const modules = <T>(key: string, create: (module: ParticleModuleFile) => T | undefined): T[] =>
      ((file[key] as readonly ParticleModuleFile[] | undefined) ?? []).map(create).filter((module): module is T => module !== undefined);
    this.spawners = modules('spawners', (module) => createSpawner(module) ?? createChildSpawner(module));
    this.initializers = modules('initializers', (module) => createInitializer(module, context) ?? createChildInitializer(module));
    this.updaters = modules('updaters', createUpdater);
    const fields = new Set<ParticleField>(['life', 'randomSeed', 'position']);
    for (const module of [...this.initializers, ...this.updaters]) if (module.enabled) for (const field of module.requiredFields) fields.add(field);
    this.pool = new ParticlePool(fields);
  }

  /** 新粒子的种子从哪来：按时间、固定（0 开始）、按粒子系统的位置。改了以后下一帧重建种子序列（同 Stride）。 */
  get randomSeedMethod(): RandomSeedMethod {
    return this.#randomSeedMethod;
  }

  set randomSeedMethod(method: RandomSeedMethod) {
    this.#randomSeedMethod = method;
    this.#initialized = false;
  }

  /** 子粒子的模块按 ParentName 连上父发射器（粒子系统建好所有发射器后调用一次；同名时取第一个，同 Stride）。 */
  linkParents(emitters: readonly ParticleEmitter[]): void {
    for (const module of [...this.spawners, ...this.initializers]) {
      if (isChildModule(module)) module.linkParent(emitters.find((emitter) => emitter.name === module.parentName));
    }
  }

  /** 父粒子要多存的字段（子粒子的模块要的）。 */
  requireField(field: ParticleField): void {
    this.pool.addField(field);
  }

  /** 种子序列（Update 第一次时建）。 */
  get seedGenerator(): RandomSeedGenerator {
    return this.#seedGenerator!;
  }

  markPoolDirty(): void {
    this.#poolDirty = true;
  }

  /** 这一帧再生成 count 个粒子（生成器调用；不能生成时忽略）。 */
  emit(count: number): void {
    if (this.canEmitParticles) this.#toSpawn += count;
  }

  /** 暂停时：只跟上粒子系统的位置。 */
  updatePaused(parent: EmitterParent): void {
    this.#updateLocations(parent);
  }

  update(dt: number, parent: EmitterParent): void {
    if (!this.#initialized) this.#initialize(parent);
    this.#updateLocations(parent);
    this.#ensureCapacity();
    this.#moveAndDelete(dt);
    for (const updater of this.updaters) if (updater.enabled && !updater.isPostUpdater) updater.update(dt, this.pool);
    this.#spawnNew(dt);
    for (const updater of this.updaters) if (updater.enabled && updater.isPostUpdater) updater.update(dt, this.pool);
  }

  /** 清空粒子，下一帧从头开始（Stride 的 ResetSimulation）。 */
  resetSimulation(): void {
    this.#poolDirty = true;
    this.pool.setCapacity(0);
    for (const spawner of this.spawners) spawner.resetSimulation();
    for (const initializer of this.initializers) initializer.resetSimulation();
    this.#initialized = false;
  }

  #initialize(parent: EmitterParent): void {
    this.#initialized = true;
    let seed = 0;
    if (this.#randomSeedMethod === 'time') seed = (performance.now() * 1000) >>> 0;
    else if (this.#randomSeedMethod === 'position') {
      // 位置的三个分量按 float32 的位模式混起来（同 Stride）
      const bits = new Uint32Array(new Float32Array(parent.translation).buffer);
      seed = ((bits[0]! ^ (bits[0]! >>> 19)) ^ (bits[1]! ^ (bits[1]! >>> 8)) ^ bits[2]!) >>> 0;
    }
    this.#seedGenerator = new RandomSeedGenerator(seed);
  }

  #updateLocations(parent: EmitterParent): void {
    const draw = this.drawTransform;
    draw.worldPosition = [...parent.translation];
    draw.worldRotation = [...parent.rotation];
    draw.worldScale = [parent.uniformScale, parent.uniformScale, parent.uniformScale];
    const world = this.simulationSpace === 'world';
    const reference = world ? draw : this.#identity;
    this.#defaults = world
      ? { position: [...parent.translation], rotation: [...parent.rotation], scale: parent.uniformScale }
      : { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: 1 };
    for (const initializer of this.initializers) initializer.setParent(reference);
    for (const updater of this.updaters) updater.setParentTransform(reference);
  }

  #ensureCapacity(): void {
    if (!this.#poolDirty) return;
    this.#poolDirty = false;
    if (this.maxParticlesOverride > 0) {
      this.pool.setCapacity(this.maxParticlesOverride);
      return;
    }
    const perSecond = this.spawners.reduce((sum, spawner) => sum + spawner.maxParticlesPerSecond(), 0);
    this.pool.setCapacity(Math.ceil(this.particleLifetime[1] * perSecond));
  }

  /** 寿命按 dt / 这个粒子的寿命减少，到 0 的删掉（连着子粒子生成器时多留一帧，寿命停在接近 0）；按速度移动。 */
  #moveAndDelete(dt: number): void {
    const pool = this.pool;
    const life = pool.field('life')!, seeds = pool.seeds;
    const [minLife, maxLife] = this.particleLifetime;
    for (let i = 0; i < pool.living; i++) {
      if (life[i]! > 1) life[i] = 1;
      const startingLife = minLife + (maxLife - minLife) * seedFloat(seeds[i]!, RandomOffset.lifetime);
      if (life[i]! <= ZERO_TOLERANCE || ((life[i]! -= dt / startingLife) <= ZERO_TOLERANCE && this.delayParticleDeath === 0)) {
        pool.remove(i);
        i--;
      } else if (life[i]! <= ZERO_TOLERANCE) {
        life[i] = ZERO_TOLERANCE;
      }
    }
    const position = pool.field('position')!;
    pool.field('oldPosition')?.set(position.subarray(0, pool.living * 3));
    const velocity = pool.field('velocity');
    if (velocity) for (let i = 0; i < pool.living * 3; i++) position[i]! += velocity[i]! * dt;
  }

  #spawnNew(dt: number): void {
    for (const spawner of this.spawners) if (spawner.enabled) spawner.spawn(dt, this);
    const pool = this.pool;
    const count = Math.min(pool.capacity - pool.living, this.#toSpawn);
    this.#toSpawn = 0;
    if (pool.capacity <= 0 || count <= 0) return;
    const life = pool.field('life')!, seeds = pool.seeds;
    let start = pool.living % pool.capacity;
    for (let n = 0; n < count; n++) {
      const i = pool.add();
      seeds[i] = this.#seedGenerator!.nextSeed();
      life[i] = 1;
    }
    let end = pool.living % pool.capacity, capacity = pool.capacity;
    // 正好填满一圈时 start == end：按 Stride 的写法改成 [0, capacity)
    if (start === end) {
      start = 0;
      end = capacity;
      capacity++;
    }
    const range: SpawnedRange = { start, end, capacity };
    this.#initializeDefaults(range);
    clearChildren(pool, range);
    for (const initializer of this.initializers) if (initializer.enabled) initializer.initialize(pool, range);
  }

  /** 新粒子的默认值（Stride 的 InitialDefaultFields）：有哪个字段设哪个。 */
  #initializeDefaults({ start, end, capacity }: SpawnedRange): void {
    const pool = this.pool, { position, rotation, scale } = this.#defaults;
    const fill = (field: Exclude<ParticleField, IntegerField>, values: readonly number[]) => {
      const column = pool.field(field);
      if (column) for (let i = start; i !== end; i = (i + 1) % capacity) column.set(values, i * values.length);
    };
    fill('position', position);
    fill('oldPosition', position);
    fill('direction', [0, 0, 0]);
    fill('quaternion', rotation);
    fill('rotation', [0]);
    fill('velocity', [0, 0, 0]);
    fill('size', [scale]);
    fill('color', [1, 1, 1, 1]);
  }
}
