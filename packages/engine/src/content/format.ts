/**
 * 运行时内容的文件格式，资源管线（Node，packages/pipeline）写，ContentManager 读。这个文件不依赖别的模块，
 * 管线可以直接导入它。资源之间用相对内容根目录的路径引用（不带扩展名），比如 `models/PrototypingBlocks/Wall0x2x5`。
 *
 * - 模型 `<路径>.model`：二进制容器。开头 12 字节是 magic 'SMDL'、版本、JSON 头的字节数，接着是 JSON 头
 *   （网格表和材质槽），补齐到 4 字节，后面是数据区：每个网格的交错顶点（位置、法线、UV，见 VERTEX_FLOATS）
 *   和索引。加载后直接上传，不做转换。
 * - 材质 `<路径>.material.json`、场景 `<路径>.scene.json`：JSON。场景以后改成二进制，物理部分直接是原生能读的布局。
 */

/** 每个顶点的 float 数：位置 xyz、法线 xyz、UV xy。 */
export const VERTEX_FLOATS = 8;

export const MODEL_MAGIC = 0x4c444d53; // 'SMDL'，小端
export const MODEL_VERSION = 1;

export const EXTENSIONS = { model: '.model', material: '.material.json', scene: '.scene.json', texture: '.ktx2' } as const;

export interface ModelMeshHeader {
  readonly name: string;
  /** 在模型材质槽里的下标；没有材质时是 null。 */
  readonly material: number | null;
  readonly vertexCount: number;
  readonly indexCount: number;
  readonly indexFormat: 'uint16' | 'uint32';
  /** 相对数据区开头的字节偏移，都是 4 的倍数。 */
  readonly vertexByteOffset: number;
  readonly indexByteOffset: number;
}

export interface ModelHeader {
  readonly meshes: readonly ModelMeshHeader[];
  /** 材质槽：模型自带的材质（内容路径），没有材质的槽是 null。实体可以按槽覆盖。 */
  readonly materials: readonly (string | null)[];
}

export interface ModelMeshData {
  readonly name: string;
  readonly material: number | null;
  readonly vertices: Float32Array;
  readonly indices: Uint16Array | Uint32Array;
}

export interface ModelData {
  readonly meshes: readonly ModelMeshData[];
  readonly materials: readonly (string | null)[];
}

const align4 = (n: number) => (n + 3) & ~3;

export function encodeModel(model: ModelData): Uint8Array {
  let offset = 0;
  const meshes: ModelMeshHeader[] = model.meshes.map((mesh) => {
    if (mesh.vertices.length % VERTEX_FLOATS !== 0) throw new RangeError(`model mesh '${mesh.name}': vertices must hold ${VERTEX_FLOATS} floats per vertex`);
    const vertexByteOffset = offset;
    offset += mesh.vertices.byteLength;
    const indexByteOffset = offset;
    offset = align4(offset + mesh.indices.byteLength);
    return {
      name: mesh.name,
      material: mesh.material,
      vertexCount: mesh.vertices.length / VERTEX_FLOATS,
      indexCount: mesh.indices.length,
      indexFormat: mesh.indices instanceof Uint16Array ? 'uint16' : 'uint32',
      vertexByteOffset,
      indexByteOffset,
    };
  });
  const json = new TextEncoder().encode(JSON.stringify({ meshes, materials: model.materials } satisfies ModelHeader));
  const dataStart = 12 + align4(json.byteLength);
  const bytes = new Uint8Array(dataStart + offset);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, MODEL_MAGIC, true);
  view.setUint32(4, MODEL_VERSION, true);
  view.setUint32(8, json.byteLength, true);
  bytes.set(json, 12);
  bytes.fill(0x20, 12 + json.byteLength, dataStart); // 用空格补齐，JSON 头仍能整段解析
  model.meshes.forEach((mesh, i) => {
    const header = meshes[i]!;
    bytes.set(new Uint8Array(mesh.vertices.buffer, mesh.vertices.byteOffset, mesh.vertices.byteLength), dataStart + header.vertexByteOffset);
    bytes.set(new Uint8Array(mesh.indices.buffer, mesh.indices.byteOffset, mesh.indices.byteLength), dataStart + header.indexByteOffset);
  });
  return bytes;
}

/** 读模型文件；顶点和索引是 buffer 上的视图，不拷贝。 */
export function decodeModel(buffer: ArrayBuffer, source = 'model'): ModelData {
  const view = new DataView(buffer);
  if (buffer.byteLength < 12 || view.getUint32(0, true) !== MODEL_MAGIC) throw new Error(`${source} is not a model file`);
  const version = view.getUint32(4, true);
  if (version !== MODEL_VERSION) throw new Error(`${source} has model format version ${version}; this engine reads version ${MODEL_VERSION}`);
  const jsonLength = view.getUint32(8, true);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 12, jsonLength))) as ModelHeader;
  const dataStart = 12 + align4(jsonLength);
  return {
    materials: header.materials,
    meshes: header.meshes.map((mesh) => ({
      name: mesh.name,
      material: mesh.material,
      vertices: new Float32Array(buffer, dataStart + mesh.vertexByteOffset, mesh.vertexCount * VERTEX_FLOATS),
      indices: mesh.indexFormat === 'uint16'
        ? new Uint16Array(buffer, dataStart + mesh.indexByteOffset, mesh.indexCount)
        : new Uint32Array(buffer, dataStart + mesh.indexByteOffset, mesh.indexCount),
    })),
  };
}

/** 材质文件。颜色都是线性空间的。 */
/** 贴图和颜色的组合方式：结果 = 运算(贴图采样, 颜色)。对应 Stride ComputeBinaryColor 的运算符，先支持用到的两个。 */
export type ColorOperator = 'multiply' | 'add';

export interface TextureSlot {
  /** 贴图的内容路径；文件是 KTX2（Basis 压缩），运行时按设备支持转码。 */
  readonly texture: string;
  /** 采样坐标 = uv * scale + offset（scale 已经乘上 Stride 材质的 UVScale）。 */
  readonly scale: readonly [number, number];
  readonly offset: readonly [number, number];
}

export interface MaterialFile {
  readonly name: string;
  /** 线性颜色。没有贴图时就是漫反射颜色，有贴图时按 baseColorOperator 和贴图组合。 */
  readonly baseColor: readonly [number, number, number, number];
  readonly baseColorTexture?: TextureSlot;
  /** 默认 multiply（baseColor 是白色时就是贴图本身）。 */
  readonly baseColorOperator?: ColorOperator;
  readonly metalness?: number;
  readonly roughness?: number;
}

export type Vec3Tuple = readonly [number, number, number];

export interface SceneEntityFile {
  readonly id: string;
  readonly name: string;
  /** 父实体的 id；根实体是 null。 */
  readonly parent: string | null;
  readonly position: Vec3Tuple;
  readonly rotation: readonly [number, number, number, number];
  readonly scale: Vec3Tuple;
  readonly components: {
    readonly model?: {
      /** 模型的内容路径。 */
      readonly model: string;
      /** 按槽覆盖模型的材质；null 表示用模型自带的。 */
      readonly materials: readonly (string | null)[];
    };
    readonly camera?: { readonly verticalFieldOfView: number; readonly nearClipPlane: number; readonly farClipPlane: number };
    readonly light?: {
      readonly type: 'directional' | 'ambient';
      /** sRGB，同 Light 组件。 */
      readonly color: Vec3Tuple;
      readonly intensity: number;
    };
  };
}

export interface SceneFile {
  readonly name: string;
  /** 父实体都排在子实体前面。 */
  readonly entities: readonly SceneEntityFile[];
}
