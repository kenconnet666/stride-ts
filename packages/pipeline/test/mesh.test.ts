import { createStrideNative, type StrideNative } from '@stride-ts/native';
import { createStrideTools, type StrideTools } from '@stride-ts/native/tools';
import { vertexLayoutOffsets, VERTEX_FLOATS, type ModelMeshData } from '@stride-ts/engine/content-format';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { addTangents, compressMeshes, MAX_QUANTIZED_EXTENT, octEncode, type SourceMesh } from '../src/index';

// 管线压缩的网格交给运行时模块解码，再按顶点着色器的做法还原，和源数据比较。

/** 同引擎顶点着色器里的 octDecode。 */
function octDecode(x: number, y: number): [number, number, number] {
  let nx = x, ny = y;
  const nz = 1 - Math.abs(x) - Math.abs(y);
  const t = Math.max(-nz, 0);
  nx += nx >= 0 ? -t : t;
  ny += ny >= 0 ? -t : t;
  const length = Math.hypot(nx, ny, nz);
  return [nx / length, ny / length, nz / length];
}

/** 一个随机的"网格"：count 个顶点的随机位置（在 size 的立方体里）、单位法线、UV，加一些三角形。 */
function randomMesh(name: string, count: number, size: number, uvRange: number, seed: number): SourceMesh {
  let state = seed;
  const random = () => ((state = (state * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const vertices = new Float32Array(count * VERTEX_FLOATS);
  for (let v = 0; v < count; v++) {
    const n = [random() - 0.5, random() - 0.5, random() - 0.5];
    const length = Math.hypot(...n);
    vertices.set([random() * size, random() * size, random() * size, ...n.map((c) => c / length), random() * uvRange, random() * uvRange], v * VERTEX_FLOATS);
  }
  const indices = new Uint32Array(count * 3).map(() => Math.floor(random() * count));
  return { name, material: null, vertices, indices };
}

/** 解码一个压缩网格，按顶点还原成 FLOAT_LAYOUT 的 [位置, 法线, UV]。 */
async function restore(native: StrideNative, mesh: ModelMeshData): Promise<{ vertices: number[][]; indices: number[] }> {
  const { stride, normal: normalOffset, uv: uvOffset } = vertexLayoutOffsets(mesh.layout);
  const [vertexBytes, indexBytes] = await native.decodeMeshoptBatch([
    { source: mesh.vertices, count: mesh.vertexCount, stride, mode: 'attributes' },
    { source: mesh.indices, count: mesh.indexCount, stride: mesh.indexFormat === 'uint16' ? 2 : 4, mode: 'triangles' },
  ]);
  const view = new DataView(vertexBytes!.buffer, vertexBytes!.byteOffset, vertexBytes!.byteLength);
  const { positionOffset: po, positionScale: ps, uvOffset: uo, uvScale: us } = mesh.dequantize;
  const vertices = Array.from({ length: mesh.vertexCount }, (_, v) => {
    const at = v * stride;
    const position = [0, 1, 2].map((k) => (mesh.layout.position === 'unorm16x4' ? po[k]! + (view.getUint16(at + k * 2, true) / 65535) * ps[k]! : view.getFloat32(at + k * 4, true)));
    const normal = octDecode(Math.max(view.getInt16(at + normalOffset, true) / 32767, -1), Math.max(view.getInt16(at + normalOffset + 2, true) / 32767, -1));
    const uv = [0, 1].map((k) => (mesh.layout.uv === 'unorm16x2' ? uo[k]! + (view.getUint16(at + uvOffset + k * 2, true) / 65535) * us[k]! : view.getFloat32(at + uvOffset + k * 4, true)));
    return [...position, ...normal, ...uv];
  });
  const indices = mesh.indexFormat === 'uint16' ? new Uint16Array(indexBytes!.buffer, indexBytes!.byteOffset, mesh.indexCount) : new Uint32Array(indexBytes!.buffer, indexBytes!.byteOffset, mesh.indexCount);
  return { vertices, indices: [...indices] };
}

/**
 * 比较还原的网格和源网格：重排改了顶点和三角形的顺序，meshopt 的索引编码还可能转动三角形的顶点。先把每个还原的顶点
 * 对到位置最近的源顶点，属性误差各自不超过 tolerance；再把三角形换成源顶点的下标、转成字典序最小的那种转法、排序后比较。
 */
function expectSameMesh(restored: { vertices: number[][]; indices: number[] }, source: SourceMesh, tolerance: { position: number; normal: number; uv: number }): void {
  const sourceVertices = Array.from({ length: source.vertices.length / VERTEX_FLOATS }, (_, v) => [...source.vertices.subarray(v * VERTEX_FLOATS, (v + 1) * VERTEX_FLOATS)]);
  const distance = (a: number[], b: number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
  const toSource = restored.vertices.map((vertex) => {
    let best = 0;
    sourceVertices.forEach((candidate, i) => {
      if (distance(vertex, candidate) < distance(vertex, sourceVertices[best]!)) best = i;
    });
    const original = sourceVertices[best]!;
    for (let k = 0; k < 3; k++) expect(Math.abs(vertex[k]! - original[k]!)).toBeLessThanOrEqual(tolerance.position);
    for (let k = 3; k < 6; k++) expect(Math.abs(vertex[k]! - original[k]!)).toBeLessThanOrEqual(tolerance.normal);
    for (let k = 6; k < 8; k++) expect(Math.abs(vertex[k]! - original[k]!)).toBeLessThanOrEqual(tolerance.uv);
    return best;
  });
  const canonical = (indices: ArrayLike<number>, map: (i: number) => number) => {
    const out: string[] = [];
    for (let i = 0; i < indices.length; i += 3) {
      const [a, b, c] = [map(indices[i]!), map(indices[i + 1]!), map(indices[i + 2]!)];
      // 三种转法里取字典序最小的（随机数据里有重复下标的退化三角形）
      out.push([[a, b, c], [b, c, a], [c, a, b]].map((r) => r.map((n) => String(n).padStart(6, '0')).join()).sort()[0]!);
    }
    return out.sort();
  };
  expect(canonical(restored.indices, (i) => toSource[i]!)).toEqual(canonical(source.indices, (i) => i));
}

describe('网格压缩', () => {
  let native: StrideNative;
  let tools: StrideTools;
  beforeAll(async () => {
    [native, tools] = await Promise.all([createStrideNative({ workerThreads: 1 }), createStrideTools({ workerThreads: 1 })]);
  });
  afterAll(() => {
    native?.shutdown();
    tools?.shutdown();
  });

  test('八面体编码：各个方向往返误差很小，下半球翻折正确', () => {
    for (const [x, y, z] of [[0, 0, 1], [0, 0, -1], [1, 0, 0], [0.3, -0.5, -0.81], [-0.7, 0.1, 0.7]] as const) {
      const length = Math.hypot(x, y, z);
      const [u, v] = octEncode(x / length, y / length, z / length);
      const quantized = (c: number) => Math.round(c * 32767) / 32767;
      const decoded = octDecode(quantized(u), quantized(v));
      [x / length, y / length, z / length].forEach((c, k) => expect(decoded[k]).toBeCloseTo(c, 4));
    }
  });

  test('小模型：位置和 UV 量化成 16 位、法线八面体，16 字节；解码后在精度内还原，三角形不变', async () => {
    const source = [randomMesh('a', 300, 2, 4, 1), randomMesh('b', 200, 1, 1, 2)];
    const meshes = compressMeshes(source, tools);
    expect(meshes.map((m) => [m.layout, vertexLayoutOffsets(m.layout).stride, m.compression, m.indexFormat])).toEqual([
      [{ position: 'unorm16x4', normal: 'snorm16x2', uv: 'unorm16x2' }, 16, 'meshopt', 'uint16'],
      [{ position: 'unorm16x4', normal: 'snorm16x2', uv: 'unorm16x2' }, 16, 'meshopt', 'uint16'],
    ]);
    // 一个模型的网格共用位置包围盒：b 在 a 的包围盒里量化，相接处不会裂开
    expect(meshes[1]!.dequantize.positionOffset).toEqual(meshes[0]!.dequantize.positionOffset);
    // 误差不超过半个量化步长：位置 2 m / 65535 / 2（取 a 的包围盒），法线约 1e-4，UV 4 / 65535 / 2
    for (const [i, mesh] of meshes.entries()) {
      expectSameMesh(await restore(native, mesh), source[i]!, { position: 1 / 65535 + 1e-6, normal: 2e-4, uv: 2 / 65535 + 1e-6 });
    }
    // 压缩后明显比 32 字节的 float 顶点小
    const raw = source.reduce((sum, m) => sum + m.vertices.byteLength + m.indices.length * 2, 0);
    expect(meshes.reduce((sum, m) => sum + m.vertices.byteLength + m.indices.byteLength, 0)).toBeLessThan(raw * 0.6);
  });

  test('切线：MikkTSpace，切线朝 U 增大的方向，w · cross(N, T) 朝 V 增大的方向；UV 镜像的接缝处拆开顶点；压缩成 snorm8x4', async () => {
    // 两个相接的四边形，在 z = 0 上，法线 +Z；右边那个的 U 反过来（镜像），共用的那条边两边的切线相反
    const vertices = new Float32Array([
      [0, 0, 0, 0, 0, 1, 0, 1], [1, 0, 0, 0, 0, 1, 1, 1], [1, 1, 0, 0, 0, 1, 1, 0], [0, 1, 0, 0, 0, 1, 0, 0],
      [2, 0, 0, 0, 0, 1, 0, 1], [2, 1, 0, 0, 0, 1, 0, 0],
    ].flat());
    const source: SourceMesh = { name: 'strip', material: 0, vertices, indices: new Uint32Array([0, 1, 2, 0, 2, 3, 1, 4, 5, 1, 5, 2]) };
    const withTangents = addTangents(source, tools);
    // 共用的顶点 1、2 各拆成两个
    expect(withTangents.vertices.length / VERTEX_FLOATS).toBe(8);
    const tangents = withTangents.tangents!;
    for (let v = 0; v < 8; v++) {
      const [tx, ty, tz, w] = tangents.subarray(v * 4, v * 4 + 4);
      const x = withTangents.vertices[v * VERTEX_FLOATS]!;
      // 左边的四边形 U 沿 +X 增大，右边的沿 -X；V 都沿 -Y 增大
      const left = withTangents.indices.slice(0, 6).includes(v);
      expect([tx, ty, tz].map((c) => Math.round(c! * 1000) / 1000 + 0)).toEqual([left ? 1 : -1, 0, 0]);
      // B = w · cross((0, 0, 1), T) = w · (-ty, tx, 0)：要朝 -Y
      expect(w! * tx!).toBeCloseTo(-1, 3);
      expect(x).toBeGreaterThanOrEqual(0);
    }

    const [mesh] = compressMeshes([withTangents], tools);
    expect(mesh!.layout.tangent).toBe('snorm8x4');
    const { stride, tangent } = vertexLayoutOffsets(mesh!.layout);
    expect(stride).toBe(20);
    const [bytes] = await native.decodeMeshoptBatch([{ source: mesh!.vertices, count: mesh!.vertexCount, stride, mode: 'attributes' }]);
    const view = new DataView(bytes!.buffer, bytes!.byteOffset, bytes!.byteLength);
    const decoded = Array.from({ length: mesh!.vertexCount }, (_, v) => [0, 1, 2, 3].map((k) => view.getInt8(v * stride + tangent! + k) / 127));
    // 重排过的顶点：拿解码后的切线集合和源切线集合比（精度 1/127）
    const sort = (list: number[][]) => list.map((t) => t.map((c) => Math.round(c))).map(String).sort();
    expect(sort(decoded)).toEqual(sort(Array.from({ length: 8 }, (_, v) => [...tangents.subarray(v * 4, v * 4 + 4)])));
  });

  test('大模型的位置和平铺很多次的 UV 保留 float32，原样还原', async () => {
    const big = randomMesh('ground', 100, MAX_QUANTIZED_EXTENT * 2, 40, 3);
    const [mesh] = compressMeshes([big], tools);
    expect([mesh!.layout, vertexLayoutOffsets(mesh!.layout).stride]).toEqual([{ position: 'float32x3', normal: 'snorm16x2', uv: 'float32x2' }, 24]);
    expectSameMesh(await restore(native, mesh!), big, { position: 0, normal: 2e-4, uv: 0 });
  });
});
