/**
 * 多边形网格（content/formats/assetFormat.ts 的 PolyMeshFile）的几何：镜像、面法线、三角化、光滑法线、自动 UV，得出按材质槽分好的
 * 三角形网格（编辑器后端烘成模型用，pipeline 的 bakers/polyModel.ts）。编辑操作在 polyEdit.ts。
 *
 * - 面法线用 Newell 法（凹的、不太平的多边形也稳）；
 * - 三角化按面法线最大的分量投到平面上耳切（凹多边形也对，不支持带洞的面）；
 * - 光滑：一个面的角点的法线是共用这个顶点、和这个面夹角小于 smoothAngle 的面的法线按面积加权平均（同 Blender 的 Auto Smooth），
 *   别的面在这里是硬边；
 * - UV 按面法线（同一个面的角点用同一个投影方向，面内不断开）投影世界坐标，同白盒。
 */
import type { PolyFaceFile, PolyMeshFile, Vec3Tuple } from '../content/formats/assetFormat.ts';

/** 一个材质槽的三角形网格：每个顶点 8 个数（位置、法线、UV），索引三个一组。 */
export interface PolySlotMesh {
  readonly material: number;
  readonly vertices: Float32Array;
  readonly indices: Uint32Array;
}

/** 光滑角的默认值（度）。 */
export const DEFAULT_SMOOTH_ANGLE = 30;

/** 网格里的面和顶点（镜像过的）：编辑操作、烘焙都按这个算。 */
export interface PolyTopology {
  readonly vertices: readonly Vec3Tuple[];
  readonly faces: readonly PolyFaceFile[];
}

/**
 * 按 mirror 镜像一份：每个顶点在平面另一边有一个镜像（落在平面上的共用自己），每个面镜像后顶点顺序倒过来（法线朝外）。
 * 没有 mirror 时原样返回。
 */
export function mirrored(file: Pick<PolyMeshFile, 'vertices' | 'faces' | 'mirror'>): PolyTopology {
  if (!file.mirror) return file;
  const axis = ({ x: 0, y: 1, z: 2 } as const)[file.mirror];
  const vertices = [...file.vertices];
  const twin = file.vertices.map((v) => {
    if (Math.abs(v[axis]) < 1e-6) return -1;
    const copy = [...v] as [number, number, number];
    copy[axis] = -v[axis];
    vertices.push(copy);
    return vertices.length - 1;
  });
  const faces = [
    ...file.faces,
    ...file.faces.map((face) => ({ ...face, vertices: [...face.vertices].reverse().map((i) => (twin[i]! < 0 ? i : twin[i]!)) })),
  ];
  return { vertices, faces };
}

/** 面法线（Newell 法，没归一化：长度是面积的两倍）。 */
export function faceNormalRaw(vertices: readonly Vec3Tuple[], face: readonly number[]): [number, number, number] {
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < face.length; i++) {
    const a = vertices[face[i]!]!, b = vertices[face[(i + 1) % face.length]!]!;
    nx += (a[1] - b[1]) * (a[2] + b[2]);
    ny += (a[2] - b[2]) * (a[0] + b[0]);
    nz += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return [nx, ny, nz];
}

/** 单位面法线；退化的面（面积 0）是 [0, 1, 0]。 */
export function faceNormal(vertices: readonly Vec3Tuple[], face: readonly number[]): [number, number, number] {
  const [x, y, z] = faceNormalRaw(vertices, face);
  const length = Math.hypot(x, y, z);
  return length > 1e-12 ? [x / length, y / length, z / length] : [0, 1, 0];
}

/** 面的中心（顶点的平均）。 */
export function faceCenter(vertices: readonly Vec3Tuple[], face: readonly number[]): [number, number, number] {
  const c: [number, number, number] = [0, 0, 0];
  for (const i of face) for (let k = 0; k < 3; k++) c[k]! += vertices[i]![k]! / face.length;
  return c;
}

/**
 * 把一个面三角化：返回面里的下标（0 起，按 face 的顺序）三个一组。按法线最大的分量投到平面上耳切，三角形和面同向。
 */
export function triangulateFace(vertices: readonly Vec3Tuple[], face: readonly number[]): number[] {
  const n = face.length;
  if (n < 3) return [];
  if (n === 3) return [0, 1, 2];
  const normal = faceNormalRaw(vertices, face);
  const ax = Math.abs(normal[0]), ay = Math.abs(normal[1]), az = Math.abs(normal[2]);
  // 投影的两个轴：丢掉法线最大的那个分量；法线朝负方向时换个顺序，投出来是逆时针
  const [u, v] = ax >= ay && ax >= az ? (normal[0] > 0 ? [1, 2] : [2, 1]) : ay >= az ? (normal[1] > 0 ? [2, 0] : [0, 2]) : (normal[2] > 0 ? [0, 1] : [1, 0]);
  const p = face.map((i) => [vertices[i]![u!]!, vertices[i]![v!]!] as const);
  const cross = (a: number, b: number, c: number) => (p[b]![0] - p[a]![0]) * (p[c]![1] - p[a]![1]) - (p[b]![1] - p[a]![1]) * (p[c]![0] - p[a]![0]);
  const inside = (a: number, b: number, c: number, x: number) => cross(a, b, x) >= 0 && cross(b, c, x) >= 0 && cross(c, a, x) >= 0;
  const left = Array.from({ length: n }, (_, i) => i);
  const out: number[] = [];
  let guard = n * n;
  while (left.length > 3 && guard-- > 0) {
    let clipped = false;
    for (let k = 0; k < left.length; k++) {
      const a = left[(k + left.length - 1) % left.length]!, b = left[k]!, c = left[(k + 1) % left.length]!;
      // 凸角，而且别的顶点不在这个三角形里：是耳朵
      if (cross(a, b, c) <= 1e-12) continue;
      if (left.some((x) => x !== a && x !== b && x !== c && inside(a, b, c, x))) continue;
      out.push(a, b, c);
      left.splice(k, 1);
      clipped = true;
      break;
    }
    // 找不到耳朵（自相交、退化的面）：剩下的按扇形切
    if (!clipped) break;
  }
  for (let k = 1; k + 1 < left.length; k++) out.push(left[0]!, left[k]!, left[k + 1]!);
  return out;
}

/**
 * 按朝向投影的 UV：法线最大的分量选投影面，朝 ±X 的面用 (z, y)、±Y 用 (x, z)、±Z 用 (x, y)，翻过来的面镜像，贴图在每个面上
 * 都是正的；scale 米一个周期。白盒、SDF 建模、多边形网格都用它。
 */
export function projectUv([x, y, z]: readonly number[], [nx, ny, nz]: readonly number[], scale: number): [number, number] {
  const ax = Math.abs(nx!), ay = Math.abs(ny!), az = Math.abs(nz!);
  if (ax >= ay && ax >= az) return [(nx! > 0 ? -z! : z!) / scale, -y! / scale];
  if (ay >= az) return [x! / scale, (ny! > 0 ? z! : -z!) / scale];
  return [(nz! > 0 ? x! : -x!) / scale, -y! / scale];
}

/**
 * 多边形网格换成按材质槽分的三角形网格（先镜像）。面的材质槽越界、顶点下标越界、少于 3 个顶点时报错，消息里有是第几个面。
 */
export function polyMeshSlots(file: PolyMeshFile, where = file.name): PolySlotMesh[] {
  const slots = Math.max(1, file.materials.length);
  file.faces.forEach((face, f) => {
    const slot = face.material ?? 0;
    if (!Number.isInteger(slot) || slot < 0 || slot >= slots) throw new Error(`${where}: face ${f} uses material slot ${slot}, but there ${slots === 1 ? 'is 1 slot' : `are ${slots} slots`}`);
    if (face.vertices.length < 3) throw new Error(`${where}: face ${f} has ${face.vertices.length} vertices (at least 3)`);
    for (const i of face.vertices) if (!Number.isInteger(i) || i < 0 || i >= file.vertices.length) throw new Error(`${where}: face ${f} refers to vertex ${i}, but there are ${file.vertices.length}`);
  });
  const { vertices, faces } = mirrored(file);
  const normals = faces.map((face) => faceNormal(vertices, face.vertices));
  const areas = faces.map((face) => Math.hypot(...faceNormalRaw(vertices, face.vertices)));
  const facesOfVertex = vertices.map(() => [] as number[]);
  faces.forEach((face, f) => face.vertices.forEach((i) => facesOfVertex[i]!.push(f)));
  const cosLimit = Math.cos(((file.smoothAngle ?? DEFAULT_SMOOTH_ANGLE) * Math.PI) / 180);
  const smooth = (file.smoothAngle ?? DEFAULT_SMOOTH_ANGLE) > 0;
  const uvScale = file.uvScale ?? 1;

  const builders = Array.from({ length: slots }, () => ({ vertices: [] as number[], indices: [] as number[], weld: new Map<string, number>() }));
  faces.forEach((face, f) => {
    const builder = builders[face.material ?? 0]!;
    const n = normals[f]!;
    const corner = face.vertices.map((i) => {
      const normal: [number, number, number] = [0, 0, 0];
      for (const g of smooth ? facesOfVertex[i]! : [f]) {
        const m = normals[g]!;
        if (g !== f && n[0] * m[0] + n[1] * m[1] + n[2] * m[2] < cosLimit) continue;
        for (let k = 0; k < 3; k++) normal[k]! += m[k]! * areas[g]!;
      }
      const length = Math.hypot(...normal) || 1;
      for (let k = 0; k < 3; k++) normal[k]! /= length;
      const position = vertices[i]!;
      const uv = projectUv(position, n, uvScale);
      // 位置、法线、UV 都一样的角点合成一个顶点（光滑的面之间、同一个投影方向的面之间）
      const key = `${i}|${normal.map((c) => Math.round(c * 1e4)).join(',')}|${uv.map((c) => Math.round(c * 1e5)).join(',')}`;
      let vertex = builder.weld.get(key);
      if (vertex === undefined) {
        vertex = builder.vertices.length / 8;
        builder.weld.set(key, vertex);
        builder.vertices.push(...position, ...normal, ...uv);
      }
      return vertex;
    });
    for (const k of triangulateFace(vertices, face.vertices)) builder.indices.push(corner[k]!);
  });
  return builders.flatMap((builder, material) => (builder.indices.length === 0 ? [] : [{ material, vertices: Float32Array.from(builder.vertices), indices: Uint32Array.from(builder.indices) }]));
}
