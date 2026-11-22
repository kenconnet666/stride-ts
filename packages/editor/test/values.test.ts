import { describe, expect, test } from 'vitest';
import { hasMixed, PROPERTY_MIXED as MIXED } from '@zerodep-dev/vue-tsx-pro-ui';
import { ENTITY_FIELDS, COMPONENT_FIELDS } from '@stride-ts/engine/editor-fields';
import { eulerToQuaternion, mergeField, mergeValues, MixedRotation, quaternionToEuler } from '../src/ui/fields/values.ts';

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

describe('多选：几个实体的值并成一个', () => {
  test('一样的照原样，向量、对象逐项并，不一样的是 MIXED', () => {
    expect(mergeValues([[1, 2, 3]])).toEqual([1, 2, 3]);
    expect(mergeValues([[1, 2, 3], [1, 5, 3]])).toEqual([1, MIXED, 3]);
    expect(mergeValues([{ model: 'A', materials: [null] }, { model: 'A', materials: [null, 'M'] }])).toEqual({ model: 'A', materials: MIXED });
    // 有的写了、有的没写（用默认值）
    expect(mergeValues([{ trigger: true }, {}])).toEqual({ trigger: MIXED });
    expect(mergeValues([undefined, undefined])).toBeUndefined();
    expect(mergeValues([0, '0'])).toBe(MIXED);
    expect([hasMixed({ a: [1, MIXED] }), hasMixed({ a: [1, 2] }), hasMixed(MIXED)]).toEqual([true, false, true]);
  });
});

describe('多选时照字段类型并（mergeField）', () => {
  const rotation = ENTITY_FIELDS.find((field) => field.name === 'rotation')!.type;

  test('旋转按欧拉角逐个角并：只有绕 Y 不一样时另外两个角照常显示；一样时原样', () => {
    const a = eulerToQuaternion([10, 20, 30]), b = eulerToQuaternion([10, 70, 30]);
    const merged = mergeField([a, b], rotation);
    expect(merged).toBeInstanceOf(MixedRotation);
    expect((merged as MixedRotation).euler).toEqual([10, MIXED, 30]);
    expect(mergeField([a, [...a]], rotation)).toEqual(a);
  });

  test('往里照类型走：碰撞体形状列表里的旋转也按角并；没描述的、有的没写的同 mergeValues', () => {
    const shape = (angles: number[], size: number) => ({ type: 'box', position: [0, 0, 0], rotation: eulerToQuaternion(angles), mass: 1, size: [size, 1, 1] });
    const merged = mergeField([{ shapes: [shape([0, 0, 45], 1)] }, { shapes: [shape([0, 0, 90], 2)] }], COMPONENT_FIELDS.static.type) as { shapes: Record<string, unknown>[] };
    expect((merged.shapes[0]!.rotation as MixedRotation).euler).toEqual([0, 0, MIXED]);
    expect(merged.shapes[0]!.size).toEqual([MIXED, 1, 1]);
    expect(hasMixed(mergeField([1, 2], { kind: 'json' }))).toBe(true);
  });
});
