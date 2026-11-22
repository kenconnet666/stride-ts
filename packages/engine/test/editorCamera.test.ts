import { describe, expect, test } from 'vitest';
import { EditorCameraState } from '../src/editor/viewport/EditorCamera';

const round = ({ x, y, z }: { x: number; y: number; z: number }) => [x, y, z].map((v) => Math.round(v * 1000) / 1000 + 0);

describe('编辑器的相机（EditorCameraState）', () => {
  test('默认在注视点后面 10 个单位、看向 -Z；绕注视点转时距离不变，偏航正的往左、俯仰正的往上看', () => {
    const state = new EditorCameraState();
    expect([round(state.position), round(state.forward)]).toEqual([[0, 0, 10], [0, 0, -1]]);
    state.orbit(Math.PI / 2, 0);
    // 往左转 90 度：看向 -X，眼睛到了 +X 一侧
    expect([round(state.forward), round(state.position), round(state.target)]).toEqual([[-1, 0, 0], [10, 0, 0], [0, 0, 0]]);
    state.orbit(-Math.PI / 2, Math.PI / 6);
    // 往上看 30 度：眼睛降到注视点下面
    expect(round(state.forward)).toEqual([0, 0.5, -0.866]);
    expect(round(state.position)).toEqual([0, -5, 8.66]);
    // 俯仰到不了正上方
    state.orbit(0, 10);
    expect(state.pitch).toBeLessThan(Math.PI / 2);
    expect(state.forward.y).toBeGreaterThan(0.999);
  });

  test('转头时眼睛不动、注视点跟着走；平移和飞行时两个一起走', () => {
    const state = new EditorCameraState();
    state.target.set(1, 2, 3);
    const eye = round(state.position);
    state.look(0.7, -0.3);
    expect(round(state.position)).toEqual(eye);
    expect(state.target.clone().subtract(state.position).length()).toBeCloseTo(10, 5);
    const back = new EditorCameraState();
    back.pan(2, 1);
    expect([round(back.target), round(back.position)]).toEqual([[2, 1, 0], [2, 1, 10]]);
    back.fly(0, 0, 3);
    expect([round(back.target), round(back.position)]).toEqual([[2, 1, -3], [2, 1, 7]]);
    // 转了以后"右"是相机的右
    back.orbit(Math.PI / 2, 0);
    back.pan(1, 0);
    expect(round(back.target)).toEqual([2, 1, -4]);
  });

  test('推拉每格乘固定的比例，到不了注视点；聚焦把球正好装进视场', () => {
    const state = new EditorCameraState();
    state.dolly(1);
    expect(state.distance).toBeCloseTo(8.5, 5);
    state.dolly(-1);
    expect(state.distance).toBeCloseTo(10, 5);
    state.dolly(1000);
    expect(state.distance).toBe(state.minDistance);
    state.orbit(0.4, 0.2);
    const forward = round(state.forward);
    state.focus({ x: 5, y: 1, z: -2 }, 2, Math.PI / 3);
    // 半径 2 的球、60 度的视场：距离 2 / sin(30°) = 4；朝向不变
    expect([round(state.target), Math.round(state.distance * 1e6) / 1e6, round(state.forward)]).toEqual([[5, 1, -2], 4, forward]);
  });

  test('接手一台摆好的相机：眼睛的位置和朝向原样，注视点在正前方', () => {
    const state = new EditorCameraState();
    const forward = { x: -0.6, y: -0.48, z: -0.64 };
    state.setFromPose({ x: 3, y: 4, z: 5 }, forward, 5);
    expect(round(state.position)).toEqual([3, 4, 5]);
    expect(round(state.forward)).toEqual([-0.6, -0.48, -0.64]);
    expect(round(state.target)).toEqual([0, 1.6, 1.8]);
  });
});
