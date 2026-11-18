/**
 * 模型网格的压缩：量化成紧凑的顶点（格式见 @stride-ts/engine 的 VertexLayout），按顶点缓存和读取顺序重排，再用 meshopt
 * 编码顶点和索引（运行时用原生模块并行解码）。做法参考 glTF-Transform 的 quantize、reorder、meshopt：
 * - 位置：一个模型的所有网格共用一个包围盒（同一个模型里相接的网格量化到同一个网格点，不会裂缝），每个轴按包围盒
 *   量化成 unorm16。包围盒最长的轴超过 MAX_QUANTIZED_EXTENT（16 位的精度会低于 0.1 mm）时保留 float32。
 * - 法线：八面体编码，两个 snorm16（精度约 0.003°，金属表面的高光看不出差别）。
 * - UV：按网格的 UV 范围量化成 unorm16；范围超过 MAX_QUANTIZED_UV_RANGE（平铺很多次，16 位的精度不够）时保留 float32。
 * - 切线（只有材质用法线贴图的网格有）：snorm8x4，xyz 加手性（同 meshopt、glTF-Transform 对切线的量化）。
 */
import type { StrideTools } from '@stride-ts/native/tools';
import { TANGENT_FLOATS, vertexLayoutOffsets, VERTEX_FLOATS, type Dequantize, type ModelMeshData, type VertexLayout } from '@stride-ts/engine/content-format';

/** 16 位量化精度 0.1 mm 对应的最长包围盒边长（米）。 */
export const MAX_QUANTIZED_EXTENT = 65535 * 0.0001;
/** UV 范围不超过 16 时，unorm16 的精度是 1/4096，对 2048 的贴图是半个纹素。 */
export const MAX_QUANTIZED_UV_RANGE = 16;

/** 管线里的网格：FLOAT_LAYOUT 的交错顶点（每个 VERTEX_FLOATS 个 float）和三角形索引，可以带切线（每个顶点 TANGENT_FLOATS 个）。 */
export interface SourceMesh {
  readonly name: string;
  readonly material: number | null;
  readonly vertices: Float32Array;
  readonly indices: Uint32Array;
  readonly tangents?: Float32Array;
}

/**
 * 给网格生成 MikkTSpace 切线（同法线贴图烘焙工具的约定）。生成的是每个三角形角一份，同一个顶点在不同三角形里的切线
 * 不一样时（UV 的接缝、镜像的地方）把顶点拆开，一样的合回一个。
 */
export function addTangents(mesh: SourceMesh, tools: StrideTools): SourceMesh {
  const count = mesh.vertices.length / VERTEX_FLOATS;
  const positions = new Float32Array(count * 3), normals = new Float32Array(count * 3), uvs = new Float32Array(count * 2);
  for (let v = 0; v < count; v++) {
    const o = v * VERTEX_FLOATS;
    positions.set(mesh.vertices.subarray(o, o + 3), v * 3);
    normals.set(mesh.vertices.subarray(o + 3, o + 6), v * 3);
    uvs.set(mesh.vertices.subarray(o + 6, o + 8), v * 2);
  }
  const corners = tools.generateTangents({ positions, normals, uvs, indices: mesh.indices });
  // 每个原顶点已经分出去的副本：（切线，新下标）
  const copies: { tangent: Float32Array; index: number }[][] = Array.from({ length: count }, () => []);
  const vertices: number[] = [], tangents: number[] = [];
  const indices = new Uint32Array(mesh.indices.length);
  mesh.indices.forEach((source, corner) => {
    const tangent = corners.subarray(corner * TANGENT_FLOATS, (corner + 1) * TANGENT_FLOATS);
    let copy = copies[source]!.find((c) => c.tangent.every((value, k) => value === tangent[k]));
    if (!copy) {
      copy = { tangent, index: vertices.length / VERTEX_FLOATS };
      copies[source]!.push(copy);
      vertices.push(...mesh.vertices.subarray(source * VERTEX_FLOATS, (source + 1) * VERTEX_FLOATS));
      tangents.push(...tangent);
    }
    indices[corner] = copy.index;
  });
  return { ...mesh, vertices: new Float32Array(vertices), indices, tangents: new Float32Array(tangents) };
}

/** 一个模型的网格压缩：重排、量化、meshopt 编码。 */
export function compressMeshes(meshes: readonly SourceMesh[], tools: StrideTools): ModelMeshData[] {
  const volume = positionVolume(meshes);
  return meshes.map((mesh) => compressMesh(reorder(mesh, tools), volume, tools));
}

interface Volume {
  readonly min: [number, number, number];
  readonly extent: [number, number, number];
  readonly quantize: boolean;
}

function positionVolume(meshes: readonly SourceMesh[]): Volume {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const { vertices } of meshes) {
    for (let v = 0; v < vertices.length; v += VERTEX_FLOATS) {
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k]!, vertices[v + k]!);
        max[k] = Math.max(max[k]!, vertices[v + k]!);
      }
    }
  }
  if (min[0] === Infinity) return { min: [0, 0, 0], extent: [1, 1, 1], quantize: false };
  const extent = [0, 1, 2].map((k) => max[k]! - min[k]!) as [number, number, number];
  return { min, extent, quantize: Math.max(...extent) <= MAX_QUANTIZED_EXTENT };
}

/** 索引按顶点缓存优化（meshopt），顶点再按第一次被用到的顺序重排：解码后读顶点更连续，meshopt 也压得更小。 */
function reorder(mesh: SourceMesh, tools: StrideTools): SourceMesh {
  const count = mesh.vertices.length / VERTEX_FLOATS;
  if (count === 0) return mesh;
  const positions = new Float32Array(count * 3);
  for (let v = 0; v < count; v++) positions.set(mesh.vertices.subarray(v * VERTEX_FLOATS, v * VERTEX_FLOATS + 3), v * 3);
  const optimized = tools.optimizeMesh(mesh.indices, positions);
  const remap = new Int32Array(count).fill(-1);
  let next = 0;
  const indices = optimized.map((i) => (remap[i] === -1 ? (remap[i] = next++) : remap[i]!));
  const vertices = new Float32Array(next * VERTEX_FLOATS);
  const tangents = mesh.tangents && new Float32Array(next * TANGENT_FLOATS);
  for (let v = 0; v < count; v++) {
    if (remap[v]! < 0) continue;
    vertices.set(mesh.vertices.subarray(v * VERTEX_FLOATS, (v + 1) * VERTEX_FLOATS), remap[v]! * VERTEX_FLOATS);
    tangents?.set(mesh.tangents!.subarray(v * TANGENT_FLOATS, (v + 1) * TANGENT_FLOATS), remap[v]! * TANGENT_FLOATS);
  }
  return { ...mesh, vertices, indices, ...(tangents ? { tangents } : {}) };
}

function compressMesh(mesh: SourceMesh, volume: Volume, tools: StrideTools): ModelMeshData {
  const count = mesh.vertices.length / VERTEX_FLOATS;
  const uv = uvRange(mesh.vertices);
  const layout: VertexLayout = {
    position: volume.quantize ? 'unorm16x4' : 'float32x3',
    normal: 'snorm16x2',
    uv: uv.quantize ? 'unorm16x2' : 'float32x2',
    ...(mesh.tangents ? { tangent: 'snorm8x4' as const } : {}),
  };
  const dequantize: Dequantize = {
    positionOffset: volume.quantize ? volume.min : [0, 0, 0],
    positionScale: volume.quantize ? volume.extent : [1, 1, 1],
    uvOffset: uv.quantize ? uv.min : [0, 0],
    uvScale: uv.quantize ? uv.range : [1, 1],
  };
  const offsets = vertexLayoutOffsets(layout);
  const bytes = new DataView(new ArrayBuffer(count * offsets.stride));
  const unorm16 = (value: number, min: number, range: number) => Math.round(Math.min(1, Math.max(0, range === 0 ? 0 : (value - min) / range)) * 65535);
  for (let v = 0; v < count; v++) {
    const source = mesh.vertices.subarray(v * VERTEX_FLOATS, (v + 1) * VERTEX_FLOATS);
    const at = v * offsets.stride;
    for (let k = 0; k < 3; k++) {
      if (volume.quantize) bytes.setUint16(at + k * 2, unorm16(source[k]!, volume.min[k]!, volume.extent[k]!), true);
      else bytes.setFloat32(at + k * 4, source[k]!, true);
    }
    const [ox, oy] = octEncode(source[3]!, source[4]!, source[5]!);
    bytes.setInt16(at + offsets.normal, Math.round(ox * 32767), true);
    bytes.setInt16(at + offsets.normal + 2, Math.round(oy * 32767), true);
    for (let k = 0; k < 2; k++) {
      if (uv.quantize) bytes.setUint16(at + offsets.uv + k * 2, unorm16(source[6 + k]!, uv.min[k]!, uv.range[k]!), true);
      else bytes.setFloat32(at + offsets.uv + k * 4, source[6 + k]!, true);
    }
    if (mesh.tangents) {
      for (let k = 0; k < 4; k++) bytes.setInt8(at + offsets.tangent! + k, Math.round(Math.min(1, Math.max(-1, mesh.tangents[v * TANGENT_FLOATS + k]!)) * 127));
    }
  }
  return {
    name: mesh.name,
    material: mesh.material,
    layout,
    dequantize,
    compression: 'meshopt',
    vertexCount: count,
    indexCount: mesh.indices.length,
    indexFormat: count <= 0xffff ? 'uint16' : 'uint32',
    vertices: tools.encodeVertices(new Uint8Array(bytes.buffer), offsets.stride),
    indices: tools.encodeIndices(mesh.indices, count),
  };
}

function uvRange(vertices: Float32Array): { min: [number, number]; range: [number, number]; quantize: boolean } {
  const min: [number, number] = [Infinity, Infinity];
  const max: [number, number] = [-Infinity, -Infinity];
  for (let v = 0; v < vertices.length; v += VERTEX_FLOATS) {
    for (let k = 0; k < 2; k++) {
      min[k] = Math.min(min[k]!, vertices[v + 6 + k]!);
      max[k] = Math.max(max[k]!, vertices[v + 6 + k]!);
    }
  }
  if (min[0] === Infinity) return { min: [0, 0], range: [1, 1], quantize: false };
  const range: [number, number] = [max[0] - min[0], max[1] - min[1]];
  return { min, range, quantize: Math.max(...range) <= MAX_QUANTIZED_UV_RANGE };
}

/**
 * 单位向量的八面体编码，结果在 [-1, 1]²：投影到 |x| + |y| + |z| = 1 的八面体上，下半部分翻折到外面。
 * 和引擎顶点着色器里的 octDecode（meshopt 的 octahedral 滤波的写法）互逆。
 */
export function octEncode(x: number, y: number, z: number): [number, number] {
  const norm = Math.abs(x) + Math.abs(y) + Math.abs(z) || 1;
  let u = x / norm, v = y / norm;
  if (z < 0) {
    const flippedU = (1 - Math.abs(v)) * (u >= 0 ? 1 : -1);
    v = (1 - Math.abs(u)) * (v >= 0 ? 1 : -1);
    u = flippedU;
  }
  return [u, v];
}
