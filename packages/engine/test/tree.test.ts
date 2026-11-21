import { describe, expect, test } from 'vitest';
import type { TreeFile } from '../src/content/treeFormat';
import { checkTree, treeMeshes } from '../src/modeling/tree';

const oak: TreeFile = {
  name: 'Oak', materials: [null, null], seed: 4,
  levels: [
    { length: 8, radius: 0.35, children: 6, sections: 10, segments: 8, gnarliness: 0.05 },
    { length: 5, radius: 0.5, angle: 50, start: 0.4, children: 4, sections: 6, segments: 5 },
    { length: 2, radius: 0.5, angle: 40, start: 0.2, sections: 4, segments: 3 },
  ],
  leaves: { count: 5, size: 1.2 },
  growth: { direction: [0, 1, 0], strength: 0.002 },
};
const verts = (v: Float32Array) => Array.from({ length: v.length / 8 }, (_, i) => Array.from(v.slice(i * 8, i * 8 + 8)));

describe('参数化的树', () => {
  test('两个槽：树皮（1 + 6 + 24 根枝的圆管）、叶片（24 根细枝 × 5 片 × 两张卡片 × 4 个顶点）', () => {
    const [bark, leaves] = treeMeshes(oak);
    expect(bark!.material).toBe(0);
    expect(leaves!.material).toBe(1);
    // 每根枝 (sections + 1) 圈、每圈 segments + 1 个顶点
    expect(bark!.vertices.length / 8).toBe(11 * 9 + 6 * 7 * 6 + 24 * 5 * 4);
    expect(leaves!.vertices.length / 8).toBe(24 * 5 * 2 * 4);
    // 树根在原点附近，往上长
    const ys = verts(bark!.vertices).map((v) => v[1]!);
    expect(Math.min(...ys)).toBeGreaterThan(-0.5);
    expect(Math.max(...ys)).toBeGreaterThan(8);
  });

  test('同一个种子长出同一棵树，换种子长出另一棵；三角形朝着法线', () => {
    const [a] = treeMeshes(oak), [b] = treeMeshes(oak), [c] = treeMeshes({ ...oak, seed: 5 });
    expect(a!.vertices).toEqual(b!.vertices);
    expect(a!.vertices).not.toEqual(c!.vertices);
    const v = verts(a!.vertices), idx = a!.indices;
    for (let i = 0; i < idx.length; i += 3) {
      const [p, q, r] = [v[idx[i]!]!, v[idx[i + 1]!]!, v[idx[i + 2]!]!];
      const e1 = [q[0]! - p[0]!, q[1]! - p[1]!, q[2]! - p[2]!], e2 = [r[0]! - p[0]!, r[1]! - p[1]!, r[2]! - p[2]!];
      const n = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!];
      expect(n[0]! * p[3]! + n[1]! * p[4]! + n[2]! * p[5]!).toBeGreaterThanOrEqual(-1e-6);
    }
  });

  test('针叶树：树干收到梢，侧枝越往上越短', () => {
    const { leaves: _, ...bare } = oak;
    const pine: TreeFile = { ...bare, shape: 'conifer', levels: [{ ...oak.levels[0]!, children: 20 }, { length: 4, radius: 0.4, angle: 80, start: 0.15, sections: 4, segments: 4 }] };
    const [bark] = treeMeshes(pine);
    const v = verts(bark!.vertices);
    // 树干的最后一圈半径是 0：顶点都在中轴上
    const top = v.slice(10 * 9, 11 * 9);
    expect(Math.max(...top.map((p) => Math.hypot(p[0]! - top[0]![0]!, p[2]! - top[0]![2]!)))).toBeLessThan(1e-6);
    // 侧枝（每根 5 圈 × 5 个顶点）：低处的伸得比高处的远
    const branches = Array.from({ length: 20 }, (_, i) => v.slice(99 + i * 25, 99 + (i + 1) * 25));
    const reach = branches.map((b) => ({ y: b[0]![1]!, out: Math.hypot(b.at(-1)![0]!, b.at(-1)![2]!) }));
    const low = reach.filter((r) => r.y < 3), high = reach.filter((r) => r.y > 6);
    expect(Math.max(...high.map((r) => r.out))).toBeLessThan(Math.min(...low.map((r) => r.out)));
  });

  test('文件检查', () => {
    expect(() => checkTree({ ...oak, levels: [] })).toThrow('levels needs 1 to 4 levels');
    expect(() => checkTree({ ...oak, levels: [{ length: 1, radius: 0.1 }, { length: 1, radius: 0.5 }] })).toThrow('levels[0].children must be a whole number');
  });
});
