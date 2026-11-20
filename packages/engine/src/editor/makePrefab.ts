/**
 * 编辑器里"做成预制体"：把场景里的一个实体连同后代存成预制体文件，场景里原地换成这个预制体的实例（docs/prefabs.md 的写法：
 * 引用加差异）。纯函数，只读文件、给出预制体的内容和对场景的一个修改（一步撤销）；写文件在界面那边（editor 包的 session.ts）。
 *
 * - 预制体里的实体照原样（id、组件、子实体的本地变换不变），根的父实体去掉、变换归零：实例的位置、旋转、缩放、名字是实例
 *   自己的（不算覆盖），所以放进场景以后和原来一样，脚本 instantiate 出来的在原点。
 * - 实例用根原来的 id（场景里指向根的引用不用改），放在根原来的位置；指向原来的后代的引用（约束、link、天空的太阳、脚本的
 *   `$entity`）改成实例成员的 id `<根>/<后代>`。
 * - 只做场景文档里的普通实体：预制体的实例、实例的成员不行（实例已经是引用了；成员要先在预制体里改）。
 */
import type { PrefabFile, SceneEntityFile } from '../content/format';
import { renameReferences } from '../content/prefabInstances';
import type { EntitiesFile, SceneEdit } from './SceneDocument';

export interface MadePrefab {
  readonly prefab: PrefabFile;
  /** 删掉子树、原地加上实例、改写指向后代的引用。 */
  readonly edit: SceneEdit;
}

/** rootId 是文档里的一个普通实体；prefabPath 是新预制体的内容路径。 */
export function makePrefab(file: EntitiesFile, rootId: string, prefabPath: string): MadePrefab {
  const index = file.entities.findIndex((entity) => entity.id === rootId);
  const root = file.entities[index];
  if (!root) throw new Error(`make prefab: ${rootId} is not an entity of this document (members of a prefab instance are edited in the prefab)`);
  if (root.prefab) throw new Error(`make prefab: ${root.name} is already an instance of ${root.prefab.path}`);

  // 子树：父实体在子树里，或者父实体是子树里某个实例的成员（`<实例>/…`）。文件里父实体排在前面，扫一遍就全了
  const inSubtree = new Set([rootId]);
  const owner = (id: string) => id.split('/')[0]!;
  for (const entity of file.entities.slice(index + 1)) {
    if (entity.parent !== null && inSubtree.has(owner(entity.parent))) inSubtree.add(entity.id);
  }
  const subtree = file.entities.filter((entity) => inSubtree.has(entity.id));

  const prefabEntities = subtree.map((entity): SceneEntityFile => (entity.id === rootId
    ? { ...entity, parent: null, position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }
    : entity));
  const instance: SceneEntityFile = {
    id: root.id, name: root.name, parent: root.parent, position: root.position, rotation: root.rotation, scale: root.scale,
    components: {}, prefab: { path: prefabPath },
  };

  // 子树外面指向后代的引用：后代成了实例的成员
  const rename = (id: string | null) => (id !== null && id !== rootId && inSubtree.has(owner(id)) ? `${rootId}/${id}` : id);
  const sets: SceneEdit[] = [];
  for (const entity of file.entities) {
    if (inSubtree.has(entity.id)) continue;
    const renamed = renameReferences(entity, rename);
    for (const key of Object.keys(renamed.components) as (keyof SceneEntityFile['components'])[]) {
      const before = entity.components[key], after = renamed.components[key];
      if (JSON.stringify(before) !== JSON.stringify(after)) sets.push({ type: 'set', entity: entity.id, path: ['components', key], value: after });
    }
  }

  const name = prefabPath.slice(prefabPath.lastIndexOf('/') + 1);
  return {
    prefab: { name, entities: prefabEntities },
    edit: { type: 'batch', edits: [{ type: 'remove', entities: subtree.map((entity) => entity.id) }, { type: 'add', entities: [{ entity: instance, index }] }, ...sets] },
  };
}
