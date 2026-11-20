/**
 * 碰撞体（Stride.BepuPhysics 的 CompoundCollider）：一组带本地位姿的形状。组件的列只能放数字，所以 Static、Character
 * 存碰撞体的 id，仿真建物体时按 id 取回。网格形状引用渲染用的网格（Stride 的 MeshCollider 引用 Model），
 * 位置从网格反量化出来，第一次用到时建成原生的三角网格。
 */
import type { Branded } from '../data/prop';
import { ResourceTable } from '../engine/ResourceTable';
import type { Mesh } from '../rendering/mesh/Mesh';

export type ColliderId = Branded<number, 'ColliderId'>;

type Vec3 = readonly [number, number, number];

/** 一个形状；position、rotation（xyzw）是在实体空间里的本地位姿，mass 只对动态物体和角色有用（各形状的和）。 */
export type ColliderShape = (
  | { readonly type: 'box'; /** 边长（Stride 的 BoxCollider.Size）。 */ readonly size: Vec3 }
  | { readonly type: 'sphere'; readonly radius: number }
  /** 沿本地 Y；length 是两端球心的距离（Stride 的 CapsuleCollider.Length）。 */
  | { readonly type: 'capsule'; readonly radius: number; readonly length: number }
  | { readonly type: 'cylinder'; readonly radius: number; readonly length: number }
  /** 这些网格的全部三角形，按实体的世界缩放（Stride 的 MeshCollider）。动态刚体上只能单独用，质量属性按封闭网格算（同 Bepu）。 */
  | { readonly type: 'mesh'; readonly meshes: readonly Mesh[] }
  /**
   * 这些网格全部顶点的凸包（Stride 的 ConvexHullCollider），按实体的世界缩放。hull 先变换顶点：缩放、旋转（xyzw）、平移
   * （Stride 的 HullAsset 的 Scaling、LocalRotation、LocalOffset），默认不变。
   */
  | { readonly type: 'convexHull'; readonly meshes: readonly Mesh[]; readonly hull?: HullTransform }
  /** 没有形状、不碰撞（Stride 的 EmptyCollider，给约束当锚点用）；只能单独用。 */
  | { readonly type: 'empty' }
) & {
  readonly position?: Vec3;
  readonly rotation?: readonly [number, number, number, number];
  readonly mass?: number;
};

/** 凸包顶点的变换。 */
export interface HullTransform {
  readonly scale: Vec3;
  readonly rotation: readonly [number, number, number, number];
  readonly offset: Vec3;
}

const colliders = new ResourceTable<Collider>();

export class Collider {
  readonly id: ColliderId;
  readonly shapes: readonly ColliderShape[];

  constructor(shapes: readonly ColliderShape[]) {
    if (shapes.length === 0) throw new RangeError('a collider needs at least one shape');
    this.shapes = shapes;
    this.id = colliders.add(this) as ColliderId;
  }

  /** @internal Static、Character 组件里存的 id 对应的碰撞体。 */
  static byId(id: number): Collider | undefined {
    return colliders.get(id);
  }
}

/** 网格形状的三角形：各网格的位置和索引合成一份（索引按前面网格的顶点数偏移）。 */
export function triangleSoup(meshes: readonly Mesh[]): { positions: Float32Array; indices: Uint32Array } {
  const parts = meshes.map((mesh) => ({ positions: mesh.positions(), indices: mesh.data.indices }));
  const positions = new Float32Array(parts.reduce((sum, p) => sum + p.positions.length, 0));
  const indices = new Uint32Array(parts.reduce((sum, p) => sum + p.indices.length, 0));
  let vertex = 0, index = 0;
  for (const part of parts) {
    positions.set(part.positions, vertex * 3);
    for (let i = 0; i < part.indices.length; i++) indices[index + i] = part.indices[i]! + vertex;
    vertex += part.positions.length / 3;
    index += part.indices.length;
  }
  return { positions, indices };
}

/** 凸包的点：各网格的全部顶点，按 hull 缩放、旋转、平移。 */
export function hullPoints(meshes: readonly Mesh[], hull?: HullTransform): Float32Array {
  const parts = meshes.map((mesh) => mesh.positions());
  const points = new Float32Array(parts.reduce((sum, p) => sum + p.length, 0));
  let at = 0;
  for (const part of parts) {
    points.set(part, at);
    at += part.length;
  }
  if (!hull) return points;
  const { scale: [sx, sy, sz], rotation: [qx, qy, qz, qw], offset: [ox, oy, oz] } = hull;
  for (let i = 0; i < points.length; i += 3) {
    const x = points[i]! * sx, y = points[i + 1]! * sy, z = points[i + 2]! * sz;
    // q · v · q⁻¹，展开成 v + 2w(u×v) + 2u×(u×v)
    const cx = qy * z - qz * y, cy = qz * x - qx * z, cz = qx * y - qy * x;
    points[i] = x + 2 * (qw * cx + qy * cz - qz * cy) + ox;
    points[i + 1] = y + 2 * (qw * cy + qz * cx - qx * cz) + oy;
    points[i + 2] = z + 2 * (qw * cz + qx * cy - qy * cx) + oz;
  }
  return points;
}
