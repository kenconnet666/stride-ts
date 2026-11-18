/**
 * 网格（对应 Stride 的 Mesh 加 MeshDraw）：交错的顶点和索引，放在 CPU 这边，布局就是 GPU 上的布局，渲染特性第一次
 * 画它时原样上传。布局见 content/format.ts 的 VertexLayout：资源管线产出的模型一般是量化的 16 字节顶点（反量化在顶点
 * 着色器里做），程序化网格和 --plain 导出的模型是 32 字节的 float（FLOAT_LAYOUT）。程序化网格对应 Stride 的
 * ProceduralModels：尺寸默认 1，右手坐标系，三角形从外面看是逆时针。
 */
import { FLOAT_LAYOUT, IDENTITY_DEQUANTIZE, VERTEX_FLOATS, vertexLayoutOffsets, type Dequantize, type VertexLayout } from '../content/format';
import type { Branded } from '../data/prop';
import { ResourceTable } from '../engine/ResourceTable';

export { VERTEX_FLOATS };

export type MeshId = Branded<number, 'MeshId'>;

export interface MeshData {
  /** 交错的顶点：FLOAT_LAYOUT 时一般是 Float32Array（每个顶点 VERTEX_FLOATS 个），其他布局是字节。 */
  readonly vertices: Float32Array | Uint8Array;
  readonly indices: Uint16Array | Uint32Array;
  /** 默认 FLOAT_LAYOUT。 */
  readonly layout?: VertexLayout;
  /** 量化属性的还原，默认不量化。 */
  readonly dequantize?: Dequantize;
}

/** 轴对齐包围盒，模型空间。 */
export interface Bounds {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

const meshes = new ResourceTable<Mesh>();

export class Mesh {
  /** 从 1 开始；Model 组件的 mesh 列存它。 */
  readonly id: MeshId;
  readonly name: string;
  readonly data: MeshData;
  readonly layout: VertexLayout;
  readonly dequantize: Dequantize;
  /** 顶点的字节数。 */
  readonly vertexStride: number;
  readonly bounds: Bounds;

  constructor(name: string, data: MeshData) {
    this.layout = data.layout ?? FLOAT_LAYOUT;
    this.dequantize = data.dequantize ?? IDENTITY_DEQUANTIZE;
    this.vertexStride = vertexLayoutOffsets(this.layout).stride;
    if (data.vertices.byteLength % this.vertexStride !== 0) throw new RangeError(`mesh '${name}': vertex bytes are not a multiple of the ${this.vertexStride}-byte vertex`);
    if (data.indices.length % 3 !== 0) throw new RangeError(`mesh '${name}': indices must form triangles`);
    this.name = name;
    this.data = data;
    this.bounds = boundsOf(data.vertices, this.layout, this.dequantize, this.vertexStride);
    this.id = meshes.add(this) as MeshId;
  }

  get vertexCount(): number {
    return this.data.vertices.byteLength / this.vertexStride;
  }

  /** 模型空间的顶点位置 xyz（量化的位置已经反量化），网格碰撞体用。 */
  positions(): Float32Array {
    const { vertices } = this.data;
    const offset = vertexLayoutOffsets(this.layout).position;
    const view = new DataView(vertices.buffer, vertices.byteOffset, vertices.byteLength);
    const out = new Float32Array(this.vertexCount * 3);
    const quantized = this.layout.position === 'unorm16x4';
    const { positionOffset: o, positionScale: s } = this.dequantize;
    for (let v = 0; v < this.vertexCount; v++) {
      const at = v * this.vertexStride + offset;
      for (let k = 0; k < 3; k++) {
        out[v * 3 + k] = quantized ? o[k]! + (view.getUint16(at + k * 2, true) / 65535) * s[k]! : view.getFloat32(at + k * 4, true);
      }
    }
    return out;
  }

  /** @internal Model 组件里存的 id 对应的网格。 */
  static byId(id: number): Mesh | undefined {
    return meshes.get(id);
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
