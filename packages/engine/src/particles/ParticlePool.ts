/**
 * 一个发射器的粒子（Stride 的 ParticlePool，Stack 策略）：活着的粒子排在 [0, living)，按字段分列存（每个字段一个类型化数组）；
 * 删掉一个时最后一个挪过来补位。只建模块要的字段（Stride 的 RequiredFields），没有的字段对应的步骤跳过（比如没有速度就不按
 * 速度移动），和 Stride 一样。
 */

/** 字段名和每个粒子占几个数（Stride 的 ParticleFields；Color 即 Stride 的 RGBA、Color4）。 */
export const PARTICLE_FIELDS = {
  life: 1,
  randomSeed: 1,
  position: 3,
  oldPosition: 3,
  direction: 3,
  quaternion: 4,
  rotation: 1,
  velocity: 3,
  size: 1,
  color: 4,
  /** 这一帧碰撞过（UpdaterCollider 写 1，Stride 的 CollisionControl 的 HasColided）。 */
  collision: 1,
} as const;

export type ParticleField = keyof typeof PARTICLE_FIELDS;

export class ParticlePool {
  /** 能放多少个粒子。 */
  capacity = 0;
  /** 活着的粒子数，它们在 [0, living)。 */
  living = 0;
  readonly #fields = new Map<ParticleField, Float32Array | Uint32Array>();

  constructor(fields: Iterable<ParticleField>) {
    for (const field of fields) this.#fields.set(field, this.#allocate(field, 0));
  }

  has(field: ParticleField): boolean {
    return this.#fields.has(field);
  }

  /** 字段的列（粒子 i 的值在 [i · 宽度, (i + 1) · 宽度)）；没有这个字段时是 undefined。 */
  field(field: ParticleField): Float32Array | undefined {
    return field === 'randomSeed' ? undefined : (this.#fields.get(field) as Float32Array | undefined);
  }

  /** 每个粒子的随机种子。 */
  get seeds(): Uint32Array {
    return this.#fields.get('randomSeed') as Uint32Array;
  }

  /** 改容量，前 min(living, 新容量) 个粒子留下（Stride 的 SetCapacity）。 */
  setCapacity(capacity: number): void {
    if (capacity < 0 || capacity === this.capacity) return;
    this.living = Math.min(this.living, capacity);
    for (const [name, old] of this.#fields) {
      const column = this.#allocate(name, capacity);
      column.set(old.subarray(0, this.living * PARTICLE_FIELDS[name]));
      this.#fields.set(name, column);
    }
    this.capacity = capacity;
  }

  /** 加一个粒子，返回下标；满了时是 -1。 */
  add(): number {
    return this.living < this.capacity ? this.living++ : -1;
  }

  /** 删掉粒子 index：最后一个粒子挪到这里（调用方遍历时要再看一次 index）。 */
  remove(index: number): void {
    const last = --this.living;
    if (index === last) return;
    // 字段只有 1 到 4 个数：逐个拷比 copyWithin 快
    for (const [name, column] of this.#fields) {
      const width = PARTICLE_FIELDS[name];
      for (let k = 0; k < width; k++) column[index * width + k] = column[last * width + k]!;
    }
  }

  #allocate(field: ParticleField, capacity: number): Float32Array | Uint32Array {
    const length = capacity * PARTICLE_FIELDS[field];
    return field === 'randomSeed' ? new Uint32Array(length) : new Float32Array(length);
  }
}
