import { describe, expect, test } from 'vitest';
import { backToFrontRuns, sortBackToFront } from '../src/rendering/mesh/transparentOrder';

/** 每个槽位一个只有平移的世界矩阵：物体在 z 轴上的位置。 */
const worldAt = (...zs: number[]) => {
  const world = new Float32Array(zs.length * 16);
  zs.forEach((z, slot) => world.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, z, 1], slot * 16));
  return world;
};
const EYE = { x: 0, y: 0, z: 10 };

describe('透明实例的先后', () => {
  test('一批的实例原地从远到近排；距离一样的按槽位', () => {
    // 槽位 0..4 的物体在 z = 5、-3、8、-3、0
    const world = worldAt(5, -3, 8, -3, 0);
    const slots = Uint32Array.of(0, 1, 2, 3, 4);
    sortBackToFront(slots, world, EYE);
    expect([...slots]).toEqual([1, 3, 4, 0, 2]);
  });

  test('两批的实例交错时拆成几段，同一批里连着的并成一段', () => {
    // 批 0（槽位 0、1、2）在 z = -6、-4、4；批 1（槽位 3、4）在 z = -5、6：从远到近是 0、3、1、2、4
    const world = worldAt(-6, -4, 4, -5, 6);
    const visibleSlots = Uint32Array.of(0, 1, 2, 3, 4);
    const runs = backToFrontRuns([{ batch: 0, start: 0, count: 3 }, { batch: 1, start: 3, count: 2 }], visibleSlots, world, EYE);
    // 每段：批、起点、个数
    expect(runs).toEqual([0, 0, 1, 1, 0, 1, 0, 1, 2, 1, 1, 1]);
  });

  test('不交错的两批各一段；没有实例时是空的', () => {
    const world = worldAt(-6, -5, 3, 4);
    const runs = backToFrontRuns([{ batch: 2, start: 2, count: 2 }, { batch: 5, start: 0, count: 2 }], Uint32Array.of(0, 1, 2, 3), world, EYE);
    expect(runs).toEqual([5, 0, 2, 2, 0, 2]);
    expect(backToFrontRuns([], Uint32Array.of(), world, EYE)).toEqual([]);
  });
});
