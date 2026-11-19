/**
 * 把 shape（`{ max: prop.f32().default(100), current: 100 }`）变成脚本或数据组件运行时用的 schema：字段、
 * 校验，以及每个 schema 只生成一次的初始化函数。生成的初始化函数逐个字段直接赋值；在 apps/bench 里，
 * 按键名循环赋值要慢 17 倍。
 */
import { Color4, Quaternion, Vector3 } from '../mathematics/vectors';
import { cellIssue, ENCODED_KINDS, toCell, toValue } from './cells';
import { prop, Prop, type AnyProp, type PropKind, type PropOptions, type Shape, type StandardIssue } from './prop';

export interface Field {
  readonly name: string;
  readonly options: PropOptions;
  /** 数据组件的列里每行占几个元素：vec3 是 3，quat 和 color 是 4，其余是 1。 */
  readonly stride: number;
}

/** 数据组件一个字段的存储。 */
export type Column = Float32Array | Float64Array | Int32Array | Uint8Array | Uint32Array | BigInt64Array | BigUint64Array | unknown[];

/** 值的一个问题：哪里不对（字段名、列表下标组成的路径）、为什么不对。 */
export interface Issue {
  readonly message: string;
  readonly path: readonly (string | number)[];
}

export interface Schema {
  readonly owner: string;
  readonly fields: readonly Field[];
  /** 每个字段声明的默认值，按字段顺序；作用域默认值会换成自己的数组传进来。 */
  readonly defaults: readonly unknown[];
  /** 用 init 或默认值设置 target 的每个字段；缺了必填字段就抛错。 */
  readonly assign: (target: object, init: object | undefined, defaults?: readonly unknown[]) => void;
  /** 写数据组件列里的一行（每个字段一列，按字段顺序）。 */
  readonly writeRow: (columns: readonly Column[], row: number, init: object | undefined, defaults?: readonly unknown[]) => void;
  /** init 对象的问题；没问题时是空数组。 */
  readonly validate: (init: unknown) => Issue[];
}

/** 是否检查运行时传进来的值：开发版检查，正式版信任调用方。 */
const CHECK_VALUES = (import.meta as { env?: { DEV?: boolean } }).env?.DEV ?? true;

const COLUMN_KINDS = new Set<PropKind>([
  'number', 'f32', 'int', 'u8', 'u32', 'bool', 'string', 'enum', 'entity', 'vec3', 'quat', 'color', ...ENCODED_KINDS,
]);
const STRIDES: Partial<Record<PropKind, number>> = { vec3: 3, quat: 4, color: 4 };

/**
 * 把字面量换成属性声明，检查默认值，生成初始化函数。
 * numberKind 是数字字面量的含义：脚本里是 'number'，数据组件里是 'f32'。
 * reserved 是拥有者自己已经用了的名字（比如脚本的 `update`）。
 */
export function createSchema(shape: Shape, numberKind: 'number' | 'f32', reserved: ReadonlySet<string>, owner: string): Schema {
  const isData = numberKind === 'f32';
  const fields = Object.entries(shape).map(([name, value]): Field => {
    const where = `${owner}.${name}`;
    if (reserved.has(name)) throw new Error(`${owner}: '${name}' is reserved and cannot be a property name`);
    const { options } = toProp(value, numberKind, where);
    if (isData && !COLUMN_KINDS.has(options.kind)) throw new Error(`${where}: data components cannot have ${options.kind} props (scripts can)`);
    if (isData && options.stat) throw new Error(`${where}: stat() is for scripts; data components change values in systems`);
    if (isData && options.hasDefault && options.defaultValue === undefined) {
      throw new Error(`${where}: data component fields cannot be optional (columns have no missing value)`);
    }
    if (options.hasDefault && options.defaultValue !== undefined) {
      const problem = issuesOf(options, options.defaultValue, [])[0];
      if (problem) throw new RangeError(`${where}: default ${problem.message}`);
    }
    return { name, options, stride: STRIDES[options.kind] ?? 1 };
  });
  const defaults = fields.map((f) => f.options.defaultValue);
  const validate = (init: unknown): Issue[] => validateInit(fields, init);
  const check = CHECK_VALUES
    ? (init: object | undefined) => {
        const issue = validateInit(fields, init)[0];
        if (issue) throw new RangeError(describeIssue(owner, issue));
      }
    : undefined;
  return {
    owner,
    fields,
    defaults,
    assign: compile(fields, owner, 'object', defaults, check),
    writeRow: compile(fields, owner, 'row', defaults, check),
    validate,
  };
}

/** 报错文字：`Health.max is below…` 这类以 is 开头的直接接在路径后面，其余用冒号隔开。 */
function describeIssue(owner: string, issue: Issue): string {
  const where = [owner, ...issue.path].join('.');
  return issue.message.startsWith('is ') ? `${where} ${issue.message}` : `${where}: ${issue.message}`;
}

function toProp(value: unknown, numberKind: 'number' | 'f32', where: string): AnyProp {
  if (value instanceof Prop) return value;
  switch (typeof value) {
    case 'number':
      return prop[numberKind]().default(value);
    case 'string':
      return prop.string().default(value);
    case 'boolean':
      return prop.bool().default(value);
    default:
      throw new TypeError(`${where}: expected a prop or a number, string or boolean literal, got ${String(value)}`);
  }
}

// -------------------------------------------------------------------------------------------------
// 校验

const INTEGER_RANGES: Partial<Record<PropKind, readonly [number, number]>> = {
  int: [-0x8000_0000, 0x7fff_ffff],
  u8: [0, 0xff],
  u32: [0, 0xffff_ffff],
};

function validateInit(fields: readonly Field[], init: unknown, path: readonly (string | number)[] = []): Issue[] {
  if (init === undefined) init = {};
  if (typeof init !== 'object' || init === null) return [{ message: `${String(init)} is not an object`, path }];
  const values = init as Record<string, unknown>;
  const issues: Issue[] = [];
  for (const key of Object.keys(values)) {
    if (!fields.some((f) => f.name === key)) issues.push({ message: 'is not a property', path: [...path, key] });
  }
  for (const field of fields) {
    const value = values[field.name];
    const at = [...path, field.name];
    if (field.options.sealed && value !== undefined) {
      issues.push({ message: 'is sealed: its owner drives it, init and override objects cannot set it', path: at });
    } else if (value === undefined) {
      if (!field.options.hasDefault) issues.push({ message: 'is required', path: at });
    } else {
      issues.push(...issuesOf(field.options, value, at));
    }
  }
  return issues;
}

/** 一个属性的一个值有哪些问题。 */
function issuesOf(options: PropOptions, value: unknown, path: readonly (string | number)[]): Issue[] {
  const fail = (message: string): Issue[] => [{ message, path }];
  if (value === undefined && options.hasDefault && options.defaultValue === undefined) return [];
  switch (options.kind) {
    case 'bool':
      return typeof value === 'boolean' ? [] : fail(`${String(value)} is not a boolean`);
    case 'string':
      return typeof value === 'string' ? [] : fail(`${String(value)} is not a string`);
    case 'enum':
      return options.values?.includes(value as string) ? [] : fail(`'${String(value)}' is not one of ${options.values?.map((v) => `'${v}'`).join(', ')}`);
    case 'entity':
      return typeof value === 'number' ? [] : fail(`${String(value)} is not an entity id`);
    case 'vec3':
      return vectorIssue(value, ['x', 'y', 'z'], path);
    case 'quat':
      return vectorIssue(value, ['x', 'y', 'z', 'w'], path);
    case 'color':
      return vectorIssue(value, ['r', 'g', 'b', 'a'], path);
    case 'list':
      return Array.isArray(value) ? value.flatMap((item, i) => issuesOf(options.item!.options, item, [...path, i])) : fail('is not an array');
    case 'object':
      return validateInit(objectFields(options), value, path);
    case 'union': {
      const tag = typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[options.discriminator!] : undefined;
      const variant = typeof tag === 'string' ? options.variants![tag] : undefined;
      if (!variant) return fail(`${options.discriminator} must be one of ${Object.keys(options.variants!).map((v) => `'${v}'`).join(', ')}`);
      const { [options.discriminator!]: _, ...rest } = value as Record<string, unknown>;
      return validateInit(variantFields(options, tag as string), rest, path);
    }
    case 'json': {
      const result = options.schema!['~standard'].validate(value);
      if (result instanceof Promise) return fail('the schema validates asynchronously, which props do not support');
      return (result.issues ?? []).map((issue: StandardIssue) => ({
        message: issue.message,
        path: [...path, ...(issue.path ?? []).map((p) => String(typeof p === 'object' ? p.key : p))],
      }));
    }
    case 'component':
      return typeof value === 'object' && value !== null ? [] : fail('is not a script or component view');
    case 'asset':
      return typeof value === 'object' && value !== null ? [] : fail(`is not a loaded ${options.assetKind} (load it with game.content first)`);
    case 'i64':
    case 'u64':
    case 'decimal':
    case 'date':
    case 'time':
    case 'datetime':
    case 'instant':
    case 'bytes': {
      const problem = cellIssue(options, value);
      return problem ? fail(problem) : [];
    }
    default: {
      if (typeof value !== 'number' || Number.isNaN(value)) return fail(`${String(value)} is not a number`);
      const range = INTEGER_RANGES[options.kind];
      if (range && (!Number.isInteger(value) || value < range[0] || value > range[1])) {
        return fail(`${value} is not a ${options.kind} (integers ${range[0]}..${range[1]})`);
      }
      if (options.min !== undefined && value < options.min) return fail(`${value} is below the minimum ${options.min}`);
      if (options.max !== undefined && value > options.max) return fail(`${value} is above the maximum ${options.max}`);
      return [];
    }
  }
}

function vectorIssue(value: unknown, keys: readonly string[], path: readonly (string | number)[]): Issue[] {
  const ok = Array.isArray(value)
    ? value.length === keys.length && value.every((v) => typeof v === 'number')
    : typeof value === 'object' && value !== null && keys.every((k) => typeof (value as Record<string, unknown>)[k] === 'number');
  return ok ? [] : [{ message: `expected [${keys.join(', ')}] or { ${keys.join(', ')} } numbers`, path }];
}

// 嵌套 shape 的字段只解析一次
const nestedFields = new WeakMap<object, readonly Field[]>();
function fieldsOf(key: object, shape: Shape): readonly Field[] {
  let fields = nestedFields.get(key);
  if (!fields) {
    fields = createSchema(shape, 'number', new Set(), 'nested').fields;
    nestedFields.set(key, fields);
  }
  return fields;
}
const objectFields = (options: PropOptions) => fieldsOf(options, options.shape!);
const variantFields = (options: PropOptions, tag: string) => fieldsOf(options.variants![tag]!, options.variants![tag]!);

// -------------------------------------------------------------------------------------------------
// 把输入的值转成存下来的值

/** 把 init 或默认值转成脚本里拿到的值：向量变成数学对象，嵌套的值复制一份。 */
function toScriptValue(options: PropOptions, value: unknown): unknown {
  if (value === undefined) return undefined;
  switch (options.kind) {
    case 'vec3': {
      const [x, y, z] = components(value, ['x', 'y', 'z']);
      return new Vector3(x, y, z);
    }
    case 'quat': {
      const [x, y, z, w] = components(value, ['x', 'y', 'z', 'w']);
      return new Quaternion(x, y, z, w);
    }
    case 'color': {
      const [r, g, b, a] = components(value, ['r', 'g', 'b', 'a']);
      return new Color4(r, g, b, a);
    }
    case 'list':
      return (value as unknown[]).map((item) => toScriptValue(options.item!.options, item));
    case 'object':
      return nestedObject(objectFields(options), value as Record<string, unknown>);
    case 'union': {
      const tag = (value as Record<string, unknown>)[options.discriminator!] as string;
      return { [options.discriminator!]: tag, ...nestedObject(variantFields(options, tag), value as Record<string, unknown>) };
    }
    case 'json': {
      const result = options.schema!['~standard'].validate(value);
      return result instanceof Promise || result.issues ? value : result.value;
    }
    default:
      return ENCODED_KINDS.has(options.kind) || options.kind === 'bytes' ? toValue(options, value) : value;
  }
}

function nestedObject(fields: readonly Field[], value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) out[field.name] = toScriptValue(field.options, value[field.name] ?? field.options.defaultValue);
  return out;
}

function components(value: unknown, keys: readonly string[]): number[] {
  return Array.isArray(value) ? (value as number[]) : keys.map((k) => (value as Record<string, number>)[k]!);
}

/** copyValue 怎么换引用：实体 id、组件引用（脚本或数据组件的视图）各换成什么。 */
export interface ReferenceMap {
  entity(id: number): number;
  component(reference: object): object;
}

/**
 * 复制一个属性现在的值，用来当另一个拥有者的 init（克隆实体时）：实体引用、组件引用经 references 换，嵌套在列表、对象里的
 * 也换；json 深拷贝；其余原样返回（向量、列表这些在 assign、writeRow 时本来就会复制）。
 */
export function copyValue(options: PropOptions, value: unknown, references: ReferenceMap): unknown {
  if (value === undefined || value === null) return value;
  switch (options.kind) {
    case 'entity':
      return references.entity(value as number);
    case 'component':
      return references.component(value as object);
    case 'list':
      return (value as unknown[]).map((item) => copyValue(options.item!.options, item, references));
    case 'object':
      return copyFields(objectFields(options), value as Record<string, unknown>, references);
    case 'union': {
      const tag = (value as Record<string, unknown>)[options.discriminator!] as string;
      return { [options.discriminator!]: tag, ...copyFields(variantFields(options, tag), value as Record<string, unknown>, references) };
    }
    case 'json':
      return structuredClone(value);
    default:
      return value;
  }
}

/** 这个属性，或者它嵌套的列表元素、对象字段里，有没有 kind 这种属性。 */
export function containsKind(options: PropOptions, kind: PropKind): boolean {
  switch (options.kind) {
    case 'list':
      return containsKind(options.item!.options, kind);
    case 'object':
      return objectFields(options).some((field) => containsKind(field.options, kind));
    case 'union':
      return Object.keys(options.variants!).some((tag) => variantFields(options, tag).some((field) => containsKind(field.options, kind)));
    default:
      return options.kind === kind;
  }
}

function copyFields(fields: readonly Field[], value: Record<string, unknown>, references: ReferenceMap): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) out[field.name] = copyValue(field.options, value[field.name], references);
  return out;
}

/** 基本类型原样存；其余的要经过转换。 */
const isPlain = (kind: PropKind) => !['vec3', 'quat', 'color', 'list', 'object', 'union', 'json', 'bytes'].includes(kind) && !ENCODED_KINDS.has(kind);

// -------------------------------------------------------------------------------------------------
// 生成的初始化函数

type Initializer<Mode extends 'object' | 'row'> = Mode extends 'object' ? Schema['assign'] : Schema['writeRow'];

/**
 * 用 new Function 生成逐字段直接赋值的初始化函数；不允许生成代码的环境（CSP 没有 'unsafe-eval'）
 * 退回按字段循环。sealed 的字段总是取默认值。
 */
function compile<Mode extends 'object' | 'row'>(
  fields: readonly Field[],
  owner: string,
  mode: Mode,
  declaredDefaults: readonly unknown[],
  check: ((init: object | undefined) => void) | undefined,
): Initializer<Mode> {
  const missing = (name: string) => {
    throw new TypeError(`${owner}.${name} is required`);
  };
  // 转换函数：对象模式是转成脚本里的值；行模式是把 stride 个 float 写进列，或把值编码成 int64 / int32
  const convert = fields.map((field) =>
    mode === 'object'
      ? isPlain(field.options.kind) ? undefined : (value: unknown) => toScriptValue(field.options, value)
      : field.stride > 1
        ? (column: Float32Array, row: number, value: unknown) => {
            const values = components(value, field.options.kind === 'color' ? ['r', 'g', 'b', 'a'] : ['x', 'y', 'z', 'w'].slice(0, field.stride));
            column.set(values, row * field.stride);
          }
        : ENCODED_KINDS.has(field.options.kind)
          ? (column: unknown[], row: number, value: unknown) => {
              column[row] = toCell(field.options, value);
            }
          : undefined,
  );
  const lines = fields.map((field, i) => {
    const key = JSON.stringify(field.name);
    const read = field.options.sealed ? 'x = undefined;' : `x = v === undefined ? undefined : v[${key}];`;
    const value = field.options.hasDefault ? `x === undefined ? d[${i}] : x` : `x === undefined ? m(${key}) : x`;
    if (mode === 'object') return `${read} t[${key}] = ${convert[i] ? `cv[${i}](${value})` : value};`;
    if (convert[i]) return `${read} cv[${i}](c[${i}], r, ${value});`;
    return `${read} c[${i}][r] = ${field.options.kind === 'bool' ? `(${value}) ? 1 : 0` : value};`;
  });
  const params = mode === 'row' ? 'c, r, v, d = dd' : 't, v, d = dd';
  const body = `${check ? 'k(v);' : ''} let x; ${lines.join(' ')}`;
  try {
    return new Function('dd', 'm', 'k', 'cv', `return function (${params}) { ${body} };`)(declaredDefaults, missing, check, convert) as Initializer<Mode>;
  } catch {
    return fallback(fields, declaredDefaults, missing, check, convert, mode);
  }
}

function fallback<Mode extends 'object' | 'row'>(
  fields: readonly Field[],
  declaredDefaults: readonly unknown[],
  missing: (name: string) => never,
  check: ((init: object | undefined) => void) | undefined,
  convert: readonly (((...args: any[]) => unknown) | undefined)[],
  mode: Mode,
): Initializer<Mode> {
  const valueOf = (init: object | undefined, defaults: readonly unknown[], i: number) => {
    const field = fields[i]!;
    const given = init === undefined || field.options.sealed ? undefined : (init as Record<string, unknown>)[field.name];
    if (given !== undefined) return given;
    return field.options.hasDefault ? defaults[i] : missing(field.name);
  };
  if (mode === 'row') {
    const writeRow: Schema['writeRow'] = (columns, row, init, defaults = declaredDefaults) => {
      check?.(init);
      for (let i = 0; i < fields.length; i++) {
        const value = valueOf(init, defaults, i);
        if (convert[i]) convert[i]!(columns[i], row, value);
        else (columns[i] as unknown[])[row] = fields[i]!.options.kind === 'bool' ? (value ? 1 : 0) : value;
      }
    };
    return writeRow as Initializer<Mode>;
  }
  const assign: Schema['assign'] = (target, init, defaults = declaredDefaults) => {
    check?.(init);
    for (let i = 0; i < fields.length; i++) {
      const value = valueOf(init, defaults, i);
      (target as Record<string, unknown>)[fields[i]!.name] = convert[i] ? convert[i]!(value) : value;
    }
  };
  return assign as Initializer<Mode>;
}

// -------------------------------------------------------------------------------------------------
// 列

/** 给字段新建一列，能放 capacity 行。 */
export function createColumn(field: Field, capacity: number): Column {
  switch (field.options.kind) {
    case 'f32':
    case 'vec3':
    case 'quat':
    case 'color':
      return new Float32Array(capacity * field.stride);
    case 'number':
    case 'entity':
      return new Float64Array(capacity);
    case 'int':
    case 'date':
      return new Int32Array(capacity);
    case 'i64':
    case 'decimal':
    case 'time':
    case 'datetime':
    case 'instant':
      return new BigInt64Array(capacity);
    case 'u64':
      return new BigUint64Array(capacity);
    case 'u8':
    case 'bool':
      return new Uint8Array(capacity);
    case 'u32':
      return new Uint32Array(capacity);
    default:
      return new Array(capacity);
  }
}

/** 把列扩到能放 capacity 行，原有的值保留。 */
export function growColumn(column: Column, field: Field, capacity: number): Column {
  const grown = createColumn(field, capacity);
  if (Array.isArray(grown)) {
    for (let i = 0; i < column.length; i++) grown[i] = (column as unknown[])[i];
  } else {
    (grown as Float64Array).set(column as Float64Array);
  }
  return grown;
}

/** 复制一行的值（stride 个元素），在同一列内或同一字段的两列之间。 */
export function copyRow(from: Column, fromRow: number, to: Column, toRow: number, stride: number): void {
  if (stride === 1) {
    (to as unknown[])[toRow] = (from as unknown[])[fromRow];
    return;
  }
  for (let s = 0; s < stride; s++) (to as Float32Array)[toRow * stride + s] = (from as Float32Array)[fromRow * stride + s]!;
}
