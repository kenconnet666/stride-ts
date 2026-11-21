import { describe, expect, test } from 'vitest';
import type { SplineFile } from '../src/content/splineFormat';
import { checkSpline, frameAt, sampleSpline, splineMeshes } from '../src/modeling/spline';

/** 网格里的顶点（每个 8 个数）。 */
const verticesOf = (vertices: Float32Array) => Array.from({ length: vertices.length / 8 }, (_, i) => Array.from(vertices.slice(i * 8, i * 8 + 8)));

describe('样条', () => {
  test('路径经过每个控制点，按弧长等距取点，朝向跟着世界的上方', () => {
    const points = [{ position: [0, 0, 0] as const }, { position: [10, 0, 0] as const }, { position: [20, 2, 10] as const }];
    const frames = sampleSpline(points, false, 1);
    for (const p of points) {
      const nearest = Math.min(...frames.map((f) => Math.hypot(f.position[0] - p.position[0], f.position[1] - p.position[1], f.position[2] - p.position[2])));
      expect(nearest).toBeLessThan(0.6);
    }
    // 间距大约 1 米、最后一个正好在终点
    const steps = frames.slice(1).map((f, i) => f.distance - frames[i]!.distance);
    expect(Math.max(...steps) - Math.min(...steps)).toBeLessThan(1e-9);
    expect(frames.at(-1)!.position).toEqual([20, 2, 10]);
    // 路面不侧翻：right 是水平的；up 朝上
    for (const f of frames) {
      expect(Math.abs(f.right[1])).toBeLessThan(1e-9);
      expect(f.up[1]).toBeGreaterThan(0.9);
    }
    // 沿 +x 走时右边是 +z（right = 切线 × 上）
    expect(frames[2]!.right[2]).toBeGreaterThan(0.99);
  });

  test('侧倾绕切线转，首尾相连的路径终点回到起点', () => {
    const tilted = sampleSpline([{ position: [0, 0, 0], tilt: 30 }, { position: [10, 0, 0], tilt: 30 }], false, 2);
    expect(tilted[1]!.right[1]).toBeCloseTo(-0.5, 5);
    const loop = sampleSpline([{ position: [0, 0, 0] }, { position: [10, 0, 0] }, { position: [10, 0, 10] }, { position: [0, 0, 10] }], true, 1);
    expect(loop.at(-1)!.position.map((c) => Math.round(c * 1e6) / 1e6)).toEqual([0, 0, 0]);
    expect(frameAt(loop, loop.at(-1)!.distance / 2).distance).toBeCloseTo(loop.at(-1)!.distance / 2, 9);
  });

  test('道路：路面朝上、宽度对，三角形逆时针朝着法线', () => {
    const road: SplineFile = { name: 'Road', materials: [null], profile: { type: 'road', width: 6, thickness: 0.3, shoulder: 0.5 }, points: [{ position: [0, 0, 0] }, { position: [30, 0, 0] }] };
    const [mesh] = splineMeshes(road);
    const vertices = verticesOf(mesh!.vertices);
    const top = vertices.filter((v) => Math.abs(v[1]!) < 1e-6 && v[4]! > 0.99);
    expect(Math.min(...top.map((v) => v[2]!))).toBeCloseTo(-3, 5);
    expect(Math.max(...top.map((v) => v[2]!))).toBeCloseTo(3, 5);
    // 每个三角形的几何法线和顶点法线同向
    for (let i = 0; i < mesh!.indices.length; i += 3) {
      const [a, b, c] = [0, 1, 2].map((k) => vertices[mesh!.indices[i + k]!]!);
      const e1 = [b![0]! - a![0]!, b![1]! - a![1]!, b![2]! - a![2]!], e2 = [c![0]! - a![0]!, c![1]! - a![1]!, c![2]! - a![2]!];
      const n = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!];
      expect(n[0]! * a![3]! + n[1]! * a![4]! + n[2]! * a![5]!).toBeGreaterThan(0);
    }
  });

  test('围栏按间距立柱，电线在两杆中间下垂 sag', () => {
    const fence = splineMeshes({ name: 'Fence', materials: [null, null], profile: { type: 'fence', postSpacing: 5, height: 1 }, points: [{ position: [0, 0, 0] }, { position: [20, 0, 0] }] });
    // 立柱每根 6 个面、每面 4 个顶点：20 米、间距 5 米是 5 根
    expect(fence[0]!.vertices.length / 8 / 24).toBe(5);
    const wire = splineMeshes({ name: 'Wire', materials: [null, null], profile: { type: 'wire', poleHeight: 10, poleSpacing: 40, sag: 2, wires: 1 }, points: [{ position: [0, 0, 0] }, { position: [40, 0, 0] }] });
    const wires = verticesOf(wire[1]!.vertices);
    const lowest = Math.min(...wires.map((v) => v[1]!));
    expect(lowest).toBeCloseTo(10 - 0.35 - 2 - 0.015, 2);
  });

  test('检查：点太少、宽度不对、不认识的横截面', () => {
    expect(() => checkSpline({ name: 'S', materials: [null], profile: { type: 'road', width: 4 }, points: [{ position: [0, 0, 0] }] })).toThrow('at least 2 points');
    expect(() => checkSpline({ name: 'S', materials: [null], profile: { type: 'road', width: 0 }, points: [{ position: [0, 0, 0] }, { position: [1, 0, 0] }] })).toThrow('profile.width must be positive');
    expect(() => checkSpline({ name: 'S', materials: [null], profile: { type: 'canal' } as never, points: [{ position: [0, 0, 0] }, { position: [1, 0, 0] }] })).toThrow('profile.type');
  });
});
