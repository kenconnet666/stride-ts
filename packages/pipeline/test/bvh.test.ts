import { describe, expect, test } from 'vitest';
import { TriangleBvh } from '../src/geometry/bvh.ts';

/** 中心在原点、边长 2 的立方体：8 个顶点、12 个三角形。 */
function cube(): { positions: Float32Array; indices: Uint32Array } {
  const positions = new Float32Array([-1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1, -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1]);
  const indices = new Uint32Array([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5]);
  return { positions, indices };
}

/** n × n 格的平面网格（z = 0，x、y 在 0..1），三角形多到要分好几层。 */
function grid(n: number): { positions: Float32Array; indices: Uint32Array } {
  const positions = new Float32Array((n + 1) * (n + 1) * 3);
  for (let y = 0; y <= n; y++) for (let x = 0; x <= n; x++) positions.set([x / n, y / n, 0], (y * (n + 1) + x) * 3);
  const indices: number[] = [];
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const a = y * (n + 1) + x;
      indices.push(a, a + 1, a + n + 2, a, a + n + 2, a + n + 1);
    }
  }
  return { positions, indices: Uint32Array.from(indices) };
}

describe('三角网格的 BVH', () => {
  test('射线：从外面打到最近的面，从里面也能打到（两面都算），超出距离或打偏时没有', () => {
    const { positions, indices } = cube();
    const bvh = new TriangleBvh(positions, indices);
    expect(bvh.rayCast([0.2, 0.3, -5], [0, 0, 1], 10)).toBeCloseTo(4);
    expect(bvh.rayCast([0.2, 0.3, 0], [0, 0, 1], 10)).toBeCloseTo(1);
    expect(bvh.rayCast([0.2, 0.3, -5], [0, 0, 1], 3)).toBeUndefined();
    expect(bvh.rayCast([3, 0, -5], [0, 0, 1], 10)).toBeUndefined();
    const s = Math.SQRT1_2;
    expect(bvh.rayCast([-3, 0, -2], [s, 0, s], 10)).toBeCloseTo(2 * Math.SQRT2);
  });

  test('最近点：面的正上方、棱外、角外、内部', () => {
    const { positions, indices } = cube();
    const bvh = new TriangleBvh(positions, indices);
    expect(bvh.distanceTo([0.5, 0.5, 3])).toBeCloseTo(2);
    expect(bvh.distanceTo([2, 2, 0])).toBeCloseTo(Math.SQRT2);
    expect(bvh.distanceTo([2, 2, 2])).toBeCloseTo(Math.sqrt(3));
    expect(bvh.distanceTo([0, 0, 0.25])).toBeCloseTo(0.75);
  });

  test('三角形多的网格：每条射线、每个最近点和逐个三角形硬算的结果一样', () => {
    const { positions, indices } = grid(24);
    const bvh = new TriangleBvh(positions, indices);
    let seed = 7;
    const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < 200; i++) {
      const point = [random() * 1.4 - 0.2, random() * 1.4 - 0.2, random() * 2 - 1] as const;
      // 平面在 z = 0：竖直的射线打到的距离是 |z|（落在网格范围里时）
      const inside = point[0] >= 0 && point[0] <= 1 && point[1] >= 0 && point[1] <= 1;
      const hit = bvh.rayCast(point, [0, 0, point[2] > 0 ? -1 : 1], 5);
      if (inside) expect(hit).toBeCloseTo(Math.abs(point[2]), 5);
      else expect(hit).toBeUndefined();
      const dx = Math.max(-point[0], 0, point[0] - 1), dy = Math.max(-point[1], 0, point[1] - 1);
      expect(bvh.distanceTo(point)).toBeCloseTo(Math.hypot(dx, dy, point[2]), 5);
    }
  });
});
