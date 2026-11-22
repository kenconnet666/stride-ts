/**
 * 旋转体（轮廓线绕 Y 转一圈）的网格：商品包装的瓶、罐、桶、果蔬（product.ts），熟食的碗、盘（ware.ts）共用。
 */
import { MeshBuilder } from './meshBuilder.ts';

/** 生成的网格（一个材质槽）和标签展开的大小（毫米：贴图的 viewBox，u、v 是它的比例）。 */
export interface ProductMesh {
  readonly vertices: Float32Array;
  readonly indices: Uint32Array;
  readonly labelSize: readonly [number, number];
}

/** 轮廓线上相邻两段的夹角超过这么多（弧度）就是硬边：顶点各用各的法线。 */
const CREASE = 0.5;

/** 轮廓线上的一点：半径、高（米），这一点往下的那一段是不是盖子。 */
export interface ProfilePoint {
  readonly r: number;
  readonly y: number;
  readonly cap?: boolean;
}

/**
 * 旋转体的网格：每一段轮廓线绕一圈是一圈四边形；u 是角度（正面 +Z 在 0.5），v 是从顶面中心沿轮廓线往下量的长度（贴图的上面
 * 对着包装的上面）。硬边两边的顶点分开、各用各段的法线，软的地方取两段的平均。
 */
export function latheMesh(profile: readonly ProfilePoint[], radial: number, deform?: (x: number, y: number, z: number, u: number) => readonly [number, number, number]): ProductMesh {
  const segments = profile.length - 1;
  const lengths = profile.slice(1).map((p, i) => Math.hypot(p.r - profile[i]!.r, p.y - profile[i]!.y));
  const total = lengths.reduce((sum, l) => sum + l, 0);
  // 每段朝外的法线（轮廓线的切线转 90°：往上走的外壁朝外）
  const normals = profile.slice(1).map((p, i) => {
    const dr = p.r - profile[i]!.r, dy = p.y - profile[i]!.y, l = Math.hypot(dr, dy) || 1;
    return [dy / l, -dr / l] as const;
  });
  const pointNormal = (segment: number, end: 0 | 1): readonly [number, number] => {
    const own = normals[segment]!, otherIndex = segment + (end === 0 ? -1 : 1), other = normals[otherIndex];
    if (!other || Math.acos(Math.min(1, own[0] * other[0] + own[1] * other[1])) > CREASE) return own;
    const r = own[0] + other[0], y = own[1] + other[1], l = Math.hypot(r, y) || 1;
    return [r / l, y / l];
  };
  const builder = new MeshBuilder();
  let below = total;
  for (let s = 0; s < segments; s++) {
    const a = profile[s]!, b = profile[s + 1]!;
    const above = below - lengths[s]!;
    if (lengths[s]! < 1e-9) continue;
    const ring = (point: ProfilePoint, end: 0 | 1, v: number) => Array.from({ length: radial + 1 }, (_, k) => {
      const u = k / radial, angle = (u - 0.5) * 2 * Math.PI;
      const [nr, ny] = pointNormal(s, end);
      // 角度 0 对着 +Z（u = 0.5），往 +X 转
      const sin = Math.sin(angle), cos = Math.cos(angle);
      const position = deform ? deform(point.r * sin, point.y, point.r * cos, u) : [point.r * sin, point.y, point.r * cos];
      return builder.vertex(position, [nr * sin, ny, nr * cos], u, v / total);
    });
    const lower = ring(a, 0, below), upper = ring(b, 1, above);
    for (let k = 0; k < radial; k++) {
      const mid = (k + 0.5) / radial, angle = (mid - 0.5) * 2 * Math.PI;
      const [nr, ny] = normals[s]!;
      builder.quad(lower[k]!, lower[k + 1]!, upper[k + 1]!, upper[k]!, [nr * Math.sin(angle), ny, nr * Math.cos(angle)]);
    }
    below = above;
  }
  if (deform) smoothNormals(builder);
  // 标签展开：宽是最粗处的周长，高是轮廓线的长度
  const circumference = 2 * Math.PI * Math.max(...profile.map((p) => p.r));
  return finish(builder, [circumference * 1000, total * 1000]);
}

export function smoothNormals(builder: MeshBuilder): void {
  const { vertices, indices } = builder;
  const key = (i: number) => `${Math.round(vertices[i * 8]! * 1e6)},${Math.round(vertices[i * 8 + 1]! * 1e6)},${Math.round(vertices[i * 8 + 2]! * 1e6)}`;
  const sums = new Map<string, [number, number, number]>();
  for (let t = 0; t < indices.length; t += 3) {
    const [a, b, c] = [indices[t]!, indices[t + 1]!, indices[t + 2]!];
    const p = (i: number) => [vertices[i * 8]!, vertices[i * 8 + 1]!, vertices[i * 8 + 2]!];
    const n = cross(sub(p(b), p(a)), sub(p(c), p(a)));
    for (const i of [a, b, c]) {
      const sum = sums.get(key(i)) ?? [0, 0, 0];
      sums.set(key(i), [sum[0] + n[0]!, sum[1] + n[1]!, sum[2] + n[2]!]);
    }
  }
  for (let i = 0; i < vertices.length / 8; i++) {
    const n = normalize(sums.get(key(i)) ?? [0, 1, 0]);
    vertices[i * 8 + 3] = n[0]!;
    vertices[i * 8 + 4] = n[1]!;
    vertices[i * 8 + 5] = n[2]!;
  }
}

export function finish(builder: MeshBuilder, labelSize: readonly [number, number]): ProductMesh {
  return { vertices: Float32Array.from(builder.vertices), indices: Uint32Array.from(builder.indices), labelSize };
}

export const sub = (a: readonly number[], b: readonly number[]) => [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!];
export const cross = (a: readonly number[], b: readonly number[]) => [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
export const normalize = (v: readonly number[]) => {
  const l = Math.hypot(v[0]!, v[1]!, v[2]!) || 1;
  return [v[0]! / l, v[1]! / l, v[2]! / l];
};
