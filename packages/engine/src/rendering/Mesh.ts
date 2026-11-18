/**
 * 网格（对应 Stride 的 Mesh 加 MeshDraw）：交错的顶点（位置 xyz、法线 xyz、UV xy，每个 32 字节）和索引，
 * 放在 CPU 这边，布局就是 GPU 上的布局，渲染特性第一次画它时原样上传。资源管线产出的模型文件用同一种布局
 * （content/format.ts），所以加载时不用转换。程序化网格对应 Stride 的 ProceduralModels：尺寸默认 1，
 * 右手坐标系，三角形从外面看是逆时针。
 */
import { VERTEX_FLOATS } from '../content/format';
import type { Branded } from '../data/prop';

export { VERTEX_FLOATS };

export type MeshId = Branded<number, 'MeshId'>;

export interface MeshData {
  /** 交错的顶点，每个 VERTEX_FLOATS 个 float。 */
  readonly vertices: Float32Array;
  readonly indices: Uint16Array | Uint32Array;
}

/** 轴对齐包围盒，模型空间。 */
export interface Bounds {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

/** 按 id 找网格：数据组件的列里只能存数字。 */
const meshes: (Mesh | undefined)[] = [undefined];

export class Mesh {
  /** 从 1 开始；Model 组件的 mesh 列存它。 */
  readonly id: MeshId;
  readonly name: string;
  readonly data: MeshData;
  readonly bounds: Bounds;

  constructor(name: string, data: MeshData) {
    if (data.vertices.length % VERTEX_FLOATS !== 0) throw new RangeError(`mesh '${name}': vertices must hold ${VERTEX_FLOATS} floats per vertex`);
    if (data.indices.length % 3 !== 0) throw new RangeError(`mesh '${name}': indices must form triangles`);
    this.id = meshes.length as MeshId;
    this.name = name;
    this.data = data;
    this.bounds = boundsOf(data.vertices);
    meshes.push(this);
  }

  get vertexCount(): number {
    return this.data.vertices.length / VERTEX_FLOATS;
  }

  /** @internal Model 组件里存的 id 对应的网格。 */
  static byId(id: number): Mesh | undefined {
    return meshes[id];
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

function boundsOf(vertices: Float32Array): Bounds {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let v = 0; v < vertices.length; v += VERTEX_FLOATS) {
    for (let k = 0; k < 3; k++) {
      const value = vertices[v + k]!;
      if (value < min[k]!) min[k] = value;
      if (value > max[k]!) max[k] = value;
    }
  }
  return vertices.length === 0 ? { min: [0, 0, 0], max: [0, 0, 0] } : { min, max };
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
