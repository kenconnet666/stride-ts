/**
 * Systems: per-frame logic over every entity that has a set of data components. update() is called once
 * per table with that table's columns, typed from the component shapes:
 *
 *   export const regen = system({
 *     with: { health: Health, regen: Regen },
 *     without: [Dead],
 *     writes: [Health],
 *     update({ health, regen, count }, time) {
 *       for (let i = 0; i < count; i++)
 *         health.current[i] = Math.min(health.max[i], health.current[i] + regen.rate[i] * time.elapsed);
 *     },
 *   });
 */
import type { Columns, EntityId, Shape } from '../data/prop';
import type { GameTime } from '../games/GameTime';
import type { Commands } from './Commands';
import type { ComponentType } from './component';
import type { Table } from './storage';

/** Where in the frame a system runs, relative to the physics step (see docs/architecture.md, frame order). */
export type Phase = 'beforePhysics' | 'afterPhysics';

type Query = Record<string, ComponentType<any>>;
type ShapeOf<C> = C extends ComponentType<infer S extends Shape> ? S : never;

/** The entity id of each row: a Float64Array whose elements are typed as EntityId. */
export type EntityIds = Float64Array & { readonly [row: number]: EntityId };

/** One table's worth of entities: `count` rows, their ids, and the columns of every queried component. */
export type Chunk<W extends Query> = {
  readonly count: number;
  readonly entities: EntityIds;
} & { readonly [K in keyof W]: Columns<ShapeOf<W[K]>> };

export interface SystemSpec<W extends Query> {
  /** The components to select on; the keys are the names update() destructures. */
  readonly with: W & { readonly count?: never; readonly entities?: never };
  readonly without?: readonly ComponentType<any>[];
  /** Components this system changes: their tables get a new version, which `changed` filters on. */
  readonly writes?: readonly W[keyof W][];
  /** Only visit tables where one of these components was written since this system last ran. */
  readonly changed?: readonly W[keyof W][];
  readonly phase?: Phase;
  /** Systems of the same phase that must run first. */
  readonly after?: readonly System<any>[];
  update(chunk: Chunk<W>, time: GameTime, commands: Commands): void;
}

export class System<W extends Query = Query> {
  readonly spec: SystemSpec<W>;
  readonly phase: Phase;
  #name: string | undefined;

  /** @internal Tables matched so far, and how many of the manager's tables have been looked at. */
  readonly matched: Table[] = [];
  /** @internal */
  tablesSeen = 0;
  /** @internal One chunk object per matched table, refreshed before each call. */
  readonly chunks = new Map<Table, Record<string, unknown>>();
  /** @internal Write version at this system's last run, for `changed`. */
  lastRun = 0;

  constructor(name: string | undefined, spec: SystemSpec<W>) {
    this.#name = name;
    this.spec = spec;
    this.phase = spec.phase ?? 'beforePhysics';
    const queried = new Set(Object.values(spec.with));
    for (const type of [...(spec.writes ?? []), ...(spec.changed ?? [])]) {
      if (!queried.has(type)) throw new Error(`system ${this.name}: ${type.name} is in writes/changed but not in with`);
    }
  }

  get name(): string {
    return this.#name ?? '(unregistered system)';
  }

  get isNamed(): boolean {
    return this.#name !== undefined;
  }

  /** @internal Set by the registry. */
  setName(name: string): void {
    if (this.#name !== undefined && this.#name !== name) throw new Error(`${this.#name} is already named; cannot rename it to ${name}`);
    this.#name = name;
  }

  /** @internal Whether a table has every `with` component and none of the `without` ones. */
  matches(table: Table): boolean {
    return Object.values(this.spec.with).every((type) => table.has(type)) && !(this.spec.without ?? []).some((type) => table.has(type));
  }
}

export function system<W extends Query>(spec: SystemSpec<W>): System<W>;
export function system<W extends Query>(name: string, spec: SystemSpec<W>): System<W>;
export function system(nameOrSpec: string | SystemSpec<Query>, spec?: SystemSpec<Query>): System {
  return typeof nameOrSpec === 'string' ? new System(nameOrSpec, spec!) : new System(undefined, nameOrSpec);
}

/** Orders the added systems: by phase, then so that every system runs after the ones in its `after`. */
export function orderSystems(systems: readonly System<any>[]): System<any>[] {
  const ordered: System<any>[] = [];
  const state = new Map<System<any>, 'visiting' | 'done'>();
  const visit = (s: System<any>, path: readonly System<any>[]) => {
    const seen = state.get(s);
    if (seen === 'done') return;
    if (seen === 'visiting') throw new Error(`systems depend on each other in a cycle: ${[...path, s].map((x) => x.name).join(' -> ')}`);
    state.set(s, 'visiting');
    for (const before of s.spec.after ?? []) {
      if (!systems.includes(before)) throw new Error(`system ${s.name} runs after ${before.name}, which was not added`);
      if (before.phase !== s.phase) throw new Error(`system ${s.name} (${s.phase}) cannot run after ${before.name} (${before.phase})`);
      visit(before, [...path, s]);
    }
    state.set(s, 'done');
    ordered.push(s);
  };
  for (const phase of ['beforePhysics', 'afterPhysics'] as const) {
    for (const s of systems) if (s.phase === phase) visit(s, []);
  }
  return ordered;
}
