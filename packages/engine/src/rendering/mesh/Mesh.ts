/**
 * 网格（对应 Stride 的 Mesh 加 MeshDraw）：交错的顶点和索引，放在 CPU 这边，布局就是 GPU 上的布局，渲染特性第一次
 * 画它时原样上传。布局见 content/formats/format.ts 的 VertexLayout：资源管线产出的模型一般是量化的 16 字节顶点（反量化在顶点
 * 着色器里做），程序化网格和 --plain 导出的模型是 32 字节的 float（FLOAT_LAYOUT）。程序化网格对应 Stride 的
 * ProceduralModels：尺寸默认 1，右手坐标系，三角形从外面看是逆时针。
 */
import { FLOAT_LAYOUT, IDENTITY_DEQUANTIZE, MORPH_ENTRY_WORDS, VERTEX_FLOATS, vertexLayoutOffsets, type Dequantize, type VertexLayout } from '../../content/formats/format';
import { meshPositions } from '../../content/modelFile';
import type { Branded } from '../../data/prop';
import { ResourceTable } from '../../engine/ResourceTable';
import { MESH_EFFECT_PARAMETERS } from './meshEffect';

export { VERTEX_FLOATS };

/** 远处卡片（MeshData.impostor、Impostors.ts）的图集有几格：绕竖直轴每 360° / 格数 一个方向，排成一行。 */
export const IMPOSTOR_FRAMES = 8;

export type MeshId = Branded<number, 'MeshId'>;

export interface MeshData {
  /** 交错的顶点：FLOAT_LAYOUT 时一般是 Float32Array（每个顶点 VERTEX_FLOATS 个），其他布局是字节。 */
  readonly vertices: Float32Array | Uint8Array;
  readonly indices: Uint16Array | Uint32Array;
  /** 默认 FLOAT_LAYOUT。 */
  readonly layout?: VertexLayout;
  /** 量化属性的还原，默认不量化。 */
  readonly dequantize?: Dequantize;
  /** 形变数据（布局见 content/formats/format.ts 的 MeshMorph），按 uint32 看。 */
  readonly morph?: Uint32Array;
  /**
   * 高度场网格（地形块共用的格子，见 HeightPages.ts）：顶点的 x、z 是格坐标，y 是 1 时是裙边；高度由实体的高度页给，
   * 顶点着色器用 vsHeightfield。
   */
  readonly heightfield?: boolean;
  /**
   * 远处卡片（Impostors.ts 的 impostorModel）：四个顶点的位置都是卡片的中心，法线的 xy 是这个角离中心的偏移（米），顶点着色器
   * vsImpostor 按相机把卡片转过来、按方向选图集里的一格。剔除用的包围盒由建它的人设（卡片转到哪个方向都要包住）。
   */
  readonly impostor?: boolean;
  /**
   * 顶点在 CPU 上会变（布料、软体每帧）：改了 vertices 以后调 Mesh.updateVertices，GPU 那边重新上传、包围盒重算。不进光追场景、
   * 天空遮挡这些按静止网格烘的东西的网格才用。
   */
  readonly dynamic?: boolean;
}

/** 轴对齐包围盒，模型空间。 */
export interface Bounds {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

const meshes = new ResourceTable<Mesh>();
const disposeListeners = new Set<(mesh: Mesh) => void>();

export class Mesh {
  /** 从 1 开始；Model 组件的 mesh 列存它。 */
  readonly id: MeshId;
  readonly name: string;
  readonly data: MeshData;
  readonly layout: VertexLayout;
  readonly dequantize: Dequantize;
  /** 顶点的字节数。 */
  readonly vertexStride: number;
  #bounds: Bounds;
  /** 剔除用的包围盒，默认就是 bounds；蒙皮网格由内容管理放大到动画会到的范围。 */
  cullBounds: Bounds;
  /** 网格效果的参数里改过的值（Stride 的 Mesh.Parameters），NaN 的用效果的默认值；没改过时是 undefined。 */
  effectParameters: Float32Array | undefined;
  /** 改了效果参数要递增，渲染特性据此重新上传。 */
  effectVersion = 0;
  /** 见 MeshData.heightfield。 */
  readonly heightfield: boolean;
  /** 见 MeshData.impostor。 */
  readonly impostor: boolean;
  /** 见 MeshData.dynamic。 */
  readonly dynamic: boolean;
  /** 顶点改过几次（updateVertices）；GPU 那边按它重新上传。 */
  vertexVersion = 0;
  #uvBounds: readonly [number, number, number, number] | undefined;

  constructor(name: string, data: MeshData) {
    this.layout = data.layout ?? FLOAT_LAYOUT;
    this.dequantize = data.dequantize ?? IDENTITY_DEQUANTIZE;
    this.vertexStride = vertexLayoutOffsets(this.layout).stride;
    if (data.vertices.byteLength % this.vertexStride !== 0) throw new RangeError(`mesh '${name}': vertex bytes are not a multiple of the ${this.vertexStride}-byte vertex`);
    if (data.indices.length % 3 !== 0) throw new RangeError(`mesh '${name}': indices must form triangles`);
    this.name = name;
    this.data = data;
    this.#bounds = boundsOf(data.vertices, this.layout, this.dequantize, this.vertexStride);
    this.cullBounds = this.#bounds;
    this.dynamic = data.dynamic === true;
    this.heightfield = data.heightfield === true;
    this.impostor = data.impostor === true;
    this.id = meshes.add(this) as MeshId;
  }

  /**
   * 改网格效果的参数（见 meshEffect）：从第 offset 个 float 起写 values，别的保持原样（没改过的用效果的默认值）。同一个模型资源
   * 的实例共用网格，一起变（同 Stride 的 Mesh.Parameters）。
   */
  setEffectParameters(values: ArrayLike<number>, offset = 0): void {
    if (offset < 0 || offset + values.length > MESH_EFFECT_PARAMETERS) throw new RangeError(`mesh '${this.name}': effect parameters ${offset}..${offset + values.length} are out of 0..${MESH_EFFECT_PARAMETERS}`);
    this.effectParameters ??= new Float32Array(MESH_EFFECT_PARAMETERS).fill(NaN);
    this.effectParameters.set(values, offset);
    this.effectVersion++;
  }

  /** 模型空间的包围盒；动态网格的跟着 updateVertices 变。 */
  get bounds(): Bounds {
    return this.#bounds;
  }

  /**
   * 动态网格（MeshData.dynamic）的顶点在原地改过了：下次画时重新上传，包围盒（剔除用的也是）重算——调用的人知道新的包围盒
   * （或者一个包得住的）时传进来，省掉重算。不是动态网格时报错。
   */
  updateVertices(bounds?: Bounds): void {
    if (!this.dynamic) throw new Error(`mesh '${this.name}' is not dynamic (create it with MeshData.dynamic to update its vertices)`);
    this.#bounds = this.cullBounds = bounds ?? boundsOf(this.data.vertices, this.layout, this.dequantize, this.vertexStride);
    this.vertexVersion++;
  }

  /** 形变增量的最大长度（米），剔除时包围盒按它放大。没有形变时是 0。 */
  get morphReach(): number {
    const morph = this.data.morph;
    if (!morph) return 0;
    const floats = new Float32Array(morph.buffer, morph.byteOffset, morph.length);
    let reach = 0;
    for (let at = morph[0]!; at + MORPH_ENTRY_WORDS <= morph.length; at += MORPH_ENTRY_WORDS) reach = Math.max(reach, Math.hypot(floats[at]!, floats[at + 1]!, floats[at + 2]!));
    return reach;
  }

  get vertexCount(): number {
    return this.data.vertices.byteLength / this.vertexStride;
  }

  /** 模型空间的顶点位置 xyz（量化的位置已经反量化），网格碰撞体用。 */
  positions(): Float32Array {
    return meshPositions({ vertices: this.data.vertices, layout: this.layout, dequantize: this.dequantize });
  }

  /** 解量化后的纹理坐标的范围 [最小 u, 最小 v, 最大 u, 最大 v]（表面颜色的烘焙按它铺满一格）；没有顶点时是 0..1。 */
  uvBounds(): readonly [number, number, number, number] {
    if (this.#uvBounds) return this.#uvBounds;
    const { vertices } = this.data;
    const offset = vertexLayoutOffsets(this.layout).uv;
    const view = new DataView(vertices.buffer, vertices.byteOffset, vertices.byteLength);
    const quantized = this.layout.uv === 'unorm16x2';
    const { uvOffset: o, uvScale: s } = this.dequantize;
    const bounds: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
    for (let v = 0; v < this.vertexCount; v++) {
      const at = v * this.vertexStride + offset;
      for (let k = 0; k < 2; k++) {
        const value = quantized ? o[k]! + (view.getUint16(at + k * 2, true) / 65535) * s[k]! : view.getFloat32(at + k * 4, true);
        bounds[k] = Math.min(bounds[k]!, value);
        bounds[k + 2] = Math.max(bounds[k + 2]!, value);
      }
    }
    return (this.#uvBounds = this.vertexCount > 0 ? bounds : [0, 0, 1, 1]);
  }

  /** 顶点的 UV（量化的已经反量化），在模型上画贴图（rendering/paint/MeshPainter.ts）用。 */
  uvs(): Float32Array {
    const { vertices } = this.data;
    const offset = vertexLayoutOffsets(this.layout).uv;
    const view = new DataView(vertices.buffer, vertices.byteOffset, vertices.byteLength);
    const out = new Float32Array(this.vertexCount * 2);
    const quantized = this.layout.uv === 'unorm16x2';
    const { uvOffset: o, uvScale: s } = this.dequantize;
    for (let v = 0; v < this.vertexCount; v++) {
      const at = v * this.vertexStride + offset;
      for (let k = 0; k < 2; k++) out[v * 2 + k] = quantized ? o[k]! + (view.getUint16(at + k * 2, true) / 65535) * s[k]! : view.getFloat32(at + k * 4, true);
    }
    return out;
  }

  /** @internal Model 组件里存的 id 对应的网格。 */
  static byId(id: number): Mesh | undefined {
    return meshes.get(id);
  }

  /**
   * 不再用了（流式加载的地形块这类运行时建、会扔掉的网格）：id 作废，渲染特性释放它的显存。用它的实体要先去掉。
   * 资源管线加载的网格跟着资源走，不用调。
   */
  dispose(): void {
    if (meshes.get(this.id) !== this) return;
    meshes.remove(this.id);
    for (const listener of disposeListeners) listener(this);
  }

  /** @internal 网格 dispose 时调（渲染特性释放显存）；返回取消登记的函数。 */
  static onDispose(listener: (mesh: Mesh) => void): () => void {
    disposeListeners.add(listener);
    return () => disposeListeners.delete(listener);
  }

  /** 立方体（Stride 的 CubeProceduralModel），中心在原点，每个面 4 个顶点，法线朝外，每个面 UV 铺满 0..1。 */
  static cube(size = 1, name = 'cube'): Mesh {
    const h = size / 2;
    const builder = new QuadBuilder();
    for (const axis of [0, 1, 2]) {
      for (const sign of [1, -1]) {
        const normal = [0, 0, 0];
        normal[axis] = sign;
        builder.quad(normal, axis === 1 ? [0, 0, -sign] : [0, 1, 0], h, h, h);
      }
    }
    return new Mesh(name, builder.build());
  }

  /** 平面（Stride 的 PlaneProceduralModel 的默认朝向）：在 y = 0 上，法线朝 +Y。 */
  static plane(sizeX = 1, sizeZ = 1, name = 'plane'): Mesh {
    const builder = new QuadBuilder();
    builder.quad([0, 1, 0], [0, 0, -1], 0, sizeX / 2, sizeZ / 2);
    return new Mesh(name, builder.build());
  }
}

/** 量化的位置就是反量化的范围；float 的位置逐个顶点算。 */
function boundsOf(vertices: Float32Array | Uint8Array, layout: VertexLayout, dequantize: Dequantize, stride: number): Bounds {
  if (layout.position === 'unorm16x4') {
    const { positionOffset: o, positionScale: s } = dequantize;
    return { min: [o[0], o[1], o[2]], max: [o[0] + s[0], o[1] + s[1], o[2] + s[2]] };
  }
  const view = new DataView(vertices.buffer, vertices.byteOffset, vertices.byteLength);
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let at = 0; at < vertices.byteLength; at += stride) {
    for (let k = 0; k < 3; k++) {
      const value = view.getFloat32(at + k * 4, true);
      if (value < min[k]!) min[k] = value;
      if (value > max[k]!) max[k] = value;
    }
  }
  return vertices.byteLength === 0 ? { min: [0, 0, 0], max: [0, 0, 0] } : { min, max };
}

class QuadBuilder {
  readonly #vertices: number[] = [];
  readonly #indices: number[] = [];

  /**
   * 法线为 n 的一个矩形：中心在 n * offset，沿 u 方向半宽 halfU，沿 v 方向半高 halfV，其中 u = v × n，
   * 所以 u × v = n，按 (-u,-v)、(+u,-v)、(+u,+v)、(-u,+v) 排列从法线这一侧看是逆时针。UV 的 v 向下，
   * 所以 (-u,-v) 对应 (0, 1)。
   */
  quad(n: readonly number[], v: readonly number[], offset: number, halfU: number, halfV: number): void {
    const u = [v[1]! * n[2]! - v[2]! * n[1]!, v[2]! * n[0]! - v[0]! * n[2]!, v[0]! * n[1]! - v[1]! * n[0]!];
    const first = this.#vertices.length / VERTEX_FLOATS;
    for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
      for (let k = 0; k < 3; k++) this.#vertices.push(n[k]! * offset + u[k]! * su * halfU + v[k]! * sv * halfV);
      this.#vertices.push(n[0]!, n[1]!, n[2]!, (su + 1) / 2, (1 - sv) / 2);
    }
    this.#indices.push(first, first + 1, first + 2, first, first + 2, first + 3);
  }

  build(): MeshData {
    return { vertices: new Float32Array(this.#vertices), indices: new Uint16Array(this.#indices) };
  }
}
