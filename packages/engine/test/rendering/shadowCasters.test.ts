import { describe, expect, test } from 'vitest';
import { ShadowCasters } from '../../src/rendering/mesh/ShadowCasters';
import type { MeshBatch } from '../../src/rendering/mesh/MeshRenderFeature';

/** 槽位 slot 的世界矩阵是平移到 (x, 0, 0)。 */
function worlds(positions: Record<number, number>) {
  const renderWorld = new Float32Array(16 * 8);
  for (let slot = 0; slot < 8; slot++) {
    renderWorld.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, positions[slot] ?? 0, 0, 0, 1], slot * 16);
  }
  return { renderWorld };
}

/** 一批单位方块（-0.5..0.5）的投影者。 */
function batch(slots: number[], dynamic = false): MeshBatch {
  return {
    ready: true, isShadowCaster: true, dynamic, slots: Uint32Array.from(slots), count: slots.length,
    mesh: { cullBounds: { min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] } },
    material: { version: 0 },
    bounds: { min: new Float64Array([Infinity, Infinity, Infinity]), max: new Float64Array([-Infinity, -Infinity, -Infinity]), dirty: false, slots: new Uint32Array(0) },
  } as unknown as MeshBatch;
}

/** regions 里每块的中心 x。 */
const centers = (boxes: readonly number[]) => Array.from({ length: boxes.length / 6 }, (_, i) => (boxes[i * 6]! + boxes[i * 6 + 3]!) / 2);

describe('ShadowCasters', () => {
  test('第一次见到的静态投影者都报；没变就不报', () => {
    const casters = new ShadowCasters(), b = batch([1, 2]);
    const w = worlds({ 1: 10, 2: 20 });
    expect(centers(casters.track([b], w, 1, () => false).regions)).toEqual([10, 20]);
    expect(casters.track([b], w, 2, () => false).regions).toEqual([]);
  });

  test('一个实例开始动（离开静态批）：按它在静态层里的旧位置报；停下来回到静态批：按新位置报', () => {
    const casters = new ShadowCasters(), still = batch([1, 2]);
    casters.track([still], worlds({ 1: 10, 2: 20 }), 1, () => false);
    // 槽位 2 挪到 25，进了动态的批
    const moving = batch([2], true);
    still.count = 1;
    const frame = casters.track([still, moving], worlds({ 1: 10, 2: 25 }), 2, (x) => x.dynamic);
    expect(centers(frame.regions)).toEqual([20]);
    expect(frame.dynamic).toHaveLength(6);
    // 停下：回到静态批
    still.slots = Uint32Array.from([1, 2]);
    still.count = 2;
    moving.count = 0;
    expect(centers(casters.track([still, moving], worlds({ 1: 10, 2: 25 }), 3, (x) => x.dynamic).regions)).toEqual([25]);
  });

  test('材质改了：整批的新旧都报；批没了：它的都报', () => {
    const casters = new ShadowCasters(), b = batch([3]);
    casters.track([b], worlds({ 3: 5 }), 1, () => false);
    (b.material as { version: number }).version = 1;
    expect(centers(casters.track([b], worlds({ 3: 5 }), 2, () => false).regions)).toEqual([5, 5]);
    expect(centers(casters.track([], worlds({ 3: 5 }), 3, () => false).regions)).toEqual([5]);
  });

  test('同一次更新里再调直接返回上次的', () => {
    const casters = new ShadowCasters(), b = batch([1]);
    const first = casters.track([b], worlds({ 1: 1 }), 7, () => false).regions.length;
    expect(casters.track([b], worlds({ 1: 1 }), 7, () => false).regions.length).toBe(first);
  });
});
