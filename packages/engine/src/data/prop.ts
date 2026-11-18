/**
 * Property declarations: `prop.f32().min(0).default(100)`. A Prop is immutable; every modifier returns a new
 * one and records what it changed in the type parameters, so the TS types of scripts, components, init
 * objects and columns are inferred from the declaration alone (same approach as easy-query-ts's columns).
 */

/** How a value is stored: data components keep a column of this kind per field. */
export type PropKind = 'number' | 'f32' | 'int' | 'u8' | 'u32' | 'bool' | 'string' | 'enum' | 'entity';

declare const brandKey: unique symbol;
/** A value type that only differs by name at compile time: `EntityId` and `BodyId` cannot be mixed up. */
export type Branded<T, B extends string> = T & { readonly [brandKey]: B };

/** An entity handle: index plus generation, so a handle to a destroyed entity is detected. */
export type EntityId = Branded<number, 'EntityId'>;

export interface PropOptions {
  readonly kind: PropKind;
  /** Whether `defaultValue` applies; a prop without one must be given a value. */
  readonly hasDefault: boolean;
  readonly defaultValue: unknown;
  /** Runtime state: not saved, not shown in the editor. */
  readonly transient: boolean;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly unit?: string;
  readonly label?: string;
  readonly group?: string;
  readonly description?: string;
  readonly hidden?: boolean;
  /** Earlier field name: scene files and hot reload still read values saved under it. */
  readonly renamedFrom?: string;
  /** Allowed values of an enum prop. */
  readonly values?: readonly string[];
}

/**
 * One property. T is the value type, D whether it has a default (then it may be left out when creating),
 * K the storage kind. The declare-only fields exist in types only.
 */
export class Prop<T, D extends boolean = false, K extends PropKind = PropKind> {
  declare readonly __type: T;
  declare readonly __hasDefault: D;
  declare readonly __kind: K;
  readonly options: PropOptions;

  constructor(options: PropOptions) {
    this.options = options;
  }

  private changed(changes: Partial<PropOptions>): Prop<any, any, any> {
    return new Prop({ ...this.options, ...changes });
  }

  default(value: T): Prop<T, true, K> {
    return this.changed({ hasDefault: true, defaultValue: value });
  }

  /** The value may be undefined; that is also its default. Not for data components (columns have no "missing"). */
  optional(): Prop<T | undefined, true, K> {
    return this.changed({ hasDefault: true, defaultValue: undefined });
  }

  /** Runtime state: not saved and not shown in the editor, so it needs a default. */
  transient(this: Prop<T, true, K>): Prop<T, true, K> {
    return this.changed({ transient: true });
  }

  min(this: Prop<number, D, K>, value: number): Prop<T, D, K> {
    return this.changed({ min: value });
  }

  max(this: Prop<number, D, K>, value: number): Prop<T, D, K> {
    return this.changed({ max: value });
  }

  /** Editor slider step. */
  step(this: Prop<number, D, K>, value: number): Prop<T, D, K> {
    return this.changed({ step: value });
  }

  /** Shown next to the value in the editor: 'm/s', 'deg'. */
  unit(this: Prop<number, D, K>, value: string): Prop<T, D, K> {
    return this.changed({ unit: value });
  }

  label(value: string): Prop<T, D, K> {
    return this.changed({ label: value });
  }

  group(value: string): Prop<T, D, K> {
    return this.changed({ group: value });
  }

  description(value: string): Prop<T, D, K> {
    return this.changed({ description: value });
  }

  hidden(): Prop<T, D, K> {
    return this.changed({ hidden: true });
  }

  renamedFrom(oldName: string): Prop<T, D, K> {
    return this.changed({ renamedFrom: oldName });
  }

  /** Changes the type only: `prop.u32().brand<'TeamId'>()`. */
  brand<B extends string>(): Prop<Branded<T, B>, D, K> {
    return this as unknown as Prop<Branded<T, B>, D, K>;
  }
}

export type AnyProp = Prop<any, boolean, PropKind>;

const declare = <T, K extends PropKind>(kind: K, extra: Partial<PropOptions> = {}): Prop<T, false, K> =>
  new Prop({ kind, hasDefault: false, defaultValue: undefined, transient: false, ...extra });

export const prop = {
  /** 64-bit float; a column of Float64Array. */
  number: () => declare<number, 'number'>('number'),
  /** 32-bit float; a column of Float32Array. The usual choice for data components. */
  f32: () => declare<number, 'f32'>('f32'),
  /** 32-bit signed integer; a column of Int32Array. */
  int: () => declare<number, 'int'>('int'),
  u8: () => declare<number, 'u8'>('u8'),
  u32: () => declare<number, 'u32'>('u32'),
  /** A column of Uint8Array (0 or 1) in data components, a boolean in scripts. */
  bool: () => declare<boolean, 'bool'>('bool'),
  string: () => declare<string, 'string'>('string'),
  enum: <const V extends string>(values: readonly [V, ...V[]]) => declare<V, 'enum'>('enum', { values }),
  /** A handle to another entity; a column of Float64Array. */
  entity: () => declare<EntityId, 'entity'>('entity'),
};

/** What a shape may contain: props, or literals as shorthand for "this type with this default". */
export type ShapeValue = AnyProp | number | string | boolean;
export type Shape = { readonly [key: string]: ShapeValue };

/** The prop a shape value stands for in a script: a number literal is a 64-bit number. */
export type ScriptPropOf<V> = V extends AnyProp
  ? V
  : V extends number
    ? Prop<number, true, 'number'>
    : V extends string
      ? Prop<string, true, 'string'>
      : V extends boolean
        ? Prop<boolean, true, 'bool'>
        : never;

/** The prop a shape value stands for in a data component: a number literal is an f32 column. */
export type DataPropOf<V> = V extends AnyProp
  ? V
  : V extends number
    ? Prop<number, true, 'f32'>
    : V extends string
      ? Prop<string, true, 'string'>
      : V extends boolean
        ? Prop<boolean, true, 'bool'>
        : never;

type TypeOf<P> = P extends Prop<infer T, any, any> ? T : never;
type HasDefault<P> = P extends Prop<any, infer D, any> ? D : never;

/** Field values of a script shape. */
export type ScriptValues<S extends Shape> = { -readonly [K in keyof S]: TypeOf<ScriptPropOf<S[K]>> };

/** Field values of a data component shape. */
export type DataValues<S extends Shape> = { -readonly [K in keyof S]: TypeOf<DataPropOf<S[K]>> };

type Flat<T> = { [K in keyof T]: T[K] } & {};
type KeysWithDefault<S extends Shape, Of> = { [K in keyof S]: HasDefault<Of extends 'data' ? DataPropOf<S[K]> : ScriptPropOf<S[K]>> extends true ? K : never }[keyof S];

/** What creating a script or component takes: props without a default are required. */
export type InitOf<S extends Shape, Of extends 'data' | 'script'> = Flat<
  { [K in Exclude<keyof S, KeysWithDefault<S, Of>>]: (Of extends 'data' ? DataValues<S> : ScriptValues<S>)[K] } & {
    [K in KeysWithDefault<S, Of>]?: (Of extends 'data' ? DataValues<S> : ScriptValues<S>)[K];
  }
>;

/** The typed array (or plain array) a data component keeps per field. */
export type ColumnOf<P> = P extends Prop<infer T, any, infer K>
  ? K extends 'f32'
    ? Float32Array
    : K extends 'number' | 'entity'
      ? Float64Array
      : K extends 'int'
        ? Int32Array
        : K extends 'u8' | 'bool'
          ? Uint8Array
          : K extends 'u32'
            ? Uint32Array
            : T[]
  : never;

export type Columns<S extends Shape> = { readonly [K in keyof S]: ColumnOf<DataPropOf<S[K]>> };
