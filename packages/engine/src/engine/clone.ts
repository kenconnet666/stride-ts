/**
 * 克隆实体（Stride 的 Entity.Clone、EntityCloner）：`entity.clone()` 把实体连同子实体再建一份。
 * - 数据组件照抄现在的值。只有运行时状态的组件（字段全是 transient，比如 PhysicsBody、Skinned）不抄：它们是系统挂上的，
 *   由那个系统重新挂（看到新实体时，或者在 `entities.onClone` 里）。
 * - 脚本按现在的属性值新建一个（transient 的属性取默认值），start() 重新跑；属性以外的创作数据由脚本的 cloneFrom 抄。
 * - 实体引用（prop.entity）、组件引用（prop.component）指向这棵子树里的实体时换成对应的克隆，指向外面的照旧；
 *   资源（prop.asset）共用。
 * - 克隆的根没有父实体，也不在任何场景里（见 Entity.scene）。
 * 和 Stride 不同：克隆出来的实体马上就在游戏里（Stride 要再加进场景才看得见、才跑脚本）。
 */
import type { EntityId } from '../data/prop';
import { containsKind, copyValue, type Field, type ReferenceMap } from '../data/schema';
import type { ComponentType } from './component';
import type { Entity } from './Entity';
import type { EntityManager } from './EntityManager';
import { ScriptComponent, type ScriptConstructor } from './scripts';
import { Transform } from './transform';

/** 克隆之后调用：clones 是这次克隆的每个实体（被克隆的 → 克隆出来的），系统在这里给克隆补上自己挂的运行时状态。 */
export type CloneHandler = (clones: ReadonlyMap<Entity, Entity>) => void;

export function cloneEntity(manager: EntityManager, root: Entity, handlers: readonly CloneHandler[]): Entity {
  // 先把实体都建出来（只带 Transform，父子关系照原样），引用才有东西可指
  const clones = new Map<Entity, Entity>();
  for (const source of subtree(root)) {
    const from = source.get(Transform);
    const transform = from && Transform.with({ position: { ...from.position }, rotation: { ...from.rotation }, scale: { ...from.scale } });
    const clone = manager.create({ name: source.name, components: transform ? [transform] : [] });
    const parent = source === root ? undefined : clones.get(from!.parent!);
    if (parent) clone.require(Transform).parent = parent;
    clones.set(source, clone);
  }
  const cloneOf = (entity: Entity) => clones.get(entity) ?? entity;
  const references = referenceMap(manager, clones);

  for (const [source, clone] of clones) {
    for (const type of manager.componentTypes(source.id)) {
      if (type === Transform || isRuntimeOnly(type)) continue;
      clone.add(type.with(valuesOf(type.schema.fields, source.require(type) as Record<string, unknown>, references)));
    }
  }

  const scripts: [source: ScriptComponent, copy: ScriptComponent, type: ScriptConstructor][] = [];
  for (const [source, clone] of clones) {
    for (const [type, script] of source.scripts) {
      clone.add({ script: type, init: scriptValues(type, script, references) });
      const copy = clone.script(type)!;
      copy.enabled = script.enabled;
      scripts.push([script, copy, type]);
    }
  }
  // 指向子树里别的脚本的组件引用，要等脚本都挂上才换得了：这时重算一遍，把带这种引用的属性换掉
  for (const [script, copy, type] of scripts) {
    const fields = type.schema.fields.filter((field) => !field.options.transient && !field.options.sealed && containsKind(field.options, 'component'));
    if (fields.length === 0) continue;
    const values: Record<string, unknown> = {};
    type.schema.assign(values, scriptValues(type, script, references));
    for (const field of fields) (copy as unknown as Record<string, unknown>)[field.name] = values[field.name];
  }
  for (const [script, copy] of scripts) copy.cloneFrom(script, cloneOf);
  for (const handler of handlers) handler(clones);
  return clones.get(root)!;
}

/** 实体和它下面的所有实体，父实体在前。 */
function subtree(root: Entity): Entity[] {
  const all = [root];
  for (let i = 0; i < all.length; i++) all.push(...(all[i]!.get(Transform)?.children ?? []));
  return all;
}

/** 只有运行时状态的组件：有字段，而且全是 transient。 */
const isRuntimeOnly = (type: ComponentType<any>) => type.schema.fields.length > 0 && type.schema.fields.every((field) => field.options.transient);

/** 数据组件一行现在的值，当 init 用：transient、sealed 的字段留给默认值；向量字段是活的视图，要拍成普通对象。 */
function valuesOf(fields: readonly Field[], view: Record<string, unknown>, references: ReferenceMap): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const field of fields) {
    if (field.options.transient || field.options.sealed) continue;
    values[field.name] = field.stride > 1 ? { ...(view[field.name] as object) } : copyValue(field.options, view[field.name], references);
  }
  return values;
}

/** 脚本现在的属性值，当 init 用；stat 属性取基础值（修饰不跟着克隆）。 */
function scriptValues(type: ScriptConstructor, script: ScriptComponent, references: ReferenceMap): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const field of type.schema.fields) {
    if (field.options.transient || field.options.sealed) continue;
    const value = field.options.stat ? script.statTable[field.name]!.base : (script as unknown as Record<string, unknown>)[field.name];
    values[field.name] = copyValue(field.options, value, references);
  }
  return values;
}

function referenceMap(manager: EntityManager, clones: ReadonlyMap<Entity, Entity>): ReferenceMap {
  // 数据组件的视图属于哪个实体的哪个组件：用到时才建
  let viewOwners: Map<object, [Entity, ComponentType<any>]> | undefined;
  const ownerOf = (view: object) => {
    viewOwners ??= new Map([...clones.keys()].flatMap((source) => [...source.views].map(([type, v]) => [v, [source, type]] as const)));
    return viewOwners.get(view);
  };
  return {
    entity: (id) => {
      const source = manager.isAlive(id as EntityId) ? manager.entity(id as EntityId) : undefined;
      return (source && clones.get(source)?.id) ?? id;
    },
    component: (reference) => {
      if (reference instanceof ScriptComponent) return clones.get(reference.entity)?.script(reference.constructor as ScriptConstructor) ?? reference;
      const owner = ownerOf(reference);
      return owner ? ((clones.get(owner[0])!.get(owner[1]) as object | undefined) ?? reference) : reference;
    },
  };
}
