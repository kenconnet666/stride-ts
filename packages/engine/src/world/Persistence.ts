/**
 * 存档和世界状态的持久化（`game.persistence`，Stride 没有；照虚幻的 SaveGame 加 World Partition 里"持久的 Actor"、开放世界游戏
 * 只存改动的做法）：
 *
 * - 挂了 `Persistent` 组件的场景实体（场景文件里建的）是持久的：它的场景卸掉时（格子走远了、换关）记下它现在的状态——本地的
 *   位置旋转缩放（`transform` 开着时）、数据组件的字段、脚本的属性；被销毁了的记"没了"。场景再读回来时把记下的套上去
 *   （没了的销毁），所以吃掉的金币、打开的门、挪过的箱子都还是那样。
 * - 记录按 `<场景路径>#<文件里的实体 id>` 存，不依赖运行时的实体编号；字段里的实体引用也换成这种键（指向运行时建的实体的
 *   字段不存）。资源引用、组件引用、transient 的字段不存（资源一般不在运行时换）。
 * - `save()` 把记录、世界时钟和游戏登记的段（`section('inventory', { save, load })`，背包、分数这类不属于某个实体的状态）拼成
 *   一段 JSON；`load(data)` 反过来，已经加载着的持久实体马上套上。存到哪由游戏决定（本地存储、服务器、下载成文件）。
 *
 * 运行时才建的实体（预制体生成的）还不存；实体上运行时才加的组件、脚本也不存（套记录时只改实体已经有的）。
 */
import { component } from '../engine/component';
import { prop } from '../data/prop';
import { objectFields, variantFields } from '../data/schema';
import type { PropOptions } from '../data/prop';
import type { Entity } from '../engine/Entity';
import type { EntityManager } from '../engine/EntityManager';
import { scriptName } from '../engine/scripts';
import { Transform } from '../engine/transform';
import type { SceneInstance } from '../content/ContentManager';
import type { WorldClock, WorldClockState } from './WorldClock';

/** 这个场景实体是持久的：场景卸掉再读回来、存档读档以后状态还在。 */
export const Persistent = component('Persistent', {
  /** 记不记位置、旋转、缩放（会被挪动的东西开着；位置由别的东西定的关掉）。 */
  transform: prop.bool().default(true),
});

/** 一个持久实体记下的状态。 */
export interface PersistedEntity {
  /** 被销毁了（读回来时也销毁）。 */
  readonly destroyed?: true;
  /** 本地的位置、旋转（四元数 xyzw）、缩放。 */
  readonly transform?: { readonly position: readonly number[]; readonly rotation: readonly number[]; readonly scale: readonly number[] };
  /** 数据组件名 → 字段的值。 */
  readonly components?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  /** 脚本名 → 属性的值。 */
  readonly scripts?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

/** 存档（save() 的结果，JSON）。 */
export interface SaveData {
  readonly format: 'stride-save';
  readonly version: 1;
  readonly clock: WorldClockState;
  /** `<场景路径>#<实体 id>` → 记下的状态。 */
  readonly entities: Readonly<Record<string, PersistedEntity>>;
  /** 游戏登记的段。 */
  readonly sections: Readonly<Record<string, unknown>>;
}

/** 游戏自己的一段存档。 */
export interface SaveSection {
  save(): unknown;
  load(data: unknown): void;
}

/** 不存的值（引用不到的实体、组件引用、资源）。 */
const SKIP = Symbol('skip');

export class PersistenceSystem {
  readonly #entities: EntityManager;
  readonly #clock: WorldClock;
  readonly #records = new Map<string, PersistedEntity>();
  readonly #sections = new Map<string, SaveSection>();
  /** 加载着的场景里持久的实体：场景 → 键 → 实体（场景卸掉时它们已经被销毁的也留着条目，好记"没了"）。 */
  readonly #tracked = new Map<SceneInstance, Map<string, Entity>>();
  /** 场景文件建的实体的键（实体引用换成键用）。 */
  #keys = new WeakMap<Entity, string>();
  readonly #byKey = new Map<string, Entity>();

  constructor(entities: EntityManager, clock: WorldClock) {
    this.#entities = entities;
    this.#clock = clock;
  }

  /** 记下的状态（调试命令看）。 */
  get records(): ReadonlyMap<string, PersistedEntity> {
    return this.#records;
  }

  /** 登记游戏自己的一段（同名替换）；返回的 Disposable 去掉它。 */
  section(name: string, section: SaveSection): Disposable {
    this.#sections.set(name, section);
    return { [Symbol.dispose]: () => { if (this.#sections.get(name) === section) this.#sections.delete(name); } };
  }

  /** 加载着的持久实体现在的状态记下来（存档前、场景卸掉前）。 */
  capture(): void {
    for (const tracked of this.#tracked.values()) for (const [key, entity] of tracked) this.#records.set(key, this.#capture(entity));
  }

  /** 整个存档：先记下加载着的持久实体。 */
  save(): SaveData {
    this.capture();
    const sections: Record<string, unknown> = {};
    for (const [name, section] of this.#sections) sections[name] = section.save();
    return { format: 'stride-save', version: 1, clock: this.#clock.state(), entities: Object.fromEntries(this.#records), sections: structuredClone(sections) };
  }

  /** 读档：时钟、记录、各段换成存档里的，加载着的持久实体马上套上。存档的格式不对时报错，什么都不改。 */
  load(data: SaveData): void {
    if (data.format !== 'stride-save' || data.version !== 1) throw new Error(`persistence.load: not a save (format ${String(data.format)}, version ${String(data.version)})`);
    this.#clock.restore(data.clock);
    this.#records.clear();
    for (const [key, record] of Object.entries(data.entities)) this.#records.set(key, record);
    for (const [name, section] of this.#sections) if (name in data.sections) section.load(data.sections[name]);
    for (const tracked of this.#tracked.values()) for (const [key, entity] of tracked) this.#apply(key, entity);
  }

  /** 忘掉记下的状态（新游戏）；给了键只忘这一个。 */
  forget(key?: string): void {
    if (key === undefined) this.#records.clear();
    else this.#records.delete(key);
  }

  /** @internal Game.loadScene 建好场景以后调：登记场景实体的键，持久的套上记下的状态。 */
  sceneLoaded(scene: SceneInstance): void {
    if (!scene.path) return;
    const tracked = new Map<string, Entity>();
    for (const [id, entity] of scene.entities) {
      const key = `${scene.path}#${id}`;
      this.#keys.set(entity, key);
      this.#byKey.set(key, entity);
      if (entity.get(Persistent)) tracked.set(key, entity);
    }
    if (tracked.size === 0) return;
    this.#tracked.set(scene, tracked);
    for (const [key, entity] of tracked) this.#apply(key, entity);
  }

  /** @internal Game.unloadScene 在销毁场景的实体之前调：记下持久实体的状态。 */
  sceneUnloading(scene: SceneInstance): void {
    const tracked = this.#tracked.get(scene);
    if (tracked) for (const [key, entity] of tracked) this.#records.set(key, this.#capture(entity));
    this.#tracked.delete(scene);
    if (scene.path) for (const id of scene.entities.keys()) this.#byKey.delete(`${scene.path}#${id}`);
  }

  #capture(entity: Entity): PersistedEntity {
    if (!entity.alive) return { destroyed: true };
    const persistent = entity.require(Persistent);
    const transform = entity.get(Transform);
    const components: Record<string, Record<string, unknown>> = {};
    for (const type of this.#entities.componentTypes(entity.id)) {
      if (type === Transform || type === Persistent) continue;
      const values = this.#fields(type.schema.fields, entity.require(type) as Record<string, unknown>);
      if (Object.keys(values).length > 0) components[type.name] = values;
    }
    const scripts: Record<string, Record<string, unknown>> = {};
    for (const [type, script] of entity.scripts) {
      const values = this.#fields(type.schema.fields, script as unknown as Record<string, unknown>);
      if (Object.keys(values).length > 0) scripts[scriptName(type)] = values;
    }
    return {
      ...(persistent.transform && transform ? { transform: { position: xyz(transform.position), rotation: [transform.rotation.x, transform.rotation.y, transform.rotation.z, transform.rotation.w], scale: xyz(transform.scale) } } : {}),
      ...(Object.keys(components).length > 0 ? { components } : {}),
      ...(Object.keys(scripts).length > 0 ? { scripts } : {}),
    };
  }

  #apply(key: string, entity: Entity): void {
    const record = this.#records.get(key);
    if (!record || !entity.alive) return;
    if (record.destroyed) {
      entity.destroy();
      return;
    }
    const transform = entity.get(Transform);
    if (record.transform && transform) {
      const [x, y, z] = record.transform.position, [rx, ry, rz, rw] = record.transform.rotation, [sx, sy, sz] = record.transform.scale;
      transform.position = { x: x!, y: y!, z: z! };
      transform.rotation = { x: rx!, y: ry!, z: rz!, w: rw! };
      transform.scale = { x: sx!, y: sy!, z: sz! };
    }
    for (const type of this.#entities.componentTypes(entity.id)) {
      const values = record.components?.[type.name];
      if (values) this.#assign(type.schema.fields, entity.require(type) as Record<string, unknown>, values);
    }
    for (const [type, script] of entity.scripts) {
      const values = record.scripts?.[scriptName(type)];
      if (values) this.#assign(type.schema.fields, script as unknown as Record<string, unknown>, values);
    }
  }

  /** 一组字段现在的值换成能存的 JSON（不存的跳过）。 */
  #fields(fields: readonly { readonly name: string; readonly options: PropOptions }[], target: Record<string, unknown>): Record<string, unknown> {
    const values: Record<string, unknown> = {};
    for (const field of fields) {
      if (field.options.transient || field.options.sealed) continue;
      const value = this.#toSave(field.options, field.options.stat ? (target as { statTable?: Record<string, { base: unknown }> }).statTable?.[field.name]?.base : target[field.name]);
      if (value !== SKIP) values[field.name] = value;
    }
    return values;
  }

  #toSave(options: PropOptions, value: unknown): unknown {
    if (value === undefined || value === null) return value ?? null;
    switch (options.kind) {
      case 'entity': {
        const id = value as number;
        const key = this.#entities.isAlive(id as never) ? this.#keys.get(this.#entities.entity(id as never)) : undefined;
        return key === undefined ? SKIP : { $entity: key };
      }
      case 'component':
      case 'asset':
        return SKIP;
      case 'list': {
        const items = (value as unknown[]).map((item) => this.#toSave(options.item!.options, item));
        return items.includes(SKIP) ? SKIP : items;
      }
      case 'object':
        return this.#nested(objectFields(options), value as Record<string, unknown>, (o, v) => this.#toSave(o, v));
      case 'union': {
        const tag = (value as Record<string, unknown>)[options.discriminator!] as string;
        const fields = this.#nested(variantFields(options, tag), value as Record<string, unknown>, (o, v) => this.#toSave(o, v));
        return fields === SKIP ? SKIP : { [options.discriminator!]: tag, ...fields };
      }
      case 'json':
        return structuredClone(value);
      default:
        // 向量、四元数、颜色是对象（数据组件里是活的视图）：拍成普通对象
        return typeof value === 'object' ? { ...(value as object) } : value;
    }
  }

  /** 嵌套对象（object、union）的每个字段按它的描述换；有一个存不了（引用不到的实体）整个不存。 */
  #nested(fields: readonly { readonly name: string; readonly options: PropOptions }[], value: Record<string, unknown>, convert: (options: PropOptions, value: unknown) => unknown): Record<string, unknown> | typeof SKIP {
    const out: Record<string, unknown> = {};
    for (const field of fields) {
      if (!(field.name in value)) continue;
      const converted = convert(field.options, value[field.name]);
      if (converted === SKIP) return SKIP;
      out[field.name] = converted;
    }
    return out;
  }

  #assign(fields: readonly { readonly name: string; readonly options: PropOptions }[], target: Record<string, unknown>, values: Readonly<Record<string, unknown>>): void {
    for (const field of fields) {
      if (!(field.name in values) || field.options.transient || field.options.sealed) continue;
      const value = this.#fromSave(field.options, values[field.name]);
      if (value === SKIP) continue;
      const current = target[field.name];
      // 向量这类是对象（视图、Vector3）：改它的分量，不换掉对象
      if (typeof current === 'object' && current !== null && typeof value === 'object' && value !== null && !Array.isArray(value) && field.options.kind !== 'object' && field.options.kind !== 'union' && field.options.kind !== 'json') Object.assign(current, value);
      else target[field.name] = value;
    }
  }

  #fromSave(options: PropOptions, value: unknown): unknown {
    if (value === null) return options.kind === 'entity' ? SKIP : null;
    switch (options.kind) {
      case 'entity': {
        const key = (value as { $entity?: string }).$entity;
        const entity = key === undefined ? undefined : this.#byKey.get(key);
        return entity?.alive ? entity.id : SKIP;
      }
      case 'list': {
        const items = (value as unknown[]).map((item) => this.#fromSave(options.item!.options, item));
        return items.includes(SKIP) ? SKIP : items;
      }
      case 'object':
        return this.#nested(objectFields(options), value as Record<string, unknown>, (o, v) => this.#fromSave(o, v));
      case 'union': {
        const tag = (value as Record<string, unknown>)[options.discriminator!] as string;
        const fields = this.#nested(variantFields(options, tag), value as Record<string, unknown>, (o, v) => this.#fromSave(o, v));
        return fields === SKIP ? SKIP : { [options.discriminator!]: tag, ...fields };
      }
      default:
        return structuredClone(value);
    }
  }
}

const xyz = (v: { readonly x: number; readonly y: number; readonly z: number }): number[] => [v.x, v.y, v.z];
