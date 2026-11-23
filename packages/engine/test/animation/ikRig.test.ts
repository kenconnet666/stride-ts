import { describe, expect, test } from 'vitest';
import { findLegs, kneePole, toJointLocal, worldToModel, type Skeleton } from '../../src';

/** 只有平移的关节矩阵（列主序 4x4）。 */
function matrices(positions: readonly (readonly number[])[]): Float32Array {
  const out = new Float32Array(positions.length * 16);
  positions.forEach((p, j) => out.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, p[0]!, p[1]!, p[2]!, 1], j * 16));
  return out;
}

describe('IK 的骨架几何', () => {
  // 髋、左右大腿根、膝（稍往前）、脚踝、脚尖（短骨），加一个脚下的辅助骨（名字带 platform，不算）
  const joints = [
    { name: 'pelvis', parent: -1 },
    { name: 'thigh_l', parent: 0 }, { name: 'calf_l', parent: 1 }, { name: 'ankle_l', parent: 2 }, { name: 'toe_l', parent: 3 },
    { name: 'thigh_r', parent: 0 }, { name: 'calf_r', parent: 5 }, { name: 'ankle_r', parent: 6 }, { name: 'toe_r', parent: 7 },
    { name: 'foot_platform_l', parent: 0 },
  ];
  const pose = matrices([
    [0, 1, 0],
    [-0.1, 0.95, 0], [-0.1, 0.5, 0.05], [-0.1, 0.08, 0], [-0.1, 0.02, 0.1],
    [0.1, 0.95, 0], [0.1, 0.5, 0.05], [0.1, 0.08, 0], [0.1, 0.02, 0.1],
    [-0.1, 0, 0],
  ]);

  test('按结构找腿：每边最低的关节往上找到长骨，辅助骨不算，两条大腿根的共同祖先是髋', () => {
    const found = findLegs({ joints } as unknown as Skeleton, pose)!;
    expect(found.hips).toBe(0);
    expect(found.legs.map((leg) => [leg.thigh, leg.knee, leg.foot])).toEqual([[1, 2, 3], [5, 6, 7]]);
    // 膝往前（+z）弯：转轴是 -x 附近（正方向把腿伸直）
    expect(found.legs[0].midAxis[0]).toBeLessThan(-0.99);
    expect(kneePole(pose, found.legs[0])[2]).toBeGreaterThan(0.99);
  });

  test('方向换到关节本地、世界换到模型空间', () => {
    // 关节绕 y 转了 90°：本地的 x 是模型的 -z
    const rotated = new Float32Array([0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1]);
    expect(toJointLocal(rotated, 0, [0, 0, -1]).map((v) => +v.toFixed(6))).toEqual([1, 0, 0]);
    const modelToWorld = Float64Array.from([2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 10, 0, 5, 1]);
    expect(worldToModel(modelToWorld, [12, 4, 5])).toEqual([1, 2, 0]);
  });
});
