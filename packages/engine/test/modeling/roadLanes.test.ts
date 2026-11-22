import { describe, expect, test } from 'vitest';
import type { SplineFile } from '../../src/content/formats/splineFormat';
import { roadLanes } from '../../src/modeling/roadLanes';

const round = (p: readonly number[]) => p.map((c) => Math.round(c * 1e6) / 1e6);
/** 丁字路口附近的点在哪条路上：按离中心远的那个坐标轴分东西南（+z）。 */
const arm = (p: readonly number[]) => (Math.abs(p[0]!) > Math.abs(p[2]!) ? (p[0]! > 0 ? 'east' : 'west') : 'south');

describe('车道图', () => {
  const straight: SplineFile = { name: 'Road', materials: [null], profile: { type: 'road', width: 7 }, points: [{ position: [0, 0, 0] }, { position: [40, 0, 0] }] };

  test('双向一车道：靠右行驶，顺着路径的在右边（+z），逆着的在左边、反过来走；路的尽头没有 next', () => {
    const lanes = roadLanes(straight);
    expect(lanes.length).toBe(2);
    const [forward, backward] = lanes;
    expect(round(forward!.points[0]!)).toEqual([0, 0, 1.75]);
    expect(round(forward!.points.at(-1)!)).toEqual([40, 0, 1.75]);
    expect(round(backward!.points[0]!)).toEqual([40, 0, -1.75]);
    expect(forward!.length).toBeCloseTo(40, 6);
    expect(lanes.every((lane) => lane.next.length === 0 && lane.junction === undefined)).toBe(true);
  });

  test('车道数：不写按 3.5 米一条；单行的全部顺着路径、从左往右排', () => {
    expect(roadLanes({ ...straight, profile: { type: 'road', width: 14 } }).length).toBe(4);
    const oneWay = roadLanes({ ...straight, profile: { type: 'road', width: 7, oneWay: true } });
    expect(oneWay.map((lane) => round(lane.points[0]!))).toEqual([[0, 0, -1.75], [0, 0, 1.75]]);
    expect(roadLanes({ ...straight, profile: { type: 'fence' } })).toEqual([]);
  });

  test('丁字路口：每条驶入的车道接到另外两条路，不掉头；连接车道从驶入车道的终点到驶出车道的起点', () => {
    const tee: SplineFile = {
      ...straight, points: [{ position: [-30, 0, 0] }, { position: [0, 0, 0] }, { position: [30, 0, 0] }],
      branches: [{ points: [{ position: [0, 0, 0] }, { position: [0, 0, 30] }] }],
    };
    const lanes = roadLanes(tee);
    const roads = lanes.filter((lane) => lane.junction === undefined), connectors = lanes.filter((lane) => lane.junction !== undefined);
    // 三条路各两个方向，3 条驶入车道各接 2 条路
    expect(roads.length).toBe(6);
    expect(connectors.length).toBe(6);
    for (const lane of roads) {
      const enters = lane.next.length > 0;
      // 驶入路口的车道终点离中心 7 米（半个路宽的交点加 3.5 米的转角半径，路停在那）
      if (enters) expect(Math.hypot(lane.points.at(-1)![0], lane.points.at(-1)![2])).toBeCloseTo(Math.hypot(7, 1.75), 6);
      for (const c of lane.next) {
        const connector = lanes[c]!;
        expect(connector.junction).toBe(0);
        expect(round(connector.points[0]!)).toEqual(round(lane.points.at(-1)!));
        const target = lanes[connector.next[0]!]!;
        expect(round(connector.points.at(-1)!)).toEqual(round(target.points[0]!));
        // 不掉头：驶出车道不和驶入车道在同一条路上（起点不在同一边）
        expect(arm(target.points[0]!)).not.toBe(arm(lane.points.at(-1)!));
      }
    }
    // 从西往东走的车道（右边，z = +1.75）到了路口能直行或右转（往 +z 的岔路）
    const eastbound = roads.find((lane) => lane.points[0]![0] < -20 && lane.points[0]![2] > 0)!;
    const exits = eastbound.next.map((c) => lanes[lanes[c]!.next[0]!]!.points[0]!).map(round);
    expect(exits).toContainEqual([7, 0, 1.75]);
    expect(exits).toContainEqual([-1.75, 0, 7]);
  });

  test('首尾焊在一起的两条路直接接上；首尾相连的路径终点接回起点', () => {
    const joined: SplineFile = { ...straight, branches: [{ points: [{ position: [40, 0, 0] }, { position: [80, 0, 0] }] }] };
    const lanes = roadLanes(joined);
    // 第一条路顺着走的车道接第二条路顺着走的
    expect(lanes[0]!.next).toEqual([2]);
    expect(lanes[3]!.next).toEqual([1]);
    const loop = roadLanes({ ...straight, closed: true, points: [{ position: [0, 0, 0] }, { position: [40, 0, 0] }, { position: [40, 0, 40] }, { position: [0, 0, 40] }] });
    expect(loop[0]!.next).toEqual([0]);
    expect(loop[1]!.next).toEqual([1]);
  });
});
