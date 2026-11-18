/**
 * 运行时内容的文件格式，资源管线（Node，packages/pipeline）写，ContentManager 读。这个文件不依赖别的模块，
 * 管线可以直接导入它。资源之间用相对内容根目录的路径引用（不带扩展名），比如 `models/PrototypingBlocks/Wall0x2x5`。
 *
 * - 模型 `<路径>.model`：二进制容器。开头 12 字节是 magic 'SMDL'、版本、JSON 头的字节数，接着是 JSON 头
 *   （网格表和材质槽），补齐到 4 字节，后面是数据区：每个网格的交错顶点（位置、法线、UV，见 VERTEX_FLOATS）
 *   和索引。加载后直接上传，不做转换。
 * - 立方体贴图 `<路径>.cubemap`：同样的容器（magic 'SCUB'），JSON 头是尺寸和级数，数据区是各级 mip 的 RGBA16F，
 *   每级 6 个面连续（+X -X +Y -Y +Z -Z，行从上到下，WebGPU 的布局），直接上传。
 * - 贴图 `<路径>.ktx2`：KTX2 加 Basis，运行时按设备转码。
 * - 材质 `<路径>.material.json`、天空盒 `<路径>.skybox.json`、场景 `<路径>.scene.json`：JSON。场景以后改成二进制，
 *   物理部分直接是原生能读的布局。
 */

/** 每个顶点的 float 数：位置 xyz、法线 xyz、UV xy。 */
export const VERTEX_FLOATS = 8;

export const MODEL_MAGIC = 0x4c444d53; // 'SMDL'，小端
export const MODEL_VERSION = 1;
export const CUBEMAP_MAGIC = 0x42554353; // 'SCUB'，小端
export const CUBEMAP_VERSION = 1;

export const EXTENSIONS = {
  model: '.model',
  material: '.material.json',
  scene: '.scene.json',
  texture: '.ktx2',
  cubemap: '.cubemap',
  skybox: '.skybox.json',
} as const;

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
  const { bytes, dataStart } = encodeContainer(MODEL_MAGIC, MODEL_VERSION, { meshes, materials: model.materials } satisfies ModelHeader, offset);
  model.meshes.forEach((mesh, i) => {
    const header = meshes[i]!;
    bytes.set(byteView(mesh.vertices), dataStart + header.vertexByteOffset);
    bytes.set(byteView(mesh.indices), dataStart + header.indexByteOffset);
  });
  return bytes;
}

/** 读模型文件；顶点和索引是 buffer 上的视图，不拷贝。 */
export function decodeModel(buffer: ArrayBuffer, source = 'model'): ModelData {
  const { header, dataStart } = decodeContainer<ModelHeader>(buffer, MODEL_MAGIC, MODEL_VERSION, 'model', source);
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

/** 立方体贴图：各级 mip 的 RGBA16F（半精度浮点的位），每级 6 个面连续，从 size 到 1。 */
export interface CubemapData {
  readonly size: number;
  readonly levels: readonly Uint16Array[];
}

interface CubemapHeader {
  readonly size: number;
  readonly levels: number;
  readonly format: 'rgba16float';
}

export function encodeCubemap(cubemap: CubemapData): Uint8Array {
  const total = cubemap.levels.reduce((sum, level, i) => {
    const edge = Math.max(1, cubemap.size >> i);
    if (level.length !== 6 * edge * edge * 4) throw new RangeError(`cubemap level ${i} must hold 6 * ${edge}² RGBA texels`);
    return sum + level.byteLength;
  }, 0);
  const { bytes, dataStart } = encodeContainer(CUBEMAP_MAGIC, CUBEMAP_VERSION, { size: cubemap.size, levels: cubemap.levels.length, format: 'rgba16float' } satisfies CubemapHeader, total);
  let offset = dataStart;
  for (const level of cubemap.levels) {
    bytes.set(byteView(level), offset);
    offset += level.byteLength;
  }
  return bytes;
}

/** 读立方体贴图文件；各级是 buffer 上的视图，不拷贝。 */
export function decodeCubemap(buffer: ArrayBuffer, source = 'cubemap'): CubemapData {
  const { header, dataStart } = decodeContainer<CubemapHeader>(buffer, CUBEMAP_MAGIC, CUBEMAP_VERSION, 'cubemap', source);
  const levels: Uint16Array[] = [];
  for (let i = 0, offset = dataStart; i < header.levels; i++) {
    const edge = Math.max(1, header.size >> i);
    levels.push(new Uint16Array(buffer, offset, 6 * edge * edge * 4));
    offset += 6 * edge * edge * 8;
  }
  return { size: header.size, levels };
}

/** 天空盒的光照（Stride 的 Skybox：漫反射是球谐，镜面是预滤波的立方体贴图）。 */
export interface SkyboxFile {
  /** 3 阶球谐的 9 个 RGB 系数（线性），已经乘过基函数常数，按 Stride 的 EvaluateSphericalHarmonics 求值。 */
  readonly diffuseSH: readonly number[];
  /** 镜面光照的立方体贴图（内容路径）：第 i 级 mip 对应粗糙度 i / (级数 - 1)。 */
  readonly specular: string;
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
  /** 金属度工作流（Stride 的 MaterialMetalnessMapFeature）；没有时材质没有镜面反射。 */
  readonly metalness?: number;
  /** 1 - 光泽度；没有时是 1（Stride 的默认光泽度 0）。 */
  readonly roughness?: number;
  /** 自发光：线性颜色乘强度。 */
  readonly emissive?: Vec3Tuple;
  /** Stride 的 Occlusion 特性里的 cavity：漫反射和镜面的可见部分乘上这两个系数。 */
  readonly cavity?: { readonly diffuse: number; readonly specular: number };
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
    readonly light?:
      | {
        readonly type: 'directional' | 'ambient';
        /** sRGB，同 Light 组件。 */
        readonly color: Vec3Tuple;
        readonly intensity: number;
      }
      | {
        readonly type: 'skybox';
        /** 天空盒的内容路径。 */
        readonly skybox: string;
        readonly intensity: number;
      };
    /** 背景（Stride 的 BackgroundComponent）：立方体贴图的内容路径和强度。 */
    readonly background?: { readonly texture: string; readonly intensity: number };
  };
}

export interface SceneFile {
  readonly name: string;
  /** 父实体都排在子实体前面。 */
  readonly entities: readonly SceneEntityFile[];
}

/** 容器的开头：magic、版本、JSON 头的字节数，接着是 JSON 头，用空格补齐到 4 字节（仍能整段解析），后面是数据区。 */
function encodeContainer(magic: number, version: number, header: object, dataBytes: number): { bytes: Uint8Array; dataStart: number } {
  const json = new TextEncoder().encode(JSON.stringify(header));
  const dataStart = 12 + align4(json.byteLength);
  const bytes = new Uint8Array(dataStart + dataBytes);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, magic, true);
  view.setUint32(4, version, true);
  view.setUint32(8, json.byteLength, true);
  bytes.set(json, 12);
  bytes.fill(0x20, 12 + json.byteLength, dataStart);
  return { bytes, dataStart };
}

function decodeContainer<H>(buffer: ArrayBuffer, magic: number, version: number, kind: string, source: string): { header: H; dataStart: number } {
  const view = new DataView(buffer);
  if (buffer.byteLength < 12 || view.getUint32(0, true) !== magic) throw new Error(`${source} is not a ${kind} file`);
  const found = view.getUint32(4, true);
  if (found !== version) throw new Error(`${source} has ${kind} format version ${found}; this engine reads version ${version}`);
  const jsonLength = view.getUint32(8, true);
  return { header: JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 12, jsonLength))) as H, dataStart: 12 + align4(jsonLength) };
}

function byteView(array: ArrayBufferView): Uint8Array {
  return new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
}
