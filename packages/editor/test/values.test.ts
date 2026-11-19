import { describe, expect, test } from 'vitest';
import { colorToHex, eulerToQuaternion, hexToColor, quaternionToEuler } from '../src/ui/values.ts';

// 属性面板上的值和文件里的值之间的换算。

describe('旋转：四元数和欧拉角（Stride 的 yaw、pitch、roll 顺序）', () => {
  test('单独绕一根轴', () => {
    const s = Math.SQRT1_2;
    expect(eulerToQuaternion([90, 0, 0]).map((v) => +v.toFixed(6))).toEqual([+s.toFixed(6), 0, 0, +s.toFixed(6)]);
    expect(eulerToQuaternion([0, 90, 0]).map((v) => +v.toFixed(6))).toEqual([0, +s.toFixed(6), 0, +s.toFixed(6)]);
    expect(eulerToQuaternion([0, 0, 90]).map((v) => +v.toFixed(6))).toEqual([0, 0, +s.toFixed(6), +s.toFixed(6)]);
    expect(quaternionToEuler([0, 0, 0, 1])).toEqual([0, 0, 0]);
  });

  test('来回换一圈还是原来的角度（避开万向锁）', () => {
    for (const angles of [[10, 20, 30], [-45, 170, 5], [80, -120, -60], [0, 179, 0]]) {
      expect(quaternionToEuler(eulerToQuaternion(angles))).toEqual(angles);
    }
  });

  test('万向锁：pitch 是 90 度时 roll 并进 yaw，转出来的朝向一样', () => {
    const q = eulerToQuaternion([90, 30, 20]);
    const back = eulerToQuaternion(quaternionToEuler(q));
    // 同一个旋转（四元数可能差一个符号）
    const dot = Math.abs(q.reduce((sum, v, i) => sum + v * back[i]!, 0));
    expect(dot).toBeCloseTo(1, 6);
    expect(quaternionToEuler(q)[2]).toBe(0);
  });
});

describe('颜色：文件里的（sRGB 或线性）和取色器的 #rrggbb', () => {
  test('sRGB 原样；线性的换过去再换回来差不到一个色阶', () => {
    expect(colorToHex([1, 0.5, 0], 'srgb')).toBe('#ff8000');
    expect(colorToHex([1, 0.2158, 0], 'linear')).toBe('#ff8000');
    expect(hexToColor('#ff8000', 'srgb', [0, 0, 0, 0.5])).toEqual([1, 0.50196, 0, 0.5]);
    expect(hexToColor('#ff8000', 'linear', [0, 0, 0])).toEqual([1, 0.21586, 0]);
  });

  test('HDR 的值（超过 1）在取色器上夹住', () => {
    expect(colorToHex([4, -1, 0.5], 'srgb')).toBe('#ff0080');
  });
});
