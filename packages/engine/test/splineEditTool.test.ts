import { describe, expect, test } from 'vitest';
import type { SplineFile } from '../src/content/splineFormat';
import { Matrix } from '../src/data/Matrix';
import { Quaternion, Vector3 } from '../src/data/vectors';
import { deleteSplinePoints, insertSplinePoint, moveSplinePoints, pickSplineCurve } from '../src/editor/SplineEditTool';
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
    const { spline, index } = insertSplinePoint(road, 0, 0.5);
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
    const projected = [[[0, 0], [10, 0]], [[10, 0], [10, 10], [10, 20]]] as const;
    expect(pickSplineCurve(projected, [5, 3])).toEqual({ segment: 0, u: 0.5 });
    expect(pickSplineCurve(projected, [12, 15])).toEqual({ segment: 1, u: 0.75 });
    expect(pickSplineCurve(projected, [50, 50])).toBeUndefined();
  });
});
