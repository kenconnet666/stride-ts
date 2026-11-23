/**
 * 可破碎物体的碎块（content/formats/fractureFormat.ts）：原生工具模块把完整的模型按 Voronoi 切开（`fractureMesh`，只有位置）以后，
 * 这里把切出来的三角形按块、按材质分成网格，补上顶点的法线和 UV：
 * - 外表面（原来的表面）：找到质心落在上面的原模型的三角形，三个角按它的重心坐标插值原来的法线、UV，材质槽也沿用它的。Manifold
 *   会把共面的原三角形并起来重新三角化，角可能落在那个原三角形外面，这时按同一个平面外推——同一个平面上 UV 是仿射的（方块的
 *   面、墙）时没有误差，UV 在平面中间转折的少见情况会有一点拉伸；
 * - 断面（切出来的面）：面法线，UV 按法线最大的分量投影（同 SDF、多边形网格），材质是断面的材质槽。
 *
 * 网格名是 `piece-<块号>-<槽号>` 或 `piece-<块号>-inside`，运行时（physics/Breakable.ts）按名字把网格分回各块（fracturePieceOf）。
 */
import { VERTEX_FLOATS } from '../content/formats/format.ts';
import { projectUv } from './polyMesh.ts';

/** 原模型的一个网格：顶点是 VERTEX_FLOATS 个 float 一个（位置、法线、UV），模型空间。 */
export interface FractureSourceMesh {
  readonly material: number | null;
  readonly vertices: Float32Array;
  readonly indices: ArrayLike<number>;
}

/** 原生 `fractureMesh` 的结果。 */
export interface FractureCut {
  readonly positions: Float32Array;
  readonly indices: Uint32Array;
  readonly pieceOfTriangle: Uint32Array;
  readonly interior: Uint32Array;
  readonly pieceCount: number;
}

/** 碎块的一个网格（同 pipeline 的 SourceMesh 的前几项）。 */
export interface FracturePieceMesh {
  readonly name: string;
  readonly material: number | null;
  readonly vertices: Float32Array;
  readonly indices: Uint32Array;
}

/** 网格名属于第几块；不是碎块的网格是 undefined。 */
export function fracturePieceOf(meshName: string): number | undefined {
  const match = /^piece-(\d+)-/.exec(meshName);
  return match ? Number(match[1]) : undefined;
}

/** 切出来的三角形分成各块的网格（块号从 0 起、连续；顺序按块号，块里外表面在前、断面在后）。 */
export function fracturePieceMeshes(source: readonly FractureSourceMesh[], cut: FractureCut, interiorMaterial: number | null, uvScale = 1): FracturePieceMesh[] {
  const surface = new SourceSurface(source);
  const pieces = Array.from({ length: cut.pieceCount }, () => new Map<string, MeshBuilder>());
  const corner = [0, 0, 0], normal = [0, 0, 0], uv = [0, 0];
  const p: number[][] = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let t = 0; t < cut.indices.length / 3; t++) {
    for (let c = 0; c < 3; c++) for (let k = 0; k < 3; k++) p[c]![k] = cut.positions[cut.indices[t * 3 + c]! * 3 + k]!;
    const [p0, p1, p2] = p as [number[], number[], number[]];
    const face = faceNormal(p0, p1, p2);
    const interior = cut.interior[t] !== 0;
    const hit = interior ? undefined : surface.at(centroid(p0, p1, p2), face);
    const key = hit ? `${hit.mesh.material ?? 'none'}` : 'inside';
    const builders = pieces[cut.pieceOfTriangle[t]!]!;
    let builder = builders.get(key);
    if (!builder) builders.set(key, (builder = new MeshBuilder(hit ? hit.mesh.material : interiorMaterial)));
    for (let c = 0; c < 3; c++) {
      for (let k = 0; k < 3; k++) corner[k] = p[c]![k]!;
      if (hit) {
        hit.interpolate(corner, normal, uv);
      } else {
        for (let k = 0; k < 3; k++) normal[k] = face[k]!;
        [uv[0], uv[1]] = projectUv(corner, normal, uvScale);
      }
      builder.add(corner, normal, uv);
    }
  }
  return pieces.flatMap((builders, piece) =>
    [...builders.entries()]
      .sort(([a], [b]) => (a === 'inside' ? 1 : b === 'inside' ? -1 : a.localeCompare(b)))
      .map(([key, builder]) => builder.build(`piece-${piece}-${key === 'inside' ? 'inside' : builder.material ?? 0}`)));
}

/** 一个网格的顶点表：位置、法线、UV 都一样的顶点只放一次。 */
class MeshBuilder {
  readonly material: number | null;
  readonly #vertices: number[] = [];
  readonly #indices: number[] = [];
  readonly #lookup = new Map<string, number>();

  constructor(material: number | null) {
    this.material = material;
  }

  add(position: readonly number[], normal: readonly number[], uv: readonly number[]): void {
    const values = [...position, ...normal, ...uv];
    const key = values.map((value) => value.toFixed(6)).join(',');
    let index = this.#lookup.get(key);
    if (index === undefined) {
      index = this.#vertices.length / VERTEX_FLOATS;
      this.#lookup.set(key, index);
      this.#vertices.push(...values);
    }
    this.#indices.push(index);
  }

  build(name: string): FracturePieceMesh {
    return { name, material: this.material, vertices: Float32Array.from(this.#vertices), indices: Uint32Array.from(this.#indices) };
  }
}

/** 原模型的三角形，按包围盒放进均匀的格子：查一个点落在哪个三角形上只看它那一格。 */
class SourceSurface {
  readonly #triangles: SourceTriangle[] = [];
  readonly #cells = new Map<number, SourceTriangle[]>();
  readonly #min = [Infinity, Infinity, Infinity];
  readonly #cellSize: number;
  readonly #cellsPerAxis: number;

  constructor(meshes: readonly FractureSourceMesh[]) {
    const max = [-Infinity, -Infinity, -Infinity];
    for (const mesh of meshes) {
      for (let t = 0; t + 2 < mesh.indices.length; t += 3) {
        const triangle = new SourceTriangle(mesh, mesh.indices[t]!, mesh.indices[t + 1]!, mesh.indices[t + 2]!);
        if (triangle.area2 <= 0) continue;
        this.#triangles.push(triangle);
        for (let k = 0; k < 3; k++) {
          this.#min[k] = Math.min(this.#min[k]!, triangle.min[k]!);
          max[k] = Math.max(max[k]!, triangle.max[k]!);
        }
      }
    }
    const extent = Math.max(1e-6, ...[0, 1, 2].map((k) => max[k]! - this.#min[k]!));
    this.#cellsPerAxis = Math.max(1, Math.min(64, Math.ceil(Math.cbrt(this.#triangles.length))));
    this.#cellSize = (extent / this.#cellsPerAxis) * 1.0001;
    const margin = extent * 1e-4;
    for (const triangle of this.#triangles) {
      const lo = triangle.min.map((v, k) => this.#cell(v - margin, k));
      const hi = triangle.max.map((v, k) => this.#cell(v + margin, k));
      for (let x = lo[0]!; x <= hi[0]!; x++) {
        for (let y = lo[1]!; y <= hi[1]!; y++) {
          for (let z = lo[2]!; z <= hi[2]!; z++) {
            const key = (x * this.#cellsPerAxis + y) * this.#cellsPerAxis + z;
            let list = this.#cells.get(key);
            if (!list) this.#cells.set(key, (list = []));
            list.push(triangle);
          }
        }
      }
    }
  }

  /** 离 point 最近、朝向和 normal 差不多的原三角形（找不到朝向相近的就要最近的）；原模型没有三角形时是 undefined。 */
  at(point: readonly number[], normal: readonly number[]): SourceTriangle | undefined {
    const key = (this.#cell(point[0]!, 0) * this.#cellsPerAxis + this.#cell(point[1]!, 1)) * this.#cellsPerAxis + this.#cell(point[2]!, 2);
    return best(this.#cells.get(key) ?? [], point, normal) ?? best(this.#triangles, point, normal);
  }

  #cell(value: number, axis: number): number {
    return Math.min(this.#cellsPerAxis - 1, Math.max(0, Math.floor((value - this.#min[axis]!) / this.#cellSize)));
  }
}

function best(triangles: readonly SourceTriangle[], point: readonly number[], normal: readonly number[]): SourceTriangle | undefined {
  let found: SourceTriangle | undefined, score = Infinity;
  for (const triangle of triangles) {
    // 朝向不同的（方块的棱两边）按距离多罚一些：棱上的质心挑同一面的
    const facing = triangle.normal[0]! * normal[0]! + triangle.normal[1]! * normal[1]! + triangle.normal[2]! * normal[2]!;
    const distance = triangle.distance(point) + (facing < 0.9 ? triangle.size : 0);
    if (distance < score) {
      score = distance;
      found = triangle;
    }
  }
  return found;
}

/** 原模型的一个三角形：三个角的位置、法线、UV，按重心坐标插值。 */
class SourceTriangle {
  readonly a: number[];
  readonly b: number[];
  readonly c: number[];
  readonly normal: number[];
  /** 两倍面积。 */
  readonly area2: number;
  readonly size: number;
  readonly min: number[];
  readonly max: number[];
  readonly mesh: FractureSourceMesh;
  readonly ia: number;
  readonly ib: number;
  readonly ic: number;

  constructor(mesh: FractureSourceMesh, ia: number, ib: number, ic: number) {
    this.mesh = mesh;
    this.ia = ia;
    this.ib = ib;
    this.ic = ic;
    const at = (i: number) => [0, 1, 2].map((k) => mesh.vertices[i * VERTEX_FLOATS + k]!);
    this.a = at(ia);
    this.b = at(ib);
    this.c = at(ic);
    const cross = crossOf(sub(this.b, this.a), sub(this.c, this.a));
    this.area2 = Math.hypot(cross[0]!, cross[1]!, cross[2]!);
    this.normal = this.area2 > 0 ? cross.map((v) => v / this.area2) : [0, 1, 0];
    this.min = [0, 1, 2].map((k) => Math.min(this.a[k]!, this.b[k]!, this.c[k]!));
    this.max = [0, 1, 2].map((k) => Math.max(this.a[k]!, this.b[k]!, this.c[k]!));
    this.size = Math.hypot(...[0, 1, 2].map((k) => this.max[k]! - this.min[k]!));
  }

  /** 重心坐标（点投影到三角形的平面上；在外面时有负的分量）。 */
  barycentric(point: readonly number[]): [number, number, number] {
    const n = this.normal;
    const u = dot(crossOf(sub(this.c, this.b), sub(point, this.b)), n) / this.area2;
    const v = dot(crossOf(sub(this.a, this.c), sub(point, this.c)), n) / this.area2;
    return [u, v, 1 - u - v];
  }

  /** 点到三角形的距离：到平面的距离加上落在三角形外面的那一截。 */
  distance(point: readonly number[]): number {
    const plane = Math.abs(dot(sub(point, this.a), this.normal));
    const outside = Math.max(0, -Math.min(...this.barycentric(point)));
    return plane + outside * this.size;
  }

  /** point 处的法线（单位化）和 UV，按重心坐标插值三个角的。 */
  interpolate(point: readonly number[], normal: number[], uv: number[]): void {
    const [wa, wb, wc] = this.barycentric(point);
    const v = this.mesh.vertices;
    const ia = this.ia * VERTEX_FLOATS, ib = this.ib * VERTEX_FLOATS, ic = this.ic * VERTEX_FLOATS;
    for (let k = 0; k < 3; k++) normal[k] = wa * v[ia + 3 + k]! + wb * v[ib + 3 + k]! + wc * v[ic + 3 + k]!;
    const length = Math.hypot(normal[0]!, normal[1]!, normal[2]!);
    for (let k = 0; k < 3; k++) normal[k] = length > 1e-9 ? normal[k]! / length : this.normal[k]!;
    for (let k = 0; k < 2; k++) uv[k] = wa * v[ia + 6 + k]! + wb * v[ib + 6 + k]! + wc * v[ic + 6 + k]!;
  }
}

const sub = (a: readonly number[], b: readonly number[]) => [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!];
const dot = (a: readonly number[], b: readonly number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
const crossOf = (a: readonly number[], b: readonly number[]) => [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
const centroid = (a: readonly number[], b: readonly number[], c: readonly number[]) => [0, 1, 2].map((k) => (a[k]! + b[k]! + c[k]!) / 3);

function faceNormal(a: readonly number[], b: readonly number[], c: readonly number[]): number[] {
  const n = crossOf(sub(b, a), sub(c, a));
  const length = Math.hypot(n[0]!, n[1]!, n[2]!);
  return length > 0 ? n.map((v) => v / length) : [0, 1, 0];
}
