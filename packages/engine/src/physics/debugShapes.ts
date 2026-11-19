/**
 * 把碰撞体的形状画成线框（game.debugDraw），调试物理和编辑器里显示碰撞体用：盒子、球、胶囊、圆柱画它们本来的样子；
 * 网格形状画三角形的边；凸包画的是给它出顶点的那些网格的边（凸包本身是这些顶点的外壳，在原生那边算，这里没有它的面）。
 *
 * 基本形状不随实体的缩放变（同物理里的形状），网格和凸包按实体的世界缩放。
 */
import type { DebugColor, DebugDraw, DebugDrawOptions } from '../debug/DebugDraw';
import type { Mesh } from '../rendering/Mesh';
import type { Collider, ColliderShape } from './Collider';

type Triple = readonly [number, number, number];

/** 列主序的 4x4 相乘：先 b 后 a。 */
function multiply(a: ArrayLike<number>, b: ArrayLike<number>): Float32Array {
  const out = new Float32Array(16);
  for (let column = 0; column < 4; column++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + row]! * b[column * 4 + k]!;
      out[column * 4 + row] = sum;
    }
  }
  return out;
}

/** 平移加旋转（四元数 xyzw）的矩阵。 */
function pose([px, py, pz]: Triple, [x, y, z, w]: readonly [number, number, number, number]): Float32Array {
  return new Float32Array([
    1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w), 0,
    2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w), 0,
    2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y), 0,
    px, py, pz, 1,
  ]);
}

/** 去掉缩放：三个轴各自归一。 */
function unscaled(world: ArrayLike<number>): Float32Array {
  const out = Float32Array.from(world);
  for (let axis = 0; axis < 3; axis++) {
    const length = Math.hypot(out[axis * 4]!, out[axis * 4 + 1]!, out[axis * 4 + 2]!) || 1;
    for (let k = 0; k < 3; k++) out[axis * 4 + k]! /= length;
  }
  return out;
}

function point(m: ArrayLike<number>, x: number, y: number, z: number): Triple {
  return [m[0]! * x + m[4]! * y + m[8]! * z + m[12]!, m[1]! * x + m[5]! * y + m[9]! * z + m[13]!, m[2]! * x + m[6]! * y + m[10]! * z + m[14]!];
}

/** 网格的边（每条边两个端点，各三个数，网格自己的坐标）：三角形共用的边只留一条。按网格缓存。 */
const meshEdges = new WeakMap<Mesh, Float32Array>();

function edgesOf(mesh: Mesh): Float32Array {
  let edges = meshEdges.get(mesh);
  if (!edges) {
    const positions = mesh.positions(), indices = mesh.data.indices;
    const seen = new Set<number>();
    const out: number[] = [];
    const vertexCount = positions.length / 3;
    for (let t = 0; t + 2 < indices.length; t += 3) {
      for (let e = 0; e < 3; e++) {
        const a = indices[t + e]!, b = indices[t + ((e + 1) % 3)]!;
        const key = Math.min(a, b) * vertexCount + Math.max(a, b);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(positions[a * 3]!, positions[a * 3 + 1]!, positions[a * 3 + 2]!, positions[b * 3]!, positions[b * 3 + 1]!, positions[b * 3 + 2]!);
      }
    }
    meshEdges.set(mesh, (edges = Float32Array.from(out)));
  }
  return edges;
}

/** 碰撞体的各个形状画成线框；world 是实体的世界矩阵（列主序）。 */
export function drawCollider(debugDraw: DebugDraw, collider: Collider, world: ArrayLike<number>, color: DebugColor, options?: DebugDrawOptions): void {
  const rigid = unscaled(world);
  for (const shape of collider.shapes) drawShape(debugDraw, shape, world, rigid, color, options);
}

function drawShape(debugDraw: DebugDraw, shape: ColliderShape, world: ArrayLike<number>, rigid: Float32Array, color: DebugColor, options: DebugDrawOptions | undefined): void {
  const local = pose(shape.position ?? [0, 0, 0], shape.rotation ?? [0, 0, 0, 1]);
  switch (shape.type) {
    case 'box':
      debugDraw.box(multiply(rigid, local), [shape.size[0] / 2, shape.size[1] / 2, shape.size[2] / 2], color, options);
      return;
    case 'sphere': {
      const m = multiply(rigid, local);
      // 三个大圆跟着形状的朝向，转起来看得出来
      for (const axis of [0, 1, 2]) debugDraw.circle([m[12]!, m[13]!, m[14]!], [m[axis * 4]!, m[axis * 4 + 1]!, m[axis * 4 + 2]!], shape.radius, color, options);
      return;
    }
    case 'capsule':
    case 'cylinder': {
      const m = multiply(rigid, local);
      const from = point(m, 0, -shape.length / 2, 0), to = point(m, 0, shape.length / 2, 0);
      if (shape.type === 'capsule') debugDraw.capsule(from, to, shape.radius, color, options);
      else debugDraw.cylinder(from, to, shape.radius, color, options);
      return;
    }
    case 'mesh':
    case 'convexHull': {
      let m = multiply(world, local);
      if (shape.type === 'convexHull' && shape.hull) {
        const { scale, rotation, offset } = shape.hull;
        const hull = pose(offset, rotation);
        for (let axis = 0; axis < 3; axis++) for (let k = 0; k < 3; k++) hull[axis * 4 + k]! *= scale[axis]!;
        m = multiply(m, hull);
      }
      for (const mesh of shape.meshes) {
        const edges = edgesOf(mesh);
        for (let i = 0; i < edges.length; i += 6) debugDraw.line(point(m, edges[i]!, edges[i + 1]!, edges[i + 2]!), point(m, edges[i + 3]!, edges[i + 4]!, edges[i + 5]!), color, options);
      }
      return;
    }
    case 'empty':
      return;
  }
}
