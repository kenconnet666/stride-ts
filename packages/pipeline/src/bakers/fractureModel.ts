/**
 * 可破碎物体的碎块的烘焙（引擎 content/formats/fractureFormat.ts 的 FractureFile）：读完整的模型、解开（运行时原生模块的
 * meshopt 解码），所有网格合在一起交给原生工具模块按 Voronoi 切（`fractureMesh`），再按块、按材质分网格、补法线和 UV（引擎
 * modeling/fracture.ts），写成同名的模型（量化加 meshopt）。材质槽是原模型的槽，断面的材质另加在最后。
 */
import { decodeModelMeshes, encodeModel, EXTENSIONS, FRACTURE, meshFloatVertices, readModelFile, VERTEX_FLOATS, type FractureFile } from '@stride-ts/engine/content-format';
import { fracturePieceMeshes } from '@stride-ts/engine/modeling';
import type { StrideTools } from '@stride-ts/native/tools';
import { compressMeshes } from '../mesh.ts';
import { runtimeNative } from './settle.ts';

/** 烘成碎块模型的字节（.model）。原模型读不到、没有体积时报错。 */
export async function bakeFracture(tools: StrideTools, input: FractureFile, readContent: (path: string) => Promise<Uint8Array>, where = input.name): Promise<Uint8Array> {
  const file = FRACTURE.parse(input, where);
  let bytes: Uint8Array;
  try {
    bytes = await readContent(file.model + EXTENSIONS.model);
  } catch (error) {
    throw new Error(`${where}: cannot read the model ${file.model}: ${(error as Error).message}`, { cause: error });
  }
  const model = readModelFile(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, `${where}: ${file.model}`);
  const native = await runtimeNative();
  const decoded = await decodeModelMeshes(model.meshes, (requests) => native.decodeMeshoptBatch(requests), `${where}: ${file.model}`);
  const source = decoded.map((mesh, i) => ({ material: model.meshes[i]!.material, vertices: meshFloatVertices(mesh), indices: mesh.indices }));

  // 合成一份位置和索引给原生切
  const vertexCount = source.reduce((sum, mesh) => sum + mesh.vertices.length / VERTEX_FLOATS, 0);
  const positions = new Float32Array(vertexCount * 3);
  const indices = new Uint32Array(source.reduce((sum, mesh) => sum + mesh.indices.length, 0));
  let base = 0, at = 0;
  for (const mesh of source) {
    const count = mesh.vertices.length / VERTEX_FLOATS;
    for (let v = 0; v < count; v++) positions.set(mesh.vertices.subarray(v * VERTEX_FLOATS, v * VERTEX_FLOATS + 3), (base + v) * 3);
    for (let i = 0; i < mesh.indices.length; i++) indices[at++] = base + mesh.indices[i]!;
    base += count;
  }
  let cut;
  try {
    cut = await tools.fractureMesh({ positions, indices }, file.count, file.seed);
  } catch (error) {
    throw new Error(`${where}: ${(error as Error).message}`, { cause: error });
  }

  const materials: (string | null)[] = model.materials.length > 0 ? [...model.materials] : [null];
  const interiorSlot = file.interiorMaterial ? materials.push(file.interiorMaterial) - 1 : (model.meshes[0]?.material ?? 0);
  const meshes = fracturePieceMeshes(source, cut, interiorSlot, file.uvScale);
  return encodeModel({ meshes: compressMeshes(meshes, tools), materials });
}
