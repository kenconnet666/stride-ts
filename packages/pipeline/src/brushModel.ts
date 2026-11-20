/**
 * 关卡白盒的烘焙（引擎 content/assetFormat.ts 的 BrushFile）：笔刷按顺序加、减、求交（原生工具模块的 Manifold，`brushCsg`），
 * 结果按笔刷的材质槽分成网格，平直的法线（白盒的硬边），UV 按面的朝向投影世界坐标（uvScale 米一个周期：贴网格图时相邻的面、
 * 不同的笔刷都接得上，同虚幻 CubeGrid 的默认 UV），同一平面上位置相同的顶点合并。写成普通的模型（量化加 meshopt），场景照常引用。
 *
 * 编辑器后端在白盒文件存下、或者在磁盘上改了以后调它（server/EditorBackend.ts）。法线贴图要的切线不生成：白盒的材质用颜色、
 * 网格图就够，要细节时导出成可编辑的网格再做。
 */
import { encodeModel, VERTEX_FLOATS, type BrushFile, type BrushShapeFile } from '@stride-ts/engine/content-format';
import type { Brush, StrideTools } from '@stride-ts/native/tools';
import { compressMeshes, type SourceMesh } from './mesh.ts';

/** 圆柱、球没写分段数时用的。 */
const DEFAULT_SEGMENTS = 32;

/** 烘成模型文件的字节（.model）。笔刷的参数不对、合不成实体时报错，消息里有是第几个笔刷。 */
export async function bakeBrushModel(tools: StrideTools, file: BrushFile, where = file.name): Promise<Uint8Array> {
  if (file.brushes.length === 0) throw new Error(`${where}: a greybox needs at least one brush`);
  const slots = Math.max(1, file.materials.length);
  file.brushes.forEach((brush, i) => {
    const slot = brush.material ?? 0;
    if (!Number.isInteger(slot) || slot < 0 || slot >= slots) throw new Error(`${where}: brush ${i} uses material slot ${slot}, but there ${slots === 1 ? 'is 1 slot' : `are ${slots} slots`}`);
  });
  let solid;
  try {
    solid = await tools.brushCsg(file.brushes.map(nativeBrush));
  } catch (error) {
    throw new Error(`${where}: ${(error as Error).message}`, { cause: error });
  }
  if (solid.indices.length === 0) throw new Error(`${where}: the brushes leave nothing (everything is subtracted)`);

  const uvScale = file.uvScale ?? 1;
  const builders = Array.from({ length: slots }, () => ({ vertices: [] as number[], indices: [] as number[], weld: new Map<string, number>() }));
  const { positions, indices, brushOfTriangle } = solid;
  const corner = [0, 0, 0], a = [0, 0, 0], b = [0, 0, 0];
  for (let t = 0; t < indices.length / 3; t++) {
    const builder = builders[file.brushes[brushOfTriangle[t]!]!.material ?? 0]!;
    const i0 = indices[t * 3]! * 3, i1 = indices[t * 3 + 1]! * 3, i2 = indices[t * 3 + 2]! * 3;
    for (let k = 0; k < 3; k++) {
      a[k] = positions[i1 + k]! - positions[i0 + k]!;
      b[k] = positions[i2 + k]! - positions[i0 + k]!;
    }
    const normal = [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
    const length = Math.hypot(normal[0]!, normal[1]!, normal[2]!);
    // 退化的三角形（布尔运算偶尔留下的细缝）不要
    if (length < 1e-12) continue;
    for (let k = 0; k < 3; k++) normal[k]! /= length;
    for (const index of [i0, i1, i2]) {
      for (let k = 0; k < 3; k++) corner[k] = positions[index + k]!;
      const key = `${corner.map((v) => Math.round(v * 1e5)).join(',')}|${normal.map((v) => Math.round(v * 1e4)).join(',')}`;
      let vertex = builder.weld.get(key);
      if (vertex === undefined) {
        vertex = builder.vertices.length / VERTEX_FLOATS;
        builder.weld.set(key, vertex);
        builder.vertices.push(corner[0]!, corner[1]!, corner[2]!, normal[0]!, normal[1]!, normal[2]!, ...projectUv(corner, normal, uvScale));
      }
      builder.indices.push(vertex);
    }
  }
  const meshes: SourceMesh[] = builders.flatMap((builder, slot) => (builder.indices.length === 0 ? [] : [{
    name: `slot${slot}`, material: slot, vertices: Float32Array.from(builder.vertices), indices: Uint32Array.from(builder.indices),
  }]));
  return encodeModel({ meshes: compressMeshes(meshes, tools), materials: file.materials.length > 0 ? file.materials : [null] });
}

/** 按法线最大的分量选投影面：朝 ±X 的面用 (z, y)、±Y 用 (x, z)、±Z 用 (x, y)，翻过来的面镜像，贴图在每个面上都是正的。 */
function projectUv([x, y, z]: readonly number[], [nx, ny, nz]: readonly number[], scale: number): [number, number] {
  const ax = Math.abs(nx!), ay = Math.abs(ny!), az = Math.abs(nz!);
  if (ax >= ay && ax >= az) return [(nx! > 0 ? -z! : z!) / scale, -y! / scale];
  if (ay >= az) return [x! / scale, (ny! > 0 ? z! : -z!) / scale];
  return [(nz! > 0 ? x! : -x!) / scale, -y! / scale];
}

/** 文件里的笔刷换成原生的：位置和旋转合成列主序的矩阵。 */
function nativeBrush(brush: BrushShapeFile): Brush {
  const [qx, qy, qz, qw] = brush.rotation ?? [0, 0, 0, 1];
  const [px, py, pz] = brush.position;
  const transform = [
    1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy + qz * qw), 2 * (qx * qz - qy * qw), 0,
    2 * (qx * qy - qz * qw), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz + qx * qw), 0,
    2 * (qx * qz + qy * qw), 2 * (qy * qz - qx * qw), 1 - 2 * (qx * qx + qy * qy), 0,
    px, py, pz, 1,
  ];
  const { operation } = brush;
  switch (brush.kind) {
    case 'box': return { kind: 'box', operation, transform, size: brush.size };
    case 'prism': return { kind: 'prism', operation, transform, points: brush.points, height: brush.height };
    case 'cylinder': return { kind: 'cylinder', operation, transform, height: brush.height, bottomRadius: brush.radius, topRadius: brush.topRadius ?? brush.radius, segments: brush.segments ?? DEFAULT_SEGMENTS };
    case 'sphere': return { kind: 'sphere', operation, transform, radius: brush.radius, segments: brush.segments ?? DEFAULT_SEGMENTS };
  }
}
