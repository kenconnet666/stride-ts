import { describe, expect, test } from 'vitest';
import { Matrix } from '../../src/data/Matrix';
import { loadPriority } from '../../src/world/WorldStreaming';

describe('读格子的优先级', () => {
  test('没有朝向时就是距离', () => {
    expect(loadPriority(100, undefined)).toBe(100);
  });

  test('正前方比同样远的侧面和身后先读', () => {
    const ahead = loadPriority(100, 1), side = loadPriority(100, 0), behind = loadPriority(100, -1);
    expect(ahead).toBeLessThan(side);
    expect(side).toBeLessThan(behind);
  });

  test('身后很近的比前方很远的先读（距离仍然是主要的）', () => {
    expect(loadPriority(40, -1)).toBeLessThan(loadPriority(150, 1));
  });
});

describe('相机朝向的约定', () => {
  test('逆视图矩阵的第三列取负是相机朝向（WorldStreaming 按它算前方）', () => {
    const view = new Float32Array(16), inverse = new Float32Array(16);
    Matrix.lookAtRH(view, [10, 5, 20], [10, 5, 120], [0, 1, 0]);
    expect(Matrix.invert(inverse, view)).toBe(true);
    expect(-inverse[8]!).toBeCloseTo(0, 5);
    expect(-inverse[10]!).toBeCloseTo(1, 5);
    expect([inverse[12], inverse[14]]).toEqual([10, 20]);
  });
});
