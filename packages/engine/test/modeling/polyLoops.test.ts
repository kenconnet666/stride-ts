import { describe, expect, test } from 'vitest';
import type { PolyMeshFile, Vec3Tuple } from '../../src/content/formats/assetFormat';
import { loopCut, polyCube } from '../../src/modeling/polyEdit';
import { edgeLoop, faceLoop, softWeights } from '../../src/modeling/polyLoops';

/** n × n 个四边形的平面网格：顶点 (x, 0, z) 的下标是 z * (n + 1) + x，面 (x, z) 的下标是 z * n + x。 */
function grid(n: number): PolyMeshFile {
  const vertices: Vec3Tuple[] = [];
  for (let z = 0; z <= n; z++) for (let x = 0; x <= n; x++) vertices.push([x, 0, z]);
  const at = (x: number, z: number) => z * (n + 1) + x;
  const faces = [];
  for (let z = 0; z < n; z++) for (let x = 0; x < n; x++) faces.push({ vertices: [at(x, z), at(x, z + 1), at(x + 1, z + 1), at(x + 1, z)] });
  return { name: 'Grid', materials: [null], vertices, faces };
}

const sorted = (edges: readonly (readonly [number, number])[]) => edges.map(([a, b]) => (a < b ? `${a}-${b}` : `${b}-${a}`)).sort();

describe('多边形的环选和软选择', () => {
  test('边环：沿着一行走到网格边上（边上的顶点只连三条边，停下）', () => {
    const mesh = grid(4);
    // 第 2 行（z = 2）中间的一条横边：整行 4 条
    const loop = edgeLoop(mesh, [11, 12]);
    expect(sorted(loop)).toEqual(sorted([[10, 11], [11, 12], [12, 13], [13, 14]]));
    // 竖边：整列
    expect(edgeLoop(mesh, [7, 12])).toHaveLength(4);
  });

  test('立方体的顶点只连三条边：边环只有它自己；网格里没有的边是空的', () => {
    const cube = polyCube('Cube');
    const [a, b] = cube.faces[0]!.vertices;
    expect(edgeLoop(cube, [a!, b!])).toHaveLength(1);
    expect(edgeLoop(cube, [0, 999])).toEqual([]);
  });

  test('面环：穿过对边一格格走，到网格边上停；绕一圈回到起点也停', () => {
    const mesh = grid(4);
    // 面 (1, 2)，穿过它的竖边：整行 4 个面
    const face = 2 * 4 + 1;
    const [v0, v1] = mesh.faces[face]!.vertices;
    expect(faceLoop(mesh, face, [v0!, v1!]).sort((a, b) => a - b)).toEqual([8, 9, 10, 11]);
    // 立方体：从一个侧面穿过竖边，绕四个侧面一圈
    const cube = polyCube('Cube');
    const side = cube.faces.findIndex((f) => {
      const ys = f.vertices.map((v) => cube.vertices[v]![1]);
      return Math.min(...ys) !== Math.max(...ys);
    });
    const ring = cube.faces[side]!.vertices;
    const vertical = ring.map((a, i) => [a, ring[(i + 1) % 4]!] as const).find(([a, b]) => cube.vertices[a]![1] !== cube.vertices[b]![1])!;
    expect(faceLoop(cube, side, vertical)).toHaveLength(4);
  });

  test('软选择：选中的是 1，半径内按平滑曲线衰减，半径外没有', () => {
    const positions: Vec3Tuple[] = [[0, 0, 0], [0.25, 0, 0], [0.5, 0, 0], [1, 0, 0]];
    const weights = softWeights(positions, [0], 1);
    expect(weights.get(0)).toBe(1);
    expect(weights.get(1)).toBeCloseTo(0.84375);
    expect(weights.get(2)).toBeCloseTo(0.5);
    expect(weights.has(3)).toBe(false);
    expect(softWeights(positions, [0], 0).size).toBe(1);
  });

  test('环切：沿穿过边的那一圈四边形切一刀，每条横档加一个点（隔壁的面也插上），每个面多出一个', () => {
    const mesh = grid(4);
    // 横边 11-12 两边的面是第 1 列：竖着一整列 4 个面，横档是这一列的 5 条横边
    const cut = loopCut(mesh, [11, 12], 0.25);
    expect(cut.mesh.vertices).toHaveLength(25 + 5);
    expect(cut.mesh.faces).toHaveLength(16 + 4);
    expect(cut.edges).toHaveLength(4);
    // 新点都在 x = 1.25（从横档的同一头量 t）
    expect(cut.mesh.vertices.slice(25).map((v) => v[0])).toEqual([1.25, 1.25, 1.25, 1.25, 1.25]);
    // 立方体：从一条竖边切，绕四个侧面切一圈
    const cube = polyCube('Cube');
    const side = cube.faces.find((f) => f.vertices.some((v, i) => cube.vertices[v]![1] !== cube.vertices[f.vertices[(i + 1) % 4]!]![1]))!;
    const vertical = side.vertices.map((a, i) => [a, side.vertices[(i + 1) % 4]!] as const).find(([a, b]) => cube.vertices[a]![1] !== cube.vertices[b]![1])!;
    const ring = loopCut(cube, vertical);
    expect(ring.mesh.vertices).toHaveLength(8 + 4);
    expect(ring.mesh.faces).toHaveLength(6 + 4);
    expect(new Set(ring.mesh.vertices.slice(8).map((v) => v[1]))).toEqual(new Set([0]));
    expect(() => loopCut(cube, [0, 999])).toThrow(/loopCut/);
  });
});
