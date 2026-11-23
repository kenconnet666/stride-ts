/**
 * 有类型的内容文件模式：一份声明同时给出文件的 TS 类型、读文件时的校验和默认值、编辑器的字段描述（属性面板、checkFields、
 * 给 agent 的 JSON Schema）。照 easy-query-ts 的写法：不可变的 builder，类型靠幻影类型参数推导，不做代码生成，实现 Standard
 * Schema（https://standardschema.dev）的 `~standard`，别的库、agent 直接能用。
 *
 *   const stock = s.object({
 *     products: s.list(s.asset('product')),
 *     messiness: s.number({ min: 0, max: 1, step: 0.05 }).default(0.5).describe('how messy the stock is'),
 *   });
 *   type StockFile = InputOf<typeof stock>;   // 文件里的样子：有默认值的可以不写
 *   type Stock = Infer<typeof stock>;         // 解析以后：默认值补齐了，必有
 *   const value = stock.parse(parseJsonc(text, file), file);
 *
 * 校验和补默认值照的是字段描述（fieldValues.ts 的 checkFields、withDefaults），和编辑器同一套规则：缺了必填的、多了没描述的键、
 * 种类不对、数超出范围都报，一次报全，带路径。
 */
import type { AssetKind } from '../../content/references';
import type { Field, FieldType } from './builders.ts';
import { checkFields, withDefaults } from './fieldValues.ts';

/** 一个字段除了类型以外的说明：能不能不写、默认值、能不能是 null、面板上的名字和分组、说明。 */
interface SchemaMeta {
  readonly optional?: boolean;
  readonly nullable?: boolean;
  readonly default?: unknown;
  readonly label?: string;
  readonly group?: string;
  readonly description?: string;
}

/** 模式解析失败：issues 是每个问题（带路径的一句话）。 */
export class SchemaError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(issues.length === 1 ? issues[0]! : `${issues.length} problems:\n${issues.map((issue) => `  ${issue}`).join('\n')}`);
    this.name = 'SchemaError';
    this.issues = issues;
  }
}

/** Standard Schema 的结果（只用到的那部分）。 */
type StandardResult<T> = { readonly value: T; readonly issues?: undefined } | { readonly issues: readonly { readonly message: string; readonly path?: readonly PropertyKey[] }[] };

/**
 * 一个值的模式：Out 是解析以后的类型（默认值补齐），In 是文件里写的类型（有默认值的、可选的可以不写）。不可变：optional、
 * default、describe 这些都返回新的模式。
 */
export class Schema<Out, In = Out> {
  declare readonly __out: Out;
  declare readonly __in: In;
  readonly type: FieldType;
  readonly meta: SchemaMeta;

  constructor(type: FieldType, meta: SchemaMeta = {}) {
    this.type = type;
    this.meta = meta;
  }

  /** 文件里可以不写，不写时解析出来是 undefined。 */
  optional(): Schema<Out | undefined, In | undefined> {
    return new Schema(this.type, { ...this.meta, optional: true });
  }

  /** 文件里可以不写，不写时是 value（解析时深拷贝一份补上）。 */
  default(value: Exclude<Out, undefined>): Schema<Exclude<Out, undefined>, In | undefined> {
    return new Schema(this.type, { ...this.meta, optional: true, default: value });
  }

  /** 可以是 null（没指定）。 */
  nullable(): Schema<Out | null, In | null> {
    return new Schema(this.type, { ...this.meta, nullable: true });
  }

  /** 说明（属性面板的提示、给 agent 的 JSON Schema 的 description）：用英文写，中文在编辑器的 fieldMessages 里。 */
  describe(description: string): Schema<Out, In> {
    return new Schema(this.type, { ...this.meta, description });
  }

  /** 属性面板上的名字（没写时按字段名）。 */
  label(label: string): Schema<Out, In> {
    return new Schema(this.type, { ...this.meta, label });
  }

  /** 属性面板上的分组。 */
  group(group: string): Schema<Out, In> {
    return new Schema(this.type, { ...this.meta, group });
  }

  /** 编辑器的字段描述的一项（属性面板、checkFields、JSON Schema 用）。 */
  field(name: string): Field {
    return { name, type: this.type, ...this.meta };
  }

  /** 照模式检查，返回问题的列表（空的就是没问题）；where 是报在前面的位置（文件名）。 */
  check(value: unknown, where = 'value'): string[] {
    if (value === undefined) return this.meta.optional ? [] : [`${where}: missing`];
    if (value === null) return this.meta.nullable ? [] : [`${where}: expected a value, got null`];
    return checkFields(value, this.type, where);
  }

  /** 检查、补默认值，返回有类型的值；不对时抛 SchemaError（所有问题一起报）。不改传进来的值。 */
  parse(value: unknown, where = 'value'): Out {
    const issues = this.check(value, where);
    if (issues.length > 0) throw new SchemaError(issues);
    if (value === undefined) return structuredClone(this.meta.default) as Out;
    if (value === null) return value as Out;
    return withDefaults(value, this.type) as Out;
  }

  /** 同 parse，不抛：`{ value }` 或 `{ issues }`。 */
  safeParse(value: unknown, where = 'value'): { readonly value: Out; readonly issues?: undefined } | { readonly value?: undefined; readonly issues: readonly string[] } {
    const issues = this.check(value, where);
    return issues.length > 0 ? { issues } : { value: this.parse(value, where) };
  }

  /** Standard Schema：表单库、tRPC 一类接收 zod、valibot 的地方能直接用。 */
  get '~standard'(): { readonly version: 1; readonly vendor: 'stride-ts'; readonly validate: (value: unknown) => StandardResult<Out>; readonly types?: { readonly input: In; readonly output: Out } } {
    return {
      version: 1,
      vendor: 'stride-ts',
      validate: (value) => {
        const issues = this.check(value);
        return issues.length > 0 ? { issues: issues.map((message) => ({ message })) } : { value: this.parse(value) };
      },
    };
  }
}

/** 解析以后的类型。 */
export type Infer<S> = S extends Schema<infer Out, unknown> ? Out : never;
/** 文件里写的类型（有默认值的、可选的可以不写）。 */
export type InputOf<S> = S extends Schema<unknown, infer In> ? In : never;

type Shape = { readonly [key: string]: Schema<unknown, unknown> };
type Simplify<T> = { [K in keyof T]: T[K] } & {};
/** 对象：值可能是 undefined 的键是可选的。 */
type ObjectOf<S extends Shape, Pick extends 'out' | 'in'> = Simplify<
  { readonly [K in keyof S as undefined extends Side<S[K], Pick> ? never : K]: Side<S[K], Pick> } &
  { readonly [K in keyof S as undefined extends Side<S[K], Pick> ? K : never]?: Exclude<Side<S[K], Pick>, undefined> }
>;
type Side<S, Pick extends 'out' | 'in'> = Pick extends 'out' ? Infer<S> : InputOf<S>;

type Tuple<N extends number, T = number, R extends readonly T[] = []> = R['length'] extends N ? R : Tuple<N, T, readonly [...R, T]>;

/** 对象的字段（给 FieldType 的 object、union 用）。 */
const fieldsOf = (shape: Shape): Field[] => Object.entries(shape).map(([name, schema]) => schema.field(name));

/** 写模式的构造函数。 */
export const s = {
  number: (options: { readonly min?: number; readonly max?: number; readonly step?: number; readonly unit?: string } = {}) => new Schema<number>({ kind: 'number', ...options }),
  integer: (min?: number, max?: number) => new Schema<number>({ kind: 'number', integer: true, ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) }),
  bool: () => new Schema<boolean>({ kind: 'bool' }),
  string: () => new Schema<string>({ kind: 'string' }),
  /** 几个字面量之一：类型就是它们的并集。 */
  oneOf: <const V extends readonly string[]>(...values: V) => new Schema<V[number]>({ kind: 'enum', values }),
  vector: <N extends 2 | 3 | 4>(size: N, unit?: string) => new Schema<Tuple<N>>({ kind: 'vector', size, ...(unit !== undefined ? { unit } : {}) }),
  /** 四元数 [x, y, z, w]。 */
  rotation: () => new Schema<Tuple<4>>({ kind: 'rotation' }),
  /** 颜色：alpha 时 4 个数；space 是文件里存的是哪种。 */
  color: <A extends boolean>(alpha: A, space: 'srgb' | 'linear' = 'linear') => new Schema<A extends true ? Tuple<4> : Tuple<3>>({ kind: 'color', alpha, space }),
  /** 一个资源的内容路径。 */
  asset: (kind: AssetKind) => new Schema<string>({ kind: 'asset', asset: kind, form: 'path' }),
  /** 场景里一个实体的 id。 */
  entity: () => new Schema<string>({ kind: 'entity', form: 'id' }),
  list: <S extends Schema<unknown, unknown>>(item: S) => new Schema<readonly Infer<S>[], readonly InputOf<S>[]>({ kind: 'list', item: item.type }),
  object: <S extends Shape>(shape: S) => new Schema<ObjectOf<S, 'out'>, ObjectOf<S, 'in'>>({ kind: 'object', fields: fieldsOf(shape) }),
  /** 形状由代码定的一组值（游戏的根渲染器的属性）：只查是对象。 */
  record: () => new Schema<Readonly<Record<string, unknown>>>({ kind: 'record' }),
  /** 还没有描述的一块 JSON：原样。 */
  json: () => new Schema<unknown>({ kind: 'json' }),
  /**
   * 几种形状之一：tag 那个键的值说是哪种（variants 的键），common 是每种都有的字段。类型是各种形状的并集（每种带上自己的 tag）。
   */
  union: <T extends string, V extends { readonly [name: string]: Shape }, C extends Shape = {}>(tag: T, variants: V, common?: C) => new Schema<
    { [K in keyof V]: Simplify<{ readonly [P in T]: K } & ObjectOf<V[K], 'out'> & ObjectOf<C, 'out'>> }[keyof V],
    { [K in keyof V]: Simplify<{ readonly [P in T]: K } & ObjectOf<V[K], 'in'> & ObjectOf<C, 'in'>> }[keyof V]
  >({ kind: 'union', tag, variants: Object.fromEntries(Object.entries(variants).map(([name, shape]) => [name, fieldsOf(shape)])), ...(common ? { common: fieldsOf(common) } : {}) }),
};

/** 对象模式的字段（编辑器里登记资源种类的字段描述要的 Field[]）。 */
export function schemaFields(schema: Schema<unknown, unknown>): readonly Field[] {
  if (schema.type.kind !== 'object') throw new TypeError(`schemaFields wants an object schema, not ${schema.type.kind}`);
  return schema.type.fields;
}
