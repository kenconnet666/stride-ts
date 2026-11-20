/**
 * 导入时把 Stride 场景（和预制体）里的预制体实例转成我们的格式（docs/prefabs.md，用户 2026-11-20 定）：
 *
 * - Stride 把实例的每个成员都完整地存在场景里，`Base` 记着它来自哪个预制体（BasePartAsset）、对应预制体里的哪个实体
 *   （BasePartId）、属于哪个实例（InstanceId）。改过的值键名带 `*`，但这个标记不可靠（decisions.md 的"预制体的实例照文件里
 *   的值"），所以不看它：场景文件里的值全部当覆盖，和预制体逐项比，相同的去掉。
 * - 实例的每个根各成一个实例实体（id 照 Stride 的），根下面的成员换成 `<实例>/<预制体里的 id>`，场景里引用成员的地方
 *   （父实体、约束、`$entity`、各种 link）跟着换。
 * - 转完用加载器的展开（engine 的 expandPrefabInstances）再展开一遍，和原来展开着的场景逐项比；对不上就整个场景照旧展开
 *   着存并报出来，所以导入的画面和以前一样。
 *
 * 纯函数：预制体由调用方先转好（连嵌套的）。
 */
import type { SceneEntityFile } from '@stride-ts/engine/content-format';
import { expandPrefabInstances, memberId, renameReferences } from '@stride-ts/engine/content-prefabs';

/** 场景实体的 Base：来自哪个预制体（内容路径）、预制体里的哪个实体（Stride 的 id）、属于哪个实例。 */
export interface StrideBase {
  readonly prefab: string;
  readonly part: string;
  readonly instance: string;
}

/** 转好的预制体：实体（实例已经转成引用），和它的实体在 Stride 里的 id → 转好以后的 id（嵌套实例的成员换了名）。 */
export interface ConvertedPrefab {
  readonly entities: readonly SceneEntityFile[];
  readonly renamed: ReadonlyMap<string, string>;
}

type Override = NonNullable<NonNullable<SceneEntityFile['prefab']>['set']>[number];

/**
 * 把展开着的实体列表（Stride 的 id）里的实例转成引用。返回转好的实体、Stride 的 id → 新 id，和没转成的原因（有原因时
 * 实体原样返回）。
 */
export function convertInstances(
  files: readonly SceneEntityFile[],
  bases: ReadonlyMap<string, StrideBase>,
  prefabs: ReadonlyMap<string, ConvertedPrefab>,
): { entities: readonly SceneEntityFile[]; renamed: ReadonlyMap<string, string>; failure?: string } {
  if (bases.size === 0) return { entities: files, renamed: new Map() };
  const byId = new Map(files.map((file) => [file.id, file]));
  const raw = new Map([...prefabs].map(([path, prefab]) => [path, prefab.entities]));
  const keep = (failure: string) => ({ entities: files, renamed: new Map<string, string>(), failure });
  const expansions = new Map<string, readonly SceneEntityFile[]>();
  const expand = (path: string) => expansions.get(path) ?? expansions.set(path, expandPrefabInstances(prefabs.get(path)!.entities, raw, () => {})).get(path)!;

  // 每个实例：成员，按根分开。Base 指着预制体里已经没有的实体时（预制体后来删了它，Stride 的场景文件里还留着；资源编译器
  // 照样把它放进游戏）当普通实体
  const groups = new Map<string, string[]>();
  for (const [id, base] of bases) {
    const prefab = prefabs.get(base.prefab);
    if (!prefab) return keep(`prefab ${base.prefab} was not converted`);
    const part = prefab.renamed.get(base.part) ?? base.part;
    if (!expand(base.prefab).some((entity) => entity.id === part)) continue;
    groups.set(base.instance, [...(groups.get(base.instance) ?? []), id]);
  }
  const rename = new Map<string, string>();
  const instances: { root: SceneEntityFile; prefab: string; rootPart: string; multipleRoots: boolean; members: string[] }[] = [];
  for (const ids of groups.values()) {
    const inGroup = new Set(ids);
    const path = bases.get(ids[0]!)!.prefab;
    const prefab = prefabs.get(path)!;
    if (ids.some((id) => bases.get(id)!.prefab !== path)) return keep(`instance ${bases.get(ids[0]!)!.instance} mixes prefabs`);
    const expanded = expand(path);
    const roots = ids.filter((id) => !inGroup.has(byId.get(id)?.parent ?? ''));
    for (const root of roots) {
      const partOf = (id: string) => prefab.renamed.get(bases.get(id)!.part) ?? bases.get(id)!.part;
      const rootPart = partOf(root);
      if (!expanded.some((entity) => entity.id === rootPart && entity.parent === null)) return keep(`entity ${root} is based on ${rootPart}, which is not a root of prefab ${path}`);
      const members = ids.filter((id) => {
        for (let current: string | null = id; current !== null && inGroup.has(current); current = byId.get(current)?.parent ?? null) if (current === root) return true;
        return false;
      });
      for (const id of members) rename.set(id, id === root ? root : memberId(root, partOf(id)));
      instances.push({ root: byId.get(root)!, prefab: path, rootPart, multipleRoots: expanded.filter((entity) => entity.parent === null).length > 1, members });
    }
  }
  const renameId = (id: string | null) => (id === null ? null : rename.get(id) ?? id);
  // 原来展开着的场景换成新 id（核对用）
  const flattened = files.map((file) => ({ ...renameReferences(file, renameId), id: renameId(file.id)!, parent: renameId(file.parent) }));
  const flattenedById = new Map(flattened.map((file) => [file.id, file]));

  const memberIds = new Set(instances.flatMap((instance) => instance.members));
  const converted: SceneEntityFile[] = [];
  for (const file of files) {
    const instance = instances.find((candidate) => candidate.root.id === file.id);
    if (instance) converted.push(instanceEntity(instance, flattenedById, raw, renameId));
    else if (!memberIds.has(file.id)) converted.push(flattenedById.get(renameId(file.id)!)!);
  }

  // 核对：再展开一遍要和原来的一样
  const check = expandPrefabInstances(converted, raw, () => {});
  if (check.length !== flattened.length) return keep(`expanding the converted scene gives ${check.length} entities instead of ${flattened.length}`);
  for (const entity of check) {
    const expected = flattenedById.get(entity.id);
    if (!expected) return keep(`expanding the converted scene gives an extra entity ${entity.id}`);
    if (!sameValue(entity, expected)) return keep(`entity ${entity.id} differs after expanding the converted scene`);
  }
  return { entities: converted, renamed: rename };
}

/** 一个实例实体：身份和摆放照场景里的根，和展开预制体得到的比出覆盖（set）和去掉的成员（removed）。 */
function instanceEntity(
  instance: { root: SceneEntityFile; prefab: string; rootPart: string; multipleRoots: boolean; members: string[] },
  flattenedById: ReadonlyMap<string, SceneEntityFile>,
  prefabs: ReadonlyMap<string, readonly SceneEntityFile[]>,
  renameId: (id: string | null) => string | null,
): SceneEntityFile {
  const root = flattenedById.get(instance.root.id)!;
  const stub: SceneEntityFile = {
    id: root.id, name: root.name, parent: root.parent, position: root.position, rotation: root.rotation, scale: root.scale, components: {},
    prefab: { path: instance.prefab, ...(instance.multipleRoots ? { root: instance.rootPart } : {}) },
  };
  const expected = expandPrefabInstances([stub], prefabs, () => {});
  const actual = new Map(instance.members.map((id) => [renameId(id)!, flattenedById.get(renameId(id)!)!]));
  const partOf = (id: string) => (id === root.id ? instance.rootPart : id.slice(root.id.length + 1));
  const set: Override[] = [];
  const removed: string[] = [];
  for (const entity of expected) {
    const real = actual.get(entity.id);
    if (!real) {
      // 父成员也去掉了的不用再写（去掉的连后代）
      if (entity.parent === null || actual.has(entity.parent) || entity.parent === root.id) removed.push(partOf(entity.id));
      continue;
    }
    const ignore = entity.id === root.id ? ['id', 'name', 'parent', 'position', 'rotation', 'scale'] : ['id'];
    diff(entity, real, [], ignore, (path, value) => set.push({ entity: partOf(entity.id), path, value }));
  }
  return { ...stub, prefab: { ...stub.prefab!, ...(set.length > 0 ? { set } : {}), ...(removed.length > 0 ? { removed } : {}) } };
}

/** expected 和 actual 不同的地方，按 set 的路径报出来；对象里去掉了键、脚本的种类变了时整个设。 */
function diff(expected: unknown, actual: unknown, path: (string | number)[], ignore: readonly string[], report: (path: (string | number)[], value: unknown) => void): void {
  if (sameValue(expected, actual)) return;
  const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (isObject(expected) && isObject(actual)) {
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)].filter((key) => path.length > 0 || !ignore.includes(key)));
    // 去掉了键：JSON 里写不出 undefined，整个对象设成新的
    if ([...keys].some((key) => expected[key] !== undefined && actual[key] === undefined)) return report(path, actual);
    for (const key of keys) diff(expected[key], actual[key], [...path, key], ignore, report);
    return;
  }
  // 脚本列表：同样的种类、同样的顺序时按类型名逐个比（覆盖的路径里脚本按类型名指）
  if (path.at(-1) === 'scripts' && Array.isArray(expected) && Array.isArray(actual)) {
    const types = (list: unknown[]) => list.map((script) => (script as { type: string }).type);
    if (sameValue(types(expected), types(actual))) {
      expected.forEach((script, i) => diff(script, actual[i], [...path, (script as { type: string }).type], ignore, report));
      return;
    }
  }
  report(path, actual);
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keysA = Object.keys(a).filter((key) => (a as Record<string, unknown>)[key] !== undefined);
  const keysB = Object.keys(b).filter((key) => (b as Record<string, unknown>)[key] !== undefined);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((key) => sameValue((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}
