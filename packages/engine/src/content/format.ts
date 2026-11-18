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
 * - 材质 `<路径>.material.json`、天空盒 `<路径>.skybox.json`、场景 `<路径>.scene.json`：JSON。场景以后改成二进制，
 *   物理部分直接是原生能读的布局。
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

export const EXTENSIONS = {
  model: '.model',
  material: '.material.json',
  scene: '.scene.json',
  cubemap: '.cubemap',
  skybox: '.skybox.json',
  skeleton: '.skeleton',
  animation: '.anim',
} as const;

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

export interface ModelMeshHeader {
  readonly name: string;
  /** 在模型材质槽里的下标；没有材质时是 null。 */
  readonly material: number | null;
  readonly skin?: MeshSkin;
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
  /** 蒙皮网格用的骨架（内容路径）。 */
  readonly skeleton?: string;
}

/** 一个网格的数据：vertices、indices 是文件里的字节（压缩时是编码后的流，解码见 ContentManager）。 */
export interface ModelMeshData extends Omit<ModelMeshHeader, 'vertexByteOffset' | 'vertexByteLength' | 'indexByteOffset' | 'indexByteLength'> {
  readonly vertices: Uint8Array;
  readonly indices: Uint8Array;
}

export interface ModelData {
  readonly meshes: readonly ModelMeshData[];
  readonly materials: readonly (string | null)[];
  readonly skeleton?: string;
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
  const header: ModelHeader = { meshes, materials: model.materials, ...(model.skeleton ? { skeleton: model.skeleton } : {}) };
  const { bytes, dataStart } = encodeContainer(MODEL_MAGIC, MODEL_VERSION, header, offset);
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
    ...(header.skeleton ? { skeleton: header.skeleton } : {}),
    meshes: header.meshes.map(({ vertexByteOffset, vertexByteLength, indexByteOffset, indexByteLength, ...mesh }) => ({
      ...mesh,
      vertices: new Uint8Array(buffer, dataStart + vertexByteOffset, vertexByteLength),
      indices: new Uint8Array(buffer, dataStart + indexByteOffset, indexByteLength),
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

/** 动画剪辑；数据区是 ozz 的动画档案，轨道按骨架的关节顺序。 */
export interface AnimationHeader {
  /** 秒。 */
  readonly duration: number;
  readonly repeatMode: AnimationRepeatMode;
  /** 剪辑对应的骨架（内容路径）。 */
  readonly skeleton: string;
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

export interface TextureSlot {
  /** 贴图的内容路径，文件是 `<路径><TEXTURE_EXTENSIONS[encoding]>`。 */
  readonly texture: string;
  /** 默认 ktx2。 */
  readonly encoding?: TextureEncoding;
  /** svg 栅格化的尺寸（像素），默认取 SVG 的 width、height。 */
  readonly size?: readonly [number, number];
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
  readonly normalMap?: NormalMapSlot;
}

export type Vec3Tuple = readonly [number, number, number];

/** 方向光的阴影设置（Stride 的 LightDirectionalShadowMap），各字段的意思见 Light 组件。 */
export interface SceneLightShadow {
  readonly size: 'xsmall' | 'small' | 'medium' | 'large' | 'xlarge';
  readonly filter: 'none' | 'pcf3x3' | 'pcf5x5' | 'pcf7x7';
  readonly cascadeCount: 'one' | 'two' | 'four';
  readonly depthBias: number;
  readonly normalOffsetScale: number;
  readonly stabilization: 'none' | 'viewSnapping' | 'projectionSnapping';
  readonly pssmFactor: number;
  readonly depthRange: 'automatic' | 'manual';
  readonly minDistance: number;
  readonly maxDistance: number;
  readonly blendCascades: boolean;
}

/** 碰撞体里的一个形状（Stride.BepuPhysics 的 BoxCollider、CapsuleCollider…… 加 CompoundCollider 的本地位姿）。 */
export type ColliderShapeFile = (
  | { readonly type: 'box'; /** 边长。 */ readonly size: Vec3Tuple }
  | { readonly type: 'sphere'; readonly radius: number }
  /** 沿本地 Y，length 是两端球心的距离。 */
  | { readonly type: 'capsule'; readonly radius: number; readonly length: number }
  | { readonly type: 'cylinder'; readonly radius: number; readonly length: number }
  /** Stride 的 MeshCollider：模型（内容路径）的全部三角形，按实体的世界缩放。 */
  | { readonly type: 'mesh'; readonly model: string }
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

/** Stride 的 AnimationComponent：按名字列出的剪辑（内容路径），脚本按名字播放。 */
export interface SceneAnimation {
  readonly animations: readonly { readonly name: string; readonly clip: string }[];
}

/** 脚本属性引用的资源种类。 */
export type SceneAssetKind = 'model' | 'material' | 'animation';

/**
 * 脚本的属性值（Stride 序列化的值换过来）：标量原样；列表是数组；Vector3、Quaternion 是数组；别的结构是键名改成
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
export interface ScenePhysics {
  readonly gravity: Vec3Tuple;
  readonly linearDamping: number;
  readonly angularDamping: number;
  /** 秒。 */
  readonly fixedTimeStep: number;
  readonly maxStepsPerFrame: number;
}

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
      /** 投下阴影；没有时是 true（同 Stride 的 ModelComponent.IsShadowCaster）。 */
      readonly isShadowCaster?: boolean;
    };
    readonly camera?: { readonly verticalFieldOfView: number; readonly nearClipPlane: number; readonly farClipPlane: number };
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
      };
    /** 背景（Stride 的 BackgroundComponent）：立方体贴图的内容路径和强度。 */
    readonly background?: { readonly texture: string; readonly intensity: number };
    /** Stride.BepuPhysics 的 StaticComponent。 */
    readonly static?: SceneCollidable;
    readonly character?: SceneCharacter;
    /** 游戏的脚本（Stride 的 ScriptComponent），按场景文件里的顺序；运行时按类型名找对应的 TS 脚本。 */
    readonly scripts?: readonly SceneScript[];
    readonly animation?: SceneAnimation;
  };
}

export interface SceneFile {
  readonly name: string;
  /** 场景用的仿真设置；没有时用引擎的默认值。 */
  readonly physics?: ScenePhysics;
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
