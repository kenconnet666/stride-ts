/**
 * 实体对象，给脚本和场景代码用（对应 Stride 的 Entity）。批量生成给系统用的实体只有 id，
 * 需要对象时用 manager.entity(id) 取。
 */
import type { DataShape, DataValues, EntityId } from '../data/prop';
import type { ComponentType, ViewOf } from './component';
import type { EntityArg, EntityManager } from './EntityManager';
import { scriptName, type ScriptComponent, type ScriptConstructor } from './scripts';
import { syncSceneRoot, Transform, type SceneRoot } from './transform';

/** 把一个实体的数据组件看成对象；读写都落到它在列里的那一行。 */
export type View<S extends DataShape> = DataValues<S>;

/** 实体所在的场景（见 Entity.scene）；场景对象由内容管理建（SceneInstance）。 */
export interface EntityScene {
  readonly name: string;
  /** 场景在变换存储里的根：场景的偏移、和父场景的关系（见 SceneRoot）。没有时场景里的实体就按自己的位置摆。 */
  readonly root?: SceneRoot | undefined;
}

export class Entity {
  readonly id: EntityId;
  readonly manager: EntityManager;
  name: string;
  /** @internal 直接放进的场景；没有时跟着父实体，见 scene。 */
  ownScene: EntityScene | undefined;
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

  /**
   * 实体所在的场景（Stride 的 Entity.Scene）：场景文件建的实体在那个场景里，别的实体跟着父实体。运行时建的根实体（create、
   * 克隆、预制体实例）不在任何场景里，场景卸载时不会跟着销毁；赋值把它放进一个场景（Stride 的 `Entity.Scene.Entities.Add`），
   * 也可以在 create 时给：
   *
   *   clone.scene = this.entity.scene;
   *   this.game.entities.create({ name: 'Bullet', scene: this.entity.scene, components: [Transform] });
   */
  get scene(): EntityScene | undefined {
    for (let entity: Entity | undefined = this; entity; entity = entity.get(Transform)?.parent) {
      if (entity.ownScene) return entity.ownScene;
    }
    return undefined;
  }

  set scene(scene: EntityScene | undefined) {
    this.ownScene = scene;
    syncSceneRoot(this.manager, this);
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

  /**
   * 子孙实体里第一个叫这个名字的（Stride 的 Entity.FindChild），没有时是 undefined。按深度优先、子实体的顺序找；要遍历整棵子树，
   * 别每帧调。和 Stride 不同：不会找到自己（Stride 从自己找起，自己同名时返回自己），同名的先找到靠前的子实体（Stride 是靠后的）。
   */
  findChild(name: string): Entity | undefined {
    for (const child of this.get(Transform)?.children ?? []) {
      const found = child.name === name ? child : child.findChild(name);
      if (found) return found;
    }
    return undefined;
  }

  /** 把这个实体连同子实体再建一份（Stride 的 Entity.Clone），见 engine/clone.ts。 */
  clone(): Entity {
    return this.manager.clone(this);
  }

  destroy(): void {
    this.manager.destroy(this.id);
  }
}
