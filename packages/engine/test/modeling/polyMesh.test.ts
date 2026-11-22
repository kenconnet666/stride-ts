import { describe, expect, test } from 'vitest';
import type { PolyMeshFile } from '../../src/content/formats/assetFormat';
import { mirrored, polyMeshSlots, triangulateFace } from '../../src/modeling/polyMesh';
import { bevelEdges, connectVertices, deleteFaces, extrudeFaces, flipFaces, insetFaces, mergeVertices, moveVertices, polyCube, splitEdge } from '../../src/modeling/polyEdit';

/** 封闭、朝向一致：每条有向边正好出现一次，反方向的也正好出现一次。 */
function expectClosed(mesh: PolyMeshFile): void {
  const directed = new Map<string, number>();
  for (const face of mesh.faces) face.vertices.forEach((a, k) => {
    const key = `${a}>${face.vertices[(k + 1) % face.vertices.length]}`;
    directed.set(key, (directed.get(key) ?? 0) + 1);
  });
  for (const [key, count] of directed) {
    expect(count, key).toBe(1);
    const [a, b] = key.split('>');
    expect(directed.get(`${b}>${a}`), `${key} has no twin`).toBe(1);
  }
}

/** 体积（三角化以后，三角形和原点的四面体加起来）。 */
function volume(mesh: PolyMeshFile): number {
  let sum = 0;
  for (const face of mesh.faces) {
    const t = triangulateFace(mesh.vertices, face.vertices);
    for (let i = 0; i < t.length; i += 3) {
      const [a, b, c] = [t[i]!, t[i + 1]!, t[i + 2]!].map((k) => mesh.vertices[face.vertices[k]!]!) as unknown as [readonly number[], readonly number[], readonly number[]];
      sum += (a[0]! * (b[1]! * c[2]! - b[2]! * c[1]!) - a[1]! * (b[0]! * c[2]! - b[2]! * c[0]!) + a[2]! * (b[0]! * c[1]! - b[1]! * c[0]!)) / 6;
    }
  }
  return sum;
}

describe('多边形网格的几何', () => {
  test('立方体：封闭、体积 1；平直的面 24 个顶点、12 个三角形', () => {
    const cube = polyCube('Cube');
    expectClosed(cube);
    expect(volume(cube)).toBeCloseTo(1);
    const [slot] = polyMeshSlots(cube);
    expect(slot!.vertices.length / 8).toBe(24);
    expect(slot!.indices.length / 3).toBe(12);
  });

  test('凹的 L 形面耳切成 4 个三角形，面积对', () => {
    const vertices = [[0, 0, 0], [2, 0, 0], [2, 0, -1], [1, 0, -1], [1, 0, -2], [0, 0, -2]] as const;
    const face = [0, 1, 2, 3, 4, 5];
    const t = triangulateFace(vertices, face);
    expect(t.length).toBe(12);
    let area = 0;
    for (let i = 0; i < t.length; i += 3) {
      const [a, b, c] = [t[i]!, t[i + 1]!, t[i + 2]!].map((k) => vertices[k]!);
      area += Math.abs((b![0] - a![0]) * (c![2] - a![2]) - (b![2] - a![2]) * (c![0] - a![0])) / 2;
    }
    expect(area).toBeCloseTo(3);
  });

  test('光滑角：大于 0 时圆柱般的相邻面共用法线，0 时全是硬边', () => {
    // 正八棱柱的侧面：相邻面夹 45°
    const n = 8;
    const vertices = Array.from({ length: n * 2 }, (_, i) => {
      const a = ((i % n) / n) * Math.PI * 2;
      return [Math.cos(a), i < n ? 0 : 1, -Math.sin(a)] as const;
    });
    const faces = Array.from({ length: n }, (_, i) => ({ vertices: [i, (i + 1) % n, ((i + 1) % n) + n, i + n] }));
    const prism: PolyMeshFile = { name: 'Prism', materials: [null], vertices, faces };
    // 位置加法线不同的组合：光滑时每个顶点一个法线（16），硬边时每个角点一个（32）；UV 按面投影，顶点数另算
    const corners = (smoothAngle: number) => {
      const v = polyMeshSlots({ ...prism, smoothAngle })[0]!.vertices;
      const set = new Set<string>();
      for (let i = 0; i < v.length; i += 8) set.add([...v.subarray(i, i + 6)].map((c) => c.toFixed(3)).join());
      return set.size;
    };
    expect(corners(50)).toBe(16);
    expect(corners(0)).toBe(32);
  });

  test('镜像：一半的立方体按 x 镜像出整个，平面上的顶点共用', () => {
    // x 从 0 到 1 的半边（开口朝 -x）
    const half: PolyMeshFile = {
      name: 'Half', materials: [null], mirror: 'x',
      vertices: [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]],
      faces: [[4, 5, 6, 7], [1, 0, 3, 2], [3, 7, 6, 2], [0, 1, 5, 4], [1, 2, 6, 5]].map((v) => ({ vertices: v })),
    };
    const whole = mirrored(half);
    expect(whole.vertices.length).toBe(12);
    expectClosed({ name: 'Whole', materials: [null], ...whole });
    expect(volume({ name: 'Whole', materials: [null], ...whole })).toBeCloseTo(2);
  });

  test('面的材质槽越界、顶点越界时报错，说是第几个面', () => {
    const cube = polyCube('Cube');
    expect(() => polyMeshSlots({ ...cube, faces: [...cube.faces.slice(0, 5), { vertices: [0, 4, 7, 3], material: 1 }] })).toThrow(/face 5 uses material slot 1/);
    expect(() => polyMeshSlots({ ...cube, faces: [{ vertices: [0, 1, 99] }] })).toThrow(/face 0 refers to vertex 99/);
  });
});

describe('多边形网格的编辑', () => {
  const cube = polyCube('Cube');
  const top = cube.faces.findIndex((face) => face.vertices.join() === '3,7,6,2');

  test('挤出顶面 0.5：多 4 个侧面，体积加 0.5，还是封闭的；选中挤出去的面', () => {
    const { mesh, faces } = extrudeFaces(cube, [top], 0.5);
    expectClosed(mesh);
    expect(mesh.faces.length).toBe(10);
    expect(volume(mesh)).toBeCloseTo(1.5);
    expect(mesh.faces[faces[0]!]!.vertices.every((v) => Math.abs(mesh.vertices[v]![1] - 1) < 1e-9)).toBe(true);
  });

  test('相邻的两个面一起挤出：中间不长侧面', () => {
    const front = cube.faces.findIndex((face) => face.vertices.join() === '4,5,6,7');
    const { mesh } = extrudeFaces(cube, [top, front], 0.25);
    expectClosed(mesh);
    // 两个面的区域边界是 6 条边
    expect(mesh.faces.length).toBe(6 + 6);
  });

  test('内插再挤出：顶面中间长出一个小方块', () => {
    const inset = insetFaces(cube, [top], 0.5);
    expectClosed(inset.mesh);
    expect(inset.mesh.faces.length).toBe(10);
    const raised = extrudeFaces(inset.mesh, inset.faces, 0.5);
    expectClosed(raised.mesh);
    // 内插的小面边长 0.5，挤出 0.5：多 0.125
    expect(volume(raised.mesh)).toBeCloseTo(1.125);
  });

  test('倒角一条棱：多一个斜面，体积少一个三棱柱，还是封闭的', () => {
    const { mesh, faces } = bevelEdges(cube, [[6, 2]], 0.2);
    expectClosed(mesh);
    expect(mesh.faces.length).toBe(7);
    expect(faces.length).toBe(1);
    expect(volume(mesh)).toBeCloseTo(1 - 0.2 * 0.2 / 2);
    // 共用一个角的两条边不能一起倒
    expect(() => bevelEdges(cube, [[6, 2], [2, 3]], 0.2)).toThrow(/share a corner/);
    expect(() => bevelEdges(cube, [[6, 2]], 2)).toThrow(/longer than the edge/);
  });

  test('合并顶面一条边的两头：那条边两边的面变成三角形，还是封闭的', () => {
    const { mesh, vertices } = mergeVertices(cube, [6, 2]);
    expectClosed(mesh);
    expect(mesh.vertices.length).toBe(7);
    expect(vertices.length).toBe(1);
    expect(mesh.faces.length).toBe(6);
    expect(mesh.faces.filter((face) => face.vertices.length === 3).length).toBe(2);
  });

  test('切割：边上加点，再在顶面里连到对角，面一分为二，还是封闭的', () => {
    const split = splitEdge(cube, [3, 2]);
    expectClosed(split.mesh);
    const m = split.vertices[0]!;
    expect(split.mesh.vertices[m]).toEqual([0, 0.5, -0.5]);
    const face = split.mesh.faces.findIndex((f) => f.vertices.includes(m) && f.vertices.includes(7));
    const cut = connectVertices(split.mesh, face, m, 7);
    expectClosed(cut.mesh);
    expect(cut.mesh.faces.length).toBe(7);
    expect(() => connectVertices(split.mesh, face, m, 3)).toThrow(/already joined/);
  });

  test('挪顶点、翻面、删面', () => {
    const moved = moveVertices(cube, [2, 3, 6, 7], [0, 1, 0]).mesh;
    expect(volume(moved)).toBeCloseTo(2);
    expect(volume(flipFaces(cube, cube.faces.map((_, f) => f)).mesh)).toBeCloseTo(-1);
    const open = deleteFaces(cube, [top]).mesh;
    expect(open.faces.length).toBe(5);
    expect(open.vertices.length).toBe(8);
  });
});
