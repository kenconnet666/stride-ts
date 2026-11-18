/**
 * Data components: plain data kept in columns, one per field, for many entities at once.
 * `component({ max: prop.f32().default(100), current: 100 })`; the name comes from the module path and
 * export when the game registers its modules, or is given first for engine and library components.
 */
import type { InitOf, Shape } from '../data/prop';
import { createSchema, type Schema } from '../data/schema';

let nextTypeId = 0;
const NO_RESERVED_NAMES = new Set<string>();

export class ComponentType<S extends Shape = Shape> {
  declare readonly __shape: S;
  /** True when every field has a default, so the type can be listed without values. */
  declare readonly __bare: {} extends InitOf<S, 'data'> ? true : false;
  /** Index into per-type arrays of the storage. */
  readonly id = nextTypeId++;
  readonly schema: Schema;
  /** A tag has no fields; only its presence matters (Dead, Stunned). */
  readonly isTag: boolean;
  #name: string | undefined;

  constructor(name: string | undefined, shape: S) {
    this.#name = name;
    this.schema = createSchema(shape, 'f32', NO_RESERVED_NAMES, name ?? 'component');
    this.isTag = this.schema.fields.length === 0;
  }

  /** The registered name: given explicitly, or `path#Export` once the game registered the module. */
  get name(): string {
    return this.#name ?? `(unregistered component #${this.id})`;
  }

  get isNamed(): boolean {
    return this.#name !== undefined;
  }

  /** @internal Set by the registry. */
  setName(name: string): void {
    if (this.#name !== undefined && this.#name !== name) throw new Error(`${this.#name} is already named; cannot rename it to ${name}`);
    this.#name = name;
  }

  /** This component with values, for entities.create: `Health.with({ max: 150 })`. */
  with(init: InitOf<S, 'data'>): ComponentInit<S> {
    return { type: this, init };
  }
}

export interface ComponentInit<S extends Shape = Shape> {
  readonly type: ComponentType<S>;
  readonly init: object | undefined;
}

/** A component type whose fields all have defaults, so it can be listed as is. */
export type BareComponent = ComponentType<any> & { readonly __bare: true };

export function component<S extends Shape>(shape: S): ComponentType<S>;
export function component<S extends Shape>(name: string, shape: S): ComponentType<S>;
export function component(nameOrShape: string | Shape, shape?: Shape): ComponentType {
  return typeof nameOrShape === 'string' ? new ComponentType(nameOrShape, shape ?? {}) : new ComponentType(undefined, nameOrShape);
}

/** A component without fields, used as a marker that systems select on: `without: [Dead]`. */
export function tag(name?: string): ComponentType<{}> {
  return new ComponentType(name, {});
}
