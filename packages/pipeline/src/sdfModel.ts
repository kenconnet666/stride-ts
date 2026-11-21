/**
 * SDF 建模的烘焙（引擎 content/assetFormat.ts 的 SdfFile）：形状按顺序平滑合成，原生工具模块网格化（`sdfMesh`，Manifold 的等值面），
 * 结果按每个三角形所属形状的材质槽分成网格，法线是距离场的梯度（光滑，融合处也是圆的），UV 按顶点法线最大的分量投影世界坐标
 * （uvScale 米一个周期）。写成普通的模型（量化加 meshopt），场景照常引用。
 *
 * 编辑器后端在 SDF 文件存下、或者在磁盘上改了以后调它（server/EditorBackend.ts）。按法线投影的 UV 在投影方向换的地方有接缝、
 * 斜面上有拉伸：贴纯色、噪声这类材质够用，要画贴图时先展 UV（以后做）。
 */
import { encodeModel, VERTEX_FLOATS, type SdfFile, type SdfShapeFile } from '@stride-ts/engine/content-format';
import type { SdfShape, StrideTools } from '@stride-ts/native/tools';
import { compressMeshes, type SourceMesh } from './mesh.ts';
import { projectUv } from '@stride-ts/engine/modeling';
import { rigidTransform } from './brushModel.ts';

/** 没写 resolution 时网格的边长（米）。 */
export const DEFAULT_SDF_RESOLUTION = 0.05;

/** 烘成模型文件的字节（.model）。形状的参数不对、什么也没留下时报错，消息里有是第几个形状。 */
export async function bakeSdfModel(tools: StrideTools, file: SdfFile, where = file.name): Promise<Uint8Array> {
  if (file.shapes.length === 0) throw new Error(`${where}: an SDF model needs at least one shape`);
  const slots = Math.max(1, file.materials.length);
  file.shapes.forEach((shape, i) => {
    const slot = shape.material ?? 0;
    if (!Number.isInteger(slot) || slot < 0 || slot >= slots) throw new Error(`${where}: shape ${i} uses material slot ${slot}, but there ${slots === 1 ? 'is 1 slot' : `are ${slots} slots`}`);
  });
  let solid;
  try {
    solid = await tools.sdfMesh(file.shapes.map(nativeShape), file.resolution ?? DEFAULT_SDF_RESOLUTION);
  } catch (error) {
    throw new Error(`${where}: ${(error as Error).message}`, { cause: error });
  }

  const uvScale = file.uvScale ?? 1;
  const { positions, normals, indices, shapeOfTriangle } = solid;
  // 每个材质槽一个网格；同一个原生顶点在一个槽里只出一次（光滑的法线，不按面拆）
  const builders = Array.from({ length: slots }, () => ({ vertices: [] as number[], indices: [] as number[], remap: new Map<number, number>() }));
  const position = [0, 0, 0], normal = [0, 0, 0];
  for (let t = 0; t < indices.length / 3; t++) {
    const builder = builders[file.shapes[shapeOfTriangle[t]!]!.material ?? 0]!;
    for (let c = 0; c < 3; c++) {
      const source = indices[t * 3 + c]!;
      let vertex = builder.remap.get(source);
      if (vertex === undefined) {
        vertex = builder.vertices.length / VERTEX_FLOATS;
        builder.remap.set(source, vertex);
        for (let k = 0; k < 3; k++) {
          position[k] = positions[source * 3 + k]!;
          normal[k] = normals[source * 3 + k]!;
        }
        builder.vertices.push(...position, ...normal, ...projectUv(position, normal, uvScale));
      }
      builder.indices.push(vertex);
    }
  }
  const resolution = file.resolution ?? DEFAULT_SDF_RESOLUTION;
  const meshes: SourceMesh[] = builders.flatMap((builder, slot) => (builder.indices.length === 0 ? [] : [{
    name: `slot${slot}`, material: slot, ...simplify(tools, Float32Array.from(builder.vertices), Uint32Array.from(builder.indices), resolution),
  }]));
  return encodeModel({ meshes: compressMeshes(meshes, tools), materials: file.materials.length > 0 ? file.materials : [null] });
}

/**
 * 等值面出的三角形大小均匀，平的地方也一样密：按几何误差简化（meshoptimizer 的边折叠，只删三角形、留下的顶点和光滑法线不变；
 * 网格的开口边——材质槽之间的接缝——锁住不动，不会裂开），误差不超过网格边长的三成，再去掉没用到的顶点。
 */
function simplify(tools: StrideTools, vertices: Float32Array, indices: Uint32Array, resolution: number): { vertices: Float32Array; indices: Uint32Array } {
  const count = vertices.length / VERTEX_FLOATS;
  const positions = new Float32Array(count * 3);
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let v = 0; v < count; v++) {
    for (let k = 0; k < 3; k++) {
      const p = vertices[v * VERTEX_FLOATS + k]!;
      positions[v * 3 + k] = p;
      min[k] = Math.min(min[k]!, p);
      max[k] = Math.max(max[k]!, p);
    }
  }
  // meshoptimizer 的误差是相对网格大小的
  const extent = Math.max(max[0]! - min[0]!, max[1]! - min[1]!, max[2]! - min[2]!, 1e-6);
  const simplified = tools.simplifyMesh(indices, positions, 0, (resolution * 0.3) / extent).indices;
  const remap = new Int32Array(count).fill(-1);
  const kept: number[] = [];
  const out = new Uint32Array(simplified.length);
  simplified.forEach((index, i) => {
    if (remap[index] === -1) {
      remap[index] = kept.length;
      kept.push(index);
    }
    out[i] = remap[index]!;
  });
  const compact = new Float32Array(kept.length * VERTEX_FLOATS);
  kept.forEach((source, v) => compact.set(vertices.subarray(source * VERTEX_FLOATS, (source + 1) * VERTEX_FLOATS), v * VERTEX_FLOATS));
  return { vertices: compact, indices: out };
}

/** 文件里的形状换成原生的：尺寸换成半长，位置和旋转合成列主序的矩阵。 */
function nativeShape(shape: SdfShapeFile): SdfShape {
  const base = { operation: shape.operation, smoothness: shape.smoothness ?? 0, transform: rigidTransform(shape.position, shape.rotation) };
  switch (shape.kind) {
    case 'sphere': return { ...base, kind: 'sphere', radius: shape.radius };
    case 'box': return { ...base, kind: 'box', halfSize: [shape.size[0] / 2, shape.size[1] / 2, shape.size[2] / 2], cornerRadius: shape.cornerRadius ?? 0 };
    case 'capsule': return { ...base, kind: 'capsule', halfHeight: shape.height / 2, radius: shape.radius };
    case 'cylinder': return { ...base, kind: 'cylinder', halfHeight: shape.height / 2, radius: shape.radius, edgeRadius: shape.edgeRadius ?? 0 };
    case 'torus': return { ...base, kind: 'torus', ringRadius: shape.ringRadius, tubeRadius: shape.tubeRadius };
    case 'ellipsoid': return { ...base, kind: 'ellipsoid', radii: shape.radii };
  }
}
