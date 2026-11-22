import { describe, expect, test } from 'vitest';
import { applyGizmoChange, applySnap, closestOnAxis, DEFAULT_SNAP, rayPlane, TransformGizmo, type GizmoChange, type Ray } from '../../src/editor/viewport/TransformGizmo';
import { Quaternion, Vector3 } from '../../src/data/vectors';

// 操纵器的几何：不碰输入、实体和绘制。

const round = (v: { x: number; y: number; z: number }) => [v.x, v.y, v.z].map((c) => +c.toFixed(4));
/** 从正上方往下看的一条射线。 */
const down = (x: number, z: number): Ray => ({ origin: { x, y: 10, z }, direction: { x: 0, y: -1, z: 0 } });
/** 从 +Z 往 -Z 看的一条射线。 */
const front = (x: number, y: number): Ray => ({ origin: { x, y, z: 10 }, direction: { x: 0, y: 0, z: -1 } });
/** 正对着 -Z 看、每个世界单位 100 像素、原点在 (400, 300) 的画面。 */
const project = (point: { x: number; y: number }) => [400 + point.x * 100, 300 - point.y * 100] as const;
const delta = (change: GizmoChange | undefined) => (change?.type === 'translate' ? round(change.delta) : undefined);
const factor = (change: GizmoChange | undefined) => (change?.type === 'scale' ? round(change.factor) : undefined);

describe('操纵器的几何（TransformGizmo）', () => {
  test('射线到轴最近的点、射线和平面的交点；平行时没有结果', () => {
    expect(closestOnAxis(down(2, 5), { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 })).toBeCloseTo(2);
    expect(closestOnAxis(down(2, 5), { x: 1, y: 0, z: 0 }, { x: 1, y: 0, z: 0 })).toBeCloseTo(1);
    expect(closestOnAxis(down(2, 5), { x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 })).toBeUndefined();
    expect(round(rayPlane(down(2, 5), { x: 0, y: 1, z: 0 }, { x: 0, y: 1, z: 0 })!)).toEqual([2, 1, 5]);
    expect(rayPlane(down(2, 5), { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 })).toBeUndefined();
    // 平面在射线背后
    expect(rayPlane(down(2, 5), { x: 0, y: 20, z: 0 }, { x: 0, y: 1, z: 0 })).toBeUndefined();
  });

  test('移动：沿轴拖只动那根轴，在面片上拖动两根轴；吸附到步长；枢轴不在原点、朝向不是世界轴时一样', () => {
    const gizmo = new TransformGizmo();
    expect(gizmo.begin({ kind: 'axis', axis: 'x' }, down(1, 0.3), [0, 0])).toBe(true);
    expect(delta(gizmo.drag(down(3, -2), [0, 0]))).toEqual([2, 0, 0]);
    gizmo.translateSnap = 0.5;
    expect(delta(gizmo.drag(down(2.2, 0), [0, 0]))).toEqual([1, 0, 0]);
    // 拖的过程中枢轴跟着实体走了（操纵器画在实体上）：拖了多少还是从按下的地方量
    gizmo.translateSnap = 0;
    gizmo.pivot.set(2, 0, 0);
    expect([delta(gizmo.drag(down(3, -2), [0, 0])), round(gizmo.dragOrigin!)]).toEqual([[2, 0, 0], [0, 0, 0]]);
    gizmo.pivot.set(0, 0, 0);
    gizmo.end();
    expect([gizmo.dragging, gizmo.dragOrigin, gizmo.drag(down(3, 0), [0, 0])]).toEqual([undefined, undefined, undefined]);
    // 面片（法线是 y）：在 XZ 平面里拖
    gizmo.translateSnap = 0;
    gizmo.begin({ kind: 'plane', axis: 'y' }, down(1, 1), [0, 0]);
    expect(delta(gizmo.drag(down(2, 3), [0, 0]))).toEqual([1, 0, 2]);
    gizmo.translateSnap = 1;
    expect(delta(gizmo.drag(down(2.4, 2.6), [0, 0]))).toEqual([1, 0, 2]);
    gizmo.end();
    // 沿着轴看过去：算不出来，不开始拖
    expect(gizmo.begin({ kind: 'axis', axis: 'y' }, down(1, 1), [0, 0])).toBe(false);
    // 本地轴：操纵器绕 Y 转了 90 度，它的 x 轴指向世界的 -Z
    gizmo.translateSnap = 0;
    gizmo.pivot.set(5, 0, 5);
    gizmo.orientation.setAxisAngle({ x: 0, y: 1, z: 0 }, Math.PI / 2);
    expect(round(gizmo.axis('x'))).toEqual([0, 0, -1]);
    gizmo.begin({ kind: 'axis', axis: 'x' }, down(5, 5), [0, 0]);
    expect(delta(gizmo.drag(down(7, 2), [0, 0]))).toEqual([0, 0, -3]);
  });

  test('旋转：绕轴转过的角度，实体的位置绕枢轴走、朝向跟着转；吸附到步长', () => {
    const gizmo = new TransformGizmo();
    gizmo.mode = 'rotate';
    gizmo.begin({ kind: 'ring', axis: 'y' }, down(1, 0), [0, 0]);
    const change = gizmo.drag(down(0, -1), [0, 0])!;
    const moved = applyGizmoChange(change, gizmo.pivot, { position: { x: 2, y: 0, z: 0 }, rotation: new Quaternion(), scale: { x: 1, y: 2, z: 3 } });
    // 绕 Y 转正 90 度：+X 转到 -Z
    expect([round(moved.position), round(new Vector3(1, 0, 0).rotate(moved.rotation)), round(moved.scale)]).toEqual([[0, 0, -2], [0, 0, -1], [1, 2, 3]]);
    gizmo.rotateSnap = Math.PI / 12;
    const snapped = gizmo.drag(down(1, -0.3), [0, 0])!;
    expect(snapped.type === 'rotate' && 2 * Math.acos(snapped.rotation.w)).toBeCloseTo(Math.PI / 12);
  });

  test('缩放：沿轴按到枢轴的距离的倍数，中间的方块三个方向一起（往上拖放大）；位置不动', () => {
    const gizmo = new TransformGizmo();
    gizmo.mode = 'scale';
    gizmo.begin({ kind: 'axis', axis: 'x' }, down(1, 0), [0, 0]);
    expect(factor(gizmo.drag(down(2.5, 0), [0, 0]))).toEqual([2.5, 1, 1]);
    // 拖过枢轴到另一边：不变成负的
    expect(factor(gizmo.drag(down(-1, 0), [0, 0]))).toEqual([0.01, 1, 1]);
    gizmo.end();
    expect(gizmo.begin({ kind: 'axis', axis: 'x' }, down(0, 0), [0, 0])).toBe(false);
    gizmo.begin({ kind: 'center' }, down(0, 0), [100, 200]);
    const change = gizmo.drag(down(0, 0), [100, 150])!;
    expect(factor(change)).toEqual([1.5, 1.5, 1.5]);
    const scaled = applyGizmoChange(change, gizmo.pivot, { position: { x: 1, y: 2, z: 3 }, rotation: new Quaternion(), scale: { x: 1, y: 2, z: 4 } });
    expect([round(scaled.position), round(scaled.scale)]).toEqual([[1, 2, 3], [1.5, 3, 6]]);
  });

  test('碰到哪个把手：离鼠标最近的，面片是落在里面；每个模式有自己的把手', () => {
    const gizmo = new TransformGizmo();
    const pick = (x: number, y: number) => gizmo.pick([x, y], project);
    expect(gizmo.handles()).toHaveLength(6);
    expect(pick(450, 303)).toEqual({ kind: 'axis', axis: 'x' });
    expect(pick(402, 240)).toEqual({ kind: 'axis', axis: 'y' });
    expect(pick(437, 262)).toEqual({ kind: 'plane', axis: 'z' });
    expect([pick(450, 320), pick(600, 100)]).toEqual([undefined, undefined]);
    // 大小跟着 size
    gizmo.size = 2;
    expect([pick(590, 300), pick(437, 262)]).toEqual([{ kind: 'axis', axis: 'x' }, undefined]);
    gizmo.size = 1;
    gizmo.mode = 'scale';
    expect(gizmo.handles()).toHaveLength(4);
    expect([pick(403, 302), pick(450, 303), pick(437, 262)]).toEqual([{ kind: 'center' }, { kind: 'axis', axis: 'x' }, undefined]);
    gizmo.mode = 'rotate';
    expect([pick(471, 229), pick(450, 250)]).toEqual([{ kind: 'ring', axis: 'z' }, undefined]);
    // 有一部分在相机后面的把手不参与
    expect(gizmo.pick([471, 229], () => undefined)).toBeUndefined();
    // 用 front 这条射线真的拖一下 z 圈：从 +X 拖到 +Y 是绕 Z 转正 90 度
    gizmo.begin(pick(471, 229)!, front(1, 0), [500, 300]);
    const change = gizmo.drag(front(0, 1), [400, 200])!;
    expect(change.type === 'rotate' && round(new Vector3(1, 0, 0).rotate(change.rotation))).toEqual([0, 1, 0]);
  });

  test('吸附设置：开着时用步长（旋转换成弧度），按住 Ctrl 反过来；关着时按住 Ctrl 临时吸附', () => {
    const gizmo = new TransformGizmo();
    const steps = () => [gizmo.translateSnap, +gizmo.rotateSnap.toFixed(6), gizmo.scaleSnap];
    applySnap(gizmo, DEFAULT_SNAP, false);
    expect(steps()).toEqual([0, 0, 0]);
    applySnap(gizmo, DEFAULT_SNAP, true);
    expect(steps()).toEqual([1, +(Math.PI / 12).toFixed(6), 0.1]);
    applySnap(gizmo, { enabled: true, translate: 0.5, rotate: 90, scale: 0.25 }, false);
    expect(steps()).toEqual([0.5, +(Math.PI / 2).toFixed(6), 0.25]);
    applySnap(gizmo, { enabled: true, translate: 0.5, rotate: 90, scale: 0.25 }, true);
    expect(steps()).toEqual([0, 0, 0]);
    // 吸附到 0.5：拖了 0.7 走 0.5
    applySnap(gizmo, { enabled: true, translate: 0.5, rotate: 90, scale: 0.25 }, false);
    gizmo.begin({ kind: 'axis', axis: 'x' }, down(0.3, 0.2), [0, 0]);
    expect(delta(gizmo.drag(down(1.0, 0.2), [0, 0]))).toEqual([0.5, 0, 0]);
  });
});
