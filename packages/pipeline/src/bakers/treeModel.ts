/**
 * 树的烘焙（引擎 content/formats/treeFormat.ts 的 TreeFile）：生长在引擎的 modeling/tree.ts，这里写成普通的模型（量化加 meshopt），
 * 场景、摆放照常引用。编辑器后端在树的文件存下、或者在磁盘上改了以后调它。
 */
import { encodeModel, type TreeFile } from '@stride-ts/engine/content-format';
import { treeMeshes } from '@stride-ts/engine/modeling';
import type { StrideTools } from '@stride-ts/native/tools';
import { compressMeshes, type SourceMesh } from '../mesh.ts';

/** 烘成模型文件的字节（.model）。参数不对时报错。 */
export function bakeTreeModel(tools: StrideTools, file: TreeFile, where = file.name): Uint8Array {
  const meshes: SourceMesh[] = treeMeshes(file, where).map((slot) => ({ name: slot.material === 0 ? 'bark' : 'leaves', material: slot.material, vertices: slot.vertices, indices: slot.indices }));
  if (meshes.length === 0) throw new Error(`${where}: the tree produced no geometry`);
  return encodeModel({ meshes: compressMeshes(meshes, tools), materials: [file.materials[0] ?? null, file.materials[1] ?? null] });
}
