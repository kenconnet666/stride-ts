/**
 * 多边形网格的烘焙（引擎 content/assetFormat.ts 的 PolyMeshFile）：几何（镜像、三角化、按光滑角的法线、自动 UV）在引擎的
 * modeling/polyMesh.ts，这里写成普通的模型（量化加 meshopt），场景照常引用。编辑器后端在多边形网格存下、或者在磁盘上改了以后
 * 调它（server/EditorBackend.ts）。
 */
import { encodeModel, type PolyMeshFile } from '@stride-ts/engine/content-format';
import { polyMeshSlots } from '@stride-ts/engine/modeling';
import type { StrideTools } from '@stride-ts/native/tools';
import { compressMeshes, type SourceMesh } from './mesh.ts';

/** 烘成模型文件的字节（.model）。面的材质槽、顶点下标不对时报错，消息里有是第几个面。 */
export function bakePolyModel(tools: StrideTools, file: PolyMeshFile, where = file.name): Uint8Array {
  if (file.faces.length === 0) throw new Error(`${where}: a poly mesh needs at least one face`);
  const meshes: SourceMesh[] = polyMeshSlots(file, where).map((slot) => ({ name: `slot${slot.material}`, material: slot.material, vertices: slot.vertices, indices: slot.indices }));
  return encodeModel({ meshes: compressMeshes(meshes, tools), materials: file.materials.length > 0 ? file.materials : [null] });
}
