/**
 * `.model` 文件有两种写法：资源管线写的二进制容器（binaryFormat.ts），或者一段 JSON（ProceduralModelFile）描述一个程序生成的
 * 形状（Stride 的程序模型）。JSON 的那种是编辑器"新建基本形状"写的，几十个字节，加载时按它生成网格，之后和二进制的一样用。
 * 按第一个不是空白的字节分：'{' 是 JSON（二进制的开头是 magic 'SMDL'）。资源引用照旧：模型的材质槽在 materials 里。
 *
 *   { "format": 1, "procedural": { "type": "cube", "size": [2, 1, 2] }, "materials": ["Materials/Ground"] }
 */
import { decodeModel, plainMesh, VERTEX_FLOATS, vertexLayoutOffsets, type Dequantize, type ModelData, type ModelMeshData, type VertexLayout } from './formats/binaryFormat.ts';
import { generateProceduralMesh, PROCEDURAL_SHAPES, proceduralTangents, type ProceduralModel } from '../rendering/mesh/procedural.ts';

export const PROCEDURAL_MODEL_FORMAT = 1;

/** JSON 写的模型：一个形状、一个材质槽（Stride 的程序模型也只有一个）。 */
export interface ProceduralModelFile {
  readonly format: typeof PROCEDURAL_MODEL_FORMAT;
  readonly procedural: ProceduralModel;
  /** 材质槽；没有或 null 时实体的 Model.materials 照样能按槽覆盖，都没有时用默认材质。 */
  readonly materials?: readonly (string | null)[];
}

/** 文件内容是 JSON 写的模型（第一个不是空白的字节是 '{'）。 */
export function isProceduralModel(bytes: ArrayBuffer | Uint8Array): boolean {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (const byte of view) {
    if (byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d || byte === 0xef || byte === 0xbb || byte === 0xbf) continue;
    return byte === 0x7b;
  }
  return false;
}

/** 解析并检查 JSON 写的模型；source 用在报错里。 */
export function parseProceduralModel(bytes: ArrayBuffer | Uint8Array, source = 'model'): ProceduralModelFile {
  const text = new TextDecoder().decode(bytes);
  let file: ProceduralModelFile;
  try {
    file = JSON.parse(text) as ProceduralModelFile;
  } catch (error) {
    throw new Error(`${source}: not a valid JSON model: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (file.format !== PROCEDURAL_MODEL_FORMAT) throw new Error(`${source}: unsupported JSON model format ${JSON.stringify(file.format)} (expected ${String(PROCEDURAL_MODEL_FORMAT)})`);
  const type = file.procedural?.type;
  if (!(PROCEDURAL_SHAPES as readonly string[]).includes(type)) throw new Error(`${source}: procedural.type must be one of ${PROCEDURAL_SHAPES.join(', ')}, got ${String(type)}`);
  if (file.materials !== undefined && !(Array.isArray(file.materials) && file.materials.every((m) => m === null || typeof m === 'string'))) {
    throw new Error(`${source}: materials must be an array of material paths or null`);
  }
  return file;
}

/** JSON 写的模型生成成和二进制解码出来一样的 ModelData：一个网格（不量化的 float 布局、带切线），材质槽 0。 */
export function proceduralModelData(file: ProceduralModelFile, source = 'model'): ModelData {
  let generated;
  try {
    generated = generateProceduralMesh(file.procedural);
  } catch (error) {
    throw new Error(`${source}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const count = generated.positions.length / 3;
  const vertices = new Float32Array(count * VERTEX_FLOATS);
  for (let v = 0; v < count; v++) {
    vertices.set(generated.positions.subarray(v * 3, v * 3 + 3), v * VERTEX_FLOATS);
    vertices.set(generated.normals.subarray(v * 3, v * 3 + 3), v * VERTEX_FLOATS + 3);
    vertices.set(generated.uvs.subarray(v * 2, v * 2 + 2), v * VERTEX_FLOATS + 6);
  }
  const indices = count <= 0xffff ? Uint16Array.from(generated.indices) : generated.indices;
  return {
    meshes: [plainMesh('mesh0', 0, vertices, indices, { tangents: proceduralTangents(generated) })],
    materials: file.materials?.length ? [...file.materials] : [null],
  };
}

/** 读一个 .model 文件（两种写法都认）。 */
export function readModelFile(buffer: ArrayBuffer, source = 'model'): ModelData {
  return isProceduralModel(buffer) ? proceduralModelData(parseProceduralModel(buffer, source), source) : decodeModel(buffer, source);
}

/** meshopt 解码的一个请求（同 @stride-ts/native 的 MeshoptRequest）。 */
export interface MeshoptRequest {
  readonly source: Uint8Array;
  readonly count: number;
  readonly stride: number;
  readonly mode: 'attributes' | 'triangles';
}

/** 并行解码一批 meshopt 流，返回每个请求的 count * stride 个字节。 */
export type MeshoptDecoder = (requests: readonly MeshoptRequest[]) => Promise<Uint8Array[]>;

/** 解开的网格：顶点、索引是 GPU 上的布局（同引擎的 MeshData）。 */
export interface DecodedMesh {
  readonly vertices: Float32Array | Uint8Array;
  readonly indices: Uint16Array | Uint32Array;
  readonly layout: VertexLayout;
  readonly dequantize: Dequantize;
  readonly morph?: Uint32Array;
}

/**
 * 模型文件里的网格解开（运行时加载模型、烘焙时读别的模型的几何共用）：压缩的一起交给 decoder 并行解码，没压缩的直接用文件里的
 * 字节。有压缩的网格却没给 decoder 时报错。
 */
export async function decodeModelMeshes(meshes: readonly ModelMeshData[], decoder: MeshoptDecoder | undefined, where: string): Promise<DecodedMesh[]> {
  const compressed = meshes.filter((mesh) => mesh.compression === 'meshopt');
  let decoded: Uint8Array[] = [];
  if (compressed.length > 0) {
    if (!decoder) throw new Error(`loading ${where}: compressed meshes need a meshoptDecoder (Game sets one when it starts)`);
    decoded = await decoder(compressed.flatMap((mesh) => [
      { source: mesh.vertices, count: mesh.vertexCount, stride: vertexLayoutOffsets(mesh.layout).stride, mode: 'attributes' as const },
      { source: mesh.indices, count: mesh.indexCount, stride: mesh.indexFormat === 'uint16' ? 2 : 4, mode: 'triangles' as const },
    ]));
  }
  let next = 0;
  return meshes.map((mesh) => {
    const [vertices, indexBytes] = mesh.compression === 'meshopt' ? [decoded[next++]!, decoded[next++]!] : [mesh.vertices, mesh.indices];
    const indices = mesh.indexFormat === 'uint16'
      ? new Uint16Array(indexBytes.buffer, indexBytes.byteOffset, mesh.indexCount)
      : new Uint32Array(indexBytes.buffer, indexBytes.byteOffset, mesh.indexCount);
    const morph = mesh.morphData && new Uint32Array(mesh.morphData.buffer, mesh.morphData.byteOffset, mesh.morphData.byteLength / 4);
    return { vertices, indices, layout: mesh.layout, dequantize: mesh.dequantize, ...(morph ? { morph } : {}) };
  });
}

/**
 * 解开的网格换成不量化的顶点（每个 VERTEX_FLOATS 个 float：位置、法线、UV，同 FLOAT_LAYOUT）：烘焙时拿别的模型的几何再加工用。
 * 八面体编码的法线还原成单位向量（同顶点着色器的 octDecode）。
 */
export function meshFloatVertices(mesh: Pick<DecodedMesh, 'vertices' | 'layout' | 'dequantize'>): Float32Array {
  const positions = meshPositions(mesh);
  const { layout, dequantize, vertices } = mesh;
  const { normal: normalAt, uv: uvAt, stride } = vertexLayoutOffsets(layout);
  const view = new DataView(vertices.buffer, vertices.byteOffset, vertices.byteLength);
  const count = positions.length / 3;
  const out = new Float32Array(count * VERTEX_FLOATS);
  for (let v = 0; v < count; v++) {
    const at = v * stride, o = v * VERTEX_FLOATS;
    out.set(positions.subarray(v * 3, v * 3 + 3), o);
    if (layout.normal === 'snorm16x2') {
      const ex = Math.max(-1, view.getInt16(at + normalAt, true) / 32767), ey = Math.max(-1, view.getInt16(at + normalAt + 2, true) / 32767);
      let nx = ex, ny = ey;
      const nz = 1 - Math.abs(ex) - Math.abs(ey), t = Math.max(-nz, 0);
      nx += nx >= 0 ? -t : t;
      ny += ny >= 0 ? -t : t;
      const length = Math.hypot(nx, ny, nz) || 1;
      out[o + 3] = nx / length;
      out[o + 4] = ny / length;
      out[o + 5] = nz / length;
    } else {
      for (let k = 0; k < 3; k++) out[o + 3 + k] = view.getFloat32(at + normalAt + k * 4, true);
    }
    for (let k = 0; k < 2; k++) {
      out[o + 6 + k] = layout.uv === 'unorm16x2' ? dequantize.uvOffset[k]! + (view.getUint16(at + uvAt + k * 2, true) / 65535) * dequantize.uvScale[k]! : view.getFloat32(at + uvAt + k * 4, true);
    }
  }
  return out;
}

/** 模型空间的顶点位置 xyz（量化的位置已经反量化）：网格碰撞体、烘焙时按几何算东西用。 */
export function meshPositions({ vertices, layout, dequantize }: Pick<DecodedMesh, 'vertices' | 'layout' | 'dequantize'>): Float32Array {
  const { position: offset, stride } = vertexLayoutOffsets(layout);
  const view = new DataView(vertices.buffer, vertices.byteOffset, vertices.byteLength);
  const count = vertices.byteLength / stride;
  const out = new Float32Array(count * 3);
  const quantized = layout.position === 'unorm16x4';
  const { positionOffset: o, positionScale: s } = dequantize;
  for (let v = 0; v < count; v++) {
    const at = v * stride + offset;
    for (let k = 0; k < 3; k++) out[v * 3 + k] = quantized ? o[k]! + (view.getUint16(at + k * 2, true) / 65535) * s[k]! : view.getFloat32(at + k * 4, true);
  }
  return out;
}
