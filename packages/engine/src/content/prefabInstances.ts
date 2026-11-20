/**
 * 预制体实例的展开（docs/prefabs.md，用户 2026-11-20 定的格式）：场景文件里的实例只存"引用哪个预制体，改了什么"，建实体
 * 之前把它展开成普通的实体列表——
 *
 * - 带 `prefab` 的实体是实例的容器（自己的名字、变换、父实体、组件照常）；预制体的根实体挂在它下面。
 * - 成员的 id 是 `<实例 id>/<预制体里的 id>`，不存：场景里别的东西引用实例成员就写这个 id，预制体改了、加了实体都不变。
 *   成员之间的引用（约束的两个物体、`$entity`、各种 link 的目标）跟着换成拼出来的 id。
 * - `set` 改成员的值（路径同场景文档的 set；脚本组件在路径里按类型名指，同一个实体上每种脚本只有一个）；`removed` 去掉
 *   成员（连后代）。指不到的（预制体改了结构）跳过并报出来，不悄悄改别的值。
 * - 预制体里也可以有实例：一层层展开，id 一层层拼；引用成环时报错。
 *
 * 纯函数，不读文件：要用到的预制体先由调用方加载好（ContentManager）。展开的结果按实例缓存：实例和预制体都没变时给同一批
 * 对象，编辑器改场景时（SceneBuilder.update 比对象是不是同一个）没动的实例不重建。
 */
import type { SceneEntityFile, SceneScriptValue } from './format';

type Entities = readonly SceneEntityFile[];

/** 实例成员在场景里的 id。 */
export const memberId = (instance: string, entity: string): string => `${instance}/${entity}`;

/** 实体列表（连同它引用的预制体，一层层往下）里用到的预制体路径。 */
export function prefabPaths(entities: Entities): string[] {
  return [...new Set(entities.flatMap((entity) => (entity.prefab ? [entity.prefab.path] : [])))];
}

/** 实例 → 展开的成员（连同当时的预制体，预制体换了就重新展开）。 */
const CACHE = new WeakMap<SceneEntityFile, { readonly prefab: Entities; readonly members: Entities }>();

/**
 * 把实体列表里的实例展开成普通实体（成员紧跟在实例后面，父实体都在前面）。prefabs 是用到的预制体（路径 → 它的实体列表，
 * 没展开过的），warn 收"指不到"的警告。没有实例时原样返回同一个数组。
 */
export function expandPrefabInstances(entities: Entities, prefabs: ReadonlyMap<string, Entities>, warn: (message: string) => void, stack: readonly string[] = []): Entities {
  if (!entities.some((entity) => entity.prefab)) return entities;
  const result: SceneEntityFile[] = [];
  for (const entity of entities) {
    if (!entity.prefab) {
      result.push(entity);
      continue;
    }
    const { prefab: _prefab, ...container } = entity;
    result.push(container);
    result.push(...membersOf(entity, prefabs, warn, stack));
  }
  return result;
}

function membersOf(instance: SceneEntityFile, prefabs: ReadonlyMap<string, Entities>, warn: (message: string) => void, stack: readonly string[]): Entities {
  const { path, set = [], removed = [] } = instance.prefab!;
  if (stack.includes(path)) throw new Error(`prefab ${path} contains itself (${[...stack, path].join(' -> ')})`);
  const source = prefabs.get(path);
  if (!source) throw new Error(`prefab ${path} (instance ${instance.id}) is not loaded`);
  const cached = CACHE.get(instance);
  if (cached?.prefab === source) return cached.members;

  // 预制体自己的实例先展开（id 在预制体里拼好，这里再拼一层）
  const expanded = expandPrefabInstances(source, prefabs, warn, [...stack, path]);
  const ids = new Set(expanded.map((entity) => entity.id));
  const gone = new Set<string>();
  for (const id of removed) {
    if (ids.has(id)) gone.add(id);
    else warn(`instance ${instance.id} of prefab ${path} removes entity ${id}, which is not in the prefab`);
  }
  // 去掉的连后代（父实体排在前面，顺着扫一遍就收全了）
  for (const entity of expanded) if (entity.parent !== null && gone.has(entity.parent)) gone.add(entity.id);
  const rename = (id: string | null): string | null => (id !== null && ids.has(id) ? memberId(instance.id, id) : id);

  const members: SceneEntityFile[] = [];
  for (const entity of expanded) {
    if (gone.has(entity.id)) continue;
    let member: SceneEntityFile = { ...renameReferences(entity, rename), id: memberId(instance.id, entity.id), parent: entity.parent === null ? instance.id : rename(entity.parent) };
    for (const override of set) {
      if (override.entity !== entity.id) continue;
      const changed = setPath(member, override.path, override.value);
      if (changed === undefined) warn(`instance ${instance.id} of prefab ${path}: ${override.path.join('.')} does not exist on entity ${entity.id}`);
      else member = changed;
    }
    members.push(member);
  }
  for (const override of set) {
    if (!ids.has(override.entity)) warn(`instance ${instance.id} of prefab ${path} overrides entity ${override.entity}, which is not in the prefab`);
  }
  CACHE.set(instance, { prefab: source, members });
  return members;
}

/** 组件里对别的实体的引用（约束、实例化、两种 link、脚本属性的 `$entity`）照 rename 换掉；没有要换的原样返回。 */
function renameReferences(entity: SceneEntityFile, rename: (id: string | null) => string | null): SceneEntityFile {
  const c = entity.components;
  const components: Record<string, unknown> = { ...c };
  if (c.constraints) components['constraints'] = c.constraints.map((constraint) => ({ ...constraint, bodyA: rename(constraint.bodyA)!, ...(constraint.bodyB !== undefined ? { bodyB: rename(constraint.bodyB)! } : {}) }));
  if (c.instance) components['instance'] = { ...c.instance, master: rename(c.instance.master) };
  if (c.nodeLink) components['nodeLink'] = { ...c.nodeLink, target: rename(c.nodeLink.target) };
  if (c.uiElementLink) components['uiElementLink'] = { ...c.uiElementLink, target: rename(c.uiElementLink.target), camera: rename(c.uiElementLink.camera) };
  if (c.scripts) components['scripts'] = c.scripts.map((script) => ({ ...script, props: renameScriptValue(script.props, rename) as typeof script.props }));
  return { ...entity, components: components as SceneEntityFile['components'] };
}

function renameScriptValue(value: SceneScriptValue, rename: (id: string | null) => string | null): SceneScriptValue {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => renameScriptValue(item, rename));
  const object = value as Record<string, SceneScriptValue>;
  if (typeof object['$entity'] === 'string') return { ...object, $entity: rename(object['$entity'])! };
  return Object.fromEntries(Object.entries(object).map(([key, item]) => [key, renameScriptValue(item, rename)]));
}

/**
 * 不改原对象，把 path 上的值设成 value，返回新的实体；路径走不通时是 undefined。路径里 `scripts` 后面跟的是脚本的类型名
 * （换成它在列表里的下标）。
 */
export function setPath(entity: SceneEntityFile, path: readonly (string | number)[], value: unknown): SceneEntityFile | undefined {
  const resolved: (string | number)[] = [];
  let node: unknown = entity;
  for (let i = 0; i < path.length; i++) {
    let key = path[i]!;
    if (Array.isArray(node) && typeof key === 'string' && path[i - 1] === 'scripts') {
      const index = (node as { type?: string }[]).findIndex((script) => script.type === key);
      if (index < 0) return undefined;
      key = index;
    }
    resolved.push(key);
    if (i === path.length - 1) break;
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<string | number, unknown>)[key];
    if (node === undefined) return undefined;
  }
  if (node === null || typeof node !== 'object') return undefined;
  return assign(entity, resolved, value) as SceneEntityFile;
}

function assign(root: unknown, path: readonly (string | number)[], value: unknown): unknown {
  const [key, ...rest] = path as [string | number, ...(string | number)[]];
  const container = root as Record<string | number, unknown>;
  const next = rest.length === 0 ? value : assign(container[key], rest, value);
  if (Array.isArray(root)) {
    const copy = root.slice();
    copy[key as number] = next;
    return copy;
  }
  return { ...container, [key]: next };
}
