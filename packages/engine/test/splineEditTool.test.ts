import { describe, expect, test } from 'vitest';
import type { SplineFile } from '../src/content/formats/splineFormat';
import { Matrix } from '../src/data/Matrix';
import { Quaternion, Vector3 } from '../src/data/vectors';
import { branchFromPoint, deleteSplinePoints, insertSplinePoint, moveSplinePoints, pickSplineCurve, splinePointList, weldedPoints } from '../src/editor/viewport/SplineEditTool';
import { splineCurve, splinePoint } from '../src/modeling/spline';

const road: SplineFile = {
  name: 'Road', materials: [null], profile: { type: 'road', width: 6 },
  points: [{ position: [0, 0, 0] }, { position: [10, 0, 0], tilt: 10 }, { position: [20, 2, 10] }],
};

describe('样条编辑', () => {
  test('路径经过控制点；画用的折线每段一组、含两端', () => {
    expect(splinePoint(road.points, false, 1, 0)).toEqual([10, 0, 0]);
    expect(splinePoint(road.points, false, 1, 1).map((v) => Math.round(v * 1e9) / 1e9)).toEqual([20, 2, 10]);
    const curve = splineCurve(road.points, false, 8);
    expect(curve.length).toBe(2);
    expect(curve[0]!.length).toBe(9);
    // 首尾相连多一段
    expect(splineCurve(road.points, true, 8).length).toBe(3);
  });

  test('双击路径加点：新点在路径上（路形不变），侧倾按两头插值，选中的下标是新点', () => {
    const { spline, index } = insertSplinePoint(road, 0, 0, 0.5);
    expect(index).toBe(1);
    expect(spline.points.length).toBe(4);
    expect(spline.points[1]!.position).toEqual(splinePoint(road.points, false, 0, 0.5).map((v) => Math.round(v * 1000) / 1000));
    expect(spline.points[1]!.tilt).toBe(5);
    expect(spline.points[1]!.width).toBeUndefined();
    expect(spline.points[2]).toBe(road.points[1]);
  });

  test('删点：至少留两个', () => {
    expect(deleteSplinePoints(road, [1]).points.map((point) => point.position)).toEqual([[0, 0, 0], [20, 2, 10]]);
    expect(() => deleteSplinePoints(road, [0, 1])).toThrow('at least 2 points');
  });

  test('操纵器拖选中的点：世界里的位移换回实体本地，没选中的点是原来的对象', () => {
    const world = Matrix.compose(new Float32Array(16), [100, 0, 0], [0, 0, 0, 1], [2, 2, 2]);
    const moved = moveSplinePoints(road, [2], { type: 'translate', delta: new Vector3(0, 4, 0) }, new Vector3(140, 4, 20), new Quaternion(), world);
    expect(moved.points[2]!.position).toEqual([20, 4, 10]);
    expect(moved.points[0]).toBe(road.points[0]);
    expect(moved.points[1]).toBe(road.points[1]);
  });

  test('点路径：最近的段和段内的参数，太远是 undefined', () => {
    const projected: [number, number][][][] = [[[[0, 0], [10, 0]], [[10, 0], [10, 10], [10, 20]]], [[[100, 0], [100, 10]]]];
    expect(pickSplineCurve(projected, [5, 3])).toEqual({ path: 0, segment: 0, u: 0.5 });
    expect(pickSplineCurve(projected, [12, 15])).toEqual({ path: 0, segment: 1, u: 0.75 });
    expect(pickSplineCurve(projected, [98, 5])).toEqual({ path: 1, segment: 0, u: 0.5 });
    expect(pickSplineCurve(projected, [50, 50])).toBeUndefined();
  });
});

describe('路网的编辑', () => {
  // 第二个点拉出一条分支：分支的起点和它焊在一起
  const { spline: network, index: end } = branchFromPoint(road, 1, 20);

  test('拉出分支：从这个点水平地往右边伸出，末端是新的扁平下标', () => {
    expect(network.branches?.length).toBe(1);
    expect(end).toBe(4);
    const list = splinePointList(network);
    expect(list.map((entry) => [entry.path, entry.index])).toEqual([[0, 0], [0, 1], [0, 2], [1, 0], [1, 1]]);
    expect(list[3]!.point.position).toEqual([10, 0, 0]);
    // 第二个点处路径往 +x 偏 +z 走，右边（切线 × 上）大致是 +z、偏 -x
    const [x, y, z] = list[4]!.point.position;
    expect(y).toBe(0);
    expect(Math.hypot(x - 10, z)).toBeCloseTo(20, 2);
    expect(z).toBeGreaterThan(15);
    expect(weldedPoints(network, [1])).toEqual([1, 3]);
  });

  test('拖焊着的点：分支的起点一起动；加点加在对的路径里', () => {
    const moved = moveSplinePoints(network, [1], { type: 'translate', delta: new Vector3(0, 2, 0) }, new Vector3(10, 0, 0), new Quaternion(), Matrix.compose(new Float32Array(16), [0, 0, 0], [0, 0, 0, 1], [1, 1, 1]));
    expect(moved.points[1]!.position).toEqual([10, 2, 0]);
    expect(moved.branches![0]!.points[0]!.position).toEqual([10, 2, 0]);
    const { spline, index } = insertSplinePoint(network, 1, 0, 0.5);
    expect(index).toBe(4);
    expect(spline.branches![0]!.points.length).toBe(3);
    expect(spline.points).toBe(network.points);
  });

  test('删点：焊着的一起删，分支剩不到两个点就整条去掉', () => {
    expect(deleteSplinePoints(network, [4]).branches).toBeUndefined();
    const without = deleteSplinePoints(network, [3]);
    expect(without.points.length).toBe(2);
    expect(without.branches).toBeUndefined();
  });
});
