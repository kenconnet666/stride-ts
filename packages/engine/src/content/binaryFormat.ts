/**
 * 二进制的内容文件（说明见 format.ts）：模型、骨架、动画剪辑、立方体贴图、字形块的容器——开头是 magic、版本、JSON 头的字节数，
 * 接着是 JSON 头，补齐到 4 字节，后面是数据区。顶点布局和量化、形变目标的打包也在这里。不依赖别的模块。
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
