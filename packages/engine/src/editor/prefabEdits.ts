/**
 * 编辑器里改预制体的实例（docs/prefabs.md）：界面和视口看到、改的是展开以后的场景，实例的成员也是实体（id 是
 * `<实例>/<预制体里的 id>`），文档里存的却是引用和差异。这里把展开的场景上的修改换成文档上的：
 *
 * - 实例自己的身份和摆放（名字、变换、父实体）照常改实例实体；
 * - 成员的值、根的组件成实例 `prefab.set` 里的一条覆盖；改回和预制体一样时去掉这条覆盖，所以文件里只留真的差异；
 * - 已经有一条覆盖盖着整个对象（例如整个脚本列表）时改它里面的值；能增删的列表（加、去掉一项）整个覆盖。
 *
 * - 删成员记进实例的 `prefab.removed`（连后代）。
 *
 * 加实体照原样交给文档：成员不在文档里，往成员下面加实体还不支持（文档报"没有这个实体"）。
 */
import type { SceneEntityFile } from '../content/format';
import { expandPrefabInstances, getPath, sameValue, setPath } from '../content/prefabInstances';
import { SceneDocument, type EntitiesFile, type SceneEdit, type ScenePath } from './SceneDocument';

type Entities = readonly SceneEntityFile[];
type Override = NonNullable<NonNullable<SceneEntityFile['prefab']>['set']>[number];

/** 实例实体自己的字段：改它们是改实例，不是覆盖。 */
const OWN_FIELDS: ReadonlySet<unknown> = new Set(['id', 'name', 'parent', 'position', 'rotation', 'scale', 'prefab']);

/** 展开的场景里一个实体属于哪个实例：实例实体，和这个实体在预制体里的 id（根也算成员）。 */
export interface InstanceMember {
  readonly instance: SceneEntityFile;
  readonly member: string;
}

/** 展开的场景里的实体 id 是不是实例的根或者成员；文档自己的普通实体（和不存在的 id）是 undefined。 */
export function instanceMember(file: EntitiesFile, prefabs: ReadonlyMap<string, Entities>, id: string): InstanceMember | undefined {
  const own = file.entities.find((entity) => entity.id === id);
  if (own) return own.prefab ? { instance: own, member: rootOf(own, prefabs) } : undefined;
  // 成员的 id 是 实例/预制体里的 id，预制体里嵌套的实例再拼一层：最短的、文档里是实例的前缀就是它属于的实例
  for (let slash = id.indexOf('/'); slash >= 0; slash = id.indexOf('/', slash + 1)) {
    const instance = file.entities.find((entity) => entity.id === id.slice(0, slash));
    if (instance?.prefab) return { instance, member: id.slice(slash + 1) };
  }
  return undefined;
}

/** 展开的场景上的修改 → 文档上的修改。prefabs 是文档用到的预制体（连嵌套的，loadPrefabs 加载的）。 */
export function toDocumentEdit(file: EntitiesFile, prefabs: ReadonlyMap<string, Entities>, edit: SceneEdit): SceneEdit {
  if (edit.type === 'batch') {
    // 一步里改同一个实例的几处：后面的要在前面的改完的文档上换
    const scratch = new SceneDocument(file);
    return {
      type: 'batch',
      edits: edit.edits.map((part) => {
        const translated = toDocumentEdit(scratch.file, prefabs, part);
        scratch.apply(translated);
        return translated;
      }),
    };
  }
  if (edit.type === 'remove') return removeEdit(file, prefabs, edit.entities);
  if (edit.type !== 'set') return edit;
  const target = instanceMember(file, prefabs, edit.entity);
  if (!target || (target.instance.id === edit.entity && OWN_FIELDS.has(edit.path[0]))) return edit;

  const { instance, member } = target;
  const current = expandPrefabInstances(file.entities, prefabs, () => {}).find((entity) => entity.id === edit.entity);
  if (!current) throw new Error(`scene ${file.name}: no entity ${edit.entity}`);
  const [path, value] = overridePath(current, edit.path, edit.value);
  const set = instance.prefab!.set ?? [];
  const mine = (override: Override) => override.entity === member;

  let next: Override[];
  const covering = set.find((override) => mine(override) && override.path.length < path.length && startsWith(path, override.path));
  if (covering) {
    // 改进已有的那条覆盖里，同一个对象里更细的覆盖并进它
    const changed = setPath(current, path, value);
    if (!changed) throw new Error(`scene ${file.name}: ${path.join('.')} does not exist on entity ${edit.entity}`);
    next = set.filter((override) => !(mine(override) && override !== covering && startsWith(override.path, covering.path)))
      .map((override) => (override === covering ? { ...override, value: getPath(changed, covering.path) } : override));
  } else {
    const rest = set.filter((override) => !(mine(override) && startsWith(override.path, path)));
    // 不带这条覆盖时是什么值：和要设的一样就不用覆盖（改回了预制体的值）
    const without = { ...instance, prefab: { ...instance.prefab!, set: rest } };
    const base = expandPrefabInstances([without], prefabs, () => {}).find((entity) => entity.id === edit.entity);
    next = base && sameValue(getPath(base, path), value) ? rest : [...rest, { entity: member, path, value }];
  }
  return { type: 'set', entity: instance.id, path: ['prefab', 'set'], value: next.length > 0 ? next : undefined };
}

/**
 * 删实体：文档里的照删，成员记进实例的 `prefab.removed`（实例自己也删了的不用记）。和文档的 remove 一样，留下的实体里不能
 * 还有要删的实体的子实体（挂在成员下面的文档实体要一起给出）。
 */
function removeEdit(file: EntitiesFile, prefabs: ReadonlyMap<string, Entities>, ids: readonly string[]): SceneEdit {
  const inDocument = new Set(file.entities.map((entity) => entity.id));
  const own = ids.filter((id) => inDocument.has(id));
  const removing = new Set(own);
  const members = new Map<SceneEntityFile, string[]>();
  for (const id of ids) {
    if (inDocument.has(id)) continue;
    const target = instanceMember(file, prefabs, id);
    if (!target) throw new Error(`scene ${file.name}: no entity ${id}`);
    if (!removing.has(target.instance.id)) members.set(target.instance, [...(members.get(target.instance) ?? []), target.member]);
  }
  const edits: SceneEdit[] = [...members].map(([instance, removed]) => ({ type: 'set', entity: instance.id, path: ['prefab', 'removed'], value: [...(instance.prefab!.removed ?? []), ...removed] }));
  if (own.length > 0) edits.push({ type: 'remove', entities: own });
  return edits.length === 1 ? edits[0]! : { type: 'batch', edits };
}

/**
 * 文档的 set 路径 → 覆盖的路径和值：脚本的下标换成类型名（覆盖里脚本按类型名指，同一个实体上每种脚本只有一个）；
 * 在列表末尾加一项、去掉一项是整个列表的覆盖。
 */
function overridePath(entity: SceneEntityFile, path: ScenePath, value: unknown): [ScenePath, unknown] {
  const named: (string | number)[] = [];
  let node: unknown = entity;
  for (let i = 0; i < path.length; i++) {
    const key = path[i]!;
    const list = Array.isArray(node) ? (node as unknown[]) : undefined;
    if (i === path.length - 1 && list && typeof key === 'number' && (value === undefined || key >= list.length)) {
      const whole = value === undefined ? list.filter((_, j) => j !== key) : [...list.slice(0, key), value];
      return [named, whole];
    }
    named.push(list && path[i - 1] === 'scripts' && typeof key === 'number' ? (list[key] as { type: string }).type : key);
    node = node !== null && typeof node === 'object' ? (node as Record<string | number, unknown>)[key] : undefined;
  }
  return [named, value];
}

/** 实例放的是预制体的哪个根：prefab.root，没写就是唯一的那个根。 */
function rootOf(instance: SceneEntityFile, prefabs: ReadonlyMap<string, Entities>): string {
  const { path, root } = instance.prefab!;
  if (root !== undefined) return root;
  const source = prefabs.get(path);
  if (!source) throw new Error(`prefab ${path} (instance ${instance.id}) is not loaded`);
  const roots = expandPrefabInstances(source, prefabs, () => {}).filter((entity) => entity.parent === null);
  if (roots.length !== 1) throw new Error(`instance ${instance.id}: prefab ${path} has ${roots.length} root entities; say which one with prefab.root`);
  return roots[0]!.id;
}

const startsWith = (path: ScenePath, prefix: ScenePath): boolean => prefix.length <= path.length && prefix.every((key, i) => path[i] === key);
