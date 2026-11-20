/**
 * 管理一个游戏的实体：按 archetype 分表存放的数据组件、脚本和系统。
 * update() 按文档里的顺序跑一帧（docs/architecture.md 的“生命周期”）：待启动脚本的 start() 和 execute()、
 * SyncScript.update、物理之前的系统、物理之后的系统，最后是 AsyncScript 的等待者，
 * 它们的后续代码在这一帧的任务返回后运行。
 */
import { ENCODED_KINDS, fromCell, toCell } from '../data/cells';
import type { EntityId } from '../data/prop';
import type { Game } from './Game';
import type { GameTime } from './GameTime';
import { cloneEntity, type CloneHandler } from './clone';
import { syncSceneRoot } from './transform';
import { Commands } from './Commands';
import { ComponentType, type BareComponent, type ColumnsOf, type ComponentInit } from './component';
import { ScopedDefaults } from './defaults';
import type { HotChange } from './registry';
import { Entity, type EntityScene } from './Entity';
import { AsyncScript, ScriptComponent, STARTED, StartupScript, SyncScript, scriptName, type BareScript, type ScriptConstructor, type ScriptInit } from './scripts';
import { Stat, type StatClock } from './stats';
import { Table, tableKey, type ColumnSet } from './storage';
import { orderSystems, System, type Phase } from './system';

/** 创建实体或给实体添加时能传的东西：数据组件（直接列出或带值）或脚本。 */
export type EntityArg = ComponentInit<any> | BareComponent | ScriptInit<any> | BareScript;

export interface EntityDesc {
  readonly name?: string;
  /** 放进这个场景，场景卸载时跟着销毁（见 Entity.scene）。 */
  readonly scene?: EntityScene | undefined;
  readonly components?: readonly EntityArg[];
}

/**
 * 一次 spawn() 生成的实体。它们的行从 firstRow 起连续，直到下一次结构性改动（销毁或搬走这张表里的实体，
 * 会把另一行搬进空出来的位置）。
 */
export interface SpawnBatch {
  readonly ids: readonly EntityId[];
  readonly count: number;
  readonly firstRow: number;
  /** 生成的实体某个组件所在的列；通过它写入算作一次改动，`changed` 能看到。 */
  columns<C extends ComponentType<any, any>>(type: C): ColumnsOf<C>;
}

/** id = 下标 + 代数 * 2^20：最多约一百万个活着的实体，过期的 id 能被识别出来。 */
const INDEX_SPAN = 1 << 20;
const indexOf = (id: number) => id % INDEX_SPAN;

/** 向量类字段在视图里的分量名，顺序与列里交错存放的顺序一致。 */
const VECTOR_KEYS = { vec3: ['x', 'y', 'z'], quat: ['x', 'y', 'z', 'w'], color: ['r', 'g', 'b', 'a'] } as const;

interface Waiter {
  readonly script: ScriptComponent;
  readonly done: (time: GameTime) => boolean;
  readonly resolve: () => void;
  readonly reject: (reason: unknown) => void;
}

export class EntityManager {
  readonly game: Game;
  /** 标了 .inherit() 的属性的作用域默认值，对之后创建的实例生效。 */
  readonly defaults = new ScopedDefaults();
  /**
   * 设了以后按阶段累计 CPU 毫秒数：每个系统按名字，另有 'scripts.start'、'scripts.update'、'physics'。
   * 调试时（Debug 的 perf 命令）打开，平时是 undefined，没有开销。
   */
  timings: Map<string, number> | undefined;
  /** 没有调用方能接住的错误交给它：比如 AsyncScript.execute 被拒绝。 */
  onError: (error: unknown) => void = (error) => {
    throw error;
  };

  // 按实体下标存放
  readonly #generation: number[] = [];
  readonly #table: (Table | undefined)[] = [];
  readonly #row: number[] = [];
  readonly #objects: (Entity | undefined)[] = [];
  readonly #free: number[] = [];
  #alive = 0;

  readonly #tables = new Map<string, Table>();
  /** @internal 按创建顺序；每个系统记着自己看到了第几张。 */
  readonly tables: Table[] = [];

  #systems: System<any>[] = [];
  #ordered: System<any>[] | undefined;
  /** 带 added 或 removed 回调的系统：实体开始或不再满足它们的条件时通知它们。 */
  #watching: System<any>[] = [];
  readonly #commands = new Commands();
  /** 每次 `changed` 应该看到的写入都递增。 */
  #version = 1;
  #iterating = false;
  #cloneHandlers: readonly CloneHandler[] = [];

  readonly #pendingStart: ScriptComponent[] = [];
  #syncScripts: SyncScript[] = [];
  #waiters: Waiter[] = [];
  /** 限时的 stat 修饰，按游戏时间到期。 */
  #timers: { readonly at: number; readonly expire: () => void }[] = [];
  readonly #clock: StatClock;

  constructor(game: Game) {
    this.game = game;
    this.#clock = {
      get now() {
        return game.updateTime.total;
      },
      schedule: (at, expire) => void this.#timers.push({ at, expire }),
    };
  }

  /** 活着的实体数。 */
  get count(): number {
    return this.#alive;
  }

  /** 所有活着的实体，按下标顺序。 */
  ids(): EntityId[] {
    const ids: EntityId[] = [];
    for (let index = 0; index < this.#table.length; index++) {
      if (this.#table[index] !== undefined) ids.push((this.#generation[index]! * INDEX_SPAN + index) as EntityId);
    }
    return ids;
  }

  /** 实体的数据组件类型。 */
  componentTypes(id: EntityId): readonly ComponentType<any>[] {
    this.#assertAlive(id);
    return this.#table[indexOf(id)]!.types;
  }

  isAlive(id: EntityId): boolean {
    const index = indexOf(id);
    return this.#table[index] !== undefined && this.#generation[index] === Math.floor(id / INDEX_SPAN);
  }

  /** 创建实体，组件直接放进最终的表，脚本一并挂上。 */
  create(desc: EntityDesc = {}): Entity {
    this.#assertNotIterating('create an entity');
    const { components, scripts } = splitArgs(desc.components ?? []);
    const table = this.#tableFor(components.map((c) => c.type));
    const id = this.#allocate(table);
    this.#writeComponents(id, components);
    const entity = new Entity(this, id, desc.name ?? `entity ${indexOf(id)}`);
    entity.ownScene = desc.scene;
    this.#objects[indexOf(id)] = entity;
    if (desc.scene?.root) syncSceneRoot(this, entity);
    for (const script of scripts) this.#attach(entity, script);
    this.#notify(id, undefined, table);
    this.#afterChange();
    return entity;
  }

  /** 把实体连同子实体再建一份，见 engine/clone.ts；脚本里写 `entity.clone()`。 */
  clone(entity: Entity): Entity {
    this.#assertNotIterating('clone an entity');
    this.#assertAlive(entity.id);
    return cloneEntity(this, entity, this.#cloneHandlers);
  }

  /** 每次克隆之后调用 handler；系统用它给克隆出来的实体补上自己挂的运行时状态（比如骨架）。释放返回值就不再调用。 */
  onClone(handler: CloneHandler): Disposable {
    this.#cloneHandlers = [...this.#cloneHandlers, handler];
    return { [Symbol.dispose]: () => (this.#cloneHandlers = this.#cloneHandlers.filter((h) => h !== handler)) };
  }

  /** 直接放在 scene 里的实体（场景文件建的，或者 Entity.scene 赋的），不含跟着父实体算进去的。 */
  inScene(scene: EntityScene): Entity[] {
    return this.#objects.filter((entity): entity is Entity => entity?.ownScene === scene);
  }

  /**
   * 生成 count 个只有数据组件、没有实体对象的实体。它们占同一张表里连续的行，所以可以按列给每个实体写值：
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
    for (const id of ids) this.#notify(id, undefined, table);
    this.#afterChange();
    return {
      ids,
      count,
      firstRow,
      columns: <C extends ComponentType<any, any>>(type: C) => {
        const set = table.sets[type.id];
        if (!set) throw new Error(`the spawned entities have no ${type.name}`);
        set.version = ++this.#version;
        return this.#columnsOf(set) as ColumnsOf<C>;
      },
    };
  }

  /** 实体对象；批量生成的实体在第一次用到时才创建。 */
  /** @internal 已经有实体对象的才返回（不为没有对象的实体新建）。 */
  peek(id: EntityId): Entity | undefined {
    return this.#objects[indexOf(id)];
  }

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
    this.#notify(id, this.#table[index], undefined);
    // 数据在原生内存里的组件释放槽位；Transform 会先销毁子实体
    for (const type of this.#table[index]!.types) type.external?.release(this, id, true);
    this.#removeRow(index);
    this.#table[index] = undefined;
    this.#objects[index] = undefined;
    this.#generation[index] = (this.#generation[index]! + 1) % 0x10000;
    this.#free.push(index);
    this.#alive--;
    this.#afterChange();
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
      const to = this.#tableFor([...from.types, component.type]);
      this.#notifyLeaving(id, from, to);
      this.#move(index, to);
      this.#writeComponents(id, [component]);
      this.#notifyEntering(id, from, to);
    }
    this.#afterChange();
  }

  remove(id: EntityId, type: ComponentType<any> | ScriptConstructor): void {
    this.#assertNotIterating('remove a component');
    this.#assertAlive(id);
    if (typeof type === 'function') {
      const entity = this.entity(id);
      const script = entity.script(type);
      if (!script) throw new Error(`entity ${id} has no ${scriptName(type)}`);
      this.#detach(entity, script);
      return;
    }
    const index = indexOf(id);
    const from = this.#table[index]!;
    if (!from.has(type)) throw new Error(`entity ${id} has no ${type.name}`);
    const to = this.#tableFor(from.types.filter((t) => t !== type));
    // 先释放：它可能拒绝（比如还有子实体的 Transform），这时什么都没变；所以 removed 回调读不到这种组件
    type.external?.release(this, id, false);
    this.#notifyLeaving(id, from, to);
    this.#move(index, to);
    this.#objects[index]?.views.delete(type);
    this.#notifyEntering(id, from, to);
    this.#afterChange();
  }

  hasComponent(id: EntityId, type: ComponentType<any>): boolean {
    return this.isAlive(id) && this.#table[indexOf(id)]!.has(type);
  }

  /** @internal 实体在 external 组件存储里的槽位（表里这个组件的第一列）。 */
  slotOf(id: EntityId, type: ComponentType<any>): number {
    this.#assertAlive(id);
    const index = indexOf(id);
    const set = this.#table[index]!.sets[type.id];
    if (!set || !type.external) throw new Error(`entity ${id} has no ${type.name}`);
    return (set.columns[0] as Int32Array)[this.#row[index]!]!;
  }

  /** @internal 视图对象：每个字段的读写都落到这个实体所在的行上，见 Entity.get。 */
  createView(id: EntityId, given: ComponentType<any>): object {
    // 热重载后 given 可能是旧版本：字段下标按表里现在的版本算
    const type = this.#table[indexOf(id)]!.sets[given.id]!.type;
    const view = {};
    type.schema.fields.forEach((field, f) => {
      const isBool = field.options.kind === 'bool';
      const touch = () => (this.#table[indexOf(id)]!.sets[type.id]!.version = ++this.#version);
      if (field.stride > 1) {
        // 向量字段：返回一个活的 x/y/z(/w) 对象，直接读写列里交错存放的那几个 float；整体赋值时逐分量拷贝
        const keys = VECTOR_KEYS[field.options.kind as 'vec3' | 'quat' | 'color'];
        const live = {};
        keys.forEach((key, k) => {
          Object.defineProperty(live, key, {
            enumerable: true,
            get: () => {
              const [column, row] = this.#cell(id, type, f);
              return column[row * field.stride + k];
            },
            set: (value: number) => {
              const [column, row] = this.#cell(id, type, f);
              column[row * field.stride + k] = value;
              touch();
            },
          });
        });
        Object.defineProperty(view, field.name, {
          enumerable: true,
          get: () => live,
          set: (value: unknown) => {
            const [column, row] = this.#cell(id, type, f);
            const values = Array.isArray(value) ? value : keys.map((key) => (value as Record<string, number>)[key]);
            for (let k = 0; k < keys.length; k++) column[row * field.stride + k] = values[k];
            touch();
          },
        });
        return;
      }
      // bigint、小数、日期时间：列里是 int64 / int32 的原始值，视图读写时换算成值对象
      const encoded = ENCODED_KINDS.has(field.options.kind);
      Object.defineProperty(view, field.name, {
        enumerable: true,
        get: () => {
          const [column, row] = this.#cell(id, type, f);
          const value = column[row];
          if (encoded) return fromCell(field.options, value as number | bigint);
          return isBool ? value === 1 : value;
        },
        set: (value: unknown) => {
          const [column, row] = this.#cell(id, type, f);
          column[row] = encoded ? toCell(field.options, value) : isBool ? (value ? 1 : 0) : value;
          touch();
        },
      });
    });
    type.external?.extendView(this, id, view);
    return view;
  }

  // ---------------------------------------------------------------------------------------------
  // 系统

  /** 加入系统；带 added 回调的系统会对已经满足条件的实体各调一次 added。 */
  addSystems(...systems: System<any>[]): void {
    for (const s of systems) {
      if (this.#systems.includes(s)) throw new Error(`system ${s.name} was already added`);
    }
    this.#systems = [...this.#systems, ...systems];
    this.#ordered = undefined;
    this.#watching = this.#systems.filter((s) => s.spec.added || s.spec.removed);
    for (const s of systems) {
      if (s.spec.added) this.#forEachMatching(s, (id) => this.#callback(() => s.spec.added!(id, this.#commands)));
    }
    this.#afterChange();
  }

  /** 移除系统；带 removed 回调的系统会对还满足条件的实体各调一次 removed。 */
  removeSystems(...systems: System<any>[]): void {
    for (const s of systems) {
      if (this.#systems.includes(s) && s.spec.removed) this.#forEachMatching(s, (id) => this.#callback(() => s.spec.removed!(id, this.#commands)));
    }
    this.#systems = this.#systems.filter((s) => !systems.includes(s));
    this.#ordered = undefined;
    this.#watching = this.#systems.filter((s) => s.spec.added || s.spec.removed);
    this.#afterChange();
  }

  // ---------------------------------------------------------------------------------------------
  // 热重载

  /**
   * 热重载（docs/architecture.md 的“热重载”）：把世界里的旧版本换成新版本，状态都保留。
   * - 数据组件：新版本接替旧版本的编号，按字段名把列搬进新布局（`renamedFrom` 生效），新字段取默认值；
   * - 脚本：已有实例换成新类的原型（下一次 update 就跑新代码），类体里新加的字段从一个新实例上拷过来，
   *   属性按新 schema 重新赋值；正在跑的 AsyncScript.execute 继续跑旧代码，直到它结束；
   * - 系统：加入过的旧版本换成新版本，排序重算。
   */
  hotUpdate(changes: readonly HotChange[]): void {
    this.#assertNotIterating('hot-update');
    for (const { previous, next } of changes) {
      if (previous instanceof ComponentType) this.#replaceComponent(previous, next as ComponentType);
      else if (previous instanceof System) this.#replaceSystem(previous, next as System);
      else this.#replaceScript(previous, next as ScriptConstructor);
    }
    this.#ordered = undefined;
    this.#watching = this.#systems.filter((s) => s.spec.added || s.spec.removed);
    // 系统缓存的 chunk 拿着旧的列集合
    for (const s of this.#systems) s.chunks.clear();
  }

  #replaceComponent(previous: ComponentType, next: ComponentType): void {
    if (previous.external || next.external) throw new Error(`hot update: ${next.name} keeps its data in native memory and cannot be replaced; reload the page`);
    next.adopt(previous);
    for (const table of this.tables) {
      if (!table.sets[previous.id]) continue;
      table.replaceType(previous, next);
      table.sets[next.id]!.version = ++this.#version;
    }
    // 视图按旧 schema 的字段下标读列，作废后下次 get 重建
    for (const entity of this.#objects) {
      entity?.views.delete(previous);
      entity?.views.delete(next);
    }
    this.defaults.migrate(previous, next);
  }

  #replaceSystem(previous: System<any>, next: System<any>): void {
    const index = this.#systems.indexOf(previous);
    if (index < 0) return;
    next.lastRun = previous.lastRun;
    this.#systems = this.#systems.with(index, next);
  }

  /**
   * 换成新版本的脚本类。一般是换原型，状态全部保留；但新版本的类（到和旧实例共有的祖先为止）有私有成员（#x）时不能换：
   * 私有成员只属于跑过那个构造函数的对象，换了原型的旧对象一访问就抛 TypeError。这时重建脚本：按当前的属性值挂一个新实例，
   * start() 重新跑，其余运行时状态丢掉。改了引擎的模块时，Vite 会连带重新执行游戏模块，没改过的脚本也会走到这里。
   */
  #replaceScript(previous: ScriptConstructor, next: ScriptConstructor): void {
    // 类体里的字段初始化只在构造时跑：新加的字段从一个新实例上取
    let template: Record<string, unknown> | undefined;
    for (const entity of this.#objects) {
      const script = entity?.scripts.get(previous);
      if (!entity || !script) continue;
      if (hasNewPrivateMembers(script, next)) {
        const values = this.#propValues(script as unknown as Record<string, unknown>, next);
        this.#detach(entity, script);
        this.#attach(entity, { script: next, init: values });
        continue;
      }
      entity.scripts.delete(previous);
      entity.scripts.set(next, script);
      Object.setPrototypeOf(script, next.prototype);
      template ??= new (next as unknown as new () => Record<string, unknown>)();
      const target = script as unknown as Record<string, unknown>;
      for (const key of Object.keys(template)) if (!Object.hasOwn(target, key)) target[key] = template[key];
      this.#reassignProps(target, next);
    }
    this.defaults.migrate(previous, next);
  }

  /** 旧实例上按新 schema 还能用的属性值（字段改名认 renamedFrom）；stat 属性不算。 */
  #propValues(script: Record<string, unknown>, next: ScriptConstructor): Record<string, unknown> {
    const values: Record<string, unknown> = {};
    for (const { name, options } of next.schema.fields.filter((f) => !f.options.stat)) {
      if (Object.hasOwn(script, name)) values[name] = script[name];
      else if (options.renamedFrom !== undefined && Object.hasOwn(script, options.renamedFrom)) values[name] = script[options.renamedFrom];
    }
    return values;
  }

  /** 脚本属性按新 schema 重新赋值：已有的值保留（字段改名认 renamedFrom），新属性取默认值；stat 属性不动。 */
  #reassignProps(script: Record<string, unknown>, next: ScriptConstructor): void {
    const fields = next.schema.fields.filter((f) => !f.options.stat);
    const values = this.#propValues(script, next);
    const assigned: Record<string, unknown> = {};
    try {
      next.schema.assign(assigned, values, this.defaults.arrayFor(next));
    } catch (error) {
      console.warn(`hot update: kept the old props of ${scriptName(next)}: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    for (const { name, options } of fields) {
      script[name] = assigned[name];
      if (options.renamedFrom !== undefined) delete script[options.renamedFrom];
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Frame

  /** 一帧：启动新脚本、跑 SyncScript 的 update、"物理前"的系统，然后 physics（仿真步进），再跑"物理后"的系统。 */
  update(time: GameTime, physics?: (time: GameTime) => void): void {
    let lap = this.#lap('', 0);
    this.#startPending();
    lap = this.#lap('scripts.start', lap);
    for (const script of this.#syncScripts) {
      if (script.attached && script.enabled) script.update(time);
    }
    this.#lap('scripts.update', lap);
    this.#runSystems('beforePhysics', time);
    if (physics) {
      lap = this.#lap('', 0);
      physics(time);
      this.#lap('physics', lap);
    }
    this.#runSystems('afterPhysics', time);
    this.#endFrame(time);
  }

  /** timings 打开时把 start 以来的毫秒数记到 label 下（label 为空时只取时间），返回现在；关着时什么都不做。 */
  #lap(label: string, start: number): number {
    if (!this.timings) return 0;
    const now = performance.now();
    if (label) this.timings.set(label, (this.timings.get(label) ?? 0) + now - start);
    return now;
  }

  /** @internal AsyncScript.nextFrame 和 delay：在第一个满足 done(time) 的帧末尾兑现。 */
  waitFor(script: ScriptComponent, done: (time: GameTime) => boolean): Promise<void> {
    if (!script.attached) return Promise.reject(script.signal.reason);
    return new Promise((resolve, reject) => this.#waiters.push({ script, done, resolve, reject }));
  }

  /** 移除所有实体，它们的脚本都被取消。 */
  clear(): void {
    for (let index = 0; index < this.#table.length; index++) {
      if (this.#table[index] !== undefined) this.destroy((this.#generation[index]! * INDEX_SPAN + index) as EntityId);
    }
  }

  #startPending(): void {
    // start() 里可能又创建了带脚本的实体：它们在同一帧启动
    for (let i = 0; i < this.#pendingStart.length; i++) {
      const script = this.#pendingStart[i]!;
      if (!script.attached) continue;
      script[STARTED] = true;
      if (script instanceof StartupScript) script.start();
      if (script instanceof SyncScript) this.#syncScripts.push(script);
      if (script instanceof AsyncScript) this.#execute(script);
    }
    this.#pendingStart.length = 0;
    if (this.#syncScripts.some((s) => !s.attached)) this.#syncScripts = this.#syncScripts.filter((s) => s.attached);
  }

  #execute(script: AsyncScript): void {
    script.execute().catch((error: unknown) => {
      // 脚本在等待时被移除：等待以中止原因被拒绝，脚本就此结束，不算错误
      if (script.signal.aborted && error === script.signal.reason) return;
      this.onError(error);
    });
  }

  /**
   * 立即对匹配的表跑一次这个系统，不加入每帧的阶段。给帧循环之外的固定时刻用，比如渲染的提取阶段
   * （世界矩阵算好之后、绘制之前）。系统不必先 addSystems；它的 added、removed 回调不会被调用。
   */
  run(s: System<any>, time: GameTime): void {
    this.#assertNotIterating('run a system');
    this.#runSystem(s, time);
  }

  #runSystems(phase: Phase, time: GameTime): void {
    this.#ordered ??= orderSystems(this.#systems);
    for (const s of this.#ordered) {
      if (s.phase !== phase) continue;
      const lap = this.#lap('', 0);
      this.#runSystem(s, time);
      this.#lap(s.name, lap);
    }
  }

  #runSystem(s: System<any>, time: GameTime): void {
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
        for (const [key, type] of Object.entries(spec.with as Record<string, ComponentType<any>>)) chunk[key] = this.#columnsOf(table.sets[type.id]!);
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

  #endFrame(time: GameTime): void {
    if (this.#timers.length > 0) {
      // 到期的限时 stat 修饰在帧末移除，下一帧读到的就是新值
      const due = this.#timers.filter((t) => t.at <= time.total);
      if (due.length > 0) {
        this.#timers = this.#timers.filter((t) => t.at > time.total);
        for (const timer of due) timer.expire();
      }
    }
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
    for (const { type: given, init } of components) {
      const set = table.sets[given.id]!;
      // 热重载后旧代码可能还拿着旧版本：按表里现在的版本写
      const type = set.type;
      if (type.external) {
        // 表里只记槽位，值按槽位写进原生内存的列（布局和表的列一样）
        const slot = type.external.allocate(this, id);
        (set.columns[0] as Int32Array)[row] = slot;
        type.schema.writeRow(type.external.data(this), slot, init, this.defaults.arrayFor(type));
      } else {
        type.schema.writeRow(set.columns, row, init, this.defaults.arrayFor(type));
      }
      set.version = ++this.#version;
    }
  }

  /** 给系统和 spawn 的列：普通组件是表里的列，external 的组件由它自己拼。 */
  #columnsOf(set: ColumnSet): object {
    return set.type.external ? set.type.external.chunk(this, set) : set.byName;
  }

  // ---------------------------------------------------------------------------------------------
  // 系统的 added / removed 通知

  /** 实体从 from 表搬到 to 表（创建时 from 为空，销毁时 to 为空）前后，通知开始或不再满足条件的系统。 */
  #notify(id: EntityId, from: Table | undefined, to: Table | undefined): void {
    this.#notifyLeaving(id, from, to);
    this.#notifyEntering(id, from, to);
  }

  /** 在搬走之前调用：removed 回调还能读到组件数据。 */
  #notifyLeaving(id: EntityId, from: Table | undefined, to: Table | undefined): void {
    if (this.#watching.length === 0 || !from) return;
    for (const s of this.#watching) {
      if (s.spec.removed && s.matches(from) && !(to && s.matches(to))) this.#callback(() => s.spec.removed!(id, this.#commands));
    }
  }

  /** 在搬好、写好数据之后调用。 */
  #notifyEntering(id: EntityId, from: Table | undefined, to: Table | undefined): void {
    if (this.#watching.length === 0 || !to) return;
    for (const s of this.#watching) {
      if (s.spec.added && s.matches(to) && !(from && s.matches(from))) this.#callback(() => s.spec.added!(id, this.#commands));
    }
  }

  /** 回调期间不允许直接做结构性改动（会打乱正在进行的搬移），只能记进命令缓冲。 */
  #callback(fn: () => void): void {
    const was = this.#iterating;
    this.#iterating = true;
    try {
      fn();
    } finally {
      this.#iterating = was;
    }
  }

  /** 公开的结构性操作做完之后，执行回调里记下的命令。系统遍历期间由系统自己在跑完后执行。 */
  #afterChange(): void {
    if (!this.#iterating) this.#commands.apply(this);
  }

  #forEachMatching(s: System<any>, fn: (id: EntityId) => void): void {
    for (const table of this.tables) {
      if (!s.matches(table)) continue;
      // 先复制 id：回调里记下的命令要等遍历完才执行，但保险起见不直接遍历会变的数组
      for (const id of Array.from(table.entities.subarray(0, table.count))) fn(id as EntityId);
    }
  }

  /** 把实体的行搬到另一张表，两张表都有的组件的值保留。 */
  #move(index: number, to: Table): void {
    const from = this.#table[index]!;
    const fromRow = this.#row[index]!;
    const toRow = to.addRow(from.entities[fromRow]!);
    to.copyShared(from, fromRow, toRow);
    this.#removeRow(index);
    this.#table[index] = to;
    this.#row[index] = toRow;
  }

  /** 用最后一行填补的方式删除实体的行，并更新搬进来的那个实体的行号。 */
  #removeRow(index: number): void {
    const moved = this.#table[index]!.removeRow(this.#row[index]!);
    if (moved >= 0) this.#row[indexOf(moved)] = this.#row[index]!;
  }

  #cell(id: EntityId, type: ComponentType<any>, field: number): [unknown[], number] {
    this.#assertAlive(id);
    const index = indexOf(id);
    const set = this.#table[index]!.sets[type.id];
    if (!set) throw new Error(`entity ${id} no longer has ${type.name}`);
    if (type.external) return [type.external.data(this)[field] as unknown[], (set.columns[0] as Int32Array)[this.#row[index]!]!];
    return [set.columns[field] as unknown[], this.#row[index]!];
  }

  // ---------------------------------------------------------------------------------------------
  // Scripts

  #attach(entity: Entity, { script: type, init }: ScriptInit<any>): void {
    if (entity.script(type)) throw new Error(`entity '${entity.name}' already has ${scriptName(type)}`);
    const Concrete = type as unknown as new () => ScriptComponent;
    const script = new Concrete();
    type.schema.assign(script, init, this.defaults.arrayFor(type));
    this.#createStats(script, type);
    script.entity = entity;
    script.game = this.game;
    entity.scripts.set(type, script);
    this.#pendingStart.push(script);
  }

  /** 把标了 stat() 的属性换成访问器：读到的是加上修饰后的值，赋值改的是基础值。 */
  #createStats(script: ScriptComponent, type: ScriptConstructor): void {
    const statFields = type.schema.fields.filter((f) => f.options.stat);
    if (statFields.length === 0) return;
    const table: Record<string, Stat> = {};
    for (const field of statFields) {
      const stat = new Stat((script as unknown as Record<string, number>)[field.name]!, field.options, this.#clock);
      table[field.name] = stat;
      Object.defineProperty(script, field.name, {
        enumerable: true,
        get: () => stat.value,
        set: (value: number) => (stat.base = value),
      });
    }
    script.statTable = table;
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

/**
 * 新版本的类（从 next 往上，直到旧实例构造时就有的祖先为止）有没有私有成员。看类的源码里有没有 `#名字`：
 * 字符串里的 # 会误判，那样只是多重建一次，不会出错。
 */
function hasNewPrivateMembers(instance: object, next: ScriptConstructor): boolean {
  for (let type: unknown = next; typeof type === 'function' && type !== Function.prototype; type = Object.getPrototypeOf(type)) {
    if (instance instanceof (type as abstract new () => unknown)) return false;
    if (/#[A-Za-z_$]/.test(Function.prototype.toString.call(type))) return true;
  }
  return false;
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
