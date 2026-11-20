/**
 * 预制体实例的展开（docs/prefabs.md，用户 2026-11-20 定的格式）：场景文件里的实例只存"引用哪个预制体，改了什么"，建实体
 * 之前把它展开成普通的实体列表——
 *
 * - 带 `prefab` 的实体就是预制体的根：id、名字、变换、父实体是实例自己的，组件是预制体根的（加上覆盖，再加上实例自己写的
 *   组件）。预制体有几个根时（Stride 的预制体可以有），一个实例只放其中一个（`prefab.root`），同 Stride 把每个根各自放进
 *   场景；所以导入的场景层级和 Stride 的一样，不多出容器实体。
 * - 根下面的成员 id 是 `<实例 id>/<预制体里的 id>`，不存：场景里别的东西引用实例成员就写这个 id，预制体改了、加了实体都
 *   不变。成员之间的引用（约束的两个物体、`$entity`、各种 link 的目标）跟着换成场景里的 id（指根的换成实例的 id）。
 * - `set` 改成员（包括根）的值（路径同场景文档的 set；脚本组件在路径里按类型名指，同一个实体上每种脚本只有一个）；
 *   `removed` 去掉成员（连后代）。指不到的（预制体改了结构）跳过并报出来，不悄悄改别的值。
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

/** 实例 → 展开的实体（根在前，连同当时的预制体，预制体换了就重新展开）。 */
const CACHE = new WeakMap<SceneEntityFile, { readonly prefab: Entities; readonly entities: Entities }>();

/**
 * 把实体列表里的实例展开成普通实体（实例换成合并好的根，成员紧跟在后面，父实体都在前面）。prefabs 是用到的预制体（路径 →
 * 它的实体列表，没展开过的），warn 收"指不到"的警告。没有实例时原样返回同一个数组。
 */
export function expandPrefabInstances(entities: Entities, prefabs: ReadonlyMap<string, Entities>, warn: (message: string) => void, stack: readonly string[] = []): Entities {
  if (!entities.some((entity) => entity.prefab)) return entities;
  const result: SceneEntityFile[] = [];
  for (const entity of entities) {
    if (entity.prefab) result.push(...instanceOf(entity, prefabs, warn, stack));
    else result.push(entity);
  }
  return result;
}

function instanceOf(instance: SceneEntityFile, prefabs: ReadonlyMap<string, Entities>, warn: (message: string) => void, stack: readonly string[]): Entities {
  const { path, root: rootOption, set = [], removed = [] } = instance.prefab!;
  if (stack.includes(path)) throw new Error(`prefab ${path} contains itself (${[...stack, path].join(' -> ')})`);
  const source = prefabs.get(path);
  if (!source) throw new Error(`prefab ${path} (instance ${instance.id}) is not loaded`);
  const cached = CACHE.get(instance);
  if (cached?.prefab === source) return cached.entities;

  // 预制体自己的实例先展开（id 在预制体里拼好，这里再拼一层）
  const expanded = expandPrefabInstances(source, prefabs, warn, [...stack, path]);
  const roots = expanded.filter((entity) => entity.parent === null);
  const rootId = rootOption ?? (roots.length === 1 ? roots[0]!.id : undefined);
  if (rootId === undefined) throw new Error(`instance ${instance.id}: prefab ${path} has ${roots.length} root entities; say which one with prefab.root`);
  if (!roots.some((entity) => entity.id === rootId)) throw new Error(`instance ${instance.id}: ${rootId} is not a root entity of prefab ${path}`);
  // 这个实例放的是根 rootId 和它的后代（父实体排在前面，顺着扫一遍就收全了）
  const inside = new Set([rootId]);
  for (const entity of expanded) if (entity.parent !== null && inside.has(entity.parent)) inside.add(entity.id);
  const gone = new Set<string>();
  for (const id of removed) {
    if (id !== rootId && inside.has(id)) gone.add(id);
    else warn(`instance ${instance.id} of prefab ${path} removes entity ${id}, which is not a member`);
  }
  for (const entity of expanded) if (entity.parent !== null && gone.has(entity.parent)) gone.add(entity.id);
  const rename = (id: string | null): string | null => (id === rootId ? instance.id : id !== null && inside.has(id) ? memberId(instance.id, id) : id);

  const result: SceneEntityFile[] = [];
  for (const entity of expanded) {
    if (!inside.has(entity.id) || gone.has(entity.id)) continue;
    let member: SceneEntityFile = entity.id === rootId
      // 根：身份和摆放是实例的，组件是预制体的，实例自己写的组件盖在上面
      ? { ...renameReferences(entity, rename), id: instance.id, name: instance.name, parent: instance.parent, position: instance.position, rotation: instance.rotation, scale: instance.scale, components: { ...renameReferences(entity, rename).components, ...instance.components } }
      : { ...renameReferences(entity, rename), id: memberId(instance.id, entity.id), parent: rename(entity.parent) };
    for (const override of set) {
      if (override.entity !== entity.id) continue;
      const changed = setPath(member, override.path, override.value);
      if (changed === undefined) warn(`instance ${instance.id} of prefab ${path}: ${override.path.join('.')} does not exist on entity ${entity.id}`);
      else member = changed;
    }
    result.push(member);
  }
  for (const override of set) {
    if (!inside.has(override.entity)) warn(`instance ${instance.id} of prefab ${path} overrides entity ${override.entity}, which is not a member`);
  }
  CACHE.set(instance, { prefab: source, entities: result });
  return result;
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
