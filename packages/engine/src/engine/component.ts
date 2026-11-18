/**
 * 数据组件：纯数据，按字段分列存放，一次处理很多实体。
 * `component({ max: prop.f32().default(100), current: 100 })`；名字在游戏登记模块时由模块路径和导出名得出，
 * 引擎和库的组件则把名字写在第一个参数。
 * 变体是成组的取值：`component(shape, { variants: { elite: { max: 300 } } })`，用时写 `Health.variant('elite')`。
 */
import type { Columns, DataShape, DataValues, EntityId, InitOf } from '../data/prop';
import { createSchema, type Column, type Field, type Schema } from '../data/schema';
import type { EntityManager } from './EntityManager';
import type { ColumnSet } from './storage';

let nextTypeId = 0;
const NO_RESERVED_NAMES = new Set<string>();

export interface ComponentOptions<S extends DataShape, V extends string> {
  readonly variants?: { readonly [K in V]: Partial<InitOf<S, 'data'>> };
}

/**
 * 数据不在表里、而在原生内存里的组件（Transform；以后还有刚体）。表里只存 tableFields 这几列，第一列是
 * 实体在外部存储里的行号（槽位）；schema 的字段按这个行号存在 data() 给出的列里，布局和表的列一样，
 * 所以写入、视图和校验都沿用普通组件的代码。
 */
export interface ExternalStorage {
  readonly tableFields: readonly Field[];
  /** 数据所在的列，按 schema 字段顺序，用槽位当行号。 */
  data(manager: EntityManager): readonly Column[];
  /** 实体得到这个组件时分配槽位。 */
  allocate(manager: EntityManager, entity: EntityId): number;
  /** 实体失去这个组件之前（销毁时 destroying 为 true）释放槽位；只是去掉组件时可以拒绝。 */
  release(manager: EntityManager, entity: EntityId, destroying: boolean): void;
  /** 给系统的列：表里的列加上数据列。 */
  chunk(manager: EntityManager, set: ColumnSet): object;
  /** 给视图加上 schema 字段以外的成员。 */
  extendView(manager: EntityManager, entity: EntityId, view: object): void;
}

export class ComponentType<S extends DataShape = DataShape, V extends string = string> {
  declare readonly __shape: S;
  /** 每个字段都有默认值时为 true，这时可以不带值直接列出这个类型。 */
  declare readonly __bare: {} extends InitOf<S, 'data'> ? true : false;
  /** 存储里按类型编号的数组的下标。 */
  readonly id = nextTypeId++;
  readonly schema: Schema;
  readonly variants: Readonly<Record<string, object>>;
  /** 标签没有字段，只看有没有（Dead、Stunned）。 */
  readonly isTag: boolean;
  /** @internal 数据在原生内存里时的存取方式。 */
  readonly external: ExternalStorage | undefined;
  /** 表里的列：普通组件就是 schema 的字段，external 的组件是它自己的几列。 */
  readonly tableFields: readonly Field[];
  #name: string | undefined;

  constructor(name: string | undefined, shape: S, options: ComponentOptions<S, V> = {}, external?: ExternalStorage) {
    this.#name = name;
    this.schema = createSchema(shape, 'f32', NO_RESERVED_NAMES, name ?? 'component');
    this.isTag = this.schema.fields.length === 0;
    this.variants = checkVariants(this.schema, options.variants ?? {});
    this.external = external;
    this.tableFields = external ? external.tableFields : this.schema.fields;
  }

  /** 登记的名字：显式给的，或者游戏登记模块后得出的 `路径#导出名`。 */
  get name(): string {
    return this.#name ?? `(unregistered component #${this.id})`;
  }

  get isNamed(): boolean {
    return this.#name !== undefined;
  }

  /**
   * @internal 热重载：这个新版本接替旧版本，用它的编号。表按编号找组件，所以旧代码手里的旧版本和新代码的
   * 新版本落到同一组列上。
   */
  adopt(previous: ComponentType<any, any>): void {
    Object.defineProperty(this, 'id', { value: previous.id });
  }

  /** @internal 由登记表设置。 */
  setName(name: string): void {
    if (this.#name !== undefined && this.#name !== name) throw new Error(`${this.#name} is already named; cannot rename it to ${name}`);
    this.#name = name;
  }

  /** 带上取值的这个组件，给 entities.create 用：`Health.with({ max: 150 })`。 */
  with(init: InitOf<S, 'data'>): ComponentInit<S> {
    return { type: this, init };
  }

  /** 先取变体的值，再叠加 init：`Enemy.variant('elite', { level: 3 })`。 */
  variant(name: V, init: Partial<InitOf<S, 'data'>> = {}): ComponentInit<S> {
    return { type: this, init: { ...variantValues(this.variants, name, this.name), ...init } };
  }
}

export interface ComponentInit<S extends DataShape = DataShape> {
  readonly type: ComponentType<S, any>;
  readonly init: object | undefined;
}

/** 系统拿到的这个组件的列。external 的组件用幻影属性 __columns 声明自己的样子。 */
export type ColumnsOf<C> = C extends { readonly __columns: infer X } ? X : C extends ComponentType<infer S, any> ? Columns<S> : never;

/** entity.get 拿到的这个组件的视图。external 的组件用幻影属性 __view 声明自己的样子。 */
export type ViewOf<C> = C extends { readonly __view: infer X } ? X : C extends ComponentType<infer S, any> ? DataValues<S> : never;

/** 所有字段都有默认值的组件类型，可以直接列出。 */
export type BareComponent = ComponentType<any, any> & { readonly __bare: true };

export function component<S extends DataShape, V extends string = never>(shape: S, options?: ComponentOptions<S, V>): ComponentType<S, V>;
export function component<S extends DataShape, V extends string = never>(name: string, shape: S, options?: ComponentOptions<S, V>): ComponentType<S, V>;
export function component(a: string | DataShape, b?: DataShape | ComponentOptions<DataShape, string>, c?: ComponentOptions<DataShape, string>): ComponentType {
  return typeof a === 'string' ? new ComponentType(a, (b as DataShape) ?? {}, c) : new ComponentType(undefined, a, b as ComponentOptions<DataShape, string>);
}

/** 没有字段的组件，当标记用，系统按它筛选：`without: [Dead]`。 */
export function tag(name?: string): ComponentType<{}, never> {
  return new ComponentType(name, {});
}

/** 变体只能给 init 对象能给的值；定义时检查一次。 */
export function checkVariants(schema: Schema, variants: Readonly<Record<string, object>>): Readonly<Record<string, object>> {
  for (const [name, values] of Object.entries(variants)) {
    const issue = schema.validate(values).find((i) => i.message !== 'is required');
    if (issue) throw new RangeError(`${schema.owner} variant '${name}': ${[...issue.path].join('.')} ${issue.message}`);
  }
  return variants;
}

export function variantValues(variants: Readonly<Record<string, object>>, name: string, owner: string): object {
  const values = variants[name];
  if (!values) throw new Error(`${owner} has no variant '${name}' (it has ${Object.keys(variants).map((v) => `'${v}'`).join(', ') || 'none'})`);
  return values;
}
