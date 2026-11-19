/**
 * 场景文件里的脚本组件（format.ts 的 SceneScript）挂到实体上：按 Stride 的类型名找翻译过来的 TS 脚本，属性值里对实体和
 * 资源的引用换成实体 id 和加载好的资源。
 *
 * 找脚本的规则：先看 loadScene 的 scripts 选项（显式对应，值为 null 表示有意不挂），再按类名（类型名最后一段）在登记表里找
 * 导出名相同的脚本。找不到时记警告并跳过：场景里可能有只在编辑器里用的脚本，或者还没翻译的脚本。
 * TS 脚本没有声明的属性也记警告并忽略（翻译时可以有意省掉一些属性）。
 *
 * 和 Stride 不同：一个实体上每种脚本只能有一个。Stride 场景里同一个实体上挂了几个同类的脚本时（比如 BepuSample 的
 * Ropes 有 5 个 RopeSpawnerComponent），第二个起挂到自动建的子实体上（变换是单位的，位置和父实体相同）。
 */
import type { SceneAssetKind, SceneScript, SceneScriptValue } from './format';
import type { EntityId } from '../data/prop';
import type { Entity } from '../engine/Entity';
import type { Registry } from '../engine/registry';
import type { ScriptConstructor } from '../engine/scripts';

/** loadScene 的选项里，Stride 类型名（带命名空间，不带程序集）到 TS 脚本的显式对应。 */
export type SceneScriptMap = Readonly<Record<string, ScriptConstructor | null>>;

/** 属性值里引用的资源：内容路径和种类。 */
export interface ScriptAssetRef {
  readonly path: string;
  readonly kind: SceneAssetKind;
}

/** 场景里所有脚本属性引用的资源（加载场景时先并行加载它们）。 */
export function scriptAssetRefs(scripts: readonly SceneScript[]): ScriptAssetRef[] {
  const refs: ScriptAssetRef[] = [];
  const visit = (value: SceneScriptValue): void => {
    if (value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) return value.forEach(visit);
    const object = value as Record<string, SceneScriptValue>;
    if (typeof object['$asset'] === 'string') return void refs.push({ path: object['$asset'], kind: object['kind'] as SceneAssetKind });
    Object.values(object).forEach(visit);
  };
  for (const script of scripts) Object.values(script.props).forEach(visit);
  return refs;
}

/** 解析场景值时要用的：场景里的实体 id → 实体，按种类和路径找加载好的资源。 */
export interface ScriptValueContext {
  readonly entities: ReadonlyMap<string, Entity>;
  readonly asset: (kind: SceneAssetKind, path: string) => object;
  /** 实体上已经有同类脚本时，建一个子实体来挂（见文件开头）。 */
  readonly extraEntity: (owner: Entity) => Entity;
}

export class SceneScriptBinder {
  readonly #registry: Registry;
  readonly #explicit: SceneScriptMap;
  /** 已经警告过的类型和属性，每个只警告一次。 */
  readonly #warned = new Set<string>();

  constructor(registry: Registry, explicit: SceneScriptMap = {}) {
    this.#registry = registry;
    this.#explicit = explicit;
  }

  /**
   * 把 script 挂到 entity 上；找不到对应的 TS 脚本时警告并跳过。where 用在警告里（场景和实体名）。
   * deferMissing 时，引用的组件或脚本还没挂上（比如同一个实体上排在后面的脚本）就不挂，返回 false，调用方之后再试。
   */
  attach(entity: Entity, script: SceneScript, context: ScriptValueContext, where: string, { deferMissing = false } = {}): boolean {
    const type = this.#resolve(script.type, where);
    if (!type) return true;
    // 场景里的属性名按旧名字（`renamedFrom`）也能找到：TS 脚本改了名（比如和脚本自己的 enabled 重名）时，场景里的值照样读进来
    const fields = new Map(type.schema.fields.flatMap((field) => [[field.name, field] as const, ...(field.options.renamedFrom ? [[field.options.renamedFrom, field] as const] : [])]));
    const init: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(script.props)) {
      // null 是 Stride 里没有设的引用：用 TS 脚本的默认值（TS 脚本没有这个属性也无所谓）
      if (value === null) continue;
      const field = fields.get(name);
      if (!field) {
        this.#warnOnce(`${script.type}.${name}`, `${where}: ${script.type}.${name} is not a prop of the TS script; ignored`);
        continue;
      }
      if (field.options.kind !== 'component') {
        // Stride 的 YAML 把空的集合写成 {}，导入器分不清是列表还是字典：TS 脚本声明的是列表时当成空列表
        const isEmptyObject = typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0;
        init[field.name] = field.options.kind === 'list' && isEmptyObject ? [] : resolveValue(value, context);
        continue;
      }
      const component = resolveComponent(value, field.options.target!(), context, `${where}: ${script.type}.${name}`, deferMissing);
      if (component === MISSING) return false;
      init[field.name] = component;
    }
    (entity.get(type) ? context.extraEntity(entity) : entity).add({ script: type, init });
    return true;
  }

  #resolve(type: string, where: string): ScriptConstructor | undefined {
    if (Object.hasOwn(this.#explicit, type)) return this.#explicit[type] ?? undefined;
    const className = type.slice(type.lastIndexOf('.') + 1);
    const found = this.#registry.scriptsNamed(className);
    if (found.length === 1) return found[0];
    if (found.length > 1) throw new Error(`${where}: several scripts are named ${className}; map '${type}' in loadScene's scripts option`);
    this.#warnOnce(type, `${where}: no TS script named ${className} for ${type}; skipped (export one, or map it in loadScene's scripts option)`);
    return undefined;
  }

  #warnOnce(key: string, message: string): void {
    if (this.#warned.has(key)) return;
    this.#warned.add(key);
    console.warn(`[stride] ${message}`);
  }
}

/** resolveComponent 的结果：引用的组件还没挂上（deferMissing 时）。 */
const MISSING = Symbol('missing');

/**
 * 引用组件的属性（prop.component）：场景里写的是组件所在的实体，换成那个实体上的组件或脚本。场景自带的组件（比如
 * AnimationComponent）在脚本之前挂；脚本之间的引用不要求顺序（同 Stride），被引用的脚本还没挂上时 deferMissing 返回 MISSING。
 */
function resolveComponent(value: SceneScriptValue, target: unknown, context: ScriptValueContext, where: string, deferMissing: boolean): unknown {
  const id = typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, SceneScriptValue>)['$entity'] : undefined;
  if (typeof id !== 'string') throw new Error(`${where}: expected a component reference, got ${JSON.stringify(value)}`);
  const entity = context.entities.get(id);
  if (!entity) throw new Error(`${where}: refers to entity ${id}, which is not in the scene`);
  const found = entity.get(target as never) as unknown;
  if (found === undefined && deferMissing) return MISSING;
  if (found === undefined) throw new Error(`${where}: entity '${entity.name}' has no ${(target as { name?: string }).name ?? 'such component'} (yet)`);
  return found;
}

/**
 * 一组属性值（场景脚本或合成器渲染器的）换成加载好的：实体引用换成实体 id，资源引用换成 asset 给的资源，其余原样。
 */
export function resolveSceneValues(props: Readonly<Record<string, SceneScriptValue>>, context: Pick<ScriptValueContext, 'entities' | 'asset'>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(props).map(([key, value]) => [key, resolveValue(value, context)]));
}

/** 场景值换成脚本属性的初始值：实体引用换成实体 id，资源引用换成加载好的资源，其余原样（数组和对象逐项换）。 */
function resolveValue(value: SceneScriptValue, context: Pick<ScriptValueContext, 'entities' | 'asset'>): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => resolveValue(item, context));
  const object = value as Record<string, SceneScriptValue>;
  if (typeof object['$entity'] === 'string') {
    const entity = context.entities.get(object['$entity']);
    if (!entity) throw new Error(`script property refers to entity ${object['$entity']}, which is not in the scene`);
    return entity.id as EntityId;
  }
  if (typeof object['$asset'] === 'string') return context.asset(object['kind'] as SceneAssetKind, object['$asset']);
  return Object.fromEntries(Object.entries(object).map(([key, item]) => [key, resolveValue(item, context)]));
}
