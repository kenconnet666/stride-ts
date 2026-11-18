/**
 * Stride 的程序模型（.sdpromodel，ProceduralModelAsset）：照 Stride 4.4.2 的 GeometricPrimitive 生成网格，再按
 * PrimitiveProceduralModelBase 先加 LocalOffset、再乘 Scale（法线乘缩放的逆再归一化）。
 * Stride 的三角形顺时针是正面，我们的渲染器逆时针是正面：生成后每个三角形的后两个顶点对调。
 * 现在有 Cube、Plane、Sphere、GeoSphere、Capsule、Cylinder、Cone；Disc、Torus、Teapot 用到时再加。
 */
import { asNumber, asObject, type StrideObject, type StrideValue } from './yaml.ts';

/** 生成的网格：位置、法线、UV 按顶点交错前的各自数组。 */
export interface ProceduralMesh {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly uvs: Float32Array;
  readonly indices: Uint32Array;
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

/** .sdpromodel 的 Type 生成网格；不认识的类型返回 undefined。 */
export function proceduralMesh(type: StrideObject): ProceduralMesh | undefined {
  const [uScale, vScale] = vec2(type['UvScale'], 1);
  let mesh: MeshBuilder;
  switch (type.$type) {
    case 'CubeProceduralModel':
      mesh = cube(vec3(type['Size'], 1), uScale, vScale);
      break;
    case 'PlaneProceduralModel': {
      const [sizeX, sizeY] = vec2(type['Size'], 1);
      const tessellation = asObject(type['Tessellation']);
      mesh = plane(sizeX, sizeY, asNumber(tessellation?.['X'], 1), asNumber(tessellation?.['Y'], 1), uScale, vScale, type['GenerateBackFace'] === true, String(type['Normal'] ?? 'UpY'));
      break;
    }
    case 'SphereProceduralModel':
      mesh = sphere(asNumber(type['Radius'], 0.5), asNumber(type['Tessellation'], 16), uScale, vScale);
      break;
    case 'GeoSphereProceduralModel':
      mesh = geoSphere(asNumber(type['Radius'], 0.5), asNumber(type['Tessellation'], 3), uScale, vScale);
      break;
    case 'CapsuleProceduralModel':
      mesh = capsule(asNumber(type['Length'], 0.5), asNumber(type['Radius'], 0.35), asNumber(type['Tessellation'], 8), uScale, vScale);
      break;
    case 'CylinderProceduralModel':
      mesh = cylinder(asNumber(type['Height'], 1), asNumber(type['Radius'], 0.5), asNumber(type['Tessellation'], 32), uScale, vScale);
      break;
    case 'ConeProceduralModel':
      mesh = cone(asNumber(type['Radius'], 0.5), asNumber(type['Height'], 1), asNumber(type['Tessellation'], 16), uScale, vScale);
      break;
    default:
      return undefined;
  }
  applyOffsetAndScale(mesh, vec3(type['LocalOffset'], 0), vec3(type['Scale'], 1));
  // 顺时针（Stride）换成逆时针（我们）
  const indices = Uint32Array.from(mesh.indices);
  for (let i = 0; i < indices.length; i += 3) [indices[i + 1], indices[i + 2]] = [indices[i + 2]!, indices[i + 1]!];
  return { positions: Float32Array.from(mesh.positions), normals: Float32Array.from(mesh.normals), uvs: Float32Array.from(mesh.uvs), indices };
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

function vec3(value: StrideValue | undefined, fallback: number): V3 {
  const o = asObject(value) ?? {};
  return [asNumber(o['X'], fallback), asNumber(o['Y'], fallback), asNumber(o['Z'], fallback)];
}

function vec2(value: StrideValue | undefined, fallback: number): [number, number] {
  const o = asObject(value) ?? {};
  return [asNumber(o['X'], fallback), asNumber(o['Y'], fallback)];
}
