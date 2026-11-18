/**
 * Owns the entities of a game: their data components in archetype tables, their scripts, and the systems.
 * update() runs one frame in the documented order (docs/architecture.md, "生命周期"): pending start() and
 * execute() calls, SyncScript.update, systems before physics, systems after physics, then the AsyncScript
 * waiters, whose continuations run once the frame's task returns.
 */
import type { Columns, EntityId, Shape } from '../data/prop';
import type { Game } from '../games/Game';
import type { GameTime } from '../games/GameTime';
import { Commands } from './Commands';
import { ComponentType, type BareComponent, type ComponentInit } from './component';
import { Entity } from './Entity';
import { AsyncScript, ScriptComponent, StartupScript, SyncScript, scriptName, type BareScript, type ScriptConstructor, type ScriptInit } from './scripts';
import { Table, tableKey } from './storage';
import { orderSystems, type Phase, type System } from './system';

/** What an entity can be created with or given: a data component (bare or with values) or a script. */
export type EntityArg = ComponentInit<any> | BareComponent | ScriptInit<any> | BareScript;

export interface EntityDesc {
  readonly name?: string;
  readonly components?: readonly EntityArg[];
}

/**
 * Entities made by one spawn() call. Their rows are consecutive, from firstRow, until the next structural
 * change (destroying or moving an entity of the table moves another row into the gap).
 */
export interface SpawnBatch {
  readonly ids: readonly EntityId[];
  readonly count: number;
  readonly firstRow: number;
  /** The table's columns of a spawned component; writing through them counts as a change for `changed`. */
  columns<S extends Shape>(type: ComponentType<S>): Columns<S>;
}

/** Ids are index + generation * 2^20: up to about a million live entities, stale ids are detected. */
const INDEX_SPAN = 1 << 20;
const indexOf = (id: number) => id % INDEX_SPAN;

interface Waiter {
  readonly script: AsyncScript;
  readonly done: (time: GameTime) => boolean;
  readonly resolve: () => void;
  readonly reject: (reason: unknown) => void;
}

export class EntityManager {
  readonly game: Game;
  /** Called with errors no caller can catch: a rejected AsyncScript.execute. */
  onError: (error: unknown) => void = (error) => {
    throw error;
  };

  // Per entity index
  readonly #generation: number[] = [];
  readonly #table: (Table | undefined)[] = [];
  readonly #row: number[] = [];
  readonly #objects: (Entity | undefined)[] = [];
  readonly #free: number[] = [];
  #alive = 0;

  readonly #tables = new Map<string, Table>();
  /** @internal In creation order; systems keep how many they have looked at. */
  readonly tables: Table[] = [];

  #systems: System<any>[] = [];
  #ordered: System<any>[] | undefined;
  readonly #commands = new Commands();
  /** Bumped on every write that `changed` filters should see. */
  #version = 1;
  #iterating = false;

  readonly #pendingStart: ScriptComponent[] = [];
  #syncScripts: SyncScript[] = [];
  #waiters: Waiter[] = [];

  constructor(game: Game) {
    this.game = game;
  }

  /** Live entities. */
  get count(): number {
    return this.#alive;
  }

  isAlive(id: EntityId): boolean {
    const index = indexOf(id);
    return this.#table[index] !== undefined && this.#generation[index] === Math.floor(id / INDEX_SPAN);
  }

  /** Creates an entity with its components and scripts placed directly in their final table. */
  create(desc: EntityDesc = {}): Entity {
    this.#assertNotIterating('create an entity');
    const { components, scripts } = splitArgs(desc.components ?? []);
    const id = this.#allocate(this.#tableFor(components.map((c) => c.type)));
    this.#writeComponents(id, components);
    const entity = new Entity(this, id, desc.name ?? `entity ${indexOf(id)}`);
    this.#objects[indexOf(id)] = entity;
    for (const script of scripts) this.#attach(entity, script);
    return entity;
  }

  /**
   * Creates count entities that only have data components, without entity objects. They take consecutive
   * rows of one table, so the returned batch can set per-entity values column by column:
   *
   *   const batch = entities.spawn(1000, [Position, Velocity]);
   *   const velocity = batch.columns(Velocity);
   *   for (let i = 0; i < batch.count; i++) velocity.y[batch.firstRow + i] = Math.random();
   */
  spawn(count: number, components: readonly (ComponentInit<any> | BareComponent)[]): SpawnBatch {
    this.#assertNotIterating('spawn entities');
    const { components: inits, scripts } = splitArgs(components);
    if (scripts.length > 0) throw new TypeError('spawn() takes data components only; create entities with scripts one by one');
    const table = this.#tableFor(inits.map((c) => c.type));
    const firstRow = table.count;
    const ids: EntityId[] = new Array(count);
    for (let i = 0; i < count; i++) {
      ids[i] = this.#allocate(table);
      this.#writeComponents(ids[i]!, inits);
    }
    return {
      ids,
      count,
      firstRow,
      columns: <S extends Shape>(type: ComponentType<S>) => {
        const set = table.sets[type.id];
        if (!set) throw new Error(`the spawned entities have no ${type.name}`);
        set.version = ++this.#version;
        return set.byName as Columns<S>;
      },
    };
  }

  /** The object of an entity, made on first use for entities that were spawned as ids. */
  entity(id: EntityId): Entity {
    this.#assertAlive(id);
    const index = indexOf(id);
    return (this.#objects[index] ??= new Entity(this, id, `entity ${index}`));
  }

  destroy(id: EntityId): void {
    this.#assertNotIterating('destroy an entity');
    this.#assertAlive(id);
    const index = indexOf(id);
    const entity = this.#objects[index];
    if (entity) {
      for (const script of [...entity.scripts.values()]) this.#detach(entity, script);
    }
    this.#removeRow(index);
    this.#table[index] = undefined;
    this.#objects[index] = undefined;
    this.#generation[index] = (this.#generation[index]! + 1) % 0x10000;
    this.#free.push(index);
    this.#alive--;
  }

  add(id: EntityId, arg: EntityArg): void {
    this.#assertNotIterating('add a component');
    this.#assertAlive(id);
    const { components, scripts } = splitArgs([arg]);
    for (const script of scripts) this.#attach(this.entity(id), script);
    for (const component of components) {
      const index = indexOf(id);
      const from = this.#table[index]!;
      if (from.has(component.type)) throw new Error(`entity ${id} already has ${component.type.name}`);
      this.#move(index, this.#tableFor([...from.types, component.type]));
      this.#writeComponents(id, [component]);
    }
  }

  remove(id: EntityId, type: ComponentType<any> | ScriptConstructor): void {
    this.#assertNotIterating('remove a component');
    this.#assertAlive(id);
    if (typeof type === 'function') {
      const entity = this.entity(id);
      const script = entity.scripts.get(type);
      if (!script) throw new Error(`entity ${id} has no ${scriptName(type)}`);
      this.#detach(entity, script);
      return;
    }
    const index = indexOf(id);
    const from = this.#table[index]!;
    if (!from.has(type)) throw new Error(`entity ${id} has no ${type.name}`);
    this.#move(index, this.#tableFor(from.types.filter((t) => t !== type)));
    this.#objects[index]?.views.delete(type);
  }

  hasComponent(id: EntityId, type: ComponentType<any>): boolean {
    return this.isAlive(id) && this.#table[indexOf(id)]!.has(type);
  }

  /** @internal A view object whose fields read and write the entity's row; see Entity.get. */
  createView(id: EntityId, type: ComponentType<any>): object {
    const view = {};
    type.schema.fields.forEach((field, f) => {
      const isBool = field.options.kind === 'bool';
      Object.defineProperty(view, field.name, {
        enumerable: true,
        get: () => {
          const [column, row] = this.#cell(id, type, f);
          const value = (column as unknown[])[row];
          return isBool ? value === 1 : value;
        },
        set: (value: unknown) => {
          const [column, row] = this.#cell(id, type, f);
          (column as unknown[])[row] = isBool ? (value ? 1 : 0) : value;
          this.#table[indexOf(id)]!.sets[type.id]!.version = ++this.#version;
        },
      });
    });
    return view;
  }

  // ---------------------------------------------------------------------------------------------
  // Systems

  addSystems(...systems: System<any>[]): void {
    for (const s of systems) {
      if (this.#systems.includes(s)) throw new Error(`system ${s.name} was already added`);
    }
    this.#systems = [...this.#systems, ...systems];
    this.#ordered = undefined;
  }

  removeSystems(...systems: System<any>[]): void {
    this.#systems = this.#systems.filter((s) => !systems.includes(s));
    this.#ordered = undefined;
  }

  // ---------------------------------------------------------------------------------------------
  // Frame

  update(time: GameTime): void {
    this.#startPending();
    for (const script of this.#syncScripts) {
      if (script.attached && script.enabled) script.update(time);
    }
    this.#runSystems('beforePhysics', time);
    this.#runSystems('afterPhysics', time);
    this.#endFrame(time);
  }

  /** @internal AsyncScript.nextFrame and delay: resolved at the end of the first frame where done(time) holds. */
  waitFor(script: AsyncScript, done: (time: GameTime) => boolean): Promise<void> {
    if (!script.attached) return Promise.reject(script.signal.reason);
    return new Promise((resolve, reject) => this.#waiters.push({ script, done, resolve, reject }));
  }

  /** Removes every entity; their scripts are cancelled. */
  clear(): void {
    for (let index = 0; index < this.#table.length; index++) {
      if (this.#table[index] !== undefined) this.destroy((this.#generation[index]! * INDEX_SPAN + index) as EntityId);
    }
  }

  #startPending(): void {
    // start() may create entities with scripts of their own: they start in the same frame
    for (let i = 0; i < this.#pendingStart.length; i++) {
      const script = this.#pendingStart[i]!;
      if (!script.attached) continue;
      if (script instanceof StartupScript) script.start();
      if (script instanceof SyncScript) this.#syncScripts.push(script);
      if (script instanceof AsyncScript) this.#execute(script);
    }
    this.#pendingStart.length = 0;
    if (this.#syncScripts.some((s) => !s.attached)) this.#syncScripts = this.#syncScripts.filter((s) => s.attached);
  }

  #execute(script: AsyncScript): void {
    script.execute().catch((error: unknown) => {
      // The script was removed while awaiting: its waits reject with the abort reason, which ends it
      if (script.signal.aborted && error === script.signal.reason) return;
      this.onError(error);
    });
  }

  #runSystems(phase: Phase, time: GameTime): void {
    this.#ordered ??= orderSystems(this.#systems);
    for (const s of this.#ordered) {
      if (s.phase !== phase) continue;
      for (; s.tablesSeen < this.tables.length; s.tablesSeen++) {
        const table = this.tables[s.tablesSeen]!;
        if (s.matches(table)) s.matched.push(table);
      }
      const { spec } = s;
      for (const table of s.matched) {
        if (table.count === 0) continue;
        if (spec.changed && !spec.changed.some((type) => table.sets[type.id]!.version > s.lastRun)) continue;
        let chunk = s.chunks.get(table);
        if (!chunk) {
          chunk = { count: 0, entities: table.entities };
          for (const [key, type] of Object.entries(spec.with as Record<string, ComponentType<any>>)) chunk[key] = table.sets[type.id]!.byName;
          s.chunks.set(table, chunk);
        }
        chunk.count = table.count;
        chunk.entities = table.entities;
        this.#iterating = true;
        try {
          spec.update(chunk as never, time, this.#commands);
        } finally {
          this.#iterating = false;
        }
        for (const type of spec.writes ?? []) table.sets[type.id]!.version = ++this.#version;
      }
      s.lastRun = this.#version;
      this.#commands.apply(this);
    }
  }

  #endFrame(time: GameTime): void {
    if (this.#waiters.length === 0) return;
    const waiting = this.#waiters;
    this.#waiters = [];
    for (const waiter of waiting) {
      if (!waiter.script.attached) waiter.reject(waiter.script.signal.reason);
      else if (waiter.done(time)) waiter.resolve();
      else this.#waiters.push(waiter);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Storage

  #tableFor(types: readonly ComponentType<any>[]): Table {
    const sorted = [...new Set(types)].sort((a, b) => a.id - b.id);
    if (sorted.length !== types.length) throw new Error(`a component is listed twice: ${types.map((t) => t.name).join(', ')}`);
    const key = tableKey(sorted);
    let table = this.#tables.get(key);
    if (!table) {
      table = new Table(sorted);
      this.#tables.set(key, table);
      this.tables.push(table);
    }
    return table;
  }

  #allocate(table: Table): EntityId {
    const index = this.#free.pop() ?? this.#generation.length;
    if (index >= INDEX_SPAN) throw new RangeError(`more than ${INDEX_SPAN} live entities`);
    this.#generation[index] ??= 0;
    const id = (this.#generation[index]! * INDEX_SPAN + index) as EntityId;
    this.#table[index] = table;
    this.#row[index] = table.addRow(id);
    this.#alive++;
    return id;
  }

  #writeComponents(id: EntityId, components: readonly ComponentInit<any>[]): void {
    const index = indexOf(id);
    const table = this.#table[index]!;
    const row = this.#row[index]!;
    for (const { type, init } of components) {
      const set = table.sets[type.id]!;
      type.schema.writeRow(set.columns, row, init);
      set.version = ++this.#version;
    }
  }

  /** Moves an entity's row to another table, keeping the components both tables have. */
  #move(index: number, to: Table): void {
    const from = this.#table[index]!;
    const fromRow = this.#row[index]!;
    const toRow = to.addRow(from.entities[fromRow]!);
    to.copyShared(from, fromRow, toRow);
    this.#removeRow(index);
    this.#table[index] = to;
    this.#row[index] = toRow;
  }

  /** Swap-removes the entity's row and fixes up the entity that moved into it. */
  #removeRow(index: number): void {
    const moved = this.#table[index]!.removeRow(this.#row[index]!);
    if (moved >= 0) this.#row[indexOf(moved)] = this.#row[index]!;
  }

  #cell(id: EntityId, type: ComponentType<any>, field: number): [unknown[], number] {
    this.#assertAlive(id);
    const index = indexOf(id);
    const set = this.#table[index]!.sets[type.id];
    if (!set) throw new Error(`entity ${id} no longer has ${type.name}`);
    return [set.columns[field] as unknown[], this.#row[index]!];
  }

  // ---------------------------------------------------------------------------------------------
  // Scripts

  #attach(entity: Entity, { script: type, init }: ScriptInit<any>): void {
    if (entity.scripts.has(type)) throw new Error(`entity '${entity.name}' already has ${scriptName(type)}`);
    const Concrete = type as unknown as new () => ScriptComponent;
    const script = new Concrete();
    type.schema.assign(script, init);
    script.entity = entity;
    script.game = this.game;
    entity.scripts.set(type, script);
    this.#pendingStart.push(script);
  }

  #detach(entity: Entity, script: ScriptComponent): void {
    entity.scripts.delete(script.constructor as ScriptConstructor);
    script.detach();
  }

  #assertAlive(id: EntityId): void {
    if (!this.isAlive(id)) throw new Error(`entity ${id} does not exist (destroyed, or an id from another game)`);
  }

  #assertNotIterating(what: string): void {
    if (this.#iterating) throw new Error(`cannot ${what} while a system iterates; record it in the system's commands`);
  }
}

function splitArgs(args: readonly EntityArg[]): { components: ComponentInit<any>[]; scripts: ScriptInit<any>[] } {
  const components: ComponentInit<any>[] = [];
  const scripts: ScriptInit<any>[] = [];
  for (const arg of args) {
    if (arg instanceof ComponentType) components.push({ type: arg, init: undefined });
    else if (typeof arg === 'function') scripts.push({ script: arg, init: undefined });
    else if ('type' in arg) components.push(arg);
    else scripts.push(arg);
  }
  return { components, scripts };
}
