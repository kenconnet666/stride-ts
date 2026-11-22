/**
 * `.model` 文件有两种写法：资源管线写的二进制容器（binaryFormat.ts），或者一段 JSON（ProceduralModelFile）描述一个程序生成的
 * 形状（Stride 的程序模型）。JSON 的那种是编辑器"新建基本形状"写的，几十个字节，加载时按它生成网格，之后和二进制的一样用。
 * 按第一个不是空白的字节分：'{' 是 JSON（二进制的开头是 magic 'SMDL'）。资源引用照旧：模型的材质槽在 materials 里。
 *
 *   { "format": 1, "procedural": { "type": "cube", "size": [2, 1, 2] }, "materials": ["Materials/Ground"] }
 */
import { decodeModel, plainMesh, VERTEX_FLOATS, type ModelData } from './formats/binaryFormat.ts';
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
