/**
 * 程序生成的网格（Stride 的 ProceduralModels，照 Stride 4.4.2 的 GeometricPrimitive）：立方体、平面、球、测地球、胶囊、圆柱、
 * 圆环、圆锥、茶壶。导入 Stride 的 .sdpromodel 和 JSON 写的 .model（ProceduralModelFile）都用它。生成后先加 localOffset、再乘
 * scale（法线乘缩放的逆再归一化，同 PrimitiveProceduralModelBase）。Stride 的三角形顺时针是正面，我们逆时针是正面：生成后
 * 每个三角形的后两个顶点对调。尺寸、细分的默认值同 Stride。
 */

/** 一种形状和它的参数（没写的用 Stride 的默认值）。 */
export type ProceduralShape =
  | { readonly type: 'cube'; readonly size?: readonly [number, number, number] }
  | {
    readonly type: 'plane';
    /** x 和另一边（法线朝 Y 时是 z）的长度。 */
    readonly size?: readonly [number, number];
    readonly tessellation?: readonly [number, number];
    /** 背面也生成一份（法线反过来）。 */
    readonly backFace?: boolean;
    /** 法线朝哪根轴，默认 y。 */
    readonly normal?: 'x' | 'y' | 'z';
  }
  | { readonly type: 'sphere'; readonly radius?: number; readonly tessellation?: number }
  | { readonly type: 'geoSphere'; readonly radius?: number; readonly tessellation?: number }
  | { readonly type: 'capsule'; readonly length?: number; readonly radius?: number; readonly tessellation?: number }
  | { readonly type: 'cylinder'; readonly height?: number; readonly radius?: number; readonly tessellation?: number }
  | { readonly type: 'torus'; readonly radius?: number; readonly thickness?: number; readonly tessellation?: number }
  | { readonly type: 'cone'; readonly radius?: number; readonly height?: number; readonly tessellation?: number }
  | { readonly type: 'teapot'; readonly size?: number; readonly tessellation?: number };

/** 形状加上所有形状共有的：UV 的缩放、先平移再缩放。 */
export type ProceduralModel = ProceduralShape & {
  readonly uvScale?: readonly [number, number];
  readonly localOffset?: readonly [number, number, number];
  readonly scale?: readonly [number, number, number];
};

export const PROCEDURAL_SHAPES = ['cube', 'plane', 'sphere', 'geoSphere', 'capsule', 'cylinder', 'torus', 'cone', 'teapot'] as const satisfies readonly ProceduralShape['type'][];

/** 生成的网格：位置、法线、UV 是各自的数组（还没交错）。 */
export interface ProceduralMesh {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly uvs: Float32Array;
  readonly indices: Uint32Array;
}

/** 按形状生成网格；参数不合法（不是有限的正数）时抛错，错误里带着字段名。 */
export function generateProceduralMesh(model: ProceduralModel): ProceduralMesh {
  const [uScale, vScale] = model.uvScale ?? [1, 1];
  let mesh: MeshBuilder;
  switch (model.type) {
    case 'cube':
      mesh = cube(positive3(model.size, [1, 1, 1], 'size'), uScale, vScale);
      break;
    case 'plane': {
      const [sizeX, sizeY] = model.size ?? [1, 1];
      const [tessellationX, tessellationY] = model.tessellation ?? [1, 1];
      mesh = plane(positive(sizeX, 'size[0]'), positive(sizeY, 'size[1]'), tessellationX, tessellationY, uScale, vScale, model.backFace === true, { x: 'UpX', y: 'UpY', z: 'UpZ' }[model.normal ?? 'y']);
      break;
    }
    case 'sphere':
      mesh = sphere(positive(model.radius ?? 0.5, 'radius'), model.tessellation ?? 16, uScale, vScale);
      break;
    case 'geoSphere':
      mesh = geoSphere(positive(model.radius ?? 0.5, 'radius'), Math.min(model.tessellation ?? 3, 8), uScale, vScale);
      break;
    case 'capsule':
      mesh = capsule(model.length ?? 0.5, positive(model.radius ?? 0.35, 'radius'), model.tessellation ?? 8, uScale, vScale);
      break;
    case 'cylinder':
      mesh = cylinder(positive(model.height ?? 1, 'height'), positive(model.radius ?? 0.5, 'radius'), model.tessellation ?? 32, uScale, vScale);
      break;
    case 'torus':
      mesh = torus(positive(model.radius ?? 0.375, 'radius'), positive(model.thickness ?? 0.125, 'thickness'), model.tessellation ?? 32, uScale, vScale);
      break;
    case 'cone':
      mesh = cone(positive(model.radius ?? 0.5, 'radius'), positive(model.height ?? 1, 'height'), model.tessellation ?? 16, uScale, vScale);
      break;
    case 'teapot':
      mesh = teapot(positive(model.size ?? 1, 'size'), model.tessellation ?? 8, uScale, vScale);
      break;
    default:
      throw new Error(`procedural model: unknown type '${(model as { type: unknown }).type}' (expected ${PROCEDURAL_SHAPES.join(', ')})`);
  }
  applyOffsetAndScale(mesh, [...(model.localOffset ?? [0, 0, 0])], [...(model.scale ?? [1, 1, 1])]);
  // 顺时针（Stride）换成逆时针（我们）
  const indices = Uint32Array.from(mesh.indices);
  for (let i = 0; i < indices.length; i += 3) [indices[i + 1], indices[i + 2]] = [indices[i + 2]!, indices[i + 1]!];
  return { positions: Float32Array.from(mesh.positions), normals: Float32Array.from(mesh.normals), uvs: Float32Array.from(mesh.uvs), indices };
}

/**
 * 逐顶点的切线（xyz 和副切线的符号 w），按三角形的 UV 方向累加再对法线正交化（Lengyel 的做法）。程序生成的形状 UV 连续、
 * 没有镜像的接缝，和 MikkTSpace 的结果一致到法线贴图看不出差别；导入的模型照旧用 MikkTSpace。
 */
export function proceduralTangents({ positions, normals, uvs, indices }: ProceduralMesh): Float32Array {
  const count = positions.length / 3;
  const tan = new Float64Array(count * 3), bitan = new Float64Array(count * 3);
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t]!, b = indices[t + 1]!, c = indices[t + 2]!;
    const e1 = [0, 1, 2].map((k) => positions[b * 3 + k]! - positions[a * 3 + k]!);
    const e2 = [0, 1, 2].map((k) => positions[c * 3 + k]! - positions[a * 3 + k]!);
    const du1 = uvs[b * 2]! - uvs[a * 2]!, dv1 = uvs[b * 2 + 1]! - uvs[a * 2 + 1]!;
    const du2 = uvs[c * 2]! - uvs[a * 2]!, dv2 = uvs[c * 2 + 1]! - uvs[a * 2 + 1]!;
    const det = du1 * dv2 - du2 * dv1;
    if (Math.abs(det) < 1e-12) continue;
    const r = 1 / det;
    for (const v of [a, b, c]) {
      for (let k = 0; k < 3; k++) {
        tan[v * 3 + k] = tan[v * 3 + k]! + (e1[k]! * dv2 - e2[k]! * dv1) * r;
        bitan[v * 3 + k] = bitan[v * 3 + k]! + (e2[k]! * du1 - e1[k]! * du2) * r;
      }
    }
  }
  const out = new Float32Array(count * 4);
  for (let v = 0; v < count; v++) {
    const n = [normals[v * 3]!, normals[v * 3 + 1]!, normals[v * 3 + 2]!];
    const t = [tan[v * 3]!, tan[v * 3 + 1]!, tan[v * 3 + 2]!];
    const d = n[0]! * t[0]! + n[1]! * t[1]! + n[2]! * t[2]!;
    let x = t[0]! - n[0]! * d, y = t[1]! - n[1]! * d, z = t[2]! - n[2]! * d;
    let length = Math.hypot(x, y, z);
    if (length < 1e-8) {
      // 退化（极点）：随便取一根和法线垂直的轴
      [x, y, z] = Math.abs(n[0]!) < 0.9 ? [0, -n[2]!, n[1]!] : [-n[2]!, 0, n[0]!];
      length = Math.hypot(x, y, z) || 1;
    }
    x /= length; y /= length; z /= length;
    // 副切线的符号：n × t 和累加的副切线同向是 +1
    const cx = n[1]! * z - n[2]! * y, cy = n[2]! * x - n[0]! * z, cz = n[0]! * y - n[1]! * x;
    const w = cx * bitan[v * 3]! + cy * bitan[v * 3 + 1]! + cz * bitan[v * 3 + 2]! < 0 ? -1 : 1;
    out.set([x, y, z, w], v * 4);
  }
  return out;
}

function positive(value: number, field: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`procedural model: ${field} must be a positive number, got ${value}`);
  return value;
}

function positive3(value: readonly [number, number, number] | undefined, fallback: [number, number, number], field: string): V3 {
  const v = value ?? fallback;
  return [positive(v[0], `${field}[0]`), positive(v[1], `${field}[1]`), positive(v[2], `${field}[2]`)];
}

type V3 = [number, number, number];

/** 生成过程中用的可变网格（Stride 的 GeometricMeshData），顶点一个个加。 */
class MeshBuilder {
  readonly positions: number[] = [];
  readonly normals: number[] = [];
  readonly uvs: number[] = [];
  indices: number[] = [];

  get vertexCount(): number {
    return this.positions.length / 3;
  }

  vertex(position: V3, normal: V3, u: number, v: number): number {
    this.positions.push(...position);
    this.normals.push(...normal);
    this.uvs.push(u, v);
    return this.vertexCount - 1;
  }
}

/** PrimitiveProceduralModelBase.Generate：先平移，再缩放（法线乘缩放的逆，再归一化）。 */
function applyOffsetAndScale(mesh: MeshBuilder, offset: V3, scale: V3): void {
  const { positions, normals } = mesh;
  for (let i = 0; i < positions.length; i += 3) {
    for (let c = 0; c < 3; c++) positions[i + c] = (positions[i + c]! + offset[c]!) * scale[c]!;
    if (scale[0] === 1 && scale[1] === 1 && scale[2] === 1) continue;
    const n = [normals[i]! / scale[0], normals[i + 1]! / scale[1], normals[i + 2]! / scale[2]];
    const length = Math.hypot(n[0]!, n[1]!, n[2]!) || 1;
    for (let c = 0; c < 3; c++) normals[i + c] = n[c]! / length;
  }
}

const CUBE_FACE_NORMALS: readonly V3[] = [[0, 0, 1], [0, 0, -1], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0]];
const CUBE_TEXTURE_COORDINATES: readonly [number, number][] = [[1, 0], [1, 1], [0, 1], [0, 0]];

/** Stride 4.4.2 的 GeometricPrimitive.Cube（没有细分）。 */
function cube(size: V3, uScale: number, vScale: number): MeshBuilder {
  const mesh = new MeshBuilder();
  const half: V3 = [size[0] / 2, size[1] / 2, size[2] / 2];
  CUBE_FACE_NORMALS.forEach((normal, i) => {
    const basis: V3 = i >= 4 ? [0, 0, 1] : [0, 1, 0];
    const side1 = cross(normal, basis), side2 = cross(normal, side1);
    const base = mesh.vertexCount;
    mesh.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    const corners: [number, number][] = [[-1, -1], [-1, 1], [1, 1], [1, -1]];
    corners.forEach(([a, b], k) => {
      const position = [0, 1, 2].map((c) => (normal[c]! + side1[c]! * a + side2[c]! * b) * half[c]!) as V3;
      const [u, v] = CUBE_TEXTURE_COORDINATES[k]!;
      mesh.vertex(position, normal, u * uScale, v * vScale);
    });
  });
  return mesh;
}

/** Stride 的 GeometricPrimitive.Plane。 */
function plane(sizeX: number, sizeY: number, tessellationX: number, tessellationY: number, uFactor: number, vFactor: number, backFace: boolean, normalDirection: string): MeshBuilder {
  const mesh = new MeshBuilder();
  const tx = Math.max(1, tessellationX), ty = Math.max(1, tessellationY);
  const lineWidth = tx + 1;
  const deltaX = sizeX / tx, deltaY = sizeY / ty;
  const hx = sizeX / 2, hy = sizeY / 2;
  const normal: V3 = normalDirection === 'UpY' ? [0, 1, 0] : normalDirection === 'UpX' ? [1, 0, 0] : [0, 0, 1];
  const positionAt = (x: number, y: number): V3 => normalDirection === 'UpY' ? [-hx + deltaX * x, 0, -hy + deltaY * y]
    : normalDirection === 'UpX' ? [0, hy - deltaY * y, hx - deltaX * x] : [-hx + deltaX * x, hy - deltaY * y, 0];
  for (let y = 0; y <= ty; y++) {
    for (let x = 0; x <= tx; x++) mesh.vertex(positionAt(x, y), normal, (uFactor * x) / tx, (vFactor * y) / ty);
  }
  for (let y = 0; y < ty; y++) {
    for (let x = 0; x < tx; x++) {
      const base = lineWidth * y + x;
      mesh.indices.push(base + 1, base + 1 + lineWidth, base + lineWidth, base + 1, base + lineWidth, base);
    }
  }
  if (backFace) {
    const back: V3 = [-normal[0], -normal[1], -normal[2]];
    for (let y = 0; y <= ty; y++) {
      for (let x = 0; x <= tx; x++) mesh.vertex(positionAt(x, y), back, (uFactor * x) / tx, (vFactor * y) / ty);
    }
    for (let y = 0; y < ty; y++) {
      for (let x = 0; x < tx; x++) {
        const base = lineWidth * (y + ty + 1) + x;
        mesh.indices.push(base + 1, base + lineWidth, base + 1 + lineWidth, base + 1, base, base + lineWidth);
      }
    }
  }
  return mesh;
}

/** Stride 的 GeometricPrimitive.Sphere（经纬球，两极各一圈重合的顶点）。 */
function sphere(radius: number, tessellation: number, uScale: number, vScale: number): MeshBuilder {
  const mesh = new MeshBuilder();
  const vertical = Math.max(3, tessellation), horizontal = vertical * 2;
  const down: V3 = [0, -1, 0], up: V3 = [0, 1, 0];
  for (let j = 0; j <= horizontal; j++) mesh.vertex(scaled(down, radius), down, (uScale * j) / horizontal, vScale);
  for (let i = 1; i < vertical; i++) {
    const v = vScale * (1 - i / vertical);
    const latitude = (i * Math.PI) / vertical - Math.PI / 2;
    const dy = Math.sin(latitude), dxz = Math.cos(latitude);
    const first: V3 = [0, dy, dxz];
    mesh.vertex(scaled(first, radius), first, 0, v);
    for (let j = 1; j < horizontal; j++) {
      const longitude = (j * 2 * Math.PI) / horizontal;
      const normal: V3 = [Math.sin(longitude) * dxz, dy, Math.cos(longitude) * dxz];
      mesh.vertex(scaled(normal, radius), normal, (uScale * j) / horizontal, v);
    }
    mesh.vertex(scaled(first, radius), first, uScale, v);
  }
  for (let j = 0; j <= horizontal; j++) mesh.vertex(scaled(up, radius), up, (uScale * j) / horizontal, 0);
  const stride = horizontal + 1;
  for (let i = 0; i < vertical; i++) {
    for (let j = 0; j < horizontal; j++) {
      const next = i + 1;
      mesh.indices.push(i * stride + j, next * stride + j, i * stride + j + 1, i * stride + j + 1, next * stride + j, next * stride + j + 1);
    }
  }
  return mesh;
}

/** Stride 的 GeometricPrimitive.Capsule（lengthRings 是 0，和 4.4.2 一样）。 */
function capsule(length: number, radius: number, tessellation: number, uScale: number, vScale: number): MeshBuilder {
  const mesh = new MeshBuilder();
  const t = Math.max(3, tessellation);
  const vertical = 2 * t, horizontal = 4 * t;
  for (let i = 0; i < vertical; i++) {
    let deltaY: number, v: number, latitude: number;
    if (i < t) {
      deltaY = -length / 2;
      v = 1 - (0.25 * i) / (t - 1);
      latitude = (i * Math.PI) / (vertical - 2) - Math.PI / 2;
    } else {
      deltaY = length / 2;
      v = 0.5 - (0.25 * (i - 1)) / (t - 1);
      latitude = ((i - 1) * Math.PI) / (vertical - 2) - Math.PI / 2;
    }
    const dy = Math.sin(latitude), dxz = Math.cos(latitude);
    for (let j = 0; j <= horizontal; j++) {
      const longitude = (j * 2 * Math.PI) / horizontal;
      const normal: V3 = [Math.sin(longitude) * dxz, dy, Math.cos(longitude) * dxz];
      mesh.vertex([normal[0] * radius, normal[1] * radius + deltaY, normal[2] * radius], normal, (j / horizontal) * uScale, v * vScale);
    }
  }
  const stride = horizontal + 1;
  for (let i = 0; i < vertical - 1; i++) {
    for (let j = 0; j <= horizontal; j++) {
      const next = i + 1, nextJ = (j + 1) % stride;
      mesh.indices.push(i * stride + j, next * stride + j, i * stride + nextJ, i * stride + nextJ, next * stride + j, next * stride + nextJ);
    }
  }
  return mesh;
}

const OCTAHEDRON_VERTICES: readonly V3[] = [[0, 1, 0], [0, 0, -1], [1, 0, 0], [0, 0, 1], [-1, 0, 0], [0, -1, 0]];
const OCTAHEDRON_INDICES = [0, 1, 2, 0, 2, 3, 0, 3, 4, 0, 4, 1, 5, 1, 4, 5, 4, 3, 5, 3, 2, 5, 2, 1];
/** XMVectorSplatEpsilon（Stride 判断顶点在本初子午线上用的误差）。 */
const SPLAT_EPSILON = 1.192092896e-7;

/** Stride 的 GeometricPrimitive.GeoSphere：八面体细分，修好经度接缝和两极的 UV。 */
/** GeometricPrimitive.Cylinder：沿 Y，侧面一圈（首尾两列顶点重合，UV 不同），上下两个扇形盖子。 */
function cylinder(height: number, radius: number, tessellation: number, uScale: number, vScale: number): MeshBuilder {
  const n = Math.max(tessellation, 3);
  const half = height / 2;
  const mesh = new MeshBuilder();
  const circle = (i: number): V3 => {
    const angle = Math.fround((i * 2 * Math.PI) / n);
    return [Math.sin(angle), 0, Math.cos(angle)];
  };
  const stride = n + 1;
  for (let i = 0; i <= n; i++) {
    const normal = circle(i);
    const side = scaled(normal, radius);
    mesh.vertex([side[0], half, side[2]], normal, (i / n) * uScale, 0);
    mesh.vertex([side[0], -half, side[2]], normal, (i / n) * uScale, vScale);
    mesh.indices.push(i * 2, (i * 2 + 2) % (stride * 2), i * 2 + 1, i * 2 + 1, (i * 2 + 2) % (stride * 2), (i * 2 + 3) % (stride * 2));
  }
  for (const isTop of [true, false]) {
    const base = mesh.vertexCount;
    for (let i = 0; i < n - 2; i++) {
      let i1 = (i + 1) % n, i2 = (i + 2) % n;
      if (isTop) [i1, i2] = [i2, i1];
      mesh.indices.push(base, base + i1, base + i2);
    }
    const normal: V3 = isTop ? [0, 1, 0] : [0, -1, 0];
    const scaleX = isTop ? -0.5 : 0.5, scaleY = -0.5;
    for (let i = 0; i < n; i++) {
      const c = circle(i);
      mesh.vertex([c[0] * radius, normal[1] * half, c[2] * radius], normal, uScale * (c[0] * scaleX + 0.5), vScale * (c[2] * scaleY + 0.5));
    }
  }
  return mesh;
}

/**
 * GeometricPrimitive.Torus：圆环在 XZ 平面上，中心线半径 radius，管的半径 thickness；第 i 圈是管的截面（XY 平面上的圆）先平移到
 * (radius, 0, 0) 再绕 Y 转 i · 2π / n - π/2，接缝处的顶点重复（UV 连续）。
 */
function torus(radius: number, thickness: number, tessellation: number, uScale: number, vScale: number): MeshBuilder {
  const n = Math.max(tessellation, 3);
  const stride = n + 1;
  const mesh = new MeshBuilder();
  for (let i = 0; i <= n; i++) {
    const outer = Math.fround((i * 2 * Math.PI) / n - Math.PI / 2);
    const cos = Math.cos(outer), sin = Math.sin(outer);
    for (let j = 0; j <= n; j++) {
      const inner = Math.fround((j * 2 * Math.PI) / n + Math.PI);
      const dx = Math.cos(inner), dy = Math.sin(inner);
      // 截面上的点 (radius + dx · thickness, dy · thickness, 0) 绕 Y 转（Stride 的 RotationY，行向量）
      const x = radius + dx * thickness;
      mesh.vertex([x * cos, dy * thickness, -x * sin], [dx * cos, dy, -dx * sin], (i / n) * uScale, (1 - j / n) * vScale);
      const nextI = (i + 1) % stride, nextJ = (j + 1) % stride;
      mesh.indices.push(i * stride + j, i * stride + nextJ, nextI * stride + j, i * stride + nextJ, nextI * stride + nextJ, nextI * stride + j);
    }
  }
  return mesh;
}

/**
 * GeometricPrimitive.Teapot：每个面片按 tessellation 细分（两次三次贝塞尔插值，法线是两个切线的叉积），左右对称地画两遍、
 * mirrorZ 的再前后对称地画两遍；镜像的面片法线取反、三角形反向、U 翻过来。退化的点（顶上和底下）法线直接朝上或朝下（同 Stride）。
 */
function teapot(size: number, tessellation: number, uScale: number, vScale: number): MeshBuilder {
  const n = Math.max(1, tessellation);
  const mesh = new MeshBuilder();
  const patchOf = (indices: readonly number[], scale: V3): V3[] => indices.map((i) => TEAPOT_CONTROL_POINTS[i]!.map((c, k) => c * scale[k]!) as V3);
  const cubic = (p1: V3, p2: V3, p3: V3, p4: V3, t: number): V3 => {
    const t2 = t * t, one2 = (1 - t) * (1 - t);
    return [0, 1, 2].map((k) => p1[k]! * (1 - t) * one2 + p2[k]! * 3 * t * one2 + p3[k]! * 3 * t2 * (1 - t) + p4[k]! * t * t2) as V3;
  };
  const tangent = (p1: V3, p2: V3, p3: V3, p4: V3, t: number): V3 => {
    const t2 = t * t;
    return [0, 1, 2].map((k) => p1[k]! * (-1 + 2 * t - t2) + p2[k]! * (1 - 4 * t + 3 * t2) + p3[k]! * (2 * t - 3 * t2) + p4[k]! * t2) as V3;
  };
  const tessellate = (indices: readonly number[], scale: V3, mirrored: boolean) => {
    const p = patchOf(indices, scale);
    const base = mesh.vertexCount, stride = n + 1;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const quad = [base + i * stride + j, base + (i + 1) * stride + j, base + (i + 1) * stride + j + 1, base + i * stride + j, base + (i + 1) * stride + j + 1, base + i * stride + j + 1];
        mesh.indices.push(...(mirrored ? quad.reverse() : quad));
      }
    }
    for (let i = 0; i <= n; i++) {
      const u = i / n;
      for (let j = 0; j <= n; j++) {
        const v = j / n;
        const p1 = cubic(p[0]!, p[1]!, p[2]!, p[3]!, u), p2 = cubic(p[4]!, p[5]!, p[6]!, p[7]!, u);
        const p3 = cubic(p[8]!, p[9]!, p[10]!, p[11]!, u), p4 = cubic(p[12]!, p[13]!, p[14]!, p[15]!, u);
        const position = cubic(p1, p2, p3, p4, v);
        const q1 = cubic(p[0]!, p[4]!, p[8]!, p[12]!, v), q2 = cubic(p[1]!, p[5]!, p[9]!, p[13]!, v);
        const q3 = cubic(p[2]!, p[6]!, p[10]!, p[14]!, v), q4 = cubic(p[3]!, p[7]!, p[11]!, p[15]!, v);
        let normal = cross(tangent(p1, p2, p3, p4, v), tangent(q1, q2, q3, q4, u));
        if (normal.every((c) => Math.abs(c) <= 1e-7)) normal = [0, position[1] < 0 ? -1 : 1, 0];
        else {
          const length = Math.hypot(...normal);
          normal = normal.map((c) => (mirrored ? -c : c) / length) as V3;
        }
        mesh.vertex(position, normal, (mirrored ? 1 - u : u) * uScale, v * vScale);
      }
    }
  };
  for (const { mirrorZ, indices } of TEAPOT_PATCHES) {
    // 左右对称：只存一边，镜像 X 再画一遍；mirrorZ 的（壶身、壶盖、壶沿、底）前后也对称
    tessellate(indices, [size, size, size], false);
    tessellate(indices, [-size, size, size], true);
    if (!mirrorZ) continue;
    tessellate(indices, [size, size, -size], true);
    tessellate(indices, [-size, size, -size], false);
  }
  return mesh;
}

/** Stride 的 GeometricPrimitive.Teapot（DirectXTK 的数据）：10 个贝塞尔面片，每个 16 个控制点的下标；mirrorZ 的面片前后也对称。 */
const TEAPOT_PATCHES: readonly { readonly mirrorZ: boolean; readonly indices: readonly number[] }[] = [
  { mirrorZ: true, indices: [102, 103, 104, 105, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] },
  { mirrorZ: true, indices: [12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27] },
  { mirrorZ: true, indices: [24, 25, 26, 27, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40] },
  { mirrorZ: true, indices: [96, 96, 96, 96, 97, 98, 99, 100, 101, 101, 101, 101, 0, 1, 2, 3] },
  { mirrorZ: true, indices: [0, 1, 2, 3, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115, 116, 117] },
  { mirrorZ: false, indices: [41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56] },
  { mirrorZ: false, indices: [53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 28, 65, 66, 67] },
  { mirrorZ: false, indices: [68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81, 82, 83] },
  { mirrorZ: false, indices: [80, 81, 82, 83, 84, 85, 86, 87, 88, 89, 90, 91, 92, 93, 94, 95] },
  { mirrorZ: true, indices: [118, 118, 118, 118, 124, 122, 119, 121, 123, 126, 125, 120, 40, 39, 38, 37] },
];

const TEAPOT_CONTROL_POINTS: readonly V3[] = [
  [0, 0.345, -0.05], [-0.028, 0.345, -0.05], [-0.05, 0.345, -0.028], [-0.05, 0.345, -0], [0, 0.3028125, -0.334375],
  [-0.18725, 0.3028125, -0.334375], [-0.334375, 0.3028125, -0.18725], [-0.334375, 0.3028125, -0], [0, 0.3028125, -0.359375],
  [-0.20125, 0.3028125, -0.359375], [-0.359375, 0.3028125, -0.20125], [-0.359375, 0.3028125, -0], [0, 0.27, -0.375], [-0.21, 0.27, -0.375],
  [-0.375, 0.27, -0.21], [-0.375, 0.27, -0], [0, 0.13875, -0.4375], [-0.245, 0.13875, -0.4375], [-0.4375, 0.13875, -0.245],
  [-0.4375, 0.13875, -0], [0, 0.007499993, -0.5], [-0.28, 0.007499993, -0.5], [-0.5, 0.007499993, -0.28], [-0.5, 0.007499993, -0],
  [0, -0.105, -0.5], [-0.28, -0.105, -0.5], [-0.5, -0.105, -0.28], [-0.5, -0.105, -0], [0, -0.105, 0.5], [0, -0.2175, -0.5],
  [-0.28, -0.2175, -0.5], [-0.5, -0.2175, -0.28], [-0.5, -0.2175, -0], [0, -0.27375, -0.375], [-0.21, -0.27375, -0.375],
  [-0.375, -0.27375, -0.21], [-0.375, -0.27375, -0], [0, -0.2925, -0.375], [-0.21, -0.2925, -0.375], [-0.375, -0.2925, -0.21],
  [-0.375, -0.2925, -0], [0, 0.17625, 0.4], [-0.075, 0.17625, 0.4], [-0.075, 0.2325, 0.375], [0, 0.2325, 0.375], [0, 0.17625, 0.575],
  [-0.075, 0.17625, 0.575], [-0.075, 0.2325, 0.625], [0, 0.2325, 0.625], [0, 0.17625, 0.675], [-0.075, 0.17625, 0.675],
  [-0.075, 0.2325, 0.75], [0, 0.2325, 0.75], [0, 0.12, 0.675], [-0.075, 0.12, 0.675], [-0.075, 0.12, 0.75], [0, 0.12, 0.75],
  [0, 0.06375, 0.675], [-0.075, 0.06375, 0.675], [-0.075, 0.007499993, 0.75], [0, 0.007499993, 0.75], [0, -0.04875001, 0.625],
  [-0.075, -0.04875001, 0.625], [-0.075, -0.09562501, 0.6625], [0, -0.09562501, 0.6625], [-0.075, -0.105, 0.5], [-0.075, -0.18, 0.475],
  [0, -0.18, 0.475], [0, 0.02624997, -0.425], [-0.165, 0.02624997, -0.425], [-0.165, -0.18, -0.425], [0, -0.18, -0.425],
  [0, 0.02624997, -0.65], [-0.165, 0.02624997, -0.65], [-0.165, -0.12375, -0.775], [0, -0.12375, -0.775], [0, 0.195, -0.575],
  [-0.0625, 0.195, -0.575], [-0.0625, 0.17625, -0.6], [0, 0.17625, -0.6], [0, 0.27, -0.675], [-0.0625, 0.27, -0.675],
  [-0.0625, 0.27, -0.825], [0, 0.27, -0.825], [0, 0.28875, -0.7], [-0.0625, 0.28875, -0.7], [-0.0625, 0.2934375, -0.88125],
  [0, 0.2934375, -0.88125], [0, 0.28875, -0.725], [-0.0375, 0.28875, -0.725], [-0.0375, 0.298125, -0.8625], [0, 0.298125, -0.8625],
  [0, 0.27, -0.7], [-0.0375, 0.27, -0.7], [-0.0375, 0.27, -0.8], [0, 0.27, -0.8], [0, 0.4575, -0], [0, 0.4575, -0.2],
  [-0.1125, 0.4575, -0.2], [-0.2, 0.4575, -0.1125], [-0.2, 0.4575, -0], [0, 0.3825, -0], [0, 0.27, -0.35], [-0.196, 0.27, -0.35],
  [-0.35, 0.27, -0.196], [-0.35, 0.27, -0], [0, 0.3075, -0.1], [-0.056, 0.3075, -0.1], [-0.1, 0.3075, -0.056], [-0.1, 0.3075, -0],
  [0, 0.3075, -0.325], [-0.182, 0.3075, -0.325], [-0.325, 0.3075, -0.182], [-0.325, 0.3075, -0], [0, 0.27, -0.325], [-0.182, 0.27, -0.325],
  [-0.325, 0.27, -0.182], [-0.325, 0.27, -0], [0, -0.33, -0], [-0.1995, -0.33, -0.35625], [0, -0.31125, -0.375], [0, -0.33, -0.35625],
  [-0.35625, -0.33, -0.1995], [-0.375, -0.31125, -0], [-0.35625, -0.33, -0], [-0.21, -0.31125, -0.375], [-0.375, -0.31125, -0.21],
];

/** GeometricPrimitive.Cone：底面在 -height/2，尖在 +height/2；锥面和底面各是一组分段的环加一排端点。 */
function cone(radius: number, height: number, tessellation: number, uScale: number, vScale: number): MeshBuilder {
  const n = Math.max(tessellation, 3);
  const perSection = n + 1;
  const mesh = new MeshBuilder();
  for (let e = 0; e < 2; e++) {
    const topHeight = e === 0 ? height : 0;
    const sign = e === 0 ? 1 : -1;
    const slopeLength = Math.sqrt(radius * radius + topHeight * topHeight);
    const slopeCos = topHeight / slopeLength, slopeSin = radius / slopeLength;
    for (let j = 0; j < n; j++) {
      const ratio = j / n;
      const y = ratio * topHeight - height * 0.5;
      const r = (1 - ratio) * radius;
      for (let i = 0; i <= n; i++) {
        const angle = (i / n) * 2 * Math.PI;
        mesh.vertex([Math.cos(angle) * r, y, Math.sin(angle) * r], [sign * Math.cos(angle) * slopeCos, sign * slopeSin, sign * Math.sin(angle) * slopeCos], (i / n) * uScale, (1 - ratio) * vScale);
      }
    }
    for (let i = 0; i <= n; i++) {
      const angle = ((i + 0.5) / n) * 2 * Math.PI;
      mesh.vertex([0, topHeight - height * 0.5, 0], [sign * Math.cos(angle) * slopeCos, sign * slopeSin, sign * Math.sin(angle) * slopeCos], ((i + 0.5) / n) * uScale, 0);
    }
  }
  for (let e = 0; e < 2; e++) {
    const offset = e === 0 ? 0 : perSection * (n + 1);
    const [v1, v2, v3, v4] = e === 0 ? [1, perSection, 1, perSection + 1] : [perSection, 1, perSection + 1, 1];
    for (let j = 0; j < n - 1; j++) {
      for (let i = 0; i < n; i++) {
        const at = offset + j * perSection + i;
        mesh.indices.push(at, at + v1, at + v2, at + perSection, at + v3, at + v4);
      }
    }
    for (let i = 0; i < n; i++) {
      const at = offset + (n - 1) * perSection + i;
      mesh.indices.push(at, at + v1, at + v2);
    }
  }
  return mesh;
}

function geoSphere(radius: number, tessellation: number, uScale: number, vScale: number): MeshBuilder {
  const points = OCTAHEDRON_VERTICES.map((p) => [...p] as V3);
  let indices = [...OCTAHEDRON_INDICES];
  for (let s = 0; s < tessellation; s++) {
    const midpoints = new Map<string, number>();
    const divide = (a: number, b: number): number => {
      const key = `${Math.max(a, b)},${Math.min(a, b)}`;
      let index = midpoints.get(key);
      if (index === undefined) {
        const pa = points[a]!, pb = points[b]!;
        index = points.push([(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2, (pa[2] + pb[2]) / 2]) - 1;
        midpoints.set(key, index);
      }
      return index;
    };
    const next: number[] = [];
    for (let t = 0; t < indices.length; t += 3) {
      const v0 = indices[t]!, v1 = indices[t + 1]!, v2 = indices[t + 2]!;
      const v01 = divide(v0, v1), v12 = divide(v1, v2), v20 = divide(v0, v2);
      next.push(v0, v01, v20, v20, v12, v2, v20, v01, v12, v01, v1, v12);
    }
    indices = next;
  }

  const mesh = new MeshBuilder();
  for (const point of points) {
    const length = Math.hypot(...point);
    const normal: V3 = [point[0] / length, point[1] / length, point[2] / length];
    const longitude = Math.atan2(normal[0], -normal[2]);
    const latitude = Math.acos(normal[1]);
    // Stride 在 float 里算：u 写回 float32，下面和 0 比较时一致
    const u = Math.fround(longitude / (Math.PI * 2) + 0.5), v = latitude / Math.PI;
    mesh.vertex(scaled(normal, radius), normal, Math.fround(1 - u) * uScale, v * vScale);
  }

  // 本初子午线上的顶点复制一份，u 改成 uScale，跨过接缝的三角形改用新顶点（三角形先转到让这个顶点在第一个）
  const preCount = mesh.vertexCount;
  const uOf = (i: number) => mesh.uvs[i * 2]!;
  for (let i = 0; i < preCount; i++) {
    if (i === 0 || i === 5) continue;
    if (Math.abs(mesh.positions[i * 3]!) > SPLAT_EPSILON || Math.abs(uOf(i)) > SPLAT_EPSILON) continue;
    const copy = mesh.vertex(
      [mesh.positions[i * 3]!, mesh.positions[i * 3 + 1]!, mesh.positions[i * 3 + 2]!],
      [mesh.normals[i * 3]!, mesh.normals[i * 3 + 1]!, mesh.normals[i * 3 + 2]!],
      uScale, mesh.uvs[i * 2 + 1]!,
    );
    for (let t = 0; t < indices.length; t += 3) {
      if (indices[t + 1] === i) [indices[t], indices[t + 1], indices[t + 2]] = [indices[t + 1]!, indices[t + 2]!, indices[t]!];
      else if (indices[t + 2] === i) [indices[t], indices[t + 1], indices[t + 2]] = [indices[t + 2]!, indices[t]!, indices[t + 1]!];
      else if (indices[t] !== i) continue;
      const u0 = uOf(indices[t]!);
      if (Math.abs(u0 - uOf(indices[t + 1]!)) > 0.5 * uScale || Math.abs(u0 - uOf(indices[t + 2]!)) > 0.5 * uScale) indices[t] = copy;
    }
  }
  mesh.indices = indices;
  fixPole(mesh, 0);
  fixPole(mesh, 5);
  return mesh;
}

/** 极点：每个用到它的三角形各一份顶点，u 取另外两个顶点的平均（第一个三角形直接改原顶点）。 */
function fixPole(mesh: MeshBuilder, pole: number): void {
  const { indices } = mesh;
  const position: V3 = [mesh.positions[pole * 3]!, mesh.positions[pole * 3 + 1]!, mesh.positions[pole * 3 + 2]!];
  const normal: V3 = [mesh.normals[pole * 3]!, mesh.normals[pole * 3 + 1]!, mesh.normals[pole * 3 + 2]!];
  const v = mesh.uvs[pole * 2 + 1]!;
  let overwritten = false;
  for (let t = 0; t < indices.length; t += 3) {
    const at = indices[t] === pole ? 0 : indices[t + 1] === pole ? 1 : indices[t + 2] === pole ? 2 : -1;
    if (at < 0) continue;
    const other0 = indices[t + ((at + 1) % 3)]!, other1 = indices[t + ((at + 2) % 3)]!;
    const u = (mesh.uvs[other0 * 2]! + mesh.uvs[other1 * 2]!) * 0.5;
    if (!overwritten) {
      mesh.uvs[pole * 2] = u;
      mesh.uvs[pole * 2 + 1] = v;
      overwritten = true;
    } else {
      indices[t + at] = mesh.vertex(position, normal, u, v);
    }
  }
}

function cross(a: V3, b: V3): V3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function scaled(v: V3, s: number): V3 {
  return [v[0] * s, v[1] * s, v[2] * s];
}
