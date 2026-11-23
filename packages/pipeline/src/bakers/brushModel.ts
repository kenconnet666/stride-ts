/**
 * 关卡白盒的烘焙（引擎 content/formats/assetFormat.ts 的 BrushFile）：笔刷按顺序加、减、求交（原生工具模块的 Manifold，`brushCsg`），
 * 结果按笔刷的材质槽分成网格，平直的法线（白盒的硬边），UV 按面的朝向投影世界坐标（uvScale 米一个周期：贴网格图时相邻的面、
 * 不同的笔刷都接得上，同虚幻 CubeGrid 的默认 UV），同一平面上位置相同的顶点合并。写成普通的模型（量化加 meshopt），场景照常引用。
 *
 * 编辑器后端在白盒文件存下、或者在磁盘上改了以后调它（server/EditorBackend.ts）。法线贴图要的切线不生成：白盒的材质用颜色、
 * 网格图就够，要细节时导出成可编辑的网格（brushToPoly）再做。
 */
import { BRUSH, encodeModel, VERTEX_FLOATS, type Brush, type BrushFile, type PolyMeshFile } from '@stride-ts/engine/content-format';
import type { Brush as NativeBrush, StrideTools } from '@stride-ts/native/tools';
import { projectUv, trianglesToPolygons } from '@stride-ts/engine/modeling';
import { compressMeshes, type SourceMesh } from '../mesh.ts';

/** 烘成模型文件的字节（.model）。笔刷的参数不对、合不成实体时报错，消息里有是第几个笔刷。 */
export async function bakeBrushModel(tools: StrideTools, input: BrushFile, where = input.name): Promise<Uint8Array> {
  const file = BRUSH.parse(input, where);
  const slots = Math.max(1, file.materials.length);
  const { positions, indices, brushOfTriangle } = await brushSolid(tools, file, where);
  const uvScale = file.uvScale;
  const builders = Array.from({ length: slots }, () => ({ vertices: [] as number[], indices: [] as number[], weld: new Map<string, number>() }));
  const corner = [0, 0, 0], a = [0, 0, 0], b = [0, 0, 0];
  for (let t = 0; t < indices.length / 3; t++) {
    const builder = builders[file.brushes[brushOfTriangle[t]!]!.material]!;
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

/**
 * 白盒导出成可编辑的多边形网格（`.poly.json`）：布尔运算的结果焊好顶点，同一平面、同一材质槽连着的三角形合成一个 n 边形
 * （modeling/trianglesToPolygons.ts），材质槽、UV 的尺度照搬，全部硬边（白盒的样子）。之后在多边形编辑里加细节。
 */
export async function brushToPoly(tools: StrideTools, input: BrushFile, name: string, where = input.name): Promise<PolyMeshFile> {
  const file = BRUSH.parse(input, where);
  const { positions, indices, brushOfTriangle } = await brushSolid(tools, file, where);
  const { vertices, faces } = trianglesToPolygons(positions, indices, (t) => file.brushes[brushOfTriangle[t]!]!.material);
  return {
    name, materials: file.materials.length > 0 ? file.materials : [null], vertices, faces, smoothAngle: 0,
    // 白盒文件里写了才照搬（没写的多边形网格同样按 1 米一个周期）
    ...(input.uvScale !== undefined ? { uvScale: input.uvScale } : {}),
  };
}

/** 检查材质槽，按顺序做笔刷的布尔运算；什么都不剩时报错。 */
async function brushSolid(tools: StrideTools, file: Brush, where: string) {
  if (file.brushes.length === 0) throw new Error(`${where}: a greybox needs at least one brush`);
  const slots = Math.max(1, file.materials.length);
  file.brushes.forEach((brush, i) => {
    const slot = brush.material;
    if (!Number.isInteger(slot) || slot < 0 || slot >= slots) throw new Error(`${where}: brush ${i} uses material slot ${slot}, but there ${slots === 1 ? 'is 1 slot' : `are ${slots} slots`}`);
  });
  let solid;
  try {
    solid = await tools.brushCsg(file.brushes.map(nativeBrush));
  } catch (error) {
    throw new Error(`${where}: ${(error as Error).message}`, { cause: error });
  }
  if (solid.indices.length === 0) throw new Error(`${where}: the brushes leave nothing (everything is subtracted)`);
  return solid;
}

/** 位置和旋转（四元数 xyzw，没写是不转）合成列主序的 4x4 矩阵（白盒的笔刷、SDF 的形状给原生用）。 */
export function rigidTransform([px, py, pz]: readonly number[], [qx, qy, qz, qw]: readonly number[] = [0, 0, 0, 1]): number[] {
  return [
    1 - 2 * (qy! * qy! + qz! * qz!), 2 * (qx! * qy! + qz! * qw!), 2 * (qx! * qz! - qy! * qw!), 0,
    2 * (qx! * qy! - qz! * qw!), 1 - 2 * (qx! * qx! + qz! * qz!), 2 * (qy! * qz! + qx! * qw!), 0,
    2 * (qx! * qz! + qy! * qw!), 2 * (qy! * qz! - qx! * qw!), 1 - 2 * (qx! * qx! + qy! * qy!), 0,
    px!, py!, pz!, 1,
  ];
}

/** 文件里的笔刷换成原生的：位置和旋转合成列主序的矩阵。 */
function nativeBrush(brush: Brush['brushes'][number]): NativeBrush {
  const transform = rigidTransform(brush.position, brush.rotation);
  const { operation } = brush;
  switch (brush.kind) {
    case 'box': return { kind: 'box', operation, transform, size: brush.size };
    case 'prism': return { kind: 'prism', operation, transform, points: brush.points, height: brush.height };
    case 'cylinder': return { kind: 'cylinder', operation, transform, height: brush.height, bottomRadius: brush.radius, topRadius: brush.topRadius ?? brush.radius, segments: brush.segments };
    case 'sphere': return { kind: 'sphere', operation, transform, radius: brush.radius, segments: brush.segments };
  }
}
