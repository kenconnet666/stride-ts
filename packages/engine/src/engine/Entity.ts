/**
 * 实体对象，给脚本和场景代码用（对应 Stride 的 Entity）。批量生成给系统用的实体只有 id，
 * 需要对象时用 manager.entity(id) 取。
 */
import type { DataShape, DataValues, EntityId } from '../data/prop';
import type { ComponentType, ViewOf } from './component';
import type { EntityArg, EntityManager } from './EntityManager';
import { scriptName, type ScriptComponent, type ScriptConstructor } from './scripts';

/** 把一个实体的数据组件看成对象；读写都落到它在列里的那一行。 */
export type View<S extends DataShape> = DataValues<S>;

export class Entity {
  readonly id: EntityId;
  readonly manager: EntityManager;
  name: string;
  /** @internal 按类存放的脚本。 */
  readonly scripts = new Map<ScriptConstructor, ScriptComponent>();
  /** @internal 数据组件的视图，第一次 get 时创建。 */
  readonly views = new Map<ComponentType<any>, object>();

  constructor(manager: EntityManager, id: EntityId, name: string) {
    this.manager = manager;
    this.id = id;
    this.name = name;
  }

  get alive(): boolean {
    return this.manager.isAlive(this.id);
  }

  get<C extends ComponentType<any, any>>(type: C): ViewOf<C> | undefined;
  get<T extends ScriptComponent>(type: abstract new () => T): T | undefined;
  get(type: ComponentType<any> | (abstract new () => ScriptComponent)): unknown {
    if (typeof type === 'function') return this.script(type as ScriptConstructor);
    if (!this.manager.hasComponent(this.id, type)) return undefined;
    let view = this.views.get(type);
    if (!view) {
      view = this.manager.createView(this.id, type);
      this.views.set(type, view);
    }
    return view;
  }

  /** 同 get，但没有这个组件或脚本时抛错。 */
  require<C extends ComponentType<any, any>>(type: C): ViewOf<C>;
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
    return typeof type === 'function' ? this.script(type) !== undefined : this.manager.hasComponent(this.id, type);
  }

  /**
   * @internal 这个类的脚本。热重载之后，没重新执行的代码（比如游戏入口）手里可能还是旧版本的类：
   * 按登记的名字也能找到。
   */
  script(type: ScriptConstructor): ScriptComponent | undefined {
    const found = this.scripts.get(type);
    if (found || type.scriptName === undefined) return found;
    for (const [registered, script] of this.scripts) if (registered.scriptName === type.scriptName) return script;
    return undefined;
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
