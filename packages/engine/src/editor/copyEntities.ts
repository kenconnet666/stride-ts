/**
 * 编辑器里复制、粘贴、复制一份实体（docs/decisions.md 2026-11-20 的"复制粘贴实体"）：
 *
 * - 复制的是选中的实体连同后代（选中的实体里有祖孙关系时只算最上面的）。文档里的实体照文件里的样子拷（预制体的实例还是
 *   引用加覆盖，成员粘贴后由预制体展开出来）；选中的是实例的成员时，拷展开以后的样子（成了普通实体，和预制体断开）。
 * - 粘贴时每个实体换新 id；拷的实体之间的引用（父实体、约束、link、脚本的 `$entity`，实例成员的 `<实例>/…`）跟着换成
 *   新的，指向拷贝以外的照旧指原来的实体。名字、本地的变换不变。
 *
 * 纯函数，只读文件、给出修改；剪贴板放在界面那边（editor 包的 session.ts）。
 */
import type { SceneEntityFile } from '../content/format';
import { expandPrefabInstances, renameReferences } from '../content/prefabInstances';
import { SceneDocument, type EntitiesFile, type SceneEdit } from './SceneDocument';

type Entities = readonly SceneEntityFile[];

/** 粘贴到哪：parent（null 是最上层）的子实体里的第 position 个，按文档里的兄弟数（实例的成员不算），超出是最后。 */
export interface PasteTarget {
  readonly parent: string | null;
  readonly position: number;
}

/** 复制：ids 是展开的场景里的实体（可以是实例的成员）。返回的实体父实体在前、每棵子树连着，根保留原来的父实体。 */
export function copyEntities(file: EntitiesFile, prefabs: ReadonlyMap<string, Entities>, ids: readonly string[]): SceneEntityFile[] {
  const expanded = expand(file, prefabs);
  const children = new Map<string | null, SceneEntityFile[]>();
  for (const entity of expanded) children.set(entity.parent, [...(children.get(entity.parent) ?? []), entity]);
  const inDocument = new Map(file.entities.map((entity) => [entity.id, entity]));
  const copied: SceneEntityFile[] = [];
  // 深度优先：父实体在前、子树连着。拷了引用的实例，它的成员由预制体展开出来，不拷；挂在成员下面的文档实体照样拷
  const visit = (entity: SceneEntityFile, referenced: boolean) => {
    const own = inDocument.get(entity.id);
    if (own) copied.push(own);
    else if (!referenced) copied.push(entity);
    for (const child of children.get(entity.id) ?? []) visit(child, own ? own.prefab !== undefined : referenced);
  };
  for (const root of topmost(expanded, ids)) visit(root, false);
  return copied;
}

/**
 * 粘贴 copied（copyEntities 的结果）到 target：一个 add 修改，和新的根的 id（按 copied 里的顺序）。target.parent 可以是
 * 实例的成员；文档里没有它（也不是文档里的实例的成员）时报错。
 */
export function pasteEntities(file: EntitiesFile, copied: Entities, target: PasteTarget, newId: () => string = () => crypto.randomUUID()): { edit: SceneEdit; roots: string[] } {
  const ids = new Map(copied.map((entity) => [entity.id, newId()]));
  const instances = copied.filter((entity) => entity.prefab);
  const rename = (id: string | null): string | null => {
    if (id === null) return null;
    const renamed = ids.get(id);
    if (renamed !== undefined) return renamed;
    const instance = instances.find((entity) => id.startsWith(`${entity.id}/`));
    return instance ? `${ids.get(instance.id)}${id.slice(instance.id.length)}` : id;
  };
  const isRoot = copied.map((entity) => entity.parent === null || !inside(entity.parent, ids, instances));
  const pasted = copied.map((entity, i): SceneEntityFile => {
    const renamed: SceneEntityFile = { ...renameReferences(entity, rename), id: rename(entity.id)!, parent: isRoot[i] ? target.parent : rename(entity.parent) };
    if (!entity.prefab?.set) return renamed;
    // 覆盖的值是展开以后的值，里面对场景实体的引用也跟着换（名字不是引用）
    const set = entity.prefab.set.map((override) => (override.path[0] === 'name' ? override : { ...override, value: renameIds(override.value, rename) }));
    return { ...renamed, prefab: { ...entity.prefab, set } };
  });
  const roots = pasted.filter((_, i) => isRoot[i]).map((entity) => entity.id);
  return { edit: new SceneDocument(file).addSubtrees(pasted, target.position), roots };
}

/**
 * 复制一份（Ctrl+D）：每个选中的（最上面的）实体拷一份，放在原来的那个后面、同一个父实体下（原来的是实例的成员时，拷贝
 * 是挂在成员的父实体下的普通实体）。一个修改，和新的根的 id。
 */
export function duplicateEntities(file: EntitiesFile, prefabs: ReadonlyMap<string, Entities>, ids: readonly string[], newId?: () => string): { edit: SceneEdit; roots: string[] } {
  const scratch = new SceneDocument(file);
  const edits: SceneEdit[] = [];
  const roots: string[] = [];
  for (const root of topmost(expand(file, prefabs), ids)) {
    const pasted = pasteEntities(scratch.file, copyEntities(file, prefabs, [root.id]), { parent: root.parent, position: positionAfter(scratch.file, root) }, newId);
    scratch.apply(pasted.edit);
    edits.push(pasted.edit);
    roots.push(...pasted.roots);
  }
  return { edit: edits.length === 1 ? edits[0]! : { type: 'batch', edits }, roots };
}

/** 紧跟在 entity 后面是它父实体的文档子实体里的第几个；它是实例的成员（不在文档里）时排在文档子实体的最前面。 */
export function positionAfter(file: EntitiesFile, entity: Pick<SceneEntityFile, 'id' | 'parent'>): number {
  const siblings = file.entities.filter((candidate) => candidate.parent === entity.parent);
  return siblings.findIndex((candidate) => candidate.id === entity.id) + 1;
}

function expand(file: EntitiesFile, prefabs: ReadonlyMap<string, Entities>): Entities {
  return expandPrefabInstances(file.entities, prefabs, () => {});
}

/** ids 里最上面的那些（祖先也选中了的不算），按展开的场景里的顺序；不存在的 id 报错。 */
function topmost(expanded: Entities, ids: readonly string[]): SceneEntityFile[] {
  const selected = new Set(ids);
  const byId = new Map(expanded.map((entity) => [entity.id, entity]));
  for (const id of selected) if (!byId.has(id)) throw new Error(`no entity ${id} to copy`);
  const hasSelectedAncestor = (entity: SceneEntityFile): boolean => {
    for (let parent = entity.parent; parent !== null; parent = byId.get(parent)?.parent ?? null) if (selected.has(parent)) return true;
    return false;
  };
  return expanded.filter((entity) => selected.has(entity.id) && !hasSelectedAncestor(entity));
}

/** parent 在拷贝里：是拷的实体，或者是拷的实例的成员。 */
function inside(parent: string, ids: ReadonlyMap<string, string>, instances: Entities): boolean {
  return ids.has(parent) || instances.some((instance) => parent.startsWith(`${instance.id}/`));
}

/** JSON 值里对实体的引用（字符串，或者 `{ $entity }`）照 rename 换掉。 */
function renameIds(value: unknown, rename: (id: string) => string | null): unknown {
  if (typeof value === 'string') return rename(value);
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => renameIds(item, rename));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, renameIds(item, rename)]));
}
