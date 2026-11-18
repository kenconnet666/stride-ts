/**
 * 运行时内容的文件格式，资源管线（Node，packages/pipeline）写，ContentManager 读。这个文件不依赖别的模块，
 * 管线可以直接导入它。资源之间用相对内容根目录的路径引用（不带扩展名），比如 `models/PrototypingBlocks/Wall0x2x5`。
 *
 * - 模型 `<路径>.model`：二进制容器。开头 12 字节是 magic 'SMDL'、版本、JSON 头的字节数，接着是 JSON 头
 *   （网格表和材质槽），补齐到 4 字节，后面是数据区：每个网格的交错顶点（布局见 VertexLayout，一般是量化的 16 字节）
 *   和索引，一般是 meshopt 编码的。解码后直接上传，反量化在顶点着色器里做。
 * - 立方体贴图 `<路径>.cubemap`：同样的容器（magic 'SCUB'），JSON 头是尺寸、级数和纹素格式（RGBA16F 或 RGB9E5），
 *   数据区是各级 mip，每级 6 个面连续（+X -X +Y -Y +Z -Z，行从上到下，WebGPU 的布局），直接上传。
 * - 贴图 `<路径>.ktx2`：KTX2 加 Basis，运行时按设备转码。
 * - 材质 `<路径>.material.json`、天空盒 `<路径>.skybox.json`、场景 `<路径>.scene.json`：JSON。场景以后改成二进制，
 *   物理部分直接是原生能读的布局。
 */

/** 不量化时每个顶点的 float 数：位置 xyz、法线 xyz、UV xy（FLOAT_LAYOUT）。 */
export const VERTEX_FLOATS = 8;

export const MODEL_MAGIC = 0x4c444d53; // 'SMDL'，小端
export const MODEL_VERSION = 2;
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

/**
 * 交错顶点里每个属性的格式（WebGPU 的顶点格式名），顺序是位置、法线、UV，紧挨着放。
 * - 位置：float32x3，或按模型的包围盒量化的 unorm16x4（w 不用）；
 * - 法线：float32x3，或八面体编码的 snorm16x2；
 * - UV：float32x2，或按网格的 UV 范围量化的 unorm16x2。
 * 量化的属性按 Dequantize 还原。
 */
export interface VertexLayout {
  readonly position: 'float32x3' | 'unorm16x4';
  readonly normal: 'float32x3' | 'snorm16x2';
  readonly uv: 'float32x2' | 'unorm16x2';
}

/** 不量化的布局：32 字节，就是 VERTEX_FLOATS 个 float。程序化网格和 --plain 导出的模型用它。 */
export const FLOAT_LAYOUT: VertexLayout = { position: 'float32x3', normal: 'float32x3', uv: 'float32x2' };

const ATTRIBUTE_BYTES = { float32x3: 12, float32x2: 8, unorm16x4: 8, snorm16x2: 4, unorm16x2: 4 } as const;

/** 各属性在顶点里的字节偏移和顶点的字节数。 */
export function vertexLayoutOffsets(layout: VertexLayout): { position: number; normal: number; uv: number; stride: number } {
  const normal = ATTRIBUTE_BYTES[layout.position];
  const uv = normal + ATTRIBUTE_BYTES[layout.normal];
  return { position: 0, normal, uv, stride: uv + ATTRIBUTE_BYTES[layout.uv] };
}

/** 量化属性的还原：值 = offset + 归一化的整数 · scale。没有量化的属性 offset 0、scale 1。 */
export interface Dequantize {
  readonly positionOffset: readonly [number, number, number];
  readonly positionScale: readonly [number, number, number];
  readonly uvOffset: readonly [number, number];
  readonly uvScale: readonly [number, number];
}

export const IDENTITY_DEQUANTIZE: Dequantize = { positionOffset: [0, 0, 0], positionScale: [1, 1, 1], uvOffset: [0, 0], uvScale: [1, 1] };

/** 'meshopt'：顶点和索引是 meshopt 编码的（glTF EXT_meshopt_compression 的 ATTRIBUTES 和 TRIANGLES），运行时并行解码。 */
export type MeshCompression = 'none' | 'meshopt';

export interface ModelMeshHeader {
  readonly name: string;
  /** 在模型材质槽里的下标；没有材质时是 null。 */
  readonly material: number | null;
  readonly layout: VertexLayout;
  readonly dequantize: Dequantize;
  readonly compression: MeshCompression;
  readonly vertexCount: number;
  readonly indexCount: number;
  readonly indexFormat: 'uint16' | 'uint32';
  /** 相对数据区开头的字节偏移和长度（压缩时是编码后的长度），偏移都是 4 的倍数。 */
  readonly vertexByteOffset: number;
  readonly vertexByteLength: number;
  readonly indexByteOffset: number;
  readonly indexByteLength: number;
}

export interface ModelHeader {
  readonly meshes: readonly ModelMeshHeader[];
  /** 材质槽：模型自带的材质（内容路径），没有材质的槽是 null。实体可以按槽覆盖。 */
  readonly materials: readonly (string | null)[];
}

/** 一个网格的数据：vertices、indices 是文件里的字节（压缩时是编码后的流，解码见 ContentManager）。 */
export interface ModelMeshData extends Omit<ModelMeshHeader, 'vertexByteOffset' | 'vertexByteLength' | 'indexByteOffset' | 'indexByteLength'> {
  readonly vertices: Uint8Array;
  readonly indices: Uint8Array;
}

export interface ModelData {
  readonly meshes: readonly ModelMeshData[];
  readonly materials: readonly (string | null)[];
}

/** 不量化、不压缩的网格（FLOAT_LAYOUT）：程序化网格、--plain 导出和测试用。 */
export function plainMesh(name: string, material: number | null, vertices: Float32Array, indices: Uint16Array | Uint32Array): ModelMeshData {
  if (vertices.length % VERTEX_FLOATS !== 0) throw new RangeError(`model mesh '${name}': vertices must hold ${VERTEX_FLOATS} floats per vertex`);
  return {
    name,
    material,
    layout: FLOAT_LAYOUT,
    dequantize: IDENTITY_DEQUANTIZE,
    compression: 'none',
    vertexCount: vertices.length / VERTEX_FLOATS,
    indexCount: indices.length,
    indexFormat: indices instanceof Uint16Array ? 'uint16' : 'uint32',
    vertices: byteView(vertices),
    indices: byteView(indices),
  };
}

const align4 = (n: number) => (n + 3) & ~3;

export function encodeModel(model: ModelData): Uint8Array {
  let offset = 0;
  const meshes: ModelMeshHeader[] = model.meshes.map(({ vertices, indices, ...mesh }) => {
    if (mesh.compression === 'none') {
      const stride = vertexLayoutOffsets(mesh.layout).stride;
      if (vertices.byteLength !== mesh.vertexCount * stride) throw new RangeError(`model mesh '${mesh.name}': ${mesh.vertexCount} vertices need ${mesh.vertexCount * stride} bytes, got ${vertices.byteLength}`);
      if (indices.byteLength !== mesh.indexCount * (mesh.indexFormat === 'uint16' ? 2 : 4)) throw new RangeError(`model mesh '${mesh.name}': index bytes do not match ${mesh.indexCount} ${mesh.indexFormat} indices`);
    }
    if (mesh.indexCount % 3 !== 0) throw new RangeError(`model mesh '${mesh.name}': indices must form triangles`);
    const vertexByteOffset = offset;
    offset = align4(offset + vertices.byteLength);
    const indexByteOffset = offset;
    offset = align4(offset + indices.byteLength);
    return { ...mesh, vertexByteOffset, vertexByteLength: vertices.byteLength, indexByteOffset, indexByteLength: indices.byteLength };
  });
  const { bytes, dataStart } = encodeContainer(MODEL_MAGIC, MODEL_VERSION, { meshes, materials: model.materials } satisfies ModelHeader, offset);
  model.meshes.forEach((mesh, i) => {
    const header = meshes[i]!;
    bytes.set(mesh.vertices, dataStart + header.vertexByteOffset);
    bytes.set(mesh.indices, dataStart + header.indexByteOffset);
  });
  return bytes;
}

/** 读模型文件；顶点和索引是 buffer 上的视图，不拷贝。 */
export function decodeModel(buffer: ArrayBuffer, source = 'model'): ModelData {
  const { header, dataStart } = decodeContainer<ModelHeader>(buffer, MODEL_MAGIC, MODEL_VERSION, 'model', source);
  return {
    materials: header.materials,
    meshes: header.meshes.map(({ vertexByteOffset, vertexByteLength, indexByteOffset, indexByteLength, ...mesh }) => ({
      ...mesh,
      vertices: new Uint8Array(buffer, dataStart + vertexByteOffset, vertexByteLength),
      indices: new Uint8Array(buffer, dataStart + indexByteOffset, indexByteLength),
    })),
  };
}

/**
 * 立方体贴图的纹素格式（WebGPU 的名字）：RGBA16F（8 字节），或 RGB9E5（4 字节，三个通道共用一个指数，
 * 没有 alpha，HDR 天空用它省一半）。
 */
export type CubemapFormat = 'rgba16float' | 'rgb9e5ufloat';

export const CUBEMAP_TEXEL_BYTES: Readonly<Record<CubemapFormat, number>> = { rgba16float: 8, rgb9e5ufloat: 4 };

/** 立方体贴图：各级 mip 的纹素（按 format 解释的字节），每级 6 个面连续，从 size 到 1。 */
export interface CubemapData {
  readonly size: number;
  readonly format: CubemapFormat;
  readonly levels: readonly Uint8Array[];
}

interface CubemapHeader {
  readonly size: number;
  readonly levels: number;
  readonly format: CubemapFormat;
}

export function encodeCubemap(cubemap: CubemapData): Uint8Array {
  const texel = CUBEMAP_TEXEL_BYTES[cubemap.format];
  const total = cubemap.levels.reduce((sum, level, i) => {
    const edge = Math.max(1, cubemap.size >> i);
    if (level.byteLength !== 6 * edge * edge * texel) throw new RangeError(`cubemap level ${i} must hold 6 * ${edge}² ${cubemap.format} texels`);
    return sum + level.byteLength;
  }, 0);
  const { bytes, dataStart } = encodeContainer(CUBEMAP_MAGIC, CUBEMAP_VERSION, { size: cubemap.size, levels: cubemap.levels.length, format: cubemap.format } satisfies CubemapHeader, total);
  let offset = dataStart;
  for (const level of cubemap.levels) {
    bytes.set(level, offset);
    offset += level.byteLength;
  }
  return bytes;
}

/** 读立方体贴图文件；各级是 buffer 上的视图，不拷贝。 */
export function decodeCubemap(buffer: ArrayBuffer, source = 'cubemap'): CubemapData {
  const { header, dataStart } = decodeContainer<CubemapHeader>(buffer, CUBEMAP_MAGIC, CUBEMAP_VERSION, 'cubemap', source);
  const texel = CUBEMAP_TEXEL_BYTES[header.format];
  if (texel === undefined) throw new Error(`${source} has cubemap format ${header.format}; this engine reads ${Object.keys(CUBEMAP_TEXEL_BYTES).join(', ')}`);
  const levels: Uint8Array[] = [];
  for (let i = 0, offset = dataStart; i < header.levels; i++) {
    const edge = Math.max(1, header.size >> i);
    levels.push(new Uint8Array(buffer, offset, 6 * edge * edge * texel));
    offset += 6 * edge * edge * texel;
  }
  return { size: header.size, format: header.format, levels };
}

/**
 * 天空盒的光照（Stride 的 Skybox）：漫反射是球谐，资源管线算好；镜面是按粗糙度预滤波的立方体贴图，运行时第一次用到
 * 时在 GPU 上从 radiance 生成（同 Stride 的 RadiancePrefilteringGGX），不随内容下载。
 */
export interface SkyboxFile {
  /** 3 阶球谐的 9 个 RGB 系数（线性），已经乘过基函数常数，按 Stride 的 EvaluateSphericalHarmonics 求值。 */
  readonly diffuseSH: readonly number[];
  /** 源立方体贴图（内容路径，通常也是背景用的那张），带 mip。 */
  readonly radiance: string;
  /** 预滤波的镜面立方体贴图的边长（2 的幂），同 Stride 的 SkyboxAsset.SpecularCubeMapSize，默认 256。 */
  readonly specularSize: number;
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
