/**
 * 一个发射器的粒子（Stride 的 ParticlePool，Stack 策略）：活着的粒子排在 [0, living)，按字段分列存（每个字段一个类型化数组）；
 * 删掉一个时最后一个挪过来补位。只建模块要的字段（Stride 的 RequiredFields），没有的字段对应的步骤跳过（比如没有速度就不按
 * 速度移动），和 Stride 一样。游戏可以加自己的字段（particleField，Stride 的 ParticleFieldDescription），给自己的模块用。
 */

/** 字段名和每个粒子占几个数（Stride 的 ParticleFields；Color 即 Stride 的 RGBA、Color4）。 */
const PARTICLE_FIELDS = {
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
  /** 生成的顺序（Stride 的 Order）：高 16 位是组（同一组连成一条飘带），低 16 位是组里的顺序。 */
  order: 1,
  /** 子粒子已经取到的序号（Stride 的 ChildOrder，InitialOrderParent 要父粒子有它）。 */
  childOrder: 1,
  /**
   * 子粒子的生成控制（Stride 的 ChildrenFlags00 到 03，SpawnerFromParent 按 ParentControlFlag 选一组）：这一帧要生成几个
   * 子粒子、累积的小数部分。
   */
  children0: 2,
  children1: 2,
  children2: 2,
  children3: 2,
} as const;

export type ParticleField = keyof typeof PARTICLE_FIELDS;
/** 存成 32 位无符号整数的字段（其余是 float）。 */
export type IntegerField = 'randomSeed' | 'order' | 'childOrder';
const INTEGER_FIELDS: ReadonlySet<ParticleField> = new Set<IntegerField>(['randomSeed', 'order', 'childOrder']);
/** 子粒子的生成控制的四组字段。 */
export const CHILDREN_FIELDS = ['children0', 'children1', 'children2', 'children3'] as const;

/** 游戏自己的字段（float）：新粒子的值是 defaultValue，宽度是它的长度。 */
export interface CustomParticleField {
  readonly name: string;
  readonly defaultValue: readonly number[];
}

/** 字段：引擎的（按名字）或者游戏自己的。 */
export type AnyParticleField = ParticleField | CustomParticleField;
/** float 存的字段。 */
export type FloatField = Exclude<ParticleField, IntegerField> | CustomParticleField;

/** 定义游戏自己的字段，比如 `particleField('RectangleXY', [1, 1])`（名字不能和引擎的重复）。 */
export function particleField(name: string, defaultValue: readonly number[]): CustomParticleField {
  if (Object.hasOwn(PARTICLE_FIELDS, name)) throw new Error(`particle field '${name}' is built in; pick another name`);
  if (defaultValue.length === 0) throw new Error(`particle field '${name}' needs a default value (its length is the width)`);
  return { name, defaultValue };
}

const nameOf = (field: AnyParticleField): string => (typeof field === 'string' ? field : field.name);
const widthOf = (field: AnyParticleField): number => (typeof field === 'string' ? PARTICLE_FIELDS[field] : field.defaultValue.length);

export class ParticlePool {
  /** 能放多少个粒子。 */
  capacity = 0;
  /** 活着的粒子数，它们在 [0, living)。 */
  living = 0;
  /** 名字 → 列和每个粒子占几个数。 */
  readonly #fields = new Map<string, { column: Float32Array | Uint32Array; readonly width: number; readonly integer: boolean }>();
  /** 游戏自己的字段（新粒子要设默认值）。 */
  readonly #custom: CustomParticleField[] = [];

  constructor(fields: Iterable<AnyParticleField>) {
    for (const field of fields) this.addField(field);
  }

  has(field: AnyParticleField): boolean {
    return this.#fields.has(nameOf(field));
  }

  /** 加一个字段（建池时，或者子粒子的发射器要父发射器有的字段），活着的粒子的值是 0。 */
  addField(field: AnyParticleField): void {
    const name = nameOf(field);
    if (this.#fields.has(name)) return;
    const width = widthOf(field), integer = typeof field === 'string' && INTEGER_FIELDS.has(field);
    this.#fields.set(name, { column: allocate(integer, this.capacity * width), width, integer });
    if (typeof field !== 'string') this.#custom.push(field);
  }

  /** float 字段的列（粒子 i 的值在 [i · 宽度, (i + 1) · 宽度)）；没有这个字段时是 undefined。 */
  field(field: FloatField): Float32Array | undefined {
    return this.#fields.get(nameOf(field))?.column as Float32Array | undefined;
  }

  /** 整数字段的列；没有这个字段时是 undefined。 */
  integers(field: IntegerField): Uint32Array | undefined {
    return this.#fields.get(field)?.column as Uint32Array | undefined;
  }

  /** 每个粒子的随机种子。 */
  get seeds(): Uint32Array {
    return this.#fields.get('randomSeed')!.column as Uint32Array;
  }

  /** 游戏自己的字段。 */
  get customFields(): readonly CustomParticleField[] {
    return this.#custom;
  }

  /** 改容量，前 min(living, 新容量) 个粒子留下（Stride 的 SetCapacity）。 */
  setCapacity(capacity: number): void {
    if (capacity < 0 || capacity === this.capacity) return;
    this.living = Math.min(this.living, capacity);
    for (const entry of this.#fields.values()) {
      const column = allocate(entry.integer, capacity * entry.width);
      column.set(entry.column.subarray(0, this.living * entry.width));
      entry.column = column;
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
    for (const { column, width } of this.#fields.values()) {
      for (let k = 0; k < width; k++) column[index * width + k] = column[last * width + k]!;
    }
  }
}

function allocate(integer: boolean, length: number): Float32Array | Uint32Array {
  return integer ? new Uint32Array(length) : new Float32Array(length);
}
