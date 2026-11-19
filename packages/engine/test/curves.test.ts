import { describe, expect, test } from 'vitest';
import { evaluateCurve, propertyCurve, PropertyStack } from '../src/animation/curves';
import { Transform } from '../src/engine/transform';
import { Light } from '../src/rendering/components';

const rotationX = (angle: number) => [Math.sin(angle / 2), 0, 0, Math.cos(angle / 2)] as const;
const value = (curve: ReturnType<typeof propertyCurve>, time: number) => {
  const out = new Float32Array(curve.size);
  evaluateCurve(curve, time, out);
  return [...out];
};
/** 四元数绕 X 转了多少（0..2π）。 */
const angleX = ([x, , , w]: number[]) => (2 * Math.atan2(x!, w!) + 4 * Math.PI) % (2 * Math.PI);

describe('属性曲线', () => {
  test('数：线性插值，两端外取端点；constant 取前一个关键帧', () => {
    const linear = propertyCurve(Light, 'intensity', [[0, 1], [1, 3], [3, 7]]);
    expect([linear.size, linear.quaternion]).toEqual([1, false]);
    expect([-1, 0, 0.5, 1, 2, 3, 9].map((t) => value(linear, t)[0])).toEqual([1, 1, 2, 3, 5, 7, 7]);
    const constant = propertyCurve(Light, 'intensity', [[0, 1], [1, 3], [3, 7]], 'constant');
    expect([0.99, 1, 2.9, 3].map((t) => value(constant, t)[0])).toEqual([1, 3, 3, 7]);
  });

  test('三次插值是过四个点的 Catmull-Rom（Stride 的 Interpolator.Cubic）：经过关键帧，两头用端点补', () => {
    const curve = propertyCurve(Light, 'intensity', [[0, 0], [1, 1], [2, 4], [3, 9]], 'cubic');
    expect(value(curve, 1)[0]).toBeCloseTo(1, 6);
    expect(value(curve, 2)[0]).toBeCloseTo(4, 6);
    // 1..2 的中点：0.5 · (0 · -0.125 + 1 · 1.125 + 4 · 1.125 + 9 · -0.125) = 2.25（正好是 x² 的值）
    expect(value(curve, 1.5)[0]).toBeCloseTo(2.25, 6);
    // 第一段前面没有点，用第一个点自己
    expect(value(curve, 0.5)[0]).toBeCloseTo(0.5 * (0 * -0.125 + 0 * 1.125 + 1 * 1.125 + 4 * -0.125), 6);
  });

  test('四元数走球面上最短的弧：ParticlesSample 的旋转曲线（0、90、180、-90、360 度）插出来是匀速转一圈', () => {
    const curve = propertyCurve(Transform, 'rotation', [
      [0, rotationX(0)], [0.25, rotationX(Math.PI / 2)], [0.5, rotationX(Math.PI)], [0.75, rotationX(-Math.PI / 2)], [1, rotationX(2 * Math.PI)],
    ]);
    expect([curve.size, curve.quaternion]).toEqual([4, true]);
    for (const t of [0.1, 0.3, 0.6, 0.7, 0.9]) {
      const q = value(curve, t);
      expect(Math.hypot(...q)).toBeCloseTo(1, 5);
      expect(angleX(q)).toBeCloseTo(t * 2 * Math.PI, 4);
    }
  });

  test('向量、颜色按分量；关键帧的时刻要升序', () => {
    const position = propertyCurve(Transform, 'position', [[0, [0, 0, 0]], [2, [2, 4, 6]]]);
    expect(value(position, 1)).toEqual([1, 2, 3]);
    const color = propertyCurve(Light, 'color', [[0, [1, 0, 0, 1]], [1, [0, 1, 0, 1]]]);
    expect([color.size, color.quaternion]).toEqual([4, false]);
    expect(value(color, 0.25)).toEqual([0.75, 0.25, 0, 1]);
    expect(() => propertyCurve(Light, 'intensity', [[1, 0], [0, 1]])).toThrow('not sorted');
  });
});

describe('PropertyStack', () => {
  const written = () => {
    const light = { intensity: 0, color: { r: 0, g: 0, b: 0, a: 0 } }, transform = { rotation: { x: 0, y: 0, z: 0, w: 1 } };
    const entity = { get: (type: unknown) => (type === Light ? light : type === Transform ? transform : undefined) } as never;
    return { light, transform, entity };
  };

  test('混合：两边都有的属性按系数插值（四元数走球面），只有一边有的取那一边', () => {
    const stack = new PropertyStack();
    stack.begin();
    stack.push([propertyCurve(Light, 'intensity', [[0, 2]]), propertyCurve(Transform, 'rotation', [[0, rotationX(0)]])], 0);
    stack.push([propertyCurve(Light, 'intensity', [[0, 6]]), propertyCurve(Transform, 'rotation', [[0, rotationX(Math.PI / 2)]]), propertyCurve(Light, 'color', [[0, [0.5, 0.25, 1, 1]]])], 0);
    stack.blend(0.25);
    const { light, transform, entity } = written();
    stack.apply(entity);
    expect(light.intensity).toBeCloseTo(3, 6);
    expect(light.color).toEqual({ r: 0.5, g: 0.25, b: 1, a: 1 });
    expect(angleX([transform.rotation.x, 0, 0, transform.rotation.w])).toBeCloseTo(Math.PI / 8, 5);
  });

  test('叠加：数相加，四元数接着转', () => {
    const stack = new PropertyStack();
    stack.begin();
    stack.push([propertyCurve(Light, 'intensity', [[0, 2]]), propertyCurve(Transform, 'rotation', [[0, rotationX(Math.PI / 2)]])], 0);
    stack.push([propertyCurve(Light, 'intensity', [[0, 6]]), propertyCurve(Transform, 'rotation', [[0, rotationX(Math.PI / 2)]])], 0);
    stack.add(0.5);
    const { light, transform, entity } = written();
    stack.apply(entity);
    expect(light.intensity).toBeCloseTo(5, 6);
    expect(angleX([transform.rotation.x, 0, 0, transform.rotation.w])).toBeCloseTo(Math.PI * 0.75, 5);
  });

  test('没有曲线的属性不动；实体没有那个组件的曲线跳过', () => {
    const stack = new PropertyStack();
    stack.begin();
    stack.push([propertyCurve(Light, 'intensity', [[0, 4]])], 0);
    const { light, transform, entity } = written();
    stack.apply(entity);
    expect(light.intensity).toBe(4);
    expect(transform.rotation).toEqual({ x: 0, y: 0, z: 0, w: 1 });
    stack.apply({ get: () => undefined } as never);
  });
});
