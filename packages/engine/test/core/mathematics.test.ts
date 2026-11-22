// 数学类型（Vector3、Quaternion）和 C# 风格的数值文字：纯计算，不用原生模块。
import { describe, expect, test } from 'vitest';
import { Quaternion, Vector3, formatBool, formatColor, formatFloat, formatVector } from '../../src';

describe('Vector3、Quaternion', () => {
  test('绕 Y 转 90° 把 +Z 转到 +X，同 Stride 的 Quaternion.Rotate', () => {
    const q = new Quaternion().setAxisAngle({ x: 0, y: 1, z: 0 }, Math.PI / 2);
    const v = new Vector3(0, 0, 1).rotate(q);
    expect(v.x).toBeCloseTo(1);
    expect(v.y).toBeCloseTo(0);
    expect(v.z).toBeCloseTo(0);
  });

  test('Quaternion.lookRotation 把本地 +Z 转到 forward，+Y 朝 up（Stride 的 LookRotation）；和 up 平行时也是单位四元数', () => {
    // 和 up 平行时换一根轴当 up，结果仍是单位四元数
    const vertical = Quaternion.lookRotation({ x: 0, y: 3, z: 0 }, { x: 0, y: 1, z: 0 });
    expect(Math.hypot(vertical.x, vertical.y, vertical.z, vertical.w)).toBeCloseTo(1, 6);
    expect(new Vector3(0, 0, 1).rotate(vertical).y).toBeCloseTo(1, 6);
    for (const forward of [{ x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: -1 }, { x: 1, y: 2, z: -3 }, { x: 0, y: -0.2, z: 1 }]) {
      const q = Quaternion.lookRotation(forward, { x: 0, y: 1, z: 0 });
      const z = new Vector3(0, 0, 1).rotate(q);
      const f = new Vector3().copy(forward).normalize();
      expect(z.clone().subtract(f).length()).toBeLessThan(1e-6);
      // +X 是水平的（up 和 forward 张成的平面的法线）
      expect(Math.abs(new Vector3(1, 0, 0).rotate(q).y)).toBeLessThan(1e-6);
    }
  });

  test('Quaternion.setYawPitchRoll 先 roll（Z）再 pitch（X）再 yaw（Y），同 Stride 的 RotationYawPitchRoll', () => {
    const [yaw, pitch, roll] = [0.7, -0.4, 0.25];
    const q = new Quaternion().setYawPitchRoll(yaw, pitch, roll);
    const expected = new Quaternion().setAxisAngle({ x: 0, y: 1, z: 0 }, yaw)
      .multiply(new Quaternion().setAxisAngle({ x: 1, y: 0, z: 0 }, pitch))
      .multiply(new Quaternion().setAxisAngle({ x: 0, y: 0, z: 1 }, roll));
    for (const key of ['x', 'y', 'z', 'w'] as const) expect(q[key]).toBeCloseTo(expected[key], 6);
  });

  test('Quaternion.betweenDirections 把 source 转到 target；方向相反时转 180°', () => {
    for (const [source, target] of [[{ x: 0, y: 1, z: 0 }, { x: 0.3, y: 0.2, z: -2 }], [{ x: 1, y: 0, z: 0 }, { x: -1, y: 0, z: 0 }], [{ x: 0, y: 2, z: 0 }, { x: 0, y: 1, z: 0 }]] as const) {
      const q = Quaternion.betweenDirections(source, target);
      expect(Math.hypot(q.x, q.y, q.z, q.w)).toBeCloseTo(1, 6);
      const rotated = new Vector3().copy(source).normalize().rotate(q);
      expect(rotated.subtract(new Vector3().copy(target).normalize()).length()).toBeLessThan(1e-6);
    }
  });

  test('Quaternion.slerp 走短的一边：0° 到 90° 的一半是 45°；目标取反（同一个旋转）结果一样', () => {
    const y = { x: 0, y: 1, z: 0 };
    const to = new Quaternion().setAxisAngle(y, Math.PI / 2);
    const half = new Quaternion().slerp(to, 0.5);
    const expected = new Quaternion().setAxisAngle(y, Math.PI / 4);
    expect([half.x, half.y, half.z, half.w].map((c, i) => c - [expected.x, expected.y, expected.z, expected.w][i]!).every((d) => Math.abs(d) < 1e-6)).toBe(true);
    const flipped = new Quaternion().slerp({ x: -to.x, y: -to.y, z: -to.z, w: -to.w }, 0.5);
    expect(Math.abs(flipped.y - half.y) < 1e-6 && Math.abs(flipped.w - half.w) < 1e-6).toBe(true);
  });

  test('Quaternion.toEulerXYZ（Stride 的 RotationEulerXYZ）：单轴的旋转拆回那个角，绕 Y 的角就是偏航；±90° 时 X 取 0', () => {
    const about = (axis: 'x' | 'y' | 'z', radians: number) => new Quaternion().setAxisAngle({ x: 0, y: 0, z: 0, [axis]: 1 }, radians);
    const rounded = (v: Vector3) => [v.x, v.y, v.z].map((n) => Math.round(n * 1e5) / 1e5 + 0);
    expect(rounded(about('x', 0.4).toEulerXYZ())).toEqual([0.4, 0, 0]);
    expect(rounded(about('y', -1.2).toEulerXYZ())).toEqual([0, -1.2, 0]);
    expect(rounded(about('z', 2).toEulerXYZ())).toEqual([0, 0, 2]);
    // 先绕 X 再绕 Y：Y 在外面
    expect(rounded(about('y', 0.5).multiply(about('x', 0.3)).toEulerXYZ())).toEqual([0.3, 0.5, 0]);
    expect(rounded(about('y', Math.PI / 2).toEulerXYZ())).toEqual([0, Math.round((Math.PI / 2) * 1e5) / 1e5, 0]);
  });

  test('Quaternion.lerp（Stride 的 Lerp）：线性插值再归一化，对称的一半和 slerp 一样，四分之一不一样；目标取反结果一样', () => {
    const y = { x: 0, y: 1, z: 0 };
    const to = new Quaternion().setAxisAngle(y, Math.PI / 2);
    const half = new Quaternion().lerp(to, 0.5);
    expect(Math.abs(half.y - Math.sin(Math.PI / 8)) < 1e-6 && Math.abs(Math.hypot(half.x, half.y, half.z, half.w) - 1) < 1e-6).toBe(true);
    const quarter = new Quaternion().lerp(to, 0.25), slerped = new Quaternion().slerp(to, 0.25);
    expect(Math.abs(quarter.y - slerped.y)).toBeGreaterThan(1e-4);
    const flipped = new Quaternion().lerp({ x: -to.x, y: -to.y, z: -to.z, w: -to.w }, 0.5);
    expect(Math.abs(flipped.y - half.y) < 1e-6 && Math.abs(flipped.w - half.w) < 1e-6).toBe(true);
  });
});

describe('C# 风格的数值文字（DebugText 打印用）', () => {
  test('float 是能还原成同一个 float32 的最短写法，指数不大于 -5、不小于 15 用科学计数法；向量、颜色、bool 同 Stride、C#', () => {
    expect([5.6, 10, 0.1, 1 / 3, 0.000012, 1e-6, 1e15, -2.5, 0].map((v) => formatFloat(v))).toEqual(['5.6', '10', '0.1', '0.33333334', '1.2E-05', '1E-06', '1E+15', '-2.5', '0']);
    expect(formatVector({ x: 1, y: 2, z: 3 })).toBe('X:1 Y:2 Z:3');
    expect(formatVector({ x: 0.5, y: 0 })).toBe('X:0.5 Y:0');
    expect(formatColor([1, 0, 0, 1])).toBe('#FFFF0000');
    expect([formatBool(true), formatBool(false)]).toEqual(['True', 'False']);
  });
});
