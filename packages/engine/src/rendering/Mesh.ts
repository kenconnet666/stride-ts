/**
 * 网格（对应 Stride 的 Mesh 加 MeshDraw）：顶点位置、法线和索引，放在 CPU 这边；渲染特性第一次画它时
 * 才建 GPU 缓冲，所以网格可以在设备创建之前、或者在 Node 里构造。内容管线做好后，网格从资源加载。
 * 程序化网格对应 Stride 的 ProceduralModels：尺寸默认 1，右手坐标系，三角形从外面看是逆时针。
 */
import type { Branded } from '../data/prop';

export type MeshId = Branded<number, 'MeshId'>;

export interface MeshData {
  /** 每个顶点 xyz。 */
  readonly positions: Float32Array;
  /** 每个顶点一个单位法线 xyz。 */
  readonly normals: Float32Array;
  readonly indices: Uint16Array | Uint32Array;
}

/** 按 id 找网格：数据组件的列里只能存数字。 */
const meshes: (Mesh | undefined)[] = [undefined];

export class Mesh {
  /** 从 1 开始；Model 组件的 mesh 列存它。 */
  readonly id: MeshId;
  readonly name: string;
  readonly data: MeshData;

  constructor(name: string, data: MeshData) {
    if (data.positions.length !== data.normals.length || data.positions.length % 3 !== 0) {
      throw new RangeError(`mesh '${name}': positions and normals must both hold xyz per vertex`);
    }
    if (data.indices.length % 3 !== 0) throw new RangeError(`mesh '${name}': indices must form triangles`);
    this.id = meshes.length as MeshId;
    this.name = name;
    this.data = data;
    meshes.push(this);
  }

  get vertexCount(): number {
    return this.data.positions.length / 3;
  }

  /** @internal Model 组件里存的 id 对应的网格。 */
  static byId(id: number): Mesh | undefined {
    return meshes[id];
  }

  /** 立方体（Stride 的 CubeProceduralModel），中心在原点，每个面 4 个顶点，法线朝外。 */
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

class QuadBuilder {
  readonly #positions: number[] = [];
  readonly #normals: number[] = [];
  readonly #indices: number[] = [];

  /**
   * 法线为 n 的一个矩形：中心在 n * offset，沿 u 方向半宽 halfU，沿 v 方向半高 halfV，其中 u = v × n，
   * 所以 u × v = n，按 (-u,-v)、(+u,-v)、(+u,+v)、(-u,+v) 排列从法线这一侧看是逆时针。
   */
  quad(n: readonly number[], v: readonly number[], offset: number, halfU: number, halfV: number): void {
    const u = [v[1]! * n[2]! - v[2]! * n[1]!, v[2]! * n[0]! - v[0]! * n[2]!, v[0]! * n[1]! - v[1]! * n[0]!];
    const first = this.#positions.length / 3;
    for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
      for (let k = 0; k < 3; k++) this.#positions.push(n[k]! * offset + u[k]! * su * halfU + v[k]! * sv * halfV);
      this.#normals.push(n[0]!, n[1]!, n[2]!);
    }
    this.#indices.push(first, first + 1, first + 2, first, first + 2, first + 3);
  }

  build(): MeshData {
    return { positions: new Float32Array(this.#positions), normals: new Float32Array(this.#normals), indices: new Uint16Array(this.#indices) };
  }
}
