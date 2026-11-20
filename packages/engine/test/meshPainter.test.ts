import { describe, expect, test } from 'vitest';
import { Mesh } from '../src/rendering/mesh/Mesh';
import { raycastMesh } from '../src/rendering/paint/MeshPainter';

describe('在模型上画贴图', () => {
  const cube = Mesh.cube(2);
  const at = (x: number, y: number, z: number) => Float32Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1);

  test('射线和网格：打到最近的面，给出交点、法线和距离；按世界矩阵挪过去；打不到是 undefined', () => {
    const hit = raycastMesh(cube, at(0, 0, 0), [0, 0, 10], [0, 0, -1])!;
    expect(hit.distance).toBeCloseTo(9, 5);
    expect(hit.point.map((v) => Math.round(v * 1e5) / 1e5)).toEqual([0, 0, 1]);
    expect(Math.abs(hit.normal[2])).toBeCloseTo(1, 5);
    // 挪到 x = 5：同一条射线打不到了，挪过去的射线打得到
    expect(raycastMesh(cube, at(5, 0, 0), [0, 0, 10], [0, 0, -1])).toBeUndefined();
    expect(raycastMesh(cube, at(5, 0, 0), [5, 0, 10], [0, 0, -1])?.point[2]).toBeCloseTo(1, 5);
  });

  test('网格的 UV 解码：方块每个面铺满 0..1', () => {
    const uvs = cube.uvs();
    expect(uvs.length).toBe(cube.vertexCount * 2);
    expect(Math.min(...uvs)).toBeCloseTo(0, 5);
    expect(Math.max(...uvs)).toBeCloseTo(1, 5);
  });
});
