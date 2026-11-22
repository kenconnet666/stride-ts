import { describe, expect, test } from 'vitest';
import type { SplineFile } from '../src/content/formats/splineFormat';
import { checkSpline, frameAt, roadNetwork, sampleSpline, splineCenterlines, splineMeshes } from '../src/modeling/spline';

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

describe('路网和路口', () => {
  // 东西向的路，正中往南（+z）岔出一条：丁字路口
  const tee: SplineFile = {
    name: 'Tee', materials: [null], profile: { type: 'road', width: 6 },
    points: [{ position: [-30, 0, 0] }, { position: [0, 0, 0] }, { position: [30, 0, 0] }],
    branches: [{ points: [{ position: [0, 0, 0] }, { position: [0, 0, 30] }] }],
  };

  test('丁字路口：三条路停在边线交点再往外一个转角半径（默认半个路宽），剩下的段拉伸', () => {
    const { junctions, kept } = roadNetwork(tee);
    expect(junctions.length).toBe(1);
    const [junction] = junctions;
    expect(junction!.position).toEqual([0, 0, 0]);
    // 按角度逆时针（atan2(z, x)，从 -180° 起）：往西、往东、往南（+z）
    expect(junction!.arms.map((arm) => [arm.path, arm.sign])).toEqual([[0, -1], [0, 1], [1, 1]]);
    for (const arm of junction!.arms) expect(arm.trim).toBeCloseTo(6, 6);
    expect(kept[0]!.map(([a, b]) => [Math.round(a * 1e6) / 1e6, Math.round(b * 1e6) / 1e6])).toEqual([[0, 24], [36, 60]]);
    expect(kept[1]!.map(([a, b]) => [Math.round(a * 1e6) / 1e6, Math.round(b * 1e6) / 1e6])).toEqual([[6, 30]]);
  });

  test('路口的轮廓：逆时针、端口接着路面的边、两个转角是圆弧，对面（180°）直连', () => {
    const [junction] = roadNetwork(tee).junctions;
    const outline = junction!.outline;
    // 3 个端口各两个点，两个转角各 7 个中间点
    expect(outline.length).toBe(6 + 2 * 7);
    expect(junction!.curb.filter((curb) => !curb).length).toBe(3);
    // 往西那条路的端口在 x = -6，z = ±3（先靠上一条路的那边）
    expect(outline.slice(0, 2).map((p) => p.map((c) => Math.round(c * 1e6) / 1e6))).toEqual([[-6, 0, 3], [-6, 0, -3]]);
    // 有向面积为正（逆时针，按 atan2(z, x) 转），都在路面的高度
    let area = 0;
    outline.forEach((a, i) => {
      const b = outline[(i + 1) % outline.length]!;
      area += a[0] * b[2] - b[0] * a[2];
    });
    expect(area).toBeGreaterThan(0);
    expect(outline.every((p) => p[1] === 0)).toBe(true);
    // 往东、往南之间的转角：端口 (6, 3)、(3, 6)，控制点是边线的交点 (3, 3)，圆弧的中点 (3.75, 3.75)
    expect(outline.some((p) => Math.abs(p[0] - 3.75) < 1e-9 && Math.abs(p[2] - 3.75) < 1e-9)).toBe(true);
  });

  test('网格：路口的顶面朝上；只有两条路相接、没有分支的不出路口', () => {
    const [mesh] = splineMeshes(tee);
    const vertices = verticesOf(mesh!.vertices);
    const indices = mesh!.indices;
    for (let i = 0; i < indices.length; i += 3) {
      const [a, b, c] = [vertices[indices[i]!]!, vertices[indices[i + 1]!]!, vertices[indices[i + 2]!]!];
      const e1 = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!], e2 = [c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!];
      const n = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!];
      // 三角形的绕向和顶点法线一致
      expect(n[0]! * a[3]! + n[1]! * a[4]! + n[2]! * a[5]!).toBeGreaterThanOrEqual(-1e-6);
    }
    const joined: SplineFile = { ...tee, points: [{ position: [-30, 0, 0] }, { position: [0, 0, 0] }], branches: [{ points: [{ position: [0, 0, 0] }, { position: [0, 0, 30] }] }] };
    expect(roadNetwork(joined).junctions).toEqual([]);
    // 别的横截面每条路径各自拉伸
    const fence = splineMeshes({ ...tee, materials: [null, null], profile: { type: 'fence' } });
    expect(fence.length).toBe(2);
    expect(() => checkSpline({ ...tee, branches: [{ points: [{ position: [0, 0, 0] }] }] })).toThrow('branches[0].points needs at least 2 points');
  });

  test('地面贴的中心线：每条路径一条折线，经过路口时走端口 → 中心 → 端口的直线；再加路口的路缘', () => {
    const lines = splineCenterlines(tee, 4);
    const [main, branch] = lines.map((line) => line.points);
    // 后面是路口的三段路缘（从端口经过转角到下一个端口）：往西到往东之间对着岔路的那边是直的，另外两个转角是圆弧
    const curbs = lines.filter((line) => line.curb);
    expect(curbs.map((line) => line.points.length)).toEqual([2, 9, 9]);
    const round = (p: readonly number[]) => p.map((c) => Math.round(c * 1e6) / 1e6);
    // 主路：……(-6, 0, 0)、(0, 0, 0)、(6, 0, 0)……，中心只出现一次
    const i = main!.findIndex((p) => round(p).join() === '0,0,0');
    expect(round(main![i - 1]!)).toEqual([-6, 0, 0]);
    expect(round(main![i + 1]!)).toEqual([6, 0, 0]);
    expect(main!.filter((p) => round(p).join() === '0,0,0').length).toBe(1);
    // 岔路从路口中心出发，接着是它的端口
    expect(round(branch![0]!)).toEqual([0, 0, 0]);
    expect(round(branch![1]!)).toEqual([0, 0, 6]);
    expect(round(branch!.at(-1)!)).toEqual([0, 0, 30]);
  });

  test('十字路口：四条路都退到交点外，两条路径共用中间的控制点', () => {
    const cross: SplineFile = { ...tee, branches: [{ points: [{ position: [0, 0, -30] }, { position: [0, 0, 0] }, { position: [0, 0, 30] }] }] };
    const [junction] = roadNetwork(cross).junctions;
    expect(junction!.arms.length).toBe(4);
    for (const arm of junction!.arms) expect(arm.trim).toBeCloseTo(6, 6);
    expect(junction!.outline.length).toBe(8 + 4 * 7);
  });
});
