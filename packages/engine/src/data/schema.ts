/**
 * Turns a shape (`{ max: prop.f32().default(100), current: 100 }`) into the runtime schema of a script or
 * data component: its fields, and initializers generated once per schema. A generated initializer assigns
 * field by field in straight-line code; looping over key names was 17x slower in apps/bench.
 */
import { prop, Prop, type AnyProp, type PropKind, type PropOptions, type Shape } from './prop';

export interface Field {
  readonly name: string;
  readonly options: PropOptions;
}

/** A data component's storage for one field. */
export type Column = Float32Array | Float64Array | Int32Array | Uint8Array | Uint32Array | unknown[];

export interface Schema {
  readonly fields: readonly Field[];
  /** Sets every field on target from init, or from the default; throws when a required field is missing. */
  readonly assign: (target: object, init: object | undefined) => void;
  /** Writes one row of a data component's columns (one column per field, in field order). */
  readonly writeRow: (columns: readonly Column[], row: number, init: object | undefined) => void;
}

/** Whether values passed in at runtime are checked against kinds, ranges and enum lists. */
const CHECK_VALUES = (import.meta as { env?: { DEV?: boolean } }).env?.DEV ?? true;

/**
 * Resolves literals to props, checks defaults, and builds the initializers.
 * numberKind is what a number literal means: 'number' in scripts, 'f32' in data components.
 * reserved lists names the owner already uses (a script's `update`, a chunk's `count`).
 */
export function createSchema(shape: Shape, numberKind: 'number' | 'f32', reserved: ReadonlySet<string>, owner: string): Schema {
  const fields = Object.entries(shape).map(([name, value]): Field => {
    if (reserved.has(name)) throw new Error(`${owner}: '${name}' is reserved and cannot be a property name`);
    const declared = toProp(value, numberKind, `${owner}.${name}`);
    checkDefault(declared.options, `${owner}.${name}`);
    return { name, options: declared.options };
  });
  const isData = numberKind === 'f32';
  if (isData) {
    for (const field of fields) {
      if (field.options.hasDefault && field.options.defaultValue === undefined) {
        throw new Error(`${owner}.${field.name}: data component fields cannot be optional (columns have no missing value)`);
      }
    }
  }
  return {
    fields,
    assign: compile(fields, owner, 'object'),
    writeRow: compile(fields, owner, 'row'),
  };
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

function checkDefault(options: PropOptions, where: string): void {
  if (!options.hasDefault || options.defaultValue === undefined) return;
  const problem = valueProblem(options, options.defaultValue);
  if (problem) throw new RangeError(`${where}: default ${problem}`);
}

const INTEGER_RANGES: Partial<Record<PropKind, readonly [number, number]>> = {
  int: [-0x8000_0000, 0x7fff_ffff],
  u8: [0, 0xff],
  u32: [0, 0xffff_ffff],
};

/** Why a value does not fit the prop, or undefined when it does. */
function valueProblem(options: PropOptions, value: unknown): string | undefined {
  switch (options.kind) {
    case 'bool':
      return typeof value === 'boolean' ? undefined : `${String(value)} is not a boolean`;
    case 'string':
      return typeof value === 'string' ? undefined : `${String(value)} is not a string`;
    case 'enum':
      return options.values?.includes(value as string) ? undefined : `'${String(value)}' is not one of ${options.values?.map((v) => `'${v}'`).join(', ')}`;
    case 'entity':
      return typeof value === 'number' ? undefined : `${String(value)} is not an entity id`;
    default: {
      if (typeof value !== 'number' || Number.isNaN(value)) return `${String(value)} is not a number`;
      const range = INTEGER_RANGES[options.kind];
      if (range && (!Number.isInteger(value) || value < range[0] || value > range[1])) {
        return `${value} is not a ${options.kind} (integers ${range[0]}..${range[1]})`;
      }
      if (options.min !== undefined && value < options.min) return `${value} is below the minimum ${options.min}`;
      if (options.max !== undefined && value > options.max) return `${value} is above the maximum ${options.max}`;
      return undefined;
    }
  }
}

function checkValues(fields: readonly Field[], init: object | undefined, owner: string): void {
  if (init === undefined) return;
  const values = init as Record<string, unknown>;
  for (const key of Object.keys(values)) {
    const field = fields.find((f) => f.name === key);
    if (!field) throw new TypeError(`${owner}: '${key}' is not a property`);
    const value = values[key];
    if (value === undefined && field.options.hasDefault) continue;
    const problem = valueProblem(field.options, value);
    if (problem) throw new RangeError(`${owner}.${key}: ${problem}`);
  }
}

type Initializer<Mode extends 'object' | 'row'> = Mode extends 'object' ? Schema['assign'] : Schema['writeRow'];

/**
 * Straight-line initializer, generated with new Function; where code generation is not allowed (a CSP
 * without 'unsafe-eval') it falls back to a loop over the fields.
 */
function compile<Mode extends 'object' | 'row'>(fields: readonly Field[], owner: string, mode: Mode): Initializer<Mode> {
  const defaults = fields.map((f) => f.options.defaultValue);
  const missing = (name: string) => {
    throw new TypeError(`${owner}.${name} is required`);
  };
  const check = CHECK_VALUES ? (init: object | undefined) => checkValues(fields, init, owner) : undefined;
  const lines = fields.map((field, i) => {
    const key = JSON.stringify(field.name);
    const read = `x = v === undefined ? undefined : v[${key}];`;
    const value = field.options.hasDefault ? `x === undefined ? d[${i}] : x` : `x === undefined ? m(${key}) : x`;
    const stored = mode === 'row' && field.options.kind === 'bool' ? `(${value}) ? 1 : 0` : value;
    return mode === 'row' ? `${read} c[${i}][r] = ${stored};` : `${read} t[${key}] = ${stored};`;
  });
  const params = mode === 'row' ? 'c, r, v' : 't, v';
  const body = `${check ? 'k(v);' : ''} let x; ${lines.join(' ')}`;
  try {
    return new Function('d', 'm', 'k', `return function (${params}) { ${body} };`)(defaults, missing, check) as Initializer<Mode>;
  } catch {
    return fallback(fields, defaults, missing, check, mode);
  }
}

function fallback<Mode extends 'object' | 'row'>(
  fields: readonly Field[],
  defaults: readonly unknown[],
  missing: (name: string) => never,
  check: ((init: object | undefined) => void) | undefined,
  mode: Mode,
): Initializer<Mode> {
  const valueOf = (init: object | undefined, i: number) => {
    const name = fields[i]!.name;
    const given = init === undefined ? undefined : (init as Record<string, unknown>)[name];
    if (given !== undefined) return given;
    return fields[i]!.options.hasDefault ? defaults[i] : missing(name);
  };
  if (mode === 'row') {
    const writeRow: Schema['writeRow'] = (columns, row, init) => {
      check?.(init);
      for (let i = 0; i < fields.length; i++) {
        const value = valueOf(init, i);
        (columns[i] as unknown[])[row] = fields[i]!.options.kind === 'bool' ? (value ? 1 : 0) : value;
      }
    };
    return writeRow as Initializer<Mode>;
  }
  const assign: Schema['assign'] = (target, init) => {
    check?.(init);
    for (let i = 0; i < fields.length; i++) (target as Record<string, unknown>)[fields[i]!.name] = valueOf(init, i);
  };
  return assign as Initializer<Mode>;
}

/** A new column of the field's kind with room for capacity rows. */
export function createColumn(kind: PropKind, capacity: number): Column {
  switch (kind) {
    case 'f32':
      return new Float32Array(capacity);
    case 'number':
    case 'entity':
      return new Float64Array(capacity);
    case 'int':
      return new Int32Array(capacity);
    case 'u8':
    case 'bool':
      return new Uint8Array(capacity);
    case 'u32':
      return new Uint32Array(capacity);
    case 'string':
    case 'enum':
      return new Array(capacity);
  }
}

/** The same column with room for capacity rows, values kept. */
export function growColumn(column: Column, kind: PropKind, capacity: number): Column {
  const grown = createColumn(kind, capacity);
  if (Array.isArray(grown)) {
    for (let i = 0; i < column.length; i++) grown[i] = (column as unknown[])[i];
  } else {
    (grown as Float64Array).set(column as Float64Array);
  }
  return grown;
}
