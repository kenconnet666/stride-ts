/**
 * 建筑的烘焙（引擎 content/formats/buildingFormat.ts 的 BuildingFile）：生成在引擎的 modeling/building.ts，这里写成普通的模型（量化加
 * meshopt），场景照常引用。编辑器后端在建筑的文件存下、或者在磁盘上改了以后调它。
 */
import { BUILDING_SLOTS, encodeModel, type BuildingFile } from '@stride-ts/engine/content-format';
import { buildingMeshes } from '@stride-ts/engine/modeling';
import type { StrideTools } from '@stride-ts/native/tools';
import { compressMeshes, type SourceMesh } from './mesh.ts';

/** 默认的四个材质槽的网格名（多出来的槽叫 slot<i>）。 */
const SLOT_NAMES = ['wall', 'glass', 'frame', 'roof'];

/** 烘成模型文件的字节（.model）。规则不对时报错。 */
export function bakeBuildingModel(tools: StrideTools, file: BuildingFile, where = file.name): Uint8Array {
  const meshes: SourceMesh[] = buildingMeshes(file, where).map((slot) => ({ name: SLOT_NAMES[slot.material] ?? `slot${slot.material}`, material: slot.material, vertices: slot.vertices, indices: slot.indices }));
  if (meshes.length === 0) throw new Error(`${where}: the building produced no geometry`);
  const slots = Math.max(BUILDING_SLOTS, file.materials.length, ...meshes.map((mesh) => (mesh.material ?? 0) + 1));
  return encodeModel({ meshes: compressMeshes(meshes, tools), materials: Array.from({ length: slots }, (_, i) => file.materials[i] ?? null) });
}
