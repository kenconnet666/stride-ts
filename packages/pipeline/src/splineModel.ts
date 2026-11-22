/**
 * 样条的烘焙（引擎 content/formats/splineFormat.ts 的 SplineFile）：几何（路径采样、拉伸、摆立柱和电杆、挂导线）在引擎的
 * modeling/spline.ts，这里写成普通的模型（量化加 meshopt），场景照常引用。编辑器后端在样条存下、或者在磁盘上改了以后调它。
 */
import { encodeModel, type SplineFile } from '@stride-ts/engine/content-format';
import { checkSpline, splineMeshes } from '@stride-ts/engine/modeling';
import type { StrideTools } from '@stride-ts/native/tools';
import { compressMeshes, type SourceMesh } from './mesh.ts';

/** 烘成模型文件的字节（.model）；河道（river）没有几何，是 undefined。控制点、横截面不对时报错。 */
export function bakeSplineModel(tools: StrideTools, file: SplineFile, where = file.name): Uint8Array | undefined {
  if (file.profile.type === 'river') {
    checkSpline(file, where);
    return undefined;
  }
  const meshes: SourceMesh[] = splineMeshes(file, where).map((slot) => ({ name: `slot${slot.material}`, material: slot.material, vertices: slot.vertices, indices: slot.indices }));
  if (meshes.length === 0) throw new Error(`${where}: the spline produced no geometry`);
  return encodeModel({ meshes: compressMeshes(meshes, tools), materials: file.materials.length > 0 ? file.materials : [null] });
}
