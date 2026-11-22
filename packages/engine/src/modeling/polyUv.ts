/**
 * 多边形网格的 UV 编辑（照 Blender 的 UV 编辑、ProBuilder 的 UV Editor）：面上存每个角的 UV（PolyFaceFile.uvs），没存的按朝向自动
 * 投影（polyMesh.ts 的 projectUv）。纯函数，编辑器的 UV 面板和 MCP 的 edit_poly 都调。
 *
 * - 平面投影（projectFacesUv）：选中的面按它们的平均法线投到一个平面上——同一块（岛）不断开、形状不变形（斜面、曲面上不像自动
 *   投影那样按最大的轴切成几块）。轴的取法和自动投影一致：正对 +Z 的面 u 是 x、v 是 −y，正对 +X 的 u 是 −z，朝上的 u 是 x、v 是 z。
 * - 变换（transformFacesUv）：选中的面的 UV 绕它们的中心旋转、缩放，再平移；还没存 UV 的面先把自动投影的那份存下来再变。
 * - 回到自动（resetFacesUv）：去掉存的 UV。
 *
 * 改了面的顶点的建模操作（切分、合并、挤出的侧面……）之后，这个面的 UV 个数对不上，烘焙时自动回到投影，不会错位。
 */
import type { PolyFaceFile, PolyMeshFile } from '../content/formats/assetFormat.ts';
import { faceNormal, projectUv } from './polyMesh.ts';

type Vec2 = readonly [number, number];

const round = (value: number) => Math.round(value * 1e5) / 1e5;

function checkFaces(mesh: PolyMeshFile, faces: readonly number[], what: string): void {
  if (faces.length === 0) throw new Error(`${what}: no faces selected`);
  for (const f of faces) if (!mesh.faces[f]) throw new Error(`${what}: there is no face ${f} (the mesh has ${mesh.faces.length})`);
}

/** 面现在的 UV（存的；没存或者对不上时是自动投影的）。 */
export function faceUvs(mesh: PolyMeshFile, face: number): Vec2[] {
  const f = mesh.faces[face]!;
  if (f.uvs?.length === f.vertices.length) return f.uvs.map(([u, v]) => [u, v]);
  const n = faceNormal(mesh.vertices, f.vertices);
  return f.vertices.map((i) => projectUv(mesh.vertices[i]!, n, mesh.uvScale ?? 1));
}

const withUvs = (mesh: PolyMeshFile, uvs: ReadonlyMap<number, readonly Vec2[] | undefined>): PolyMeshFile => ({
  ...mesh,
  faces: mesh.faces.map((face, f): PolyFaceFile => {
    if (!uvs.has(f)) return face;
    const next = uvs.get(f);
    if (next) return { ...face, uvs: next.map(([u, v]) => [round(u), round(v)] as const) };
    const { uvs: _dropped, ...rest } = face;
    return rest;
  }),
});

/** 平面投影（见文件开头）：uvScale 米一个周期，默认用网格的 uvScale。 */
export function projectFacesUv(mesh: PolyMeshFile, faces: readonly number[], uvScale = mesh.uvScale ?? 1): PolyMeshFile {
  checkFaces(mesh, faces, 'uvProject');
  if (!(uvScale > 0)) throw new Error(`uvProject: uvScale must be > 0, got ${uvScale}`);
  const sum = [0, 0, 0];
  for (const f of faces) {
    const n = faceNormal(mesh.vertices, mesh.faces[f]!.vertices);
    for (let k = 0; k < 3; k++) sum[k]! += n[k]!;
  }
  const length = Math.hypot(sum[0]!, sum[1]!, sum[2]!) || 1;
  const n = [sum[0]! / length, sum[1]! / length, sum[2]! / length] as const;
  // 朝上、朝下的面用 −Z 当"上"，别的用 +Y（和自动投影的轴一致）
  const up = Math.abs(n[1]) > 0.999 ? [0, 0, -Math.sign(n[1])] : [0, 1, 0];
  const cross = (a: readonly number[], b: readonly number[]) => [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
  const uRaw = cross(up, n), uLength = Math.hypot(uRaw[0]!, uRaw[1]!, uRaw[2]!);
  const u = uRaw.map((c) => c / uLength), v = cross(n, u);
  const dot = (a: readonly number[], b: readonly number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
  const uvs = new Map<number, Vec2[]>();
  for (const f of faces) uvs.set(f, mesh.faces[f]!.vertices.map((i) => [dot(mesh.vertices[i]!, u) / uvScale, -dot(mesh.vertices[i]!, v) / uvScale]));
  return withUvs(mesh, uvs);
}

/** 变换（见文件开头）：rotation 度（逆时针），scale 一个数或 [u, v]，offset 加在最后。 */
export function transformFacesUv(mesh: PolyMeshFile, faces: readonly number[], { offset = [0, 0], scale = 1, rotation = 0 }: { readonly offset?: Vec2; readonly scale?: number | Vec2; readonly rotation?: number }): PolyMeshFile {
  checkFaces(mesh, faces, 'uvTransform');
  const [su, sv] = typeof scale === 'number' ? [scale, scale] : scale;
  const current = new Map(faces.map((f) => [f, faceUvs(mesh, f)] as const));
  const all = [...current.values()].flat();
  const center = [all.reduce((s, p) => s + p[0], 0) / all.length, all.reduce((s, p) => s + p[1], 0) / all.length] as const;
  const a = (rotation * Math.PI) / 180, cos = Math.cos(a), sin = Math.sin(a);
  const uvs = new Map<number, Vec2[]>();
  for (const [f, points] of current) {
    uvs.set(f, points.map(([u, v]) => {
      const x = (u - center[0]) * su, y = (v - center[1]) * sv;
      return [center[0] + x * cos - y * sin + offset[0], center[1] + x * sin + y * cos + offset[1]];
    }));
  }
  return withUvs(mesh, uvs);
}

/** 回到自动投影：去掉这些面存的 UV。 */
export function resetFacesUv(mesh: PolyMeshFile, faces: readonly number[]): PolyMeshFile {
  checkFaces(mesh, faces, 'uvReset');
  return withUvs(mesh, new Map(faces.map((f) => [f, undefined] as const)));
}
