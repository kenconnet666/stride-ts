/**
 * 系统：对拥有某组数据组件的所有实体做的每帧逻辑。update() 每张表调用一次，拿到这张表的列，
 * 列的类型由组件的 shape 推导：
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
import type { EntityId } from '../data/prop';
import type { GameTime } from './GameTime';
import type { Commands } from './Commands';
import type { ColumnsOf, ComponentType } from './component';
import type { Table } from './storage';

/** 系统在一帧里相对物理步进的位置（见 docs/architecture.md 的每帧顺序）。 */
export type Phase = 'beforePhysics' | 'afterPhysics';

type Query = Record<string, ComponentType<any, any>>;

/** 每一行的实体 id：元素类型标成 EntityId 的 Float64Array。 */
export type EntityIds = Float64Array & { readonly [row: number]: EntityId };

/** 一张表的实体：`count` 行、它们的 id，以及每个查询组件的列。 */
export type Chunk<W extends Query> = {
  readonly count: number;
  readonly entities: EntityIds;
} & { readonly [K in keyof W]: ColumnsOf<W[K]> };

export interface SystemSpec<W extends Query> {
  /** 要筛选的组件；键名就是 update() 里解构出来的名字。 */
  readonly with: W & { readonly count?: never; readonly entities?: never };
  readonly without?: readonly ComponentType<any>[];
  /** 这个系统会改的组件：跑过之后表的版本递增，`changed` 按版本筛选。 */
  readonly writes?: readonly W[keyof W][];
  /** 只处理自这个系统上次运行以来、这些组件被写过的表。 */
  readonly changed?: readonly W[keyof W][];
  readonly phase?: Phase;
  /** 同一阶段里必须先跑的系统。 */
  readonly after?: readonly System<any>[];
  update(chunk: Chunk<W>, time: GameTime, commands: Commands): void;
  /**
   * 实体开始满足这个系统的条件时调用（创建、加组件，或系统加入时已经满足的实体），数据已经写好。
   * 用来创建对应的原生资源，比如刚体。结构性改动只能记进 commands。
   */
  added?(entity: EntityId, commands: Commands): void;
  /** 实体不再满足条件时调用（销毁、去掉组件，或系统被移除），这时还能读到它的数据。 */
  removed?(entity: EntityId, commands: Commands): void;
}

export class System<W extends Query = Query> {
  readonly spec: SystemSpec<W>;
  readonly phase: Phase;
  #name: string | undefined;

  /** @internal 已经匹配上的表，以及管理器的表看到了第几张。 */
  readonly matched: Table[] = [];
  /** @internal */
  tablesSeen = 0;
  /** @internal 每张匹配的表一个 chunk 对象，每次调用前刷新。 */
  readonly chunks = new Map<Table, Record<string, unknown>>();
  /** @internal 这个系统上次运行时的写入版本，给 `changed` 用。 */
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

  /** @internal 由登记表设置。 */
  setName(name: string): void {
    if (this.#name !== undefined && this.#name !== name) throw new Error(`${this.#name} is already named; cannot rename it to ${name}`);
    this.#name = name;
  }

  /** @internal 表是否有 `with` 里的全部组件、且没有 `without` 里的任何一个。 */
  matches(table: Table): boolean {
    return Object.values(this.spec.with).every((type) => table.has(type)) && !(this.spec.without ?? []).some((type) => table.has(type));
  }
}

export function system<W extends Query>(spec: SystemSpec<W>): System<W>;
export function system<W extends Query>(name: string, spec: SystemSpec<W>): System<W>;
export function system(nameOrSpec: string | SystemSpec<Query>, spec?: SystemSpec<Query>): System {
  return typeof nameOrSpec === 'string' ? new System(nameOrSpec, spec!) : new System(undefined, nameOrSpec);
}

/** 给加入的系统排序：先按阶段，再保证每个系统都在它 `after` 里的系统之后。 */
export function orderSystems(systems: readonly System<any>[]): System<any>[] {
  const ordered: System<any>[] = [];
  const state = new Map<System<any>, 'visiting' | 'done'>();
  const visit = (s: System<any>, path: readonly System<any>[]) => {
    const seen = state.get(s);
    if (seen === 'done') return;
    if (seen === 'visiting') throw new Error(`systems depend on each other in a cycle: ${[...path, s].map((x) => x.name).join(' -> ')}`);
    state.set(s, 'visiting');
    for (const after of s.spec.after ?? []) {
      // 热重载后，没重新执行的代码手里可能还是旧版本：按名字找加入的新版本
      const before = systems.includes(after) ? after : systems.find((x) => x.isNamed && x.name === after.name);
      if (!before) throw new Error(`system ${s.name} runs after ${after.name}, which was not added`);
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
