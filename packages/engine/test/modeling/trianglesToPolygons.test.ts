import { describe, expect, test } from 'vitest';
import { trianglesToPolygons } from '../../src/modeling/trianglesToPolygons';

/** 一个方块的 12 个三角形，每个三角形三个独立的顶点（像布尔运算的输出那样没焊）。 */
function cube(size = 1): { positions: number[]; indices: number[] } {
  const h = size / 2;
  const quads: number[][][] = [
    [[h, -h, -h], [h, h, -h], [h, h, h], [h, -h, h]],
    [[-h, -h, h], [-h, h, h], [-h, h, -h], [-h, -h, -h]],
    [[-h, h, -h], [-h, h, h], [h, h, h], [h, h, -h]],
    [[-h, -h, h], [-h, -h, -h], [h, -h, -h], [h, -h, h]],
    [[-h, -h, h], [h, -h, h], [h, h, h], [-h, h, h]],
    [[h, -h, -h], [-h, -h, -h], [-h, h, -h], [h, h, -h]],
  ];
  const positions: number[] = [], indices: number[] = [];
  for (const [a, b, c, d] of quads) {
    for (const tri of [[a, b, c], [a, c, d]]) for (const p of tri) {
      indices.push(positions.length / 3);
      positions.push(...p!);
    }
  }
  return { positions, indices };
}

describe('三角网格转多边形网格', () => {
  test('方块：12 个三角形合成 6 个四边形、8 个顶点，绕向照旧', () => {
    const { positions, indices } = cube();
    const mesh = trianglesToPolygons(positions, indices, () => 0);
    expect(mesh.vertices).toHaveLength(8);
    expect(mesh.faces).toHaveLength(6);
    for (const face of mesh.faces) expect(face.vertices).toHaveLength(4);
    // +x 的面：顶点的 x 都是 0.5，按从外面看逆时针（法线朝 +x）
    const right = mesh.faces.find((face) => face.vertices.every((v) => mesh.vertices[v]![0] === 0.5))!;
    const [a, b, c] = right.vertices.map((v) => mesh.vertices[v]!) as unknown as [number[], number[], number[]];
    const normalX = (b[1]! - a[1]!) * (c[2]! - a[2]!) - (b[2]! - a[2]!) * (c[1]! - a[1]!);
    expect(normalX).toBeGreaterThan(0);
  });

  test('不同组（材质槽）的共面三角形不合并；边上共线的点去掉', () => {
    const { positions, indices } = cube();
    const mesh = trianglesToPolygons(positions, indices, (t) => (t === 0 ? 1 : 0));
    // 第一个面的两个三角形分在两组：那个面留成两个三角形
    expect(mesh.faces).toHaveLength(7);
    expect(mesh.faces.filter((face) => face.material === 1)).toHaveLength(1);

    // 两个三角形合成一个大三角形：底边中间那个点和前后两点共线，去掉
    const strip = trianglesToPolygons([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 2, 0, 0, 0, 1, 0], [0, 1, 2, 3, 4, 5], () => 0);
    expect(strip.faces).toHaveLength(1);
    expect(strip.faces[0]!.vertices).toHaveLength(3);
  });

  test('有洞的一块平面（多边形的面不能带洞）切成几块不带洞的简单多边形，面积不变、每块一圈边界', () => {
    // 外框 4×4、中间挖 2×2 的洞：8 个三角形围成一圈
    const p = (x: number, y: number) => [x, y, 0];
    const outer = [p(0, 0), p(4, 0), p(4, 4), p(0, 4)], inner = [p(1, 1), p(3, 1), p(3, 3), p(1, 3)];
    const positions: number[] = [], indices: number[] = [];
    for (let k = 0; k < 4; k++) {
      const o0 = outer[k]!, o1 = outer[(k + 1) % 4]!, i0 = inner[k]!, i1 = inner[(k + 1) % 4]!;
      for (const tri of [[o0, o1, i1], [o0, i1, i0]]) for (const v of tri) {
        indices.push(positions.length / 3);
        positions.push(...v);
      }
    }
    const mesh = trianglesToPolygons(positions, indices, () => 0);
    expect(mesh.vertices).toHaveLength(8);
    // 一个洞多切出一块：比 8 个三角形少得多，每块都比三角形大
    expect(mesh.faces.length).toBeGreaterThanOrEqual(2);
    expect(mesh.faces.length).toBeLessThanOrEqual(3);
    expect(mesh.faces.every((face) => face.vertices.length >= 4)).toBe(true);
    // 面积加起来是 16 - 4，每块的顶点不重复（简单多边形，没有在一个点上掐住）
    const area = (face: { vertices: readonly number[] }) => {
      let sum = 0;
      face.vertices.forEach((v, i) => {
        const a = mesh.vertices[v]!, b = mesh.vertices[face.vertices[(i + 1) % face.vertices.length]!]!;
        sum += a[0]! * b[1]! - b[0]! * a[1]!;
      });
      return sum / 2;
    };
    expect(mesh.faces.reduce((total, face) => total + area(face), 0)).toBeCloseTo(12);
    for (const face of mesh.faces) {
      expect(new Set(face.vertices).size).toBe(face.vertices.length);
      expect(area(face)).toBeGreaterThan(0);
    }
  });

  test('一块平面上两个洞（地板上立着两根柱子）：切开以后没有留下零碎的三角形', () => {
    // 6×2 的地板，(1,0.5)-(2,1.5) 和 (4,0.5)-(5,1.5) 两个洞，按网格三角化后去掉洞里的格子
    const positions: number[] = [], indices: number[] = [];
    const holes = new Set(['2,1', '3,1', '2,2', '3,2', '8,1', '9,1', '8,2', '9,2']);
    const at = (x: number, y: number) => [x / 2, y / 2, 0];
    for (let x = 0; x < 12; x++) for (let y = 0; y < 4; y++) {
      if (holes.has(`${x},${y}`)) continue;
      const a = at(x, y), b = at(x + 1, y), c = at(x + 1, y + 1), d = at(x, y + 1);
      for (const tri of [[a, b, c], [a, c, d]]) for (const v of tri) {
        indices.push(positions.length / 3);
        positions.push(...v);
      }
    }
    const mesh = trianglesToPolygons(positions, indices, () => 0);
    expect(mesh.faces.length).toBeLessThanOrEqual(5);
    expect(mesh.faces.filter((face) => face.vertices.length === 3)).toHaveLength(0);
    for (const face of mesh.faces) expect(new Set(face.vertices).size).toBe(face.vertices.length);
  });
});
