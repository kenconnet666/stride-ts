/**
 * An entity as an object, for scripts and scene code (Stride's Entity). Entities spawned in bulk for
 * systems are only ids; manager.entity(id) gives the object when one is needed.
 */
import type { DataValues, EntityId, Shape } from '../data/prop';
import type { ComponentType } from './component';
import type { EntityArg, EntityManager } from './EntityManager';
import { scriptName, type ScriptComponent, type ScriptConstructor } from './scripts';

/** A data component of one entity seen as an object; reads and writes go to its row in the columns. */
export type View<S extends Shape> = DataValues<S>;

export class Entity {
  readonly id: EntityId;
  readonly manager: EntityManager;
  name: string;
  /** @internal Scripts by class. */
  readonly scripts = new Map<ScriptConstructor, ScriptComponent>();
  /** @internal Views of data components, made on first get. */
  readonly views = new Map<ComponentType<any>, object>();

  constructor(manager: EntityManager, id: EntityId, name: string) {
    this.manager = manager;
    this.id = id;
    this.name = name;
  }

  get alive(): boolean {
    return this.manager.isAlive(this.id);
  }

  get<S extends Shape>(type: ComponentType<S>): View<S> | undefined;
  get<T extends ScriptComponent>(type: abstract new () => T): T | undefined;
  get(type: ComponentType<any> | (abstract new () => ScriptComponent)): unknown {
    if (typeof type === 'function') return this.scripts.get(type as ScriptConstructor);
    if (!this.manager.hasComponent(this.id, type)) return undefined;
    let view = this.views.get(type);
    if (!view) {
      view = this.manager.createView(this.id, type);
      this.views.set(type, view);
    }
    return view;
  }

  /** Like get, but throws when the entity lacks the component or script. */
  require<S extends Shape>(type: ComponentType<S>): View<S>;
  require<T extends ScriptComponent>(type: abstract new () => T): T;
  require(type: ComponentType<any> | (abstract new () => ScriptComponent)): unknown {
    const found = this.get(type as ComponentType<any>);
    if (found === undefined) {
      const what = typeof type === 'function' ? scriptName(type as ScriptConstructor) : type.name;
      throw new Error(`entity '${this.name}' (${this.id}) has no ${what}`);
    }
    return found;
  }

  has(type: ComponentType<any> | ScriptConstructor): boolean {
    return typeof type === 'function' ? this.scripts.has(type) : this.manager.hasComponent(this.id, type);
  }

  add(arg: EntityArg): this {
    this.manager.add(this.id, arg);
    return this;
  }

  remove(type: ComponentType<any> | ScriptConstructor): this {
    this.manager.remove(this.id, type);
    return this;
  }

  destroy(): void {
    this.manager.destroy(this.id);
  }
}
