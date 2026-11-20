/**
 * 运行时内容的文件格式，资源管线（Node，packages/pipeline）写，ContentManager 读。这个文件不依赖别的模块，
 * 管线可以直接导入它。资源之间用相对内容根目录的路径引用（不带扩展名），比如 `models/PrototypingBlocks/Wall0x2x5`。
 *
 * - 模型 `<路径>.model`：二进制容器。开头 12 字节是 magic 'SMDL'、版本、JSON 头的字节数，接着是 JSON 头
 *   （网格表和材质槽），补齐到 4 字节，后面是数据区：每个网格的交错顶点（布局见 VertexLayout，一般是量化的 16 字节）
 *   和索引，一般是 meshopt 编码的。解码后直接上传，反量化在顶点着色器里做。
 * - 立方体贴图 `<路径>.cubemap`：同样的容器（magic 'SCUB'），JSON 头是尺寸、级数和纹素格式（RGBA16F 或 RGB9E5），
 *   数据区是各级 mip，每级 6 个面连续（+X -X +Y -Y +Z -Z，行从上到下，WebGPU 的布局），直接上传。
 * - 贴图：`<路径>.ktx2`（KTX2 加 Basis，运行时按设备转码，显存最省），或者下载最小的 `.svg`（矢量，加载时按指定尺寸
 *   栅格化）、`.png`/`.jpg`（浏览器解码），后两种在 GPU 上生成 mip。用哪种写在材质的贴图槽里（TextureSlot.encoding）。
 * - 材质 `<路径>.material.json`、天空盒 `<路径>.skybox.json`、场景 `<路径>.scene.json`、预制体 `<路径>.prefab.json`：
 *   JSON。场景以后改成二进制，物理部分直接是原生能读的布局。
 */

/** 不量化时每个顶点的 float 数：位置 xyz、法线 xyz、UV xy（FLOAT_LAYOUT）。 */
export const VERTEX_FLOATS = 8;

export const MODEL_MAGIC = 0x4c444d53; // 'SMDL'，小端
export const MODEL_VERSION = 3;
export const CUBEMAP_MAGIC = 0x42554353; // 'SCUB'，小端
export const CUBEMAP_VERSION = 1;
export const SKELETON_MAGIC = 0x4c4b5353; // 'SSKL'，小端
export const SKELETON_VERSION = 1;
export const ANIMATION_MAGIC = 0x4d4e4153; // 'SANM'，小端
export const ANIMATION_VERSION = 1;
export const GLYPHS_MAGIC = 0x594c4753; // 'SGLY'，小端
// 2：点是网格上的 16 位整数、存差分，带的字是 16 位
export const GLYPHS_VERSION = 2;

export const EXTENSIONS = {
  model: '.model',
  material: '.material.json',
  scene: '.scene.json',
  prefab: '.prefab.json',
  spriteSheet: '.sheet.json',
  cubemap: '.cubemap',
  skybox: '.skybox.json',
  skeleton: '.skeleton',
  animation: '.anim',
  font: '.font.json',
  /** 单独引用的贴图（脚本属性、合成器的渲染器）：它的 TextureRef，贴图本身在旁边。 */
  texture: '.texture.json',
  gameSettings: '.game.json',
  /** UI 页面或 UI 库（UIFile）。 */
  ui: '.ui.json',
  /** 字体的一个码位块（码位 >> 8）：`<字体>.<块号>.glyphs`。 */
  glyphs: '.glyphs',
  /** 声音（SoundFile），音频文件在旁边。 */
  sound: '.sound.json',
} as const;

/** 浏览器能解的音频格式（声音的源文件原样复制，见 docs/roadmap.md 的 D9）。 */
export type SoundEncoding = 'mp3' | 'ogg' | 'wav' | 'flac' | 'aac';

/**
 * 声音（Stride 的 Sound 资源，.sdsnd）：音频文件是 `<路径>.<encoding>`。streamFromDisk 的边下边放（音乐），其余的先整个解码
 * （音效）；spatialized 的可以按 AudioEmitter 的位置空间化。
 */
export interface SoundFile {
  readonly name: string;
  readonly encoding: SoundEncoding;
  readonly streamFromDisk: boolean;
  readonly spatialized: boolean;
}

/**
 * 交错顶点里每个属性的格式（WebGPU 的顶点格式名），顺序是位置、法线、UV，紧挨着放。
 * - 位置：float32x3，或按模型的包围盒量化的 unorm16x4（w 不用）；
 * - 法线：float32x3，或八面体编码的 snorm16x2；
 * - UV：float32x2，或按网格的 UV 范围量化的 unorm16x2。
 * - 切线（可选，材质有法线贴图的网格才有）：xyz 加手性 w（副切线 = w · cross(法线, 切线)，同 MikkTSpace 和 Stride），
 *   float32x4 或 snorm8x4。
 * - 蒙皮（可选，蒙皮网格才有）：4 个关节下标（网格蒙皮的关节表的下标，见 MeshSkin）uint8x4 或 uint16x4，
 *   4 个权重（和为 1）unorm8x4 或 float32x4。
 * 量化的属性按 Dequantize 还原。
 */
export interface VertexLayout {
  readonly position: 'float32x3' | 'unorm16x4';
  readonly normal: 'float32x3' | 'snorm16x2';
  readonly uv: 'float32x2' | 'unorm16x2';
  readonly tangent?: 'float32x4' | 'snorm8x4';
  readonly joints?: 'uint8x4' | 'uint16x4';
  readonly weights?: 'unorm8x4' | 'float32x4';
}

/** 不量化的布局：32 字节，就是 VERTEX_FLOATS 个 float。程序化网格和 --plain 导出的模型用它。 */
export const FLOAT_LAYOUT: VertexLayout = { position: 'float32x3', normal: 'float32x3', uv: 'float32x2' };
export const TANGENT_FLOATS = 4;

const ATTRIBUTE_BYTES = { float32x4: 16, float32x3: 12, float32x2: 8, unorm16x4: 8, snorm16x2: 4, unorm16x2: 4, snorm8x4: 4, uint8x4: 4, uint16x4: 8, unorm8x4: 4 } as const;

/** 各属性在顶点里的字节偏移和顶点的字节数；没有的可选属性是 undefined。 */
export interface VertexOffsets {
  readonly position: number;
  readonly normal: number;
  readonly uv: number;
  readonly tangent: number | undefined;
  readonly joints: number | undefined;
  readonly weights: number | undefined;
  readonly stride: number;
}

export function vertexLayoutOffsets(layout: VertexLayout): VertexOffsets {
  let at = 0;
  const next = (format: keyof typeof ATTRIBUTE_BYTES | undefined) => {
    if (format === undefined) return undefined;
    const offset = at;
    at += ATTRIBUTE_BYTES[format];
    return offset;
  };
  const position = next(layout.position)!, normal = next(layout.normal)!, uv = next(layout.uv)!;
  const tangent = next(layout.tangent), joints = next(layout.joints), weights = next(layout.weights);
  return { position, normal, uv, tangent, joints, weights, stride: at };
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

/**
 * 网格的蒙皮：顶点的关节下标指向 joints，joints 是模型骨架（ModelHeader.skeleton）的关节下标；inverseBinds 每个关节
 * 一个列主序 4x4（网格的顶点到绑定时的关节空间）。关节的模型矩阵乘逆绑定就是蒙皮矩阵。
 * 没有蒙皮、但挂在骨架节点上的网格（刚性部件）导入成只有一个关节、权重 1 的蒙皮。
 */
export interface MeshSkin {
  readonly joints: readonly number[];
  readonly inverseBinds: readonly number[];
}

/**
 * 网格的形变数据（Stride 的 MeshMorphData：只存目标真的移动了的顶点）。数据区里是一串 uint32：[0] 是第一个条目的下标 e，
 * [1 + v] 到 [2 + v] 是顶点 v 的条目范围（vertexCount + 1 个偏移，条目从 0 数），条目从 e 起，每个 MORPH_ENTRY_WORDS 个数：
 * 位置增量 xyz（float）、模型的目标槽（ModelHeader.morphTargets 的下标）、法线增量 xyz（float，没有时是 0）、0。
 * 条目按顶点再按目标排；增量在网格空间里（量化之前的位置）。
 */
export interface MeshMorph {
  readonly entryCount: number;
  readonly hasNormals: boolean;
}

/** 一个形变条目几个 32 位数。 */
export const MORPH_ENTRY_WORDS = 8;

/** 一个顶点、一个目标的增量（packMeshMorph 的输入）。 */
export interface MorphDelta {
  readonly vertex: number;
  /** 模型的目标槽。 */
  readonly target: number;
  readonly position: readonly [number, number, number];
  readonly normal?: readonly [number, number, number];
}

/** 把增量打包成 MeshMorph 的数据区（按顶点再按目标排）。 */
export function packMeshMorph(vertexCount: number, deltas: readonly MorphDelta[]): { morph: MeshMorph; data: Uint8Array } {
  const sorted = [...deltas].sort((a, b) => a.vertex - b.vertex || a.target - b.target);
  const first = 2 + vertexCount;
  const words = new DataView(new ArrayBuffer((first + sorted.length * MORPH_ENTRY_WORDS) * 4));
  words.setUint32(0, first, true);
  let entry = 0;
  for (let v = 0; v <= vertexCount; v++) {
    while (entry < sorted.length && sorted[entry]!.vertex < v) entry++;
    words.setUint32((1 + v) * 4, entry, true);
  }
  sorted.forEach(({ vertex, target, position, normal }, i) => {
    if (vertex < 0 || vertex >= vertexCount) throw new RangeError(`morph delta for vertex ${vertex} is outside the mesh (${vertexCount} vertices)`);
    const at = (first + i * MORPH_ENTRY_WORDS) * 4;
    position.forEach((value, k) => words.setFloat32(at + k * 4, value, true));
    words.setUint32(at + 12, target, true);
    normal?.forEach((value, k) => words.setFloat32(at + 16 + k * 4, value, true));
  });
  return { morph: { entryCount: sorted.length, hasNormals: sorted.some((d) => d.normal !== undefined) }, data: new Uint8Array(words.buffer) };
}

export interface ModelMeshHeader {
  readonly name: string;
  /** 在模型材质槽里的下标；没有材质时是 null。 */
  readonly material: number | null;
  readonly skin?: MeshSkin;
  /** 形变目标（数据在 morphByteOffset 起的 morphByteLength 个字节里）。 */
  readonly morph?: MeshMorph;
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
  readonly morphByteOffset?: number;
  readonly morphByteLength?: number;
}

export interface ModelHeader {
  readonly meshes: readonly ModelMeshHeader[];
  /** 材质槽：模型自带的材质（内容路径），没有材质的槽是 null。实体可以按槽覆盖。 */
  readonly materials: readonly (string | null)[];
  /** 蒙皮网格用的骨架（内容路径）。 */
  readonly skeleton?: string;
  /** 形变目标的名字，按模型的目标槽排（各网格同名的目标合成一个槽，同 Stride 的 ModelMorphLayout）。 */
  readonly morphTargets?: readonly string[];
}

/** 一个网格的数据：vertices、indices 是文件里的字节（压缩时是编码后的流，解码见 ContentManager）。 */
export interface ModelMeshData extends Omit<ModelMeshHeader, 'vertexByteOffset' | 'vertexByteLength' | 'indexByteOffset' | 'indexByteLength' | 'morphByteOffset' | 'morphByteLength'> {
  readonly vertices: Uint8Array;
  readonly indices: Uint8Array;
  /** 形变数据（布局见 MeshMorph）。 */
  readonly morphData?: Uint8Array;
}

export interface ModelData {
  readonly meshes: readonly ModelMeshData[];
  readonly materials: readonly (string | null)[];
  readonly skeleton?: string;
  readonly morphTargets?: readonly string[];
}

/** plainMesh 的可选属性。 */
export interface PlainMeshExtras {
  /** 每个顶点 TANGENT_FLOATS 个。 */
  readonly tangents?: Float32Array;
  /** 蒙皮：关节表、逆绑定，和每个顶点 4 个关节下标（joints 的下标）、4 个权重。 */
  readonly skin?: MeshSkin & { readonly vertexJoints: Uint16Array; readonly vertexWeights: Float32Array };
}

/**
 * 不量化、不压缩的网格（FLOAT_LAYOUT）：程序化网格、--plain 导出和测试用。给了切线时交错进顶点（float32x4），
 * 给了蒙皮时再加 uint16x4 的关节下标和 float32x4 的权重。
 */
export function plainMesh(name: string, material: number | null, vertices: Float32Array, indices: Uint16Array | Uint32Array, { tangents, skin }: PlainMeshExtras = {}): ModelMeshData {
  if (vertices.length % VERTEX_FLOATS !== 0) throw new RangeError(`model mesh '${name}': vertices must hold ${VERTEX_FLOATS} floats per vertex`);
  const count = vertices.length / VERTEX_FLOATS;
  if (tangents && tangents.length !== count * TANGENT_FLOATS) throw new RangeError(`model mesh '${name}': tangents must hold ${TANGENT_FLOATS} floats per vertex`);
  if (skin && (skin.vertexJoints.length !== count * 4 || skin.vertexWeights.length !== count * 4)) throw new RangeError(`model mesh '${name}': skin needs 4 joints and 4 weights per vertex`);
  const layout: VertexLayout = {
    ...FLOAT_LAYOUT,
    ...(tangents ? { tangent: 'float32x4' as const } : {}),
    ...(skin ? { joints: 'uint16x4' as const, weights: 'float32x4' as const } : {}),
  };
  const offsets = vertexLayoutOffsets(layout);
  const bytes = new DataView(new ArrayBuffer(count * offsets.stride));
  for (let v = 0; v < count; v++) {
    const at = v * offsets.stride;
    for (let k = 0; k < VERTEX_FLOATS; k++) bytes.setFloat32(at + k * 4, vertices[v * VERTEX_FLOATS + k]!, true);
    if (tangents) for (let k = 0; k < TANGENT_FLOATS; k++) bytes.setFloat32(at + offsets.tangent! + k * 4, tangents[v * TANGENT_FLOATS + k]!, true);
    if (skin) {
      for (let k = 0; k < 4; k++) {
        bytes.setUint16(at + offsets.joints! + k * 2, skin.vertexJoints[v * 4 + k]!, true);
        bytes.setFloat32(at + offsets.weights! + k * 4, skin.vertexWeights[v * 4 + k]!, true);
      }
    }
  }
  return {
    name,
    material,
    ...(skin ? { skin: { joints: skin.joints, inverseBinds: skin.inverseBinds } } : {}),
    layout,
    dequantize: IDENTITY_DEQUANTIZE,
    compression: 'none',
    vertexCount: count,
    indexCount: indices.length,
    indexFormat: indices instanceof Uint16Array ? 'uint16' : 'uint32',
    vertices: new Uint8Array(bytes.buffer),
    indices: byteView(indices),
  };
}

const align4 = (n: number) => (n + 3) & ~3;

export function encodeModel(model: ModelData): Uint8Array {
  let offset = 0;
  const meshes: ModelMeshHeader[] = model.meshes.map(({ vertices, indices, morphData, ...mesh }) => {
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
    if (!mesh.morph !== !morphData) throw new RangeError(`model mesh '${mesh.name}': morph and morphData go together`);
    const morphByteOffset = offset;
    if (morphData) offset = align4(offset + morphData.byteLength);
    return {
      ...mesh, vertexByteOffset, vertexByteLength: vertices.byteLength, indexByteOffset, indexByteLength: indices.byteLength,
      ...(morphData ? { morphByteOffset, morphByteLength: morphData.byteLength } : {}),
    };
  });
  const header: ModelHeader = {
    meshes, materials: model.materials, ...(model.skeleton ? { skeleton: model.skeleton } : {}), ...(model.morphTargets ? { morphTargets: model.morphTargets } : {}),
  };
  const { bytes, dataStart } = encodeContainer(MODEL_MAGIC, MODEL_VERSION, header, offset);
  model.meshes.forEach((mesh, i) => {
    const header = meshes[i]!;
    bytes.set(mesh.vertices, dataStart + header.vertexByteOffset);
    bytes.set(mesh.indices, dataStart + header.indexByteOffset);
    if (mesh.morphData) bytes.set(mesh.morphData, dataStart + header.morphByteOffset!);
  });
  return bytes;
}

/** 读模型文件；顶点和索引是 buffer 上的视图，不拷贝。 */
export function decodeModel(buffer: ArrayBuffer, source = 'model'): ModelData {
  const { header, dataStart } = decodeContainer<ModelHeader>(buffer, MODEL_MAGIC, MODEL_VERSION, 'model', source);
  return {
    materials: header.materials,
    ...(header.skeleton ? { skeleton: header.skeleton } : {}),
    ...(header.morphTargets ? { morphTargets: header.morphTargets } : {}),
    meshes: header.meshes.map(({ vertexByteOffset, vertexByteLength, indexByteOffset, indexByteLength, morphByteOffset, morphByteLength, ...mesh }) => ({
      ...mesh,
      vertices: new Uint8Array(buffer, dataStart + vertexByteOffset, vertexByteLength),
      indices: new Uint8Array(buffer, dataStart + indexByteOffset, indexByteLength),
      ...(morphByteOffset !== undefined ? { morphData: new Uint8Array(buffer, dataStart + morphByteOffset, morphByteLength) } : {}),
    })),
  };
}

/** 骨架的关节（深度优先，父关节在前）；数据区是 ozz 的骨架档案（运行时交给 stride-native）。 */
export interface SkeletonHeader {
  readonly joints: readonly { readonly name: string; readonly parent: number }[];
}

export interface SkeletonData extends SkeletonHeader {
  /** ozz 的骨架档案。 */
  readonly archive: Uint8Array;
}

/** 播放到头之后怎么办（Stride 的 AnimationRepeatMode）。 */
export type AnimationRepeatMode = 'playOnce' | 'loopInfinite' | 'playOnceHold';

/** 形变权重的一条曲线：按目标名对上模型的目标表，线性插值。 */
export interface MorphWeightCurve {
  readonly target: string;
  readonly times: readonly number[];
  readonly values: readonly number[];
}

/** 动画剪辑；数据区是 ozz 的动画档案，轨道按骨架的关节顺序（只有形变权重、没有骨架的剪辑数据区是空的）。 */
export interface AnimationHeader {
  /** 秒。 */
  readonly duration: number;
  readonly repeatMode: AnimationRepeatMode;
  /** 剪辑对应的骨架（内容路径）；只动形变权重的剪辑（MorphTargets 的立方体）没有。 */
  readonly skeleton?: string;
  readonly morphWeights?: readonly MorphWeightCurve[];
}

export interface AnimationData extends AnimationHeader {
  readonly archive: Uint8Array;
}

export function encodeSkeleton({ archive, ...header }: SkeletonData): Uint8Array {
  return encodeBlob(SKELETON_MAGIC, SKELETON_VERSION, header satisfies SkeletonHeader, archive);
}

export function decodeSkeleton(buffer: ArrayBuffer, source = 'skeleton'): SkeletonData {
  const { header, blob } = decodeBlob<SkeletonHeader>(buffer, SKELETON_MAGIC, SKELETON_VERSION, 'skeleton', source);
  return { ...header, archive: blob };
}

export function encodeAnimation({ archive, ...header }: AnimationData): Uint8Array {
  return encodeBlob(ANIMATION_MAGIC, ANIMATION_VERSION, header satisfies AnimationHeader, archive);
}

export function decodeAnimation(buffer: ArrayBuffer, source = 'animation'): AnimationData {
  const { header, blob } = decodeBlob<AnimationHeader>(buffer, ANIMATION_MAGIC, ANIMATION_VERSION, 'animation', source);
  return { ...header, archive: blob };
}

/** JSON 头加一整块数据的容器（骨架、动画）。 */
function encodeBlob(magic: number, version: number, header: object, blob: Uint8Array): Uint8Array {
  const { bytes, dataStart } = encodeContainer(magic, version, header, blob.byteLength);
  bytes.set(blob, dataStart);
  return bytes;
}

function decodeBlob<H>(buffer: ArrayBuffer, magic: number, version: number, kind: string, source: string): { header: H; blob: Uint8Array } {
  const { header, dataStart } = decodeContainer<H>(buffer, magic, version, kind, source);
  return { header, blob: new Uint8Array(buffer, dataStart) };
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

/**
 * 贴图文件的编码：ktx2（Basis，运行时转码成 GPU 压缩格式），svg（矢量，加载时栅格化），png、jpeg（浏览器解码）。
 * 后三种在显存里是未压缩的 RGBA8，换来的是更小的下载。
 */
export type TextureEncoding = 'ktx2' | 'svg' | 'png' | 'jpeg';

export const TEXTURE_EXTENSIONS: Readonly<Record<TextureEncoding, string>> = { ktx2: '.ktx2', svg: '.svg', png: '.png', jpeg: '.jpg' };

/** 一张贴图文件：内容路径和编码。 */
export interface TextureRef {
  /** 贴图的内容路径，文件是 `<路径><TEXTURE_EXTENSIONS[encoding]>`。 */
  readonly texture: string;
  /** 默认 ktx2。 */
  readonly encoding?: TextureEncoding;
  /** svg 栅格化的尺寸（像素），默认取 SVG 的 width、height。 */
  readonly size?: readonly [number, number];
  /** 按 sRGB 采样（Stride 的贴图类型决定）；没写时按用途：颜色贴图是，法线、遮蔽这些数据贴图不是。 */
  readonly srgb?: boolean;
  /**
   * 颜色树里采样时把绿色通道翻过来（g 换成 1 - g）：法线贴图的 InvertY（Stride 的 NormalMapTextureType，默认 true）。
   * Stride 在编译贴图时翻，我们的贴图照源文件，所以在采样的地方翻；固定槽的法线贴图用 NormalMapSlot.invertY。
   */
  readonly invertY?: boolean;
}

/** 采样器（Stride 的 ComputeTextureBase.Filtering、AddressModeU/V）：没写的是线性三线性过滤、重复寻址。 */
export interface TextureSampler {
  readonly filter?: 'point' | 'anisotropic';
  /** Stride 的 Clamp、Border 都是 clamp（WebGPU 没有边框色），Mirror、MirrorOnce 都是 mirror。 */
  readonly addressU?: 'clamp' | 'mirror';
  readonly addressV?: 'clamp' | 'mirror';
}

export interface TextureSlot extends TextureRef, TextureSampler {
  /** 采样坐标 = uv * scale + offset（scale 已经乘上 Stride 材质的 UVScale）。 */
  readonly scale: readonly [number, number];
  readonly offset: readonly [number, number];
}

/**
 * 法线贴图（Stride 的 MaterialNormalMapFeature）：贴图是线性的；scaleAndBias 把 0..1 映射到 -1..1，isXYNormal 只用 xy、
 * z 由单位长度算出，invertY 把 y 取反（Stride 的 NormalMapTextureType.InvertY 在导入时翻转绿色通道，这里在采样后做，
 * 结果一样）。网格要有切线。
 */
export interface NormalMapSlot extends TextureSlot {
  readonly scaleAndBias: boolean;
  readonly isXYNormal: boolean;
  readonly invertY: boolean;
}

/**
 * 一个材质层（Stride 的 MaterialBlendLayer）：子材质的各个属性按遮罩 blend（0 到 1）线性混进下面的结果（Stride 的
 * MaterialStreamLinearBlend）。子材质没有的属性不改；都是颜色树，运行时编译。
 */
export interface MaterialLayerFile {
  /** 遮罩（BlendMap，标量树）。 */
  readonly blend: ParticleModuleFile;
  readonly diffuse?: ParticleModuleFile;
  /** 镜面颜色工作流：颜色乘强度。 */
  readonly specular?: { readonly color: ParticleModuleFile; readonly intensity: ParticleModuleFile };
  /** 金属度工作流。 */
  readonly metalness?: ParticleModuleFile;
  /** 光泽度（invert 时存的是粗糙度）。 */
  readonly glossiness?: { readonly tree: ParticleModuleFile; readonly invert: boolean };
  /** 切线空间的法线（规则同 MaterialFile.normalTree）。 */
  readonly normal?: { readonly tree: ParticleModuleFile; readonly scaleAndBias: boolean; readonly isXYNormal: boolean };
  /** 自发光：颜色乘强度（下面没有自发光时是 0 往上混）。 */
  readonly emissive?: { readonly tree: ParticleModuleFile; readonly intensity: number };
  /**
   * 环境光遮蔽（Occlusion 特性的 AmbientOcclusionMap，标量树）和直射光受它影响的程度（DirectLightingFactor）；
   * 下面没有遮蔽时是从 1、0 往上混。
   */
  readonly occlusion?: { readonly tree: ParticleModuleFile; readonly directLighting: number };
}

/** 法线贴图的颜色树和它的两个开关（意思同 NormalMapSlot）。 */
export interface NormalTreeFile {
  readonly tree: ParticleModuleFile;
  readonly scaleAndBias: boolean;
  readonly isXYNormal: boolean;
}

/**
 * 清漆（Stride 的 MaterialClearCoatFeature，车漆）：两遍。底下一遍是金属碎片和底漆：漫反射色和光泽度按到相机的距离从碎片过渡到
 * 底漆（过渡量 = saturate(距离 × lodDistance)），法线是碎片的法线贴图，金属度是碎片的；上面一遍画在透明阶段、加到画面上：
 * 材质自己的漫反射色配清漆的金属度、光泽度和橘皮法线。都是颜色树；invert 时光泽度的树存的是粗糙度。
 */
export interface ClearCoatFile {
  readonly lodDistance: ParticleModuleFile;
  readonly basePaint: { readonly diffuse: ParticleModuleFile; readonly glossiness: ParticleModuleFile; readonly invert: boolean };
  readonly metalFlakes: { readonly diffuse: ParticleModuleFile; readonly glossiness: ParticleModuleFile; readonly invert: boolean; readonly metalness: ParticleModuleFile; readonly normal: NormalTreeFile };
  readonly coat: { readonly glossiness: ParticleModuleFile; readonly invert: boolean; readonly metalness: ParticleModuleFile; readonly normal: NormalTreeFile };
}

export interface MaterialFile {
  readonly name: string;
  /** 线性颜色。没有贴图时就是漫反射颜色，有贴图时按 baseColorOperator 和贴图组合。 */
  readonly baseColor: readonly [number, number, number, number];
  readonly baseColorTexture?: TextureSlot;
  /** 默认 multiply（baseColor 是白色时就是贴图本身）。 */
  readonly baseColorOperator?: ColorOperator;
  /** 金属度工作流（Stride 的 MaterialMetalnessMapFeature）；没有时材质没有镜面反射（除非有 specular）。 */
  readonly metalness?: number;
  /** 镜面工作流（Stride 的 MaterialSpecularMapFeature）：镜面颜色乘强度，线性；和 metalness 二选一。 */
  readonly specular?: Vec3Tuple;
  /** 镜面工作流不守恒能量（Stride 的 IsEnergyConservative 是 false）：漫反射不乘 1 - 镜面。默认守恒。 */
  readonly specularEnergyConservative?: false;
  /**
   * 没有镜面着色模型（Stride 的 SpecularModel 是空的，SamplesAssetPackage 的木地板 board1B）：不画镜面反射，但金属度、镜面颜色
   * 照常折进漫反射（金属没有漫反射、能量守恒时乘 1 - 镜面）。默认有。
   */
  readonly specularShading?: false;
  /** 没有漫反射着色模型（Stride 的 DiffuseModel 是空的）：不算漫反射光照，漫反射的颜色只当玻璃的颜色这类用途。默认有。 */
  readonly diffuseShading?: false;
  /**
   * 玻璃（Stride 的 MaterialSpecularThinGlassModelFeature）：画在透明阶段，先把透过去的比例乘到背景上，再把反射加上去；
   * 两个比例按折射率、视角和玻璃的颜色（漫反射的颜色）算。doubleSided 时背面和正面各画一次，能看到玻璃的里面。
   */
  readonly glass?: { readonly refractiveIndex: number };
  /** 清漆，见 ClearCoatFile。 */
  readonly clearCoat?: ClearCoatFile;
  /**
   * 次表面散射（Stride 的 MaterialSubsurfaceScatteringFeature 和皮肤散射核）：width 是散射宽度（世界单位），translucency 是
   * 透光度，strength、falloff 是散射核的强度和衰减（各通道）。意思同 rendering/Material.ts 的 MaterialSubsurfaceScattering。
   */
  readonly subsurfaceScattering?: { readonly width: number; readonly translucency: number; readonly strength: Vec3Tuple; readonly falloff: Vec3Tuple };
  /** 1 - 光泽度；没有时是 1（Stride 的默认光泽度 0）。有 glossinessTexture 时不看它。 */
  readonly roughness?: number;
  /**
   * 光泽度贴图（Stride 的 MaterialGlossinessMapFeature 的 ComputeTextureScalar）：光泽度 = 贴图的 channel 通道，粗糙度 =
   * 1 - 光泽度；invert 时贴图存的就是粗糙度（Stride 的 Invert）。
   */
  readonly glossinessTexture?: TextureSlot & { readonly channel: 'r' | 'g' | 'b' | 'a'; readonly invert: boolean };
  /** 自发光：线性颜色乘强度；有 emissiveTexture 时再乘贴图（Stride 的 ComputeBinaryColor 乘法）。 */
  readonly emissive?: Vec3Tuple;
  readonly emissiveTexture?: TextureSlot;
  /**
   * 化不成"贴图乘颜色"的自发光（比如有着色器类）：整棵颜色树（格式同粒子材质的，见 ParticleModuleFile），运行时编译成 WGSL；
   * 有它时不看 emissive、emissiveTexture。useAlpha：输出的 alpha 用自发光的 alpha（Stride 的 UseAlpha）。
   */
  /**
   * 法线贴图是颜色树（MaterialNormalMapFeature 的 NormalMap 是着色器类这样的树，MaterialShader 的 ComputeColorWaveNormal）：
   * 在片元着色器里算，ScaleAndBias、IsXYNormal 同 normalMap。
   */
  readonly normalTree?: { readonly tree: ParticleModuleFile; readonly scaleAndBias: boolean; readonly isXYNormal: boolean };
  /**
   * 位移贴图（MaterialDisplacementMapFeature，Stage 是 Vertex）：顶点沿模型空间的法线移动 树的值 × intensity
   * （scaleAndBias 时值先从 0..1 换到 -1..1）。
   */
  readonly displacementTree?: { readonly tree: ParticleModuleFile; readonly intensity: number; readonly scaleAndBias: boolean };
  readonly emissiveTree?: { readonly tree: ParticleModuleFile; readonly intensity: number; readonly useAlpha: boolean };
  /**
   * 材质层（Stride 的 MaterialBlendLayer），按顺序叠在这个材质上面。材质自己的属性化不成上面那些固定的形状时（光泽度是
   * "贴图乘数"、镜面带贴图……），导入器把这些属性的树放进最底下一层、遮罩是常量 1 的层里：和材质层走同一条路径，盖住固定槽的值。
   */
  readonly layers?: readonly MaterialLayerFile[];
  /** 两面都画（Stride 的 CullMode 是 None）。 */
  readonly doubleSided?: boolean;
  /** 环境光遮蔽（Stride 的 Occlusion 特性的 AmbientOcclusionMap）。 */
  readonly ambientOcclusion?: AmbientOcclusionSlot;
  /** 透明（Stride 的 MaterialTransparencyBlendFeature）：预乘 alpha 混合，画在透明阶段。 */
  readonly transparency?: TransparencyFile;
  /** Alpha 裁剪（Stride 的 MaterialTransparencyCutoffFeature 的 Alpha）：基础色的 alpha 低于它的像素丢掉，材质仍是不透明的。 */
  readonly alphaCutoff?: number;
  /** Stride 的 Occlusion 特性里的 cavity：漫反射和镜面的可见部分乘上这两个系数。 */
  readonly cavity?: { readonly diffuse: number; readonly specular: number };
  readonly normalMap?: NormalMapSlot;
}

export type Vec3Tuple = readonly [number, number, number];

/**
 * 环境光遮蔽：遮蔽值 = 贴图的 channel 通道（没有贴图时是 value）。环境光（环境色、天空盒）乘遮蔽值，直射光乘
 * lerp(1, 遮蔽值, directLighting)（Stride 的 MaterialPixelStream、LightSkyboxShader）。
 */
export interface AmbientOcclusionSlot {
  readonly value: number;
  readonly texture?: TextureSlot & { readonly channel: 'r' | 'g' | 'b' | 'a' };
  readonly directLighting: number;
}

/**
 * 透明混合：可见的漫反射乘 alpha、镜面乘 specularAlpha（默认同 alpha），都乘 tint，输出的 alpha 是漫反射的 alpha 乘 alpha
 * （Stride 的预乘 alpha 和 matDiffuseSpecularAlphaBlend）。Stride 的加法透明（MaterialTransparencyAdditiveFeature）也是它：
 * alpha = max(0, 2a - 1)、specularAlpha = min(1, 2a)，a 是 0.5 时完全是加法。
 */
export interface TransparencyFile {
  readonly type: 'blend';
  readonly alpha: number;
  readonly specularAlpha?: number;
  /** 线性颜色，默认白色。 */
  readonly tint?: Vec3Tuple;
}

/** 方向光的阴影设置（Stride 的 LightDirectionalShadowMap），各字段的意思见 Light 组件。 */
export interface SceneLightShadow {
  readonly size: 'xsmall' | 'small' | 'medium' | 'large' | 'xlarge';
  readonly filter: 'none' | 'pcf3x3' | 'pcf5x5' | 'pcf7x7' | 'pcss';
  readonly cascadeCount: 'one' | 'two' | 'four';
  readonly depthBias: number;
  readonly normalOffsetScale: number;
  readonly stabilization: 'none' | 'viewSnapping' | 'projectionSnapping';
  readonly pssmFactor: number;
  readonly depthRange: 'automatic' | 'manual';
  readonly minDistance: number;
  readonly maxDistance: number;
  readonly blendCascades: boolean;
  /** 光源的角直径（度），pcss 用；没写是 0.53（太阳）。Stride 没有。 */
  readonly lightAngle?: number;
}

/**
 * 点光、聚光的阴影设置（Stride 的 LightPointShadowMap、LightStandardShadowMap）。点光的阴影是立方体的六个面；
 * 和 Stride 不同：Stride 可以选抛物面的画法（LightPointShadowMapType.DualParaboloid），我们都按立方体画。
 */
export type SceneLocalLightShadow = Pick<SceneLightShadow, 'size' | 'filter' | 'depthBias' | 'normalOffsetScale'>;

/** 碰撞体里的一个形状（Stride.BepuPhysics 的 BoxCollider、CapsuleCollider…… 加 CompoundCollider 的本地位姿）。 */
export type ColliderShapeFile = (
  | { readonly type: 'box'; /** 边长。 */ readonly size: Vec3Tuple }
  /** Stride 的 EmptyCollider：没有形状、不碰撞，只能单独用。 */
  | { readonly type: 'empty' }
  | { readonly type: 'sphere'; readonly radius: number }
  /** 沿本地 Y，length 是两端球心的距离。 */
  | { readonly type: 'capsule'; readonly radius: number; readonly length: number }
  | { readonly type: 'cylinder'; readonly radius: number; readonly length: number }
  /** Stride 的 MeshCollider：模型（内容路径）的全部三角形，按实体的世界缩放。 */
  | { readonly type: 'mesh'; readonly model: string }
  /**
   * Stride 的 ConvexHullCollider 加 HullAsset（不做分解）：模型（内容路径）全部顶点的凸包，顶点先按 hull 的 scale、rotation、
   * offset 变换（HullAsset 的 Scaling、LocalRotation、LocalOffset），按实体的世界缩放。
   */
  | {
    readonly type: 'convexHull';
    readonly model: string;
    readonly hull: { readonly scale: Vec3Tuple; readonly rotation: readonly [number, number, number, number]; readonly offset: Vec3Tuple };
  }
) & {
  readonly position: Vec3Tuple;
  readonly rotation: readonly [number, number, number, number];
  readonly mass: number;
};

/** 物理物体的公共部分（Stride 的 CollidableComponent）。 */
export interface SceneCollidable {
  readonly shapes: readonly ColliderShapeFile[];
  /** CollisionLayer，0..31。 */
  readonly layer: number;
  readonly friction: number;
  /** ContactEventHandler 是 Stride 的 Trigger。 */
  readonly trigger?: boolean;
}

/** Stride.BepuPhysics 的 BodyComponent：动态（或运动学）刚体。 */
export interface SceneBody extends SceneCollidable {
  readonly kinematic: boolean;
  readonly gravity: boolean;
  /** SleepThreshold；负数一直醒着。 */
  readonly sleepThreshold: number;
  readonly interpolated: boolean;
}

/** Stride 的 CharacterComponent。 */
export interface SceneCharacter extends SceneCollidable {
  readonly speed: number;
  readonly jumpForce: number;
  readonly maximumHorizontalForce: number;
  readonly maximumVerticalForce: number;
  readonly slopeAngle: number;
  readonly airControlForceScale: number;
  readonly airControlScale: number;
  readonly gravity: boolean;
  readonly interpolated: boolean;
}

/** 前向渲染器的设置（Stride 的 ForwardRenderer）。 */
export interface SceneForwardRenderer {
  /** 线性空间的清屏色。 */
  readonly clearColor: readonly [number, number, number, number];
  /** 后处理（Stride 的 ForwardRenderer.PostEffects）；null 是没有后处理。 */
  readonly postEffects: ScenePostEffects | null;
  /** 这台相机画哪些渲染组（Stride 的 SceneCameraRenderer.RenderMask，第 g 位是第 g 组）；没写是全部。 */
  readonly renderMask?: number;
  /** 画不画透明阶段（Stride 的 TransparentRenderStage 不为 null）；画进渲染目标贴图的常常不画，贴图里就不会再出现贴图自己。 */
  readonly transparent: boolean;
  /** 次表面散射的模糊（Stride 的 ForwardRenderer.SubsurfaceScatteringBlurEffect 不为 null）；没写是关着。 */
  readonly subsurfaceScattering?: true;
}

/** 后处理里各效果开不开（Stride 的 PostProcessingEffects 下各效果的 Enabled），只有运行时有的效果。 */
export interface ScenePostEffects {
  readonly brightFilter: boolean;
  readonly bloom: boolean;
  readonly lightStreak: boolean;
  readonly lensFlare: boolean;
  /** 色调映射（ColorTransforms 里的 ToneMap）；关掉时 HDR 画面加上泛光等叠加层直接输出，超过 1 的截断。 */
  readonly toneMap: boolean;
  /** FXAA（Antialiasing）。 */
  readonly antialiasing: boolean;
  /** 环境光遮蔽（AmbientOcclusion，我们用 GTAO 只乘环境光）；没写是关着。radius 是 Stride 的 ParamRadius（世界单位）。 */
  readonly ambientOcclusion?: { readonly radius: number };
  /**
   * 屏幕空间反射（LocalReflections，见 rendering/ScreenSpaceReflections.ts）；没写是关着。maxRoughness 是 1 减 Stride 的
   * GlossinessThreshold，edgeFade 是它的 EdgeFadeFactor。
   */
  readonly localReflections?: { readonly maxRoughness: number; readonly edgeFade: number };
}

/** 渲染目标贴图（Stride 的 RenderTexture，.sdrendertex）：合成器里的相机画进去，精灵可以显示它。按内容路径区分。 */
export interface SceneRenderTexture {
  readonly renderTexture: string;
  readonly width: number;
  readonly height: number;
  /** Stride 的 Format：HDR 是 16 位浮点，LDR 是 8 位。 */
  readonly hdr: boolean;
  /** LDR 时按 sRGB 存（Stride 的 UseSRgbSampling）。 */
  readonly srgb: boolean;
}

/** 合成器里画进渲染目标贴图的相机（Stride 的 SceneCameraRenderer 加 RenderTextureSceneRenderer）。 */
export interface SceneTextureCamera extends SceneForwardRenderer {
  /** 相机槽位（Camera.slot）。 */
  readonly cameraSlot: number;
  readonly texture: SceneRenderTexture;
}

/** 场景用的图形合成器：主画面（槽位 0 的相机）的前向渲染器设置，和先画好的渲染目标贴图。 */
export interface SceneCompositor extends SceneForwardRenderer {
  readonly textureCameras?: readonly SceneTextureCamera[];
  /** false：整个合成器不画阴影（Stride 的 ForwardLightingRenderFeature 没有 ShadowMapRenderer）。没写是画。 */
  readonly shadows?: false;
  /**
   * true：粒子画在 UI 上面（Stride 的合成器把粒子放进自己的渲染阶段，在前向渲染器之后用 SingleStageRenderer 画，UIParticles）。
   * 没写时粒子在场景的透明阶段里。
   */
  readonly particlesOverUI?: true;
  /**
   * 网格用的效果（Stride 合成器里 MeshRenderFeature 的 EffectName，不是默认的 StrideForwardShadingEffect 时），运行时按名字对上
   * 游戏导出的 meshEffect（SpaceEscape 的 SpaceEscapeEffectMain）。没写是默认效果。
   */
  readonly meshEffect?: string;
}

/**
 * 粒子模块里的值：数字、布尔、字符串（枚举，首字母小写；名字原样）、数组（向量、四元数、颜色）、贴图、对实体（或它的组件）
 * 的引用、嵌套的模块、模块的列表。
 */
export type ParticleValue =
  | number | boolean | string | null | readonly number[] | TextureRef | { readonly $entity: string } | ParticleModuleFile | readonly ParticleModuleFile[];

/**
 * 粒子系统里的一个对象（Stride 的 ParticleSystemComponent、ParticleSystem、发射器、生成器、初始化器、更新器、形状、材质……）：
 * $type 是 Stride 的类名首字母小写（发射器这种不带类型标签的没有），其余是属性，名字首字母小写，没写的用 Stride 的默认值。
 * 向量、四元数、颜色是数组（颜色原样，不换色彩空间），贴图是 TextureRef，Spawners、Initializers、Updaters、Emitters 是数组。
 * 导入器只留下运行时认识的模块类型（见 pipeline 的 particles.ts），其余的警告后去掉。
 */
export interface ParticleModuleFile {
  readonly $type?: string;
  readonly [key: string]: ParticleValue | undefined;
}

/** 精灵的混合方式（Stride 的 SpriteBlend；auto 是贴图透明时 alphaBlend，不透明时 none）。 */
export type SpriteBlend = 'auto' | 'none' | 'alphaBlend' | 'additiveBlend' | 'noColor';

/** 精灵（Stride 的 SpriteComponent）：一整张贴图（SpriteFromTexture）或精灵表里的一个精灵（SpriteFromSheet）。 */
export type SceneSprite = SceneSpriteSettings & (SceneSpriteFromTexture | SceneSpriteFromSheet);

export interface SceneSpriteFromTexture {
  readonly texture: TextureRef | SceneRenderTexture;
  /** 贴图的几个像素是 1 个单位。 */
  readonly pixelsPerUnit: number;
  /** 精灵的原点（实体的位置）在贴图上的像素位置：centerFromMiddle 时从贴图中心算，否则从左上角算。 */
  readonly center: readonly [number, number];
  readonly centerFromMiddle: boolean;
}

export interface SceneSpriteFromSheet {
  /** 精灵表的内容路径（`.sheet.json`）。 */
  readonly sheet: string;
  /** 默认显示第几个精灵（Stride 的 CurrentFrame）。 */
  readonly frame: number;
}

export interface SceneSpriteSettings {
  /** 没写是 true（Stride 的 Enabled）。 */
  readonly enabled?: boolean;
  /** 渲染组（Stride 的 RenderGroup，0 到 31）；没写是 0。 */
  readonly renderGroup?: number;
  /** billboard 一直朝着相机。 */
  readonly type: 'sprite' | 'billboard';
  /** 乘在贴图上的颜色（RGBA）和强度。 */
  readonly color: readonly [number, number, number, number];
  readonly intensity: number;
  readonly isTransparent: boolean;
  readonly premultipliedAlpha: boolean;
  readonly ignoreDepth: boolean;
  readonly isAlphaCutoff: boolean;
  readonly blendMode: SpriteBlend;
  readonly sampler: 'linearClamp' | 'pointClamp' | 'anisotropicClamp';
}

/** 精灵表（Stride 的 SpriteSheet，.sdsheet）：按 Stride 里的顺序列出精灵。 */
export interface SpriteSheetFile {
  readonly name: string;
  readonly sprites: readonly {
    readonly name: string;
    /** 精灵所在的贴图（按 sRGB 采样）。同一张源图的精灵共用一张贴图。 */
    readonly texture: TextureRef;
    /** 贴图上的区域，像素：x、y（左上角）、宽、高。 */
    readonly region: readonly [number, number, number, number];
    readonly pixelsPerUnit: number;
    /** 原点在区域里的像素位置：centerFromMiddle 时从区域中心算，否则从左上角算。 */
    readonly center: readonly [number, number];
    readonly centerFromMiddle: boolean;
    /** 九宫格的边框（Stride 的 Sprite.Borders），像素：左、上、右、下；没有时是 0（整张拉伸）。 */
    readonly borders?: readonly [number, number, number, number];
  }[];
}

/**
 * 字体（Stride 的 SpriteFont，.sdfnt）：字形是轮廓（矢量文字，见 rendering/text），按码位分块存在旁边的 .glyphs 文件里，
 * 用到哪块才下载哪块。长度单位都是 em（字号是 1 像素时的像素数），y 向上。
 */
export interface FontFile {
  readonly name: string;
  /**
   * Stride 的字体类型：static 是编译期栅格化的（OfflineRasterized，只有导入时列出的字符，画的时候按 size，不能换字号），
   * dynamic 是运行时栅格化的（RuntimeRasterized，字体里的所有字符，字号可变），sdf 是有向距离场的（字号可变）。
   * 我们都按轮廓画，区别只在字符集和能不能换字号。
   */
  readonly kind: 'static' | 'dynamic' | 'sdf';
  /** 默认字号（像素，Stride 的 Size）。 */
  readonly size: number;
  /** aliased 时覆盖率按 0.5 取舍（没有抗锯齿）；clearType 在 Stride 里已经升级成灰度，和 default 一样。 */
  readonly antiAlias: 'default' | 'aliased' | 'clearType';
  /**
   * 字体要求栅格化时把 ppem（每 em 的像素数）取整（head 表 flags 的第 3 位，Arial 这些 TrueType 字体都有）：Stride 用的 FreeType
   * 开着 hinting，照做，字号 33.33 的字按 33 画、按 33 排，见 rendering/text/layout.ts 的 glyphScale。
   */
  readonly integerPpem: boolean;
  /** 字体的上升、下降（都是正数）和行间距（hhea）。 */
  readonly ascent: number;
  readonly descent: number;
  readonly lineGap: number;
  /** Stride 的 Spacing（字符之间额外的距离）和 LineSpacing（行之间额外的距离），像素，按 size 定的。 */
  readonly spacing: number;
  readonly lineSpacing: number;
  /** Stride 的 LineGapFactor、LineGapBaseLineFactor。 */
  readonly lineGapFactor: number;
  readonly lineGapBaseLineFactor: number;
  /** 找不到字形时用的字符（Stride 的 DefaultCharacter）。 */
  readonly defaultCharacter: number;
  /** 有字形的码位块（码位 >> 8），升序。 */
  readonly blocks: readonly number[];
  /** kern 表的字距，每三个一组：左边的码位、右边的码位、调整量（em）；按左、右码位排序。 */
  readonly kerning: readonly number[];
}

/** 一个码位块里的字形（Slug 的数据，见 pipeline 的 font.ts）。 */
export interface GlyphBlock {
  /** 每个字形 GLYPH_WORDS 个字，见 GLYPH_RECORD。 */
  readonly glyphs: ArrayBuffer;
  readonly glyphCount: number;
  /** 点（x、y 交替，em），字形的点从 pointStart 起。 */
  readonly points: Float32Array;
  /** 带的头和曲线表，字形的带从 bandStart 起，里面的偏移和点下标都相对字形。 */
  readonly bands: Uint32Array;
  /** 点所在网格的步长（em）：文件里点存成这个步长的 16 位整数，见 encodeGlyphBlock。 */
  readonly pointStep: number;
}

/** 字形记录里每个字的位置（u32 和 f32 混着放）。 */
export const GLYPH_RECORD = {
  codepoint: 0,
  advance: 1,
  /** x0 y0 x1 y1，em。 */
  bounds: 2,
  /** 竖带、横带的 em 坐标到带下标的缩放和偏移：scaleX scaleY offsetX offsetY。 */
  bandTransform: 6,
  pointStart: 10,
  bandStart: 11,
  hBands: 12,
  vBands: 13,
} as const;
export const GLYPH_WORDS = 16;

/**
 * 坐标（x、y 交替）对齐到步长 step 的网格上：存进文件再读出来就是这些值。管线在分带之前调用——分带看的就是运行时拿到的几何，
 * 对齐以后才变成水平、竖直的线也照水平、竖直的处理（它们和平行的射线求交会除以 0）。
 */
export function snapGlyphPoints(points: Float32Array, step: number): Float32Array {
  return points.map((value) => Math.round(value / step) * step);
}

/**
 * 能把这些坐标都存进 16 位整数的步长：从 finest 起，放不下就翻倍。finest 取字体网格的四分之一（1 / (4 · unitsPerEm)）时，
 * TrueType 的轮廓（整数的点和它们的中点）正好落在网格上，没有损失。
 */
export function glyphPointStep(finest: number, largest: number): number {
  let step = finest;
  while (largest / step > 32767) step *= 2;
  return step;
}

/**
 * 字形块的文件：字形记录，点，带。
 * - 点是步长 pointStep 的网格上的 16 位整数，存的是和同一个字形里前一个点的差（每个字形的第一个点是它本身），x 和 y 分开放：
 *   轮廓上相邻的点离得近，差都是小数，压缩以后比直接存 f32 小得多。
 * - 带的字存成 16 位（一个字形的带头、曲线表里的数都相对这个字形，不会超过 65535）。
 * 读进来以后还原成 f32 的点和 u32 的带，运行时和着色器用的还是那一份。
 */
export function encodeGlyphBlock({ glyphs, glyphCount, points, bands, pointStep }: GlyphBlock): Uint8Array {
  const glyphBytes = glyphCount * GLYPH_WORDS * 4;
  const records = new Uint32Array(glyphs, 0, glyphCount * GLYPH_WORDS);
  const pointCount = points.length / 2;
  const deltas = new Int16Array(points.length);
  for (let g = 0; g < glyphCount; g++) {
    const start = records[g * GLYPH_WORDS + GLYPH_RECORD.pointStart]!;
    const end = g + 1 < glyphCount ? records[(g + 1) * GLYPH_WORDS + GLYPH_RECORD.pointStart]! : pointCount;
    let lastX = 0, lastY = 0;
    for (let i = start; i < end; i++) {
      const x = Math.round(points[i * 2]! / pointStep), y = Math.round(points[i * 2 + 1]! / pointStep);
      if (Math.abs(x) > 32767 || Math.abs(y) > 32767) throw new Error(`glyph block: point ${points[i * 2]}, ${points[i * 2 + 1]} does not fit 16 bits at step ${pointStep}`);
      // 差可以超出 16 位：按 16 位回绕着存，读的时候回绕着加回来
      deltas[i] = x - lastX;
      deltas[pointCount + i] = y - lastY;
      lastX = x;
      lastY = y;
    }
  }
  const narrow = new Uint16Array(bands.length);
  bands.forEach((word, i) => {
    if (word > 0xffff) throw new Error(`glyph block: band word ${word} does not fit 16 bits`);
    narrow[i] = word;
  });
  const { bytes, dataStart } = encodeContainer(GLYPHS_MAGIC, GLYPHS_VERSION, { glyphCount, pointCount, bandWords: bands.length, pointStep },
    glyphBytes + deltas.byteLength + narrow.byteLength);
  let at = dataStart;
  for (const part of [new Uint8Array(glyphs, 0, glyphBytes), byteView(deltas), byteView(narrow)]) {
    bytes.set(part, at);
    at += part.byteLength;
  }
  return bytes;
}

export function decodeGlyphBlock(buffer: ArrayBuffer, source = 'glyphs'): GlyphBlock {
  const { header, dataStart } = decodeContainer<{ glyphCount: number; pointCount: number; bandWords: number; pointStep: number }>(buffer, GLYPHS_MAGIC, GLYPHS_VERSION, 'glyphs', source);
  const { glyphCount, pointCount, bandWords, pointStep } = header;
  const pointsAt = dataStart + glyphCount * GLYPH_WORDS * 4, bandsAt = pointsAt + pointCount * 4;
  const glyphs = buffer.slice(dataStart, pointsAt);
  const records = new Uint32Array(glyphs);
  const deltas = new Int16Array(buffer.slice(pointsAt, bandsAt));
  const points = new Float32Array(pointCount * 2);
  // 回绕着累加（差是按 16 位回绕存的）
  const sum = new Int16Array(2);
  for (let g = 0; g < glyphCount; g++) {
    const start = records[g * GLYPH_WORDS + GLYPH_RECORD.pointStart]!;
    const end = g + 1 < glyphCount ? records[(g + 1) * GLYPH_WORDS + GLYPH_RECORD.pointStart]! : pointCount;
    sum[0] = sum[1] = 0;
    for (let i = start; i < end; i++) {
      sum[0]! += deltas[i]!;
      sum[1]! += deltas[pointCount + i]!;
      points[i * 2] = sum[0]! * pointStep;
      points[i * 2 + 1] = sum[1]! * pointStep;
    }
  }
  return { glyphs, glyphCount, points, bands: Uint32Array.from(new Uint16Array(buffer.slice(bandsAt, bandsAt + bandWords * 2))), pointStep };
}

/**
 * 背景（Stride 的 BackgroundComponent）：立方体贴图（内容路径），或者 Is2D 的平面图片（铺满画面，多出的部分裁掉）。
 */
export type SceneBackground =
  | { readonly type: 'cubemap'; readonly texture: string; readonly intensity: number; readonly renderGroup?: number }
  | { readonly type: '2d'; readonly image: TextureRef; readonly intensity: number; readonly renderGroup?: number };

/** 反射探针（Stride 没有）：各字段的意思见 ReflectionProbe 组件；没写的用组件的默认值。 */
export interface SceneReflectionProbe {
  readonly size: Vec3Tuple;
  readonly blendDistance?: number;
  readonly boxProjection?: boolean;
  readonly intensity?: number;
  readonly refresh?: 'once' | 'everyFrame';
}

/** 物理天空（Stride 没有）：各字段的意思见 SkyAtmosphere 组件；没写的用地球的默认值。 */
export interface SceneSkyAtmosphere {
  readonly planetRadius?: number;
  readonly atmosphereHeight?: number;
  readonly rayleighScattering?: Vec3Tuple;
  readonly mieScattering?: number;
  readonly mieAbsorption?: number;
  readonly miePhaseG?: number;
  readonly ozoneAbsorption?: Vec3Tuple;
  readonly groundAlbedo?: Vec3Tuple;
  readonly skyIntensity?: number;
}

/** Stride 的 AnimationComponent：按名字列出的剪辑（内容路径），脚本按名字播放。 */
export interface SceneAnimation {
  readonly animations: readonly { readonly name: string; readonly clip: string }[];
}

/** 脚本属性引用的资源种类。 */
/**
 * scene：只记路径，不随引用它的场景加载（场景之间常常互相引用），切换时才加载（Game.setRootScene）。
 * prefab：随场景加载好（和它引用的资源一起），脚本运行中实例化。
 */
export type SceneAssetKind = 'model' | 'material' | 'animation' | 'scene' | 'prefab' | 'font' | 'texture' | 'spriteSheet' | 'uiPage' | 'uiLibrary' | 'sound';

/**
 * 游戏设置（Stride 的 GameSettings）：默认场景和图形合成器。合成器的根（Stride 的 GraphicsCompositor.Game）是游戏自己的渲染器时
 * （SpriteFonts 的 FontRenderer），renderer 是它的类型名和属性，运行时按类型名对上游戏给的 TS 渲染器（Game.loadGameSettings）。
 */
export interface GameSettingsFile {
  readonly name: string;
  /** 默认场景的内容路径（只记路径，场景要另外导入）；没有时是 null（SpriteFonts）。 */
  readonly defaultScene: string | null;
  readonly renderer: SceneScript | null;
  /**
   * 默认的后备缓冲大小（Stride 的 RenderingSettings.DefaultBackBufferWidth、Height）：桌面 Stride 的窗口一开始就是这么大，
   * 游戏在初始化时取后备缓冲大小当设计分辨率（JumpyJet 的背景、管子的个数）。没写时是 Stride 的默认 1280x720。
   */
  readonly defaultBackBufferSize?: readonly [number, number];
}

/**
 * 脚本的属性值（Stride 序列化的值换过来）：标量原样；列表是数组；Vector2、Vector3、Quaternion 是数组；别的结构是键名改成
 * 小写开头的对象；对实体或组件的引用是 { $entity: 场景里的实体 id }；对资源的引用是 { $asset: 内容路径, kind }。
 */
export type SceneScriptValue =
  | null
  | boolean
  | number
  | string
  | readonly SceneScriptValue[]
  | { readonly $entity: string }
  | { readonly $asset: string; readonly kind: SceneAssetKind }
  | { readonly [key: string]: SceneScriptValue };

/** 场景里的一个脚本组件：Stride 的类型名（不带程序集）和属性（键名改成小写开头）。 */
export interface SceneScript {
  readonly type: string;
  readonly props: Readonly<Record<string, SceneScriptValue>>;
}

/** 仿真设置（Stride 的 GameSettings 里 BepuConfiguration 的 BepuSimulation）。 */
/** 导航的设置（Stride 的 RecastNavigationConfiguration，在 GameSettings 里）。 */
export interface SceneNavigation {
  readonly build: {
    readonly cellSize: number;
    readonly cellHeight: number;
    readonly agentHeight: number;
    readonly agentRadius: number;
    readonly agentMaxClimb: number;
    readonly agentMaxSlopeDegrees: number;
    readonly tileSize: number;
    readonly maxEdgeLength: number;
    readonly maxSimplificationError: number;
    readonly minRegionSize: number;
    readonly mergeRegionSize: number;
    readonly detailSampleDistance: number;
    readonly detailSampleMaxError: number;
  };
  /** 参与的碰撞层，第 n 位是层 n。 */
  readonly includedLayers: number;
}

export interface ScenePhysics {
  readonly gravity: Vec3Tuple;
  readonly linearDamping: number;
  readonly angularDamping: number;
  /** 秒。 */
  readonly fixedTimeStep: number;
  readonly maxStepsPerFrame: number;
  /** 碰撞矩阵（Stride 的 Layer0 到 Layer31）：collisionMasks[a] 的第 b 位为 1 表示层 a 和层 b 碰撞；没写是全部碰撞。 */
  readonly collisionMasks?: readonly number[];
}

/**
 * Stride 的 CollisionMask 在资源文件里的写法（`Everything`、`None`，或者 `Layer0, Layer3, …`）换成位掩码：第 n 位是层 n。
 * 没写当全部。场景里的脚本属性是这种字符串时（射线的 CollideWith）脚本自己调它；已经是数字的原样返回。
 */
export function parseCollisionMask(value: unknown): number {
  if (typeof value === 'number') return value >>> 0;
  if (value === undefined || value === null || value === 'Everything') return 0xffffffff;
  if (value === 'None') return 0;
  let mask = 0;
  for (const flag of String(value).split(',')) {
    const layer = /^Layer(\d+)$/.exec(flag.trim());
    if (layer) mask |= 1 << Number(layer[1]);
  }
  return mask >>> 0;
}

/**
 * 场景（或预制体）里的一个预制体实例（docs/prefabs.md，用户 2026-11-20 定）：带着它的实体就是预制体的根（身份和摆放是
 * 实例自己的）；根下面的成员不存，加载时由预制体合并出来，在场景里的 id 是 `<实例 id>/<预制体里的 id>`（prefabInstances.ts）。
 */
export interface PrefabInstanceFile {
  /** 预制体的内容路径。 */
  readonly path: string;
  /** 放的是预制体的哪个根（预制体里的 id）；预制体只有一个根时不用写。 */
  readonly root?: string;
  /**
   * 在预制体某个实体（预制体里的 id）的某条路径上改成的值；脚本组件在路径里按类型名指（`scripts`, `Game.Health`）。没有 value
   * 是去掉这个键（例如去掉根上的一个组件）。
   */
  readonly set?: readonly { readonly entity: string; readonly path: readonly (string | number)[]; readonly value?: unknown }[];
  /** 这个实例不要的预制体实体（连后代），预制体里的 id。 */
  readonly removed?: readonly string[];
}

export interface SceneEntityFile {
  readonly id: string;
  readonly name: string;
  /** 父实体的 id；根实体是 null。 */
  readonly parent: string | null;
  /** 这个实体是一个预制体的实例（见 PrefabInstanceFile）。 */
  readonly prefab?: PrefabInstanceFile;
  readonly position: Vec3Tuple;
  readonly rotation: readonly [number, number, number, number];
  readonly scale: Vec3Tuple;
  readonly components: {
    /**
     * Stride.BepuPhysics 的约束组件（BallSocketConstraintComponent 等），可以有几个。type 是约束种类（类名去掉
     * ConstraintComponent、首字母小写），bodyA、bodyB 是带物理组件的实体（场景里的 id，单体约束没有 bodyB），settings 是
     * 其余属性（名字首字母小写，同 Simulation.addConstraint 的设置；向量、四元数是数组）。
     */
    readonly constraints?: readonly SceneConstraint[];
    /** Stride 的 InstancingComponent：这个实体的模型给 instance 引用它的实体画。 */
    readonly instancing?: Record<string, never>;
    /** Stride 的 InstanceComponent：master 是带 instancing 的实体（场景里的 id），null 是还没指定（运行时由脚本设）。 */
    readonly instance?: { readonly master: string | null };
    /**
     * Stride 的 ModelNodeLinkComponent：挂到 target（带模型的实体，场景里的 id；null 是父实体）的骨骼节点 nodeName 上。
     */
    readonly nodeLink?: { readonly target: string | null; readonly nodeName: string };
    /**
     * Stride 的 UIElementLinkComponent：跟着 UI 元素 nodeName 走。target 是带 UI 组件的实体（场景里的 id；null 是父实体），
     * camera 是带相机的实体（Stride 用它算面向相机的 UI 的朝向；引擎按 UI 实际画的相机算，不用它，见 UIElementLink）。
     */
    readonly uiElementLink?: { readonly target: string | null; readonly camera: string | null; readonly nodeName: string };
    /** Stride 的 ParticleSystemComponent（Control、Color、Speed 和 ParticleSystem），见 ParticleModuleFile。 */
    readonly particleSystem?: ParticleModuleFile;
    readonly model?: {
      /** 模型的内容路径。 */
      readonly model: string;
      /** 按槽覆盖模型的材质；null 表示用模型自带的。 */
      readonly materials: readonly (string | null)[];
      /** 投下阴影；没有时是 true（同 Stride 的 ModelComponent.IsShadowCaster）。 */
      readonly isShadowCaster?: boolean;
      /** 渲染组（Stride 的 RenderGroup，0 到 31）；没写是 0。 */
      readonly renderGroup?: number;
    };
    /** slot：图形合成器的相机槽位下标（Stride 的 CameraComponent.Slot），默认 0。 */
    readonly camera?: {
      readonly verticalFieldOfView: number;
      readonly nearClipPlane: number;
      readonly farClipPlane: number;
      readonly slot?: number;
      /** 没写是透视。 */
      readonly projection?: 'orthographic';
      readonly orthographicSize?: number;
    };
    readonly light?:
      | {
        readonly type: 'directional' | 'ambient';
        /** sRGB，同 Light 组件。 */
        readonly color: Vec3Tuple;
        readonly intensity: number;
        /** 方向光的阴影，字段同 Light 组件的 shadow 开头的列；没有就是不投阴影。 */
        readonly shadow?: SceneLightShadow;
      }
      | {
        readonly type: 'skybox';
        /** 天空盒的内容路径。 */
        readonly skybox: string;
        readonly intensity: number;
      }
      /** 点光（Stride 的 LightPoint）。 */
      | { readonly type: 'point'; readonly color: Vec3Tuple; readonly intensity: number; readonly radius: number; readonly shadow?: SceneLocalLightShadow }
      /** 聚光（Stride 的 LightSpot），锥角是度、整个锥的张角。 */
      | {
        readonly type: 'spot'; readonly color: Vec3Tuple; readonly intensity: number; readonly range: number; readonly angleInner: number; readonly angleOuter: number;
        readonly shadow?: SceneLocalLightShadow;
      };
    readonly background?: SceneBackground;
    readonly reflectionProbe?: SceneReflectionProbe;
    readonly skyAtmosphere?: SceneSkyAtmosphere;
    /** Stride.BepuPhysics 的 StaticComponent。 */
    readonly static?: SceneCollidable;
    readonly character?: SceneCharacter;
    readonly body?: SceneBody;
    /** 游戏的脚本（Stride 的 ScriptComponent），按场景文件里的顺序；运行时按类型名找对应的 TS 脚本。 */
    readonly scripts?: readonly SceneScript[];
    readonly animation?: SceneAnimation;
    readonly sprite?: SceneSprite;
    readonly ui?: SceneUI;
  };
}

/** Stride 的 UIComponent：在这个实体上显示一个 UI 页面。 */
export interface SceneUI {
  /** UI 页面（UIFile）的内容路径；null 是还没指定（运行时由脚本设）。 */
  readonly page: string | null;
  /** 虚拟分辨率（页面按它布局），宽、高；深度 Z 只用于 3D 的 UI，没写是 1000。 */
  readonly resolution: readonly [number, number, number];
  /** 在场景里的大小（非全屏时），同 Stride 的 Size。 */
  readonly size: readonly [number, number, number];
  readonly resolutionStretch: 'fixedWidthFixedHeight' | 'fixedWidthAdaptableHeight' | 'fixedHeightAdaptableWidth';
  /** 渲染组（Stride 的 RenderGroup，0 到 31）；没写是 0。主相机的掩码里没有这一组时不画。 */
  readonly renderGroup?: number;
  /** 没写是 true（同 Stride）。 */
  readonly isFullScreen?: boolean;
  readonly isBillboard?: boolean;
  readonly isFixedSize?: boolean;
  readonly snapText?: boolean;
  readonly sampler?: 'linearClamp' | 'pointClamp' | 'anisotropicClamp';
  readonly enabled?: boolean;
}

/**
 * UI 页面或 UI 库（Stride 的 UIPageAsset、UILibraryAsset，.sduipage、.sduilib）：元素平铺成数组，互相用下标引用。
 * 布局只有两维（和 Stride 不同：Stride 的布局是三维的，深度方向的尺寸、对齐、Grid 的层都不导入，见 docs/decisions.md）。
 */
export interface UIFile {
  readonly name: string;
  /** 设计时的分辨率（Stride 的 Design.Resolution），宽、高。 */
  readonly designResolution: readonly [number, number];
  /** 页面的根元素；UI 库没有。 */
  readonly root?: number;
  /** UI 库公开的元素（Stride 的 UILibrary.UIElements）：名字 → 元素。 */
  readonly templates?: Readonly<Record<string, number>>;
  readonly elements: readonly UIElementFile[];
}

/**
 * UI 元素的类型（Stride 的类名，能写在 .sduipage 里的都在；ContentControl 这类抽象类不算）。RichTextBlock 是我们加的
 * （Markdown 的富文本，Stride 没有）。
 */
export type UIElementType =
  | 'Border' | 'Button' | 'Canvas' | 'ContentDecorator' | 'ContentPresenter' | 'EditText' | 'Grid'
  | 'ImageButton' | 'ImageElement' | 'ModalElement' | 'RichTextBlock' | 'ScrollBar' | 'ScrollingText' | 'ScrollViewer' | 'Slider' | 'StackPanel'
  | 'TextBlock' | 'ToggleButton' | 'UniformGrid';

export interface UIElementFile {
  readonly type: UIElementType;
  /** 元素的属性：Stride 的属性名首字母小写，值见 UIValue。没写的是 Stride 的默认值。 */
  readonly props: Readonly<Record<string, UIValue>>;
  /**
   * 附加属性（Stride 的 DependencyProperties 里别的类定义的），名字同运行时 UIElement 上的属性：`gridRow`、`gridColumn`、
   * `gridRowSpan`、`gridColumnSpan`、`panelZIndex`、`canvasAbsolutePosition`、`canvasRelativePosition`、`canvasRelativeSize`、
   * `canvasPinOrigin`、`canvasUseAbsolutePosition`。
   */
  readonly attached?: Readonly<Record<string, UIValue>>;
  /** 面板的子元素（Stride 的 Panel.Children），按顺序。 */
  readonly children?: readonly number[];
  /** 内容控件的内容（Stride 的 ContentControl.Content）。 */
  readonly content?: number;
}

/**
 * UI 元素的属性值：标量原样，枚举是首字母小写的名字（'center'、'collapsed'）；颜色是 sRGB 的 [r, g, b, a]（0 到 1）；
 * Thickness（Margin、Padding）是 [左, 上, 右, 下]；颜色、Thickness 里的 null 是文件里没写的成员（保持元素类型的默认值）；
 * 向量是数组，Stride 里的 NaN（没设）是 null；Grid 的行列定义是对象的数组；图片是 UISpriteValue；字体是 { $asset, kind: 'font' }。
 */
export type UIValue =
  | null
  | boolean
  | number
  | string
  | readonly (number | null)[]
  | UISpriteValue
  | readonly UIStripDefinition[]
  | { readonly $asset: string; readonly kind: 'font' };

/** UI 的图片（Stride 的 ISpriteProvider）：精灵表的一帧，或者一整张贴图。 */
export type UISpriteValue =
  | { readonly sheet: string; readonly frame: number }
  | { readonly texture: TextureRef };

/** Grid 的一行或一列（Stride 的 StripDefinition）；没写的同 Stride 的默认值（star、1、0、无穷大）。 */
export interface UIStripDefinition {
  readonly type?: 'fixed' | 'auto' | 'star';
  readonly sizeValue?: number;
  readonly minimumSize?: number;
  readonly maximumSize?: number;
}

export interface SceneFile {
  readonly name: string;
  /** 场景用的仿真设置；没有时用引擎的默认值。 */
  readonly physics?: ScenePhysics;
  /** 场景用的导航设置；没有时用 Stride 的默认值。 */
  readonly navigation?: SceneNavigation;
  /**
   * 整个场景的平移（Stride 的 Scene.Offset，TopDownRPG 的分块场景用它摆到各自的位置）：场景在变换存储里占一个隐藏的根，
   * 偏移在它上面，实体的本地位置不带偏移；子场景的根挂在父场景的根下面，偏移一层层累加（见 engine/transform.ts 的 SceneRoot）。
   */
  readonly offset?: readonly [number, number, number];
  /** 主画面的合成器设置；没有时用前向渲染器的默认值。 */
  readonly compositor?: SceneCompositor;
  /** 父实体都排在子实体前面。 */
  readonly entities: readonly SceneEntityFile[];
}

export interface SceneConstraint {
  readonly type: string;
  readonly enabled: boolean;
  readonly bodyA: string;
  readonly bodyB?: string;
  readonly settings: Readonly<Record<string, number | readonly number[]>>;
}

/** 预制体（Stride 的 PrefabAsset）：和场景一样的实体层级，实例化时才建出来。 */
export interface PrefabFile {
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
