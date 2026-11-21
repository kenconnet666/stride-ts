/**
 * 预制体（Stride 的 Prefab）：ContentManager.loadPrefab 加载，引用的资源已经加载好，`instantiate`、`spawn` 时才建实体。
 *
 *   const cube = await game.content.loadPrefab('BepuSample/Prefabs/Bepu/BepuInstancedCube');
 *   const [root] = cube.instantiate(game.entities);
 *   root.require(Transform).position = { x: 0, y: 10, z: 0 };
 *
 * 按生成的句柄加载的预制体带着它的结构（工程的 src/assets.gen.ts，见 docs/architecture.md 的"资源的强类型"）：`spawn` 返回的
 * 根实体、子实体按名字取，脚本按导出名取，都有类型；编辑器里改了名字、删了实体，引用它的代码在类型检查时报错。
 *
 *   const coin = (await game.content.load(assets.prefabs.Prefabs.Coin)).spawn(game.entities);
 *   coin.roots.Coin.scripts.Coin.value = 5;              // Coin 脚本的实例
 *   coin.roots.Coin.children.Glow.entity;                // 子实体
 */
import type { Entity } from '../engine/Entity';
import type { EntityManager } from '../engine/EntityManager';
import type { ScriptComponent } from '../engine/scripts';
import type { SceneEntityFile } from './format';
import { scriptKey } from './prefabInstances';

/** 预制体里一个实体的结构（生成的类型写的）：挂着的脚本（按导出名）和有名字的子实体。 */
export interface EntityShape {
  readonly scripts: object;
  readonly children: object;
}

/** 预制体的结构：有名字的根实体。 */
export interface PrefabShape {
  readonly roots: object;
}

/** 没有生成的结构时（按路径加载的）：名字、脚本都是字符串索引。 */
export interface UntypedEntityShape extends EntityShape {
  readonly scripts: Readonly<Record<string, ScriptComponent>>;
  readonly children: Readonly<Record<string, UntypedEntityShape>>;
}

export interface UntypedPrefabShape extends PrefabShape {
  readonly roots: Readonly<Record<string, UntypedEntityShape>>;
}

/** spawn 建出来的一个实体：实体本身、挂着的脚本（按导出名）、有名字的子实体（同名的取第一个）。 */
export interface SpawnedEntity<S extends EntityShape = UntypedEntityShape> {
  readonly entity: Entity;
  readonly scripts: S['scripts'];
  readonly children: { readonly [K in keyof S['children']]: S['children'][K] extends EntityShape ? SpawnedEntity<S['children'][K]> : never };
}

/** spawn 的结果：根实体（按预制体里的顺序）和按名字取的结构。 */
export interface SpawnedPrefab<S extends PrefabShape = UntypedPrefabShape> {
  readonly entities: readonly Entity[];
  readonly roots: { readonly [K in keyof S['roots']]: S['roots'][K] extends EntityShape ? SpawnedEntity<S['roots'][K]> : never };
}

export class Prefab<S extends PrefabShape = UntypedPrefabShape> {
  readonly name: string;
  /** 预制体的实体（实例已经展开）：spawn 照它们的父子关系、名字和脚本搭结构。 */
  readonly #files: readonly SceneEntityFile[];
  readonly #instantiate: (entities: EntityManager) => ReadonlyMap<string, Entity>;

  /** @internal ContentManager 建：instantiate 建出 files 的实体，返回按文件里的 id 的表。 */
  constructor(name: string, files: readonly SceneEntityFile[], instantiate: (entities: EntityManager) => ReadonlyMap<string, Entity>) {
    this.name = name;
    this.#files = files;
    this.#instantiate = instantiate;
  }

  /**
   * 建出预制体的实体（Stride 的 Prefab.Instantiate），返回根实体（按预制体里的顺序）。和 Stride 不同：实体建出来就在游戏里，
   * 不用再加进场景；脚本下一帧启动。
   */
  instantiate(entities: EntityManager): readonly Entity[] {
    return this.spawn(entities).entities;
  }

  /**
   * 同 instantiate，另外按名字给出建出来的结构：`roots.<名字>.children.<名字>`、`.scripts.<导出名>`。脚本没挂上（属性校验
   * 不过，控制台有报错）时取它报错。
   */
  spawn(entities: EntityManager): SpawnedPrefab<S> {
    const created = this.#instantiate(entities);
    const ids = new Set(this.#files.map((file) => file.id));
    const children = new Map<string | null, SceneEntityFile[]>();
    for (const file of this.#files) {
      const parent = file.parent !== null && ids.has(file.parent) ? file.parent : null;
      children.set(parent, [...(children.get(parent) ?? []), file]);
    }
    const named = (files: readonly SceneEntityFile[]) => {
      const result: Record<string, unknown> = {};
      for (const file of files) if (file.name !== '' && !Object.hasOwn(result, file.name)) result[file.name] = node(file);
      return result;
    };
    const node = (file: SceneEntityFile): SpawnedEntity => {
      const entity = created.get(file.id)!;
      const scripts: Record<string, ScriptComponent> = {};
      for (const { type } of file.components.scripts ?? []) {
        const key = scriptKey(type);
        if (Object.hasOwn(scripts, key)) continue;
        Object.defineProperty(scripts, key, {
          enumerable: true,
          get: () => {
            const script = entity.manager.game.registry.scriptsForType(type).map((ctor) => entity.script(ctor)).find((found) => found !== undefined);
            if (!script) throw new Error(`prefab ${this.name}: entity '${file.name}' has no ${type} script (not attached; see the errors when it was created)`);
            return script;
          },
        });
      }
      return { entity, scripts, children: named(children.get(file.id) ?? []) as SpawnedEntity['children'] };
    };
    const roots = children.get(null) ?? [];
    return { entities: roots.map((file) => created.get(file.id)!), roots: named(roots) as SpawnedPrefab<S>['roots'] };
  }
}
