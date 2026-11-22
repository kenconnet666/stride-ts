/**
 * 属性声明：`prop.f32().min(0).default(100)`。Prop 不可变，每个修饰方法都返回新对象，并把改了什么记在
 * 类型参数里；脚本字段、组件、init 对象、视图和列的 TS 类型都只从声明推导出来（做法同 easy-query-ts 的列）。
 */
import type { Color4, ColorLike, Quaternion, QuatLike, Vec3Like, Vector3 } from './vectors';
import type { Decimal } from './Decimal';
import type { Instant, LocalDate, LocalDateTime, LocalTime } from './temporal';

/** 数据组件能存的种类：每个字段一列（向量按行交错存放，每行 3 或 4 个 float）。 */
export type ColumnKind =
  | 'number' | 'f32' | 'int' | 'u8' | 'u32' | 'bool' | 'string' | 'enum' | 'entity' | 'vec3' | 'quat' | 'color'
  | 'i64' | 'u64' | 'decimal' | 'date' | 'time' | 'datetime' | 'instant';
/** 只有脚本能用的种类：长度不定或值是对象。 */
export type ObjectKind = 'list' | 'object' | 'union' | 'json' | 'component' | 'bytes' | 'asset';
export type PropKind = ColumnKind | ObjectKind;

/** 记在类型里的修饰：sealed（由拥有者驱动）、inherit（作用域默认值）、stat（运行时修饰）。 */
export type Modifier = 'sealed' | 'inherit' | 'stat';

declare const brandKey: unique symbol;
/** 只在编译期区分名字的值类型：`EntityId` 和 `BodyId` 不能混用，运行时就是原来的类型。 */
export type Branded<T, B extends string> = T & { readonly [brandKey]: B };

/** 实体句柄：下标加代数，已销毁实体的旧句柄能被识别出来。 */
export type EntityId = Branded<number, 'EntityId'>;

export type Vec3Input = Readonly<Vec3Like> | readonly [number, number, number];
export type QuatInput = Readonly<QuatLike> | readonly [number, number, number, number];
export type ColorInput = Readonly<ColorLike> | readonly [number, number, number, number];
/** 小数可以从这些写法得到：Decimal、文字（`"12.50"`）、数字、bigint。 */
export type DecimalInput = Decimal | string | number | bigint;

/**
 * Standard Schema（https://standardschema.dev）里 prop.json() 用到的部分：zod、valibot、arktype 的 schema
 * 都有 `~standard.validate`。只支持同步校验。
 */
export interface StandardSchema<Output = unknown> {
  readonly '~standard': {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) => StandardResult<Output> | Promise<StandardResult<Output>>;
    readonly types?: { readonly input: unknown; readonly output: Output } | undefined;
  };
}

export type StandardResult<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | { readonly issues: readonly StandardIssue[] };

export interface StandardIssue {
  readonly message: string;
  readonly path?: readonly (PropertyKey | { readonly key: PropertyKey })[] | undefined;
}

export interface PropOptions {
  readonly kind: PropKind;
  /** `defaultValue` 是否有效；没有默认值的属性创建时必须给值。 */
  readonly hasDefault: boolean;
  readonly defaultValue: unknown;
  /** 运行时状态：不存盘，不进编辑器面板。 */
  readonly transient: boolean;
  /** 由拥有者驱动：init 和覆盖对象都不能设它。 */
  readonly sealed: boolean;
  /** 作用域默认值（game.defaults）可以设它。 */
  readonly inherit: boolean;
  /** 可以通过 script.stats 加运行时修饰。 */
  readonly stat: boolean;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly unit?: string;
  readonly label?: string;
  readonly group?: string;
  readonly description?: string;
  readonly hidden?: boolean;
  /** 改名之前的字段名：场景文件和热重载仍能读到按旧名保存的值。 */
  readonly renamedFrom?: string;
  /** enum：允许的取值。 */
  readonly values?: readonly string[];
  /** asset：资源的种类（AssetTypes 的键）。 */
  readonly assetKind?: string;
  /** list：元素的属性声明。 */
  readonly item?: AnyProp;
  /** object：嵌套的 shape。union：每个子类型的 shape。 */
  readonly shape?: Shape;
  readonly variants?: Readonly<Record<string, Shape>>;
  /** union：标明子类型的那个字段。 */
  readonly discriminator?: string;
  /** json：校验器。 */
  readonly schema?: StandardSchema;
  /** component：脚本类或组件类型，包在函数里，模块之间可以互相引用。 */
  readonly target?: () => unknown;
  /** decimal：小数位数，以及最多几位有效数字（存成 int64 时不超过 18）。 */
  readonly scale?: number;
  readonly precision?: number;
}

/**
 * 一个属性。T 是脚本里拿到的值类型，D 是否有默认值（有就可以在创建时省略），K 是存储种类，M 是修饰，
 * I 是 init 对象可以传的类型（向量可以传元组）。declare 的字段只存在于类型里。
 */
export class Prop<T, D extends boolean = false, K extends PropKind = PropKind, M extends Modifier = never, I = T> {
  declare readonly __type: T;
  declare readonly __hasDefault: D;
  declare readonly __kind: K;
  declare readonly __modifiers: M;
  declare readonly __input: I;
  readonly options: PropOptions;

  constructor(options: PropOptions) {
    this.options = options;
  }

  private changed(changes: Partial<PropOptions>): Prop<any, any, any, any, any> {
    return new Prop({ ...this.options, ...changes });
  }

  default(value: I): Prop<T, true, K, M, I> {
    return this.changed({ hasDefault: true, defaultValue: value });
  }

  /** 值可以是 undefined，默认值也是它。数据组件不能用（列里没有“缺失”这个值）。 */
  optional(): Prop<T | undefined, true, K, M, I | undefined> {
    return this.changed({ hasDefault: true, defaultValue: undefined });
  }

  /** 运行时状态：不存盘、不进编辑器面板，所以要先有默认值。 */
  transient(this: Prop<T, true, K, M, I>): Prop<T, true, K, M, I> {
    return this.changed({ transient: true });
  }

  /** 由所属的脚本或系统驱动：init 和覆盖对象都不能设它，所以要先有默认值。 */
  sealed(this: Prop<T, true, K, M, I>): Prop<T, true, K, M | 'sealed', I> {
    return this.changed({ sealed: true });
  }

  /** 允许作用域默认值设置：game.defaults.set(Type, { ... })。只给调参类的值用，不给状态用。 */
  inherit(this: Prop<T, true, K, M, I>): Prop<T, true, K, M | 'inherit', I> {
    return this.changed({ inherit: true });
  }

  /** 运行时可以通过 script.stats 加上加值和乘数（只有脚本能用）。 */
  stat(this: Prop<number, true, K, M, I>): Prop<T, true, K, M | 'stat', I> {
    return this.changed({ stat: true });
  }

  min(this: Prop<number, D, K, M, I>, value: number): Prop<T, D, K, M, I> {
    return this.changed({ min: value });
  }

  max(this: Prop<number, D, K, M, I>, value: number): Prop<T, D, K, M, I> {
    return this.changed({ max: value });
  }

  /** 编辑器滑块的步长。 */
  step(this: Prop<number, D, K, M, I>, value: number): Prop<T, D, K, M, I> {
    return this.changed({ step: value });
  }

  /** 编辑器里显示在值旁边的单位：'m/s'、'deg'。 */
  unit(this: Prop<number, D, K, M, I>, value: string): Prop<T, D, K, M, I> {
    return this.changed({ unit: value });
  }

  label(value: string): Prop<T, D, K, M, I> {
    return this.changed({ label: value });
  }

  group(value: string): Prop<T, D, K, M, I> {
    return this.changed({ group: value });
  }

  description(value: string): Prop<T, D, K, M, I> {
    return this.changed({ description: value });
  }

  hidden(): Prop<T, D, K, M, I> {
    return this.changed({ hidden: true });
  }

  renamedFrom(oldName: string): Prop<T, D, K, M, I> {
    return this.changed({ renamedFrom: oldName });
  }

  /** 只改类型：`prop.u32().brand<'TeamId'>()`。 */
  brand<B extends string>(): Prop<Branded<T, B>, D, K, M, Branded<T, B>> {
    return this as never;
  }
}

export type AnyProp = Prop<any, boolean, PropKind, Modifier, any>;

const declare = <T, K extends PropKind, I = T>(kind: K, extra: Partial<PropOptions> = {}): Prop<T, false, K, never, I> =>
  new Prop({ kind, hasDefault: false, defaultValue: undefined, transient: false, sealed: false, inherit: false, stat: false, ...extra });

/** prop.component() 需要知道的那部分组件类型或脚本类。 */
type Referable = { readonly __shape: Shape };

/**
 * prop.asset 能引用的资源种类和加载后的类型。数据层不依赖资源模块：各模块用声明合并加上自己的种类，比如
 * content/ContentManager.ts 加了 model、material。
 */
export interface AssetTypes {}

export const prop = {
  /** 64 位浮点数；列是 Float64Array。 */
  number: () => declare<number, 'number'>('number'),
  /** 32 位浮点数；列是 Float32Array。数据组件一般用它。 */
  f32: () => declare<number, 'f32'>('f32'),
  /** 32 位有符号整数；列是 Int32Array。 */
  int: () => declare<number, 'int'>('int'),
  u8: () => declare<number, 'u8'>('u8'),
  u32: () => declare<number, 'u32'>('u32'),
  /** 数据组件里是 Uint8Array 列（0 或 1），脚本和视图里是 boolean。 */
  bool: () => declare<boolean, 'bool'>('bool'),
  string: () => declare<string, 'string'>('string'),
  enum: <const V extends string>(values: readonly [V, ...V[]]) => declare<V, 'enum'>('enum', { values }),
  /** 另一个实体的句柄；列是 Float64Array。 */
  entity: () => declare<EntityId, 'entity'>('entity'),
  /** 脚本里是 Vector3；数据组件里每行交错存 3 个 float。默认 (0, 0, 0)。 */
  vec3: () => declare<Vector3, 'vec3', Vec3Input>('vec3', { hasDefault: true, defaultValue: [0, 0, 0] }) as unknown as Prop<Vector3, true, 'vec3', never, Vec3Input>,
  /** 脚本里是 Quaternion；数据组件里每行交错存 4 个 float。默认单位四元数。 */
  quat: () => declare<Quaternion, 'quat', QuatInput>('quat', { hasDefault: true, defaultValue: [0, 0, 0, 1] }) as unknown as Prop<Quaternion, true, 'quat', never, QuatInput>,
  /** 脚本里是线性空间的 RGBA Color4；数据组件里每行交错存 4 个 float。默认白色。 */
  color: () => declare<Color4, 'color', ColorInput>('color', { hasDefault: true, defaultValue: [1, 1, 1, 1] }) as unknown as Prop<Color4, true, 'color', never, ColorInput>,
  /** 元素的列表（只有脚本能用）。默认空列表，每个脚本实例各有一份。 */
  list: <P extends AnyProp>(item: P) =>
    declare<ValueOfProp<P>[], 'list', InputOfProp<P>[]>('list', { item, hasDefault: true, defaultValue: [] }) as unknown as Prop<ValueOfProp<P>[], true, 'list', never, InputOfProp<P>[]>,
  /** 嵌套对象（只有脚本能用）：`prop.object({ min: prop.vec3(), max: prop.vec3() })`。 */
  object: <S extends Shape>(shape: S) =>
    declare<ScriptValues<S>, 'object', InitOf<S, 'script'>>('object', { shape, hasDefault: isAllDefault(shape), defaultValue: {} }) as unknown as Prop<
      ScriptValues<S>,
      {} extends InitOf<S, 'script'> ? true : false,
      'object',
      never,
      InitOf<S, 'script'>
    >,
  /** 几种 shape 之一，靠判别字段区分（只有脚本能用）。 */
  union: <const D extends string, V extends Record<string, Shape>>(discriminator: D, variants: V) =>
    declare<UnionValue<D, V>, 'union', UnionInput<D, V>>('union', { discriminator, variants }),
  /** 64 位有符号整数，脚本里是 bigint；列是 BigInt64Array，和 C 的 int64_t 布局相同。 */
  i64: () => declare<bigint, 'i64', bigint | number>('i64'),
  /** 64 位无符号整数，脚本里是 bigint；列是 BigUint64Array。 */
  u64: () => declare<bigint, 'u64', bigint | number>('u64'),
  /**
   * 定点小数，scale 位小数、最多 precision 位有效数字（默认 18，存成 int64 的单位数时不能更多）。
   * 脚本里是 Decimal；列是 BigInt64Array（单位数），同 Arrow 的 decimal64。多出的小数位不会被悄悄舍掉，而是报错。
   */
  decimal: (scale: number, precision = 18) => declare<Decimal, 'decimal', DecimalInput>('decimal', { scale, precision }),
  /** 日期，脚本里是 LocalDate；列是 Int32Array（1970-01-01 起的天数）。也可以传 `"2024-01-31"`。 */
  date: () => declare<LocalDate, 'date', LocalDate | string>('date'),
  /** 一天里的时刻，脚本里是 LocalTime；列是 BigInt64Array（零点起的纳秒）。 */
  time: () => declare<LocalTime, 'time', LocalTime | string>('time'),
  /** 不带时区的日期时间，脚本里是 LocalDateTime；列是 BigInt64Array（纳秒）。 */
  datetime: () => declare<LocalDateTime, 'datetime', LocalDateTime | string>('datetime'),
  /** 时间线上的时刻（UTC），脚本里是 Instant；列是 BigInt64Array（Unix 纪元起的纳秒）。也可以传 Date 或带时差的 ISO 文字。 */
  instant: () => declare<Instant, 'instant', Instant | Date | string>('instant'),
  /** 字节（只有脚本能用），线上写成 base64。默认空，每个脚本实例各有一份。 */
  bytes: () => declare<Uint8Array, 'bytes'>('bytes', { hasDefault: true, defaultValue: new Uint8Array(0) }) as unknown as Prop<Uint8Array, true, 'bytes'>,
  /** Standard Schema（zod、valibot、arktype）接受的任意数据；赋值时校验（只有脚本能用）。 */
  json: <Output>(schema: StandardSchema<Output>) => declare<Output, 'json'>('json', { schema }),
  /**
   * 另一个脚本或数据组件，创建时传入（只有脚本能用）。包在函数里，模块之间可以互相 import。
   * 引用自己或互相引用的脚本时，在 props() 里写 `() => ScriptComponent`，再在类体里用 declare 收窄类型：
   * 继承表达式里出现自己的类名会让 TS 报循环引用（TS2506）。
   */
  component: <C extends Referable>(target: () => C) => declare<ReferenceTo<C>, 'component'>('component', { target }),
  /**
   * 一个加载好的资源（只有脚本能用），比如 `prop.asset('model')`：场景里的脚本属性引用资源时，加载场景时一并加载好再传进来；
   * 代码里创建时传加载好的对象（`game.content.loadModel(...)`）。种类见 AssetTypes。
   */
  asset: <K extends keyof AssetTypes>(kind: K) => declare<AssetTypes[K], 'asset'>('asset', { assetKind: kind }),
};

function isAllDefault(shape: Shape): boolean {
  return Object.values(shape).every((value) => !(value instanceof Prop) || value.options.hasDefault);
}

/** 引用在脚本里的值：脚本实例，或数据组件的视图。 */
export type ReferenceTo<C> = C extends abstract new () => infer Instance
  ? Instance
  : C extends { readonly __shape: infer S extends Shape }
    ? DataValues<S>
    : never;

type UnionValue<D extends string, V extends Record<string, Shape>> = {
  [K in keyof V & string]: Flat<{ -readonly [P in D]: K } & ScriptValues<V[K]>>;
}[keyof V & string];
type UnionInput<D extends string, V extends Record<string, Shape>> = {
  [K in keyof V & string]: Flat<{ readonly [P in D]: K } & InitOf<V[K], 'script'>>;
}[keyof V & string];

/** shape 里可以写的东西：属性声明，或字面量（简写“这个类型、这个默认值”）。 */
export type ShapeValue = AnyProp | number | string | boolean;
export type Shape = { readonly [key: string]: ShapeValue };
/** 数据组件接受的 shape：只能是能放进列的种类。 */
export type DataShape = { readonly [key: string]: Prop<any, boolean, ColumnKind, Modifier, any> | number | string | boolean };

/** shape 里的值在脚本中代表的属性：数字字面量是 64 位数。 */
export type ScriptPropOf<V> = V extends AnyProp
  ? V
  : V extends number
    ? Prop<number, true, 'number'>
    : V extends string
      ? Prop<string, true, 'string'>
      : V extends boolean
        ? Prop<boolean, true, 'bool'>
        : never;

/** shape 里的值在数据组件中代表的属性：数字字面量是 f32 列。 */
export type DataPropOf<V> = V extends AnyProp
  ? V
  : V extends number
    ? Prop<number, true, 'f32'>
    : V extends string
      ? Prop<string, true, 'string'>
      : V extends boolean
        ? Prop<boolean, true, 'bool'>
        : never;

type ValueOfProp<P> = P extends Prop<infer T, any, any, any, any> ? T : never;
type InputOfProp<P> = P extends Prop<any, any, any, any, infer I> ? I : never;
type HasDefault<P> = P extends Prop<any, infer D, any, any, any> ? D : never;
type ModifiersOf<P> = P extends Prop<any, any, any, infer M, any> ? M : never;

/** 通过视图看到的数据组件字段：向量是直接读写列的 x/y/z(/w) 对象。 */
type ViewValueOf<P> = P extends Prop<infer T, any, infer K, any, any>
  ? K extends 'vec3'
    ? Vec3Like
    : K extends 'quat'
      ? QuatLike
      : K extends 'color'
        ? ColorLike
        : T
  : never;

/** 脚本 shape 的字段值。 */
export type ScriptValues<S extends Shape> = { -readonly [K in keyof S]: ValueOfProp<ScriptPropOf<S[K]>> };

/** 数据组件 shape 的字段值，按视图里的样子。 */
export type DataValues<S extends Shape> = { -readonly [K in keyof S]: ViewValueOf<DataPropOf<S[K]>> };

type Flat<T> = { [K in keyof T]: T[K] } & {};
type PropOfKind<S extends Shape, K extends keyof S, Of> = Of extends 'data' ? DataPropOf<S[K]> : ScriptPropOf<S[K]>;
type SealedKeys<S extends Shape, Of> = { [K in keyof S]: 'sealed' extends ModifiersOf<PropOfKind<S, K, Of>> ? K : never }[keyof S];
type DefaultedKeys<S extends Shape, Of> = { [K in keyof S]: HasDefault<PropOfKind<S, K, Of>> extends true ? K : never }[keyof S];

/** 创建脚本或组件时传的值：没有默认值的必填，sealed 的不能传。 */
export type InitOf<S extends Shape, Of extends 'data' | 'script'> = Flat<
  { readonly [K in Exclude<keyof S, DefaultedKeys<S, Of> | SealedKeys<S, Of>>]: InputOfProp<PropOfKind<S, K, Of>> } & {
    readonly [K in Exclude<DefaultedKeys<S, Of>, SealedKeys<S, Of>>]?: InputOfProp<PropOfKind<S, K, Of>>;
  }
>;

/** 作用域默认值可以设的属性（标了 .inherit() 的）。 */
export type InheritedOf<S extends Shape, Of extends 'data' | 'script'> = Flat<{
  readonly [K in keyof S as 'inherit' extends ModifiersOf<PropOfKind<S, K, Of>> ? K : never]?: InputOfProp<PropOfKind<S, K, Of>>;
}>;

/** 脚本 shape 里标了 .stat() 的键。 */
export type StatKeys<S extends Shape> = { [K in keyof S]: 'stat' extends ModifiersOf<ScriptPropOf<S[K]>> ? K : never }[keyof S];

/** 每种列存储种类对应的数组类型；不在表里的（string、enum）是普通数组。 */
interface ColumnArrays {
  f32: Float32Array;
  vec3: Float32Array;
  quat: Float32Array;
  color: Float32Array;
  number: Float64Array;
  entity: Float64Array;
  i64: BigInt64Array;
  decimal: BigInt64Array;
  time: BigInt64Array;
  datetime: BigInt64Array;
  instant: BigInt64Array;
  u64: BigUint64Array;
  int: Int32Array;
  date: Int32Array;
  u8: Uint8Array;
  bool: Uint8Array;
  u32: Uint32Array;
}

/** 数据组件每个字段的列：TypedArray 或普通数组。 */
export type ColumnOf<P> = P extends Prop<infer T, any, infer K, any, any> ? (K extends keyof ColumnArrays ? ColumnArrays[K] : T[]) : never;

export type Columns<S extends Shape> = { readonly [K in keyof S]: ColumnOf<DataPropOf<S[K]>> };
