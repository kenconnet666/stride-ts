/**
 * 撞了会瘪的物体（Stride 没有）：车身、铁皮桶、垃圾箱、护栏。挂在有 Static 或 Body、有模型的实体上：开始接触时接近的速度
 * （StartedContact.speed）过了 threshold，接触点附近 radius 米以内的顶点沿接触法线往里推（中心推得最深，往外平滑地衰减到 0），
 * 推的深度随超出的速度变大，每个顶点离原位最多 maxDent 米；推过的地方重算法线。碰撞体不变（只是看起来瘪了）。
 *
 * 模型在第一次挂上时复制成这个实体自己的动态网格（Mesh.updateVertices，量化的位置、法线换成 float），同一个模型的别的实例不受
 * 影响；subdivide 大于 0 时把三角形细分到边不超过它（方块这种面很大的低模也能瘪出坑）。蒙皮的网格不支持。
 *
 * 设接触处理器会顶掉实体上原来的（Breakable 和它不能挂在同一个实体上）。
 */
import { prop } from '../data/prop';
import { Matrix } from '../data/Matrix';
import type { Entity } from '../engine/Entity';
import { SyncScript } from '../engine/scripts';
import { Transform } from '../engine/transform';
import { meshFloatVertices, meshTangents } from '../content/modelFile';
import { Model, ModelPart } from '../rendering/components';
import { Mesh, type Bounds } from '../rendering/mesh/Mesh';
import type { StartedContact } from './contacts';
import { Body, Static } from './components';

/** 不量化的顶点：位置、法线、UV、切线（xyz 加手性 w）。 */
const STRIDE = 12;
const LAYOUT = { position: 'float32x3', normal: 'float32x3', uv: 'float32x2', tangent: 'float32x4' } as const;

export class Deformable extends SyncScript.props('Deformable', {
  /** 撞上时接近的速度过了它才瘪（米/秒）。 */
  threshold: prop.number().min(0).default(3).unit('m/s'),
  /** 超出 threshold 的每米/秒推进去多深（米）。 */
  softness: prop.number().min(0).default(0.015).unit('s'),
  /** 一次撞击影响的半径（米）；撞得越狠越大（超出的每米/秒加 5%）。 */
  radius: prop.number().min(0.01).default(0.35).unit('m'),
  /** 每个顶点离原位最多多远（米）。 */
  maxDent: prop.number().min(0).default(0.15).unit('m'),
  /** 复制网格时把三角形细分到边不超过它（米）；0 是不细分。 */
  subdivide: prop.number().min(0).default(0).unit('m'),
}) {
  /** 瘪过几次。 */
  dents = 0;
  /** 顶点离原位最远的距离（米），玩法按它算损伤。 */
  deepest = 0;
  #parts: Part[] = [];

  override start(): void {
    const simulation = this.game.simulation;
    if (!simulation) throw new Error(`Deformable on '${this.entity.name}': the game runs without physics (nativeFeatures: [physics])`);
    if (!this.entity.get(Body) && !this.entity.get(Static)) throw new Error(`Deformable on '${this.entity.name}': the entity needs a Static or a Body`);
    for (const entity of [this.entity, ...this.entity.require(Transform).children.filter((child) => child.has(ModelPart))]) {
      const model = entity.get(Model);
      const mesh = model && Mesh.byId(model.mesh);
      if (!model || !mesh) continue;
      if (mesh.layout.joints) throw new Error(`Deformable on '${this.entity.name}': skinned meshes cannot be dented`);
      const copy = deformableCopy(mesh, this.subdivide);
      model.mesh = copy.mesh.id;
      const scale = averageScale(entity.require(Transform).world);
      this.#parts.push({ entity, ...copy, ...surfaceIndex(copy.rest, copy.mesh.data.indices, this.radius / scale), bounds: expand(copy.mesh.bounds, this.maxDent / scale) });
    }
    if (this.#parts.length === 0) throw new Error(`Deformable on '${this.entity.name}': the entity has no model`);
    simulation.setContactHandler(this.entity, { onStartedTouching: (contact) => this.#hit(contact) });
  }

  override cancel(): void {
    for (const part of this.#parts) part.mesh.dispose();
    this.#parts = [];
  }

  /** 在世界位置 point 处沿 direction（单位向量，往物体里）推进去 depth 米，影响半径 radius 米。 */
  dent(point: readonly number[], direction: readonly number[], depth: number, radius: number): void {
    if (!(depth > 0)) return;
    this.dents++;
    for (const part of this.#parts) this.deepest = Math.max(this.deepest, dentPart(part, point, direction, depth, radius, this.maxDent));
  }

  #hit({ speed, point, normal }: StartedContact): void {
    const over = speed - this.threshold;
    if (over <= 0) return;
    // 法线从自己指向对方：往里推是反方向
    this.dent(point, [-normal[0], -normal[1], -normal[2]], over * this.softness, this.radius * (1 + over * 0.05));
  }
}

interface Part extends SurfaceIndex {
  readonly entity: Entity;
  readonly mesh: Mesh;
  /** 原来的位置（模型空间），限制离原位的距离用。 */
  readonly rest: Float32Array;
  /** 剔除用的包围盒：原来的放大 maxDent（凹陷只往里推，不用每次重算）。 */
  readonly bounds: Bounds;
}

/** 找一次凹陷碰到哪些顶点、三角形用的索引：原位置按格子分桶，顶点到所在三角形的邻接表（CSR）。 */
interface SurfaceIndex {
  readonly cellSize: number;
  readonly cells: Map<string, number[]>;
  readonly triangleStart: Uint32Array;
  readonly triangles: Uint32Array;
  /** 重算法线时标记顶点用：marks[v] 等于这一轮的编号 round[0] 时已经取过。 */
  readonly marks: Uint32Array;
  readonly round: Uint32Array;
}

function surfaceIndex(rest: Float32Array, indices: ArrayLike<number>, cellSize: number): SurfaceIndex {
  const cells = new Map<string, number[]>();
  for (let v = 0; v < rest.length / 3; v++) {
    const key = cellKey(rest[v * 3]! / cellSize, rest[v * 3 + 1]! / cellSize, rest[v * 3 + 2]! / cellSize);
    let list = cells.get(key);
    if (!list) cells.set(key, (list = []));
    list.push(v);
  }
  const count = rest.length / 3;
  const triangleStart = new Uint32Array(count + 1);
  for (let i = 0; i < indices.length; i++) triangleStart[indices[i]! + 1]!++;
  for (let v = 0; v < count; v++) triangleStart[v + 1]! += triangleStart[v]!;
  const triangles = new Uint32Array(indices.length), filled = triangleStart.slice(0, count);
  for (let i = 0; i < indices.length; i++) triangles[filled[indices[i]!]!++] = Math.floor(i / 3);
  return { cellSize, cells, triangleStart, triangles, marks: new Uint32Array(count), round: new Uint32Array(1) };
}

const cellKey = (x: number, y: number, z: number) => `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`;

/** 世界矩阵的平均缩放（三个轴缩放的几何平均）。 */
function averageScale(world: Float64Array): number {
  return Math.cbrt(Math.abs(Matrix.decompose(world).scale.reduce((product, value) => product * value, 1))) || 1;
}

function expand({ min, max }: Bounds, by: number): Bounds {
  return { min: [min[0] - by, min[1] - by, min[2] - by], max: [max[0] + by, max[1] + by, max[2] + by] };
}

/** 网格复制成不量化的动态网格（可选细分）。 */
export function deformableCopy(mesh: Mesh, subdivide: number): { mesh: Mesh; rest: Float32Array } {
  const source = { vertices: mesh.data.vertices, layout: mesh.layout, dequantize: mesh.dequantize };
  const basic = meshFloatVertices(source), tangents = meshTangents(source);
  const count = basic.length / 8;
  let vertices: Float32Array = new Float32Array(count * STRIDE);
  for (let v = 0; v < count; v++) {
    vertices.set(basic.subarray(v * 8, v * 8 + 8), v * STRIDE);
    vertices.set(tangents ? tangents.subarray(v * 4, v * 4 + 4) : [1, 0, 0, 1], v * STRIDE + 8);
  }
  let indices: Uint32Array = Uint32Array.from(mesh.data.indices);
  if (subdivide > 0) ({ vertices, indices } = subdivideMesh(vertices, indices, subdivide));
  const rest = new Float32Array(vertices.length / STRIDE * 3);
  for (let v = 0; v < rest.length / 3; v++) rest.set(vertices.subarray(v * STRIDE, v * STRIDE + 3), v * 3);
  return { mesh: new Mesh(`${mesh.name} (dented)`, { vertices, indices, layout: LAYOUT, dynamic: true }), rest };
}

/** 中点细分，直到所有边不超过 maxEdge（顶点数到 65536 以上停下）；同一条边（按两个顶点下标）的中点只建一个。 */
export function subdivideMesh(vertices: Float32Array, indices: Uint32Array, maxEdge: number, stride = STRIDE): { vertices: Float32Array; indices: Uint32Array } {
  let values = Array.from(vertices), tris = Array.from(indices);
  const length = (a: number, b: number) => Math.hypot(values[a * stride]! - values[b * stride]!, values[a * stride + 1]! - values[b * stride + 1]!, values[a * stride + 2]! - values[b * stride + 2]!);
  for (let round = 0; round < 12 && values.length / stride < 65536; round++) {
    const midpoints = new Map<number, number>();
    const next: number[] = [];
    let split = false;
    const midpoint = (a: number, b: number) => {
      const key = Math.min(a, b) * 0x200000 + Math.max(a, b);
      let m = midpoints.get(key);
      if (m === undefined) {
        m = values.length / stride;
        for (let k = 0; k < stride; k++) values.push((values[a * stride + k]! + values[b * stride + k]!) / 2);
        // 法线重新归一（切线的手性照第一个点的）；只有位置的（stride 3）没有法线
        if (stride >= 6) {
          const n = m * stride + 3, length = Math.hypot(values[n]!, values[n + 1]!, values[n + 2]!) || 1;
          for (let k = 0; k < 3; k++) values[n + k]! /= length;
        }
        if (stride >= 12) values[m * stride + 11] = values[a * stride + 11]!;
        midpoints.set(key, m);
      }
      return m;
    };
    for (let t = 0; t < tris.length; t += 3) {
      const [a, b, c] = [tris[t]!, tris[t + 1]!, tris[t + 2]!];
      if (Math.max(length(a, b), length(b, c), length(c, a)) <= maxEdge) {
        next.push(a, b, c);
        continue;
      }
      split = true;
      const ab = midpoint(a, b), bc = midpoint(b, c), ca = midpoint(c, a);
      next.push(a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca);
    }
    tris = next;
    if (!split) break;
  }
  return { vertices: Float32Array.from(values), indices: Uint32Array.from(tris) };
}

/** 推一个部分；返回推完以后离原位最远的距离（世界米，按平均缩放折算）。 */
function dentPart(part: Part, point: readonly number[], direction: readonly number[], depth: number, radius: number, maxDent: number): number {
  const world = part.entity.require(Transform).world;
  const inverse = new Float64Array(16);
  Matrix.invert(inverse, world);
  const scale = averageScale(world);
  // 接触点、方向换到模型空间（方向按逆矩阵的线性部分）
  const local = [0, 1, 2].map((k) => inverse[k]! * point[0]! + inverse[4 + k]! * point[1]! + inverse[8 + k]! * point[2]! + inverse[12 + k]!);
  const along = [0, 1, 2].map((k) => inverse[k]! * direction[0]! + inverse[4 + k]! * direction[1]! + inverse[8 + k]! * direction[2]!);
  const r = radius / scale, push = depth / scale, limit = maxDent / scale;
  const vertices = part.mesh.data.vertices as Float32Array, rest = part.rest;
  const moved: number[] = [];
  let deepest = 0;
  // 只看接触点周围的格子（原位离接触点 r + limit 以内的才可能碰到）
  const reach = r + limit, size = part.cellSize;
  const lo = local.map((value) => Math.floor((value - reach) / size)), hi = local.map((value) => Math.floor((value + reach) / size));
  const candidates: number[] = [];
  for (let x = lo[0]!; x <= hi[0]!; x++) for (let y = lo[1]!; y <= hi[1]!; y++) for (let z = lo[2]!; z <= hi[2]!; z++) {
    const list = part.cells.get(`${x},${y},${z}`);
    if (list) for (const v of list) candidates.push(v);
  }
  const [px, py, pz] = local as [number, number, number], [ax, ay, az] = along as [number, number, number];
  for (const v of candidates) {
    const o = v * STRIDE, q = v * 3;
    const dx = vertices[o]! - px, dy = vertices[o + 1]! - py, dz = vertices[o + 2]! - pz;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 >= r * r) continue;
    const amount = push * (1 - d2 / (r * r)) ** 2;
    let x = vertices[o]! + ax * amount, y = vertices[o + 1]! + ay * amount, z = vertices[o + 2]! + az * amount;
    // 离原位不超过 limit
    let ox = x - rest[q]!, oy = y - rest[q + 1]!, oz = z - rest[q + 2]!;
    let distance = Math.sqrt(ox * ox + oy * oy + oz * oz);
    if (distance > limit) {
      const shrink = limit / distance;
      ox *= shrink;
      oy *= shrink;
      oz *= shrink;
      x = rest[q]! + ox;
      y = rest[q + 1]! + oy;
      z = rest[q + 2]! + oz;
      distance = limit;
    }
    vertices[o] = x;
    vertices[o + 1] = y;
    vertices[o + 2] = z;
    if (distance * scale > deepest) deepest = distance * scale;
    moved.push(v);
  }
  if (moved.length === 0) return 0;
  recomputeNormals(vertices, part.mesh.data.indices, part, moved);
  part.mesh.updateVertices(part.bounds);
  return deepest;
}

/** 动过的顶点的法线按它们所在三角形（邻接表）的面法线（面积加权）重算；它们的三角形的别的角也跟着重算。 */
function recomputeNormals(vertices: Float32Array, indices: ArrayLike<number>, index: SurfaceIndex, moved: readonly number[]): void {
  // 动过的顶点和它们三角形的别的角，各取一次（按这一轮的编号标记，不用 Set）
  const round = ++index.round[0]!;
  const touched: number[] = [];
  const mark = (v: number) => {
    if (index.marks[v] === round) return;
    index.marks[v] = round;
    touched.push(v);
  };
  for (const v of moved) {
    for (let i = index.triangleStart[v]!; i < index.triangleStart[v + 1]!; i++) {
      const t = index.triangles[i]! * 3;
      mark(indices[t]!);
      mark(indices[t + 1]!);
      mark(indices[t + 2]!);
    }
  }
  for (const v of touched) {
    let nx = 0, ny = 0, nz = 0;
    for (let i = index.triangleStart[v]!; i < index.triangleStart[v + 1]!; i++) {
      const t = index.triangles[i]! * 3;
      const a = indices[t]! * STRIDE, b = indices[t + 1]! * STRIDE, c = indices[t + 2]! * STRIDE;
      const e1x = vertices[b]! - vertices[a]!, e1y = vertices[b + 1]! - vertices[a + 1]!, e1z = vertices[b + 2]! - vertices[a + 2]!;
      const e2x = vertices[c]! - vertices[a]!, e2y = vertices[c + 1]! - vertices[a + 1]!, e2z = vertices[c + 2]! - vertices[a + 2]!;
      nx += e1y * e2z - e1z * e2y;
      ny += e1z * e2x - e1x * e2z;
      nz += e1x * e2y - e1y * e2x;
    }
    const length = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (length > 1e-12) {
      vertices[v * STRIDE + 3] = nx / length;
      vertices[v * STRIDE + 4] = ny / length;
      vertices[v * STRIDE + 5] = nz / length;
    }
  }
}
