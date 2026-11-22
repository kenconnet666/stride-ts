import { describe, expect, test } from 'vitest';
import type { PolyMeshFile } from '../../src/content/formats/assetFormat';
import { applyPolyOperation, polyCube } from '../../src/modeling/polyEdit';
import { polyMeshSlots, projectUv, faceNormal } from '../../src/modeling/polyMesh';
import { faceUvs, projectFacesUv, resetFacesUv, transformFacesUv } from '../../src/modeling/polyUv';

/** 一个斜着的屋顶：两个面在屋脊处接着。 */
const roof: PolyMeshFile = {
  name: 'Roof', materials: [null],
  vertices: [[0, 0, 0], [2, 0, 0], [2, 1, 1], [0, 1, 1], [2, 0, 2], [0, 0, 2]],
  faces: [{ vertices: [0, 3, 2, 1] }, { vertices: [3, 5, 4, 2] }],
};

describe('多边形的 UV 编辑', () => {
  test('平面投影：正对轴的面和自动投影一样；斜面整块展平、不变形', () => {
    const cube = polyCube('Cube', 2);
    const f = cube.faces.findIndex((face) => faceNormal(cube.vertices, face.vertices)[2] > 0.9);
    const projected = projectFacesUv(cube, [f]);
    const auto = cube.faces[f]!.vertices.map((i) => projectUv(cube.vertices[i]!, [0, 0, 1], 1));
    projected.faces[f]!.uvs!.forEach((uv, k) => {
      expect(uv[0]).toBeCloseTo(auto[k]![0]);
      expect(uv[1]).toBeCloseTo(auto[k]![1]);
    });
    // 斜面：UV 里的边长等于实际的边长（√2 米的斜边在 UV 里也是 √2）
    const flat = projectFacesUv(roof, [0]).faces[0]!.uvs!;
    const length = Math.hypot(flat[1]![0] - flat[0]![0], flat[1]![1] - flat[0]![1]);
    expect(length).toBeCloseTo(Math.SQRT2, 4);
  });

  test('变换：绕选中的 UV 的中心转 90°、放大，再平移；没存 UV 的先存下自动投影的', () => {
    const square: PolyMeshFile = { name: 'Square', materials: [null], vertices: [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]], faces: [{ vertices: [0, 1, 2, 3] }] };
    const before = faceUvs(square, 0);
    const moved = transformFacesUv(square, [0], { rotation: 90, scale: 2, offset: [1, 0] });
    const after = moved.faces[0]!.uvs!;
    const center = [before.reduce((s, p) => s + p[0], 0) / 4, before.reduce((s, p) => s + p[1], 0) / 4];
    // 第一个角：(u − c) 转 90° 再乘 2
    const [du, dv] = [before[0]![0] - center[0]!, before[0]![1] - center[1]!];
    expect(after[0]![0]).toBeCloseTo(center[0]! - 2 * dv + 1);
    expect(after[0]![1]).toBeCloseTo(center[1]! + 2 * du);
    expect(resetFacesUv(moved, [0]).faces[0]!.uvs).toBeUndefined();
  });

  test('烘焙用面存的 UV；改了面的顶点（个数对不上）回到自动投影；翻面时 UV 跟着倒', () => {
    const moved = transformFacesUv(roof, [0], { offset: [5, 0] });
    const slot = polyMeshSlots(moved)[0]!;
    const us = Array.from({ length: slot.vertices.length / 8 }, (_, v) => slot.vertices[v * 8 + 6]!);
    expect(Math.max(...us)).toBeGreaterThan(4);
    const broken: PolyMeshFile = { ...moved, faces: [{ ...moved.faces[0]!, uvs: moved.faces[0]!.uvs!.slice(0, 3) }, moved.faces[1]!] };
    const autoSlot = polyMeshSlots(broken)[0]!;
    expect(Math.max(...Array.from({ length: autoSlot.vertices.length / 8 }, (_, v) => autoSlot.vertices[v * 8 + 6]!))).toBeLessThan(4);
    const flipped = applyPolyOperation(moved, { op: 'flip', faces: [0] }).mesh.faces[0]!;
    expect(flipped.uvs).toEqual([...moved.faces[0]!.uvs!].reverse());
    // 按名字调：edit_poly 的 uvProject、uvTransform、uvReset
    expect(applyPolyOperation(roof, { op: 'uvProject', faces: [0, 1] }).mesh.faces.every((face) => face.uvs?.length === 4)).toBe(true);
    expect(() => applyPolyOperation(roof, { op: 'uvReset', faces: [9] })).toThrow(/no face 9/);
  });
});
