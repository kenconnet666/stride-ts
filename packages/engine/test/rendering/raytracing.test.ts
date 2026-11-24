import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createStrideNative, type StrideNative } from '@stride-ts/native';
import { RayTracingScene, RT_EMITTER_WORDS, emitterTable, type Emitter } from '../../src/rendering/raytracing/RayTracingScene';
import { fakeGpu, stubGpuGlobals } from '../fakeGpu';

/** Möller–Trumbore（两面都算），没打到是 Infinity。 */
function intersect(o: number[], d: number[], v0: number[], e1: number[], e2: number[]): number {
  const p = [d[1]! * e2[2]! - d[2]! * e2[1]!, d[2]! * e2[0]! - d[0]! * e2[2]!, d[0]! * e2[1]! - d[1]! * e2[0]!];
  const det = e1[0]! * p[0]! + e1[1]! * p[1]! + e1[2]! * p[2]!;
  if (Math.abs(det) < 1e-12) return Infinity;
  const inv = 1 / det, s = [o[0]! - v0[0]!, o[1]! - v0[1]!, o[2]! - v0[2]!];
  const u = (s[0]! * p[0]! + s[1]! * p[1]! + s[2]! * p[2]!) * inv;
  if (u < 0 || u > 1) return Infinity;
  const q = [s[1]! * e1[2]! - s[2]! * e1[1]!, s[2]! * e1[0]! - s[0]! * e1[2]!, s[0]! * e1[1]! - s[1]! * e1[0]!];
  const v = (d[0]! * q[0]! + d[1]! * q[1]! + d[2]! * q[2]!) * inv;
  if (v < 0 || u + v > 1) return Infinity;
  const t = (e2[0]! * q[0]! + e2[1]! * q[1]! + e2[2]! * q[2]!) * inv;
  return t > 1e-6 ? t : Infinity;
}

/**
 * 按 GPU 上同样的布局遍历：4 叉的节点 32 个 32 位（4 个子节点的最小 x、y、z，最大 x、y、z 各 4 个，子节点 4 个，图元数 4 个；空的子节点
 * 盒子是反的），三角形是 v0 加两条边。返回最近的交点和原来的三角形下标。
 */
function traverse(nodes: Uint32Array, triangles: Float32Array, o: number[], d: number[]): { t: number; triangle: number } {
  const f = new Float32Array(nodes.buffer, nodes.byteOffset, nodes.length);
  const words = new Uint32Array(triangles.buffer, triangles.byteOffset, triangles.length);
  let best = { t: Infinity, triangle: -1 };
  const stack = [0];
  // 布局对不上时下标会指回去、死循环：同步的循环 vitest 的超时打断不了，自己限步数
  for (let steps = 0; stack.length > 0; steps++) {
    if (steps > 100_000) throw new Error('BVH traversal did not finish: node layout does not match');
    const at = stack.pop()! * 32;
    for (let c = 0; c < 4; c++) {
      if (f[at + c]! > f[at + 12 + c]!) continue;
      let tmin = 0, tmax = best.t;
      for (let axis = 0; axis < 3; axis++) {
        const inv = 1 / d[axis]!;
        let t0 = (f[at + axis * 4 + c]! - o[axis]!) * inv, t1 = (f[at + 12 + axis * 4 + c]! - o[axis]!) * inv;
        if (t0 > t1) [t0, t1] = [t1, t0];
        tmin = Math.max(tmin, t0);
        tmax = Math.min(tmax, t1);
      }
      if (tmin > tmax) continue;
      const child = nodes[at + 24 + c]!, count = nodes[at + 28 + c]!;
      if (count === 0) {
        stack.push(child);
        continue;
      }
      for (let i = child; i < child + count; i++) {
        const v = (k: number) => [triangles[i * 12 + k]!, triangles[i * 12 + k + 1]!, triangles[i * 12 + k + 2]!];
        const t = intersect(o, d, v(0), v(4), v(8));
        if (t < best.t) best = { t, triangle: words[i * 12 + 3]! };
      }
    }
  }
  return best;
}

describe('光追的 BVH（原生建，GPU 的布局）', () => {
  let native: StrideNative;
  beforeAll(async () => {
    native = await createStrideNative({ workerThreads: 2 });
  });
  afterAll(() => native?.shutdown());

  test('随机的三角形：按 BVH 遍历和挨个求交得到同一个最近的三角形', async () => {
    let seed = 3;
    const random = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296;
    const count = 2000, positions = new Float32Array(count * 9), indices = new Uint32Array(count * 3);
    for (let t = 0; t < count; t++) {
      const c = [random() * 40 - 20, random() * 40 - 20, random() * 40 - 20];
      for (let k = 0; k < 3; k++) {
        positions.set([c[0]! + random() * 2, c[1]! + random() * 2, c[2]! + random() * 2], (t * 3 + k) * 3);
        indices[t * 3 + k] = t * 3 + k;
      }
    }
    const { nodes, triangles, nodeCount } = await native.buildTriangleBvh(positions, indices);
    expect(nodeCount).toBeLessThan(count);
    let hits = 0;
    for (let r = 0; r < 300; r++) {
      const o = [random() * 60 - 30, random() * 60 - 30, -40];
      const d = [random() - 0.5, random() - 0.5, 1];
      const length = Math.hypot(...d);
      const dir = d.map((x) => x / length);
      let brute = { t: Infinity, triangle: -1 };
      for (let t = 0; t < count; t++) {
        const v = (k: number) => [0, 1, 2].map((c) => positions[indices[t * 3 + k]! * 3 + c]!);
        const v0 = v(0), e1 = v(1).map((x, c) => x - v0[c]!), e2 = v(2).map((x, c) => x - v0[c]!);
        const hit = intersect(o, dir, v0, e1, e2);
        if (hit < brute.t) brute = { t: hit, triangle: t };
      }
      const found = traverse(nodes, triangles, o, dir);
      // 两个三角形在同一点上被打中（平局）时哪个都算：比距离
      expect(found.t).toBeCloseTo(brute.t, 4);
      if (found.triangle >= 0) {
        hits++;
      }
    }
    expect(hits).toBeGreaterThan(10);
  });

  test('包围盒的 BVH：每个盒子在一个叶子里，叶子最多两个', async () => {
    const boxes = new Float32Array(Array.from({ length: 50 }, (_, i) => [i * 3, 0, 0, i * 3 + 1, 1, 1]).flat());
    const { nodes, order, nodeCount } = await native.buildBoxBvh(boxes);
    expect([...order].sort((a, b) => a - b)).toEqual(Array.from({ length: 50 }, (_, i) => i));
    for (let n = 0; n < nodeCount; n++) for (let c = 0; c < 4; c++) expect(nodes[n * 32 + 28 + c]!).toBeLessThanOrEqual(2);
  });
});

describe('发光体表（RayTracedEmissive 抽样用）', () => {
  test('每项是世界矩阵的三行、三角形的范围、实例，累积分布按功率、最后一项是 1', () => {
    // 两个实例：第 0 个在原点不动，第 1 个平移 (1, 2, 3)、x 放大 2 倍（列主序的 4×4）
    const world = new Float32Array(32);
    world.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], 0);
    world.set([2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 2, 3, 1], 16);
    const emitters = [
      { instance: 4, slot: 0, blas: { triangleOffset: 10, triangles: 2 }, power: 1 },
      { instance: 7, slot: 1, blas: { triangleOffset: 30, triangles: 5 }, power: 3 },
    ] as unknown as Emitter[];
    const table = emitterTable(world, emitters);
    const words = new Uint32Array(table.buffer);
    expect(table.length).toBe(2 * RT_EMITTER_WORDS);
    const second = RT_EMITTER_WORDS;
    // 网格坐标到世界：x' = 2x + 1，y' = y + 2，z' = z + 3
    expect([...table.subarray(second, second + 12)]).toEqual([2, 0, 0, 1, 0, 1, 0, 2, 0, 0, 1, 3]);
    expect([words[12], words[13], words[14]]).toEqual([10, 2, 4]);
    expect([words[second + 12], words[second + 13], words[second + 14]]).toEqual([30, 5, 7]);
    expect(table[15]).toBeCloseTo(0.25);
    expect(table[second + 15]).toBe(1);
  });
});

describe('光追场景（RayTracingScene）', () => {
  let native: StrideNative;
  beforeAll(async () => {
    stubGpuGlobals();
    native = await createStrideNative({ workerThreads: 2 });
  });
  afterAll(() => native?.shutdown());

  /** 一个三角形的网格的批（只给 RayTracingScene 读的字段）。 */
  const triangleBatch = () => ({
    mesh: { id: 1, name: 'triangle', data: { indices: [0, 1, 2] }, positions: () => new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), heightfield: false, impostor: false, cullBounds: { min: [0, 0, 0], max: [1, 1, 0] } },
    material: { id: 1, version: 0, isTransparent: false, doubleSided: false, baseColor: { r: 1, g: 1, b: 1 }, emissive: [0, 0, 0] },
    count: 1,
    slots: [0],
    skinned: false,
    visibleInRayTracing: true,
  });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

  test('没有能光追的实例时不给绑定组：空的 BVH 的根在 GPU 上会当成指回自己的内部节点，遍历死循环把显卡卡到驱动重置', async () => {
    const { device } = fakeGpu();
    const scene = new RayTracingScene(device);
    const game = { frames: 0, meshes: { batches: [] as unknown[], warm: () => Promise.resolve() }, transforms: { changedSlots: () => [], renderWorld: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) }, native };
    // 每次是新的一帧（一帧里只更新一次）
    const update = () => {
      game.frames++;
      scene.update(game as never);
    };
    update();
    await settle();
    update();
    expect(scene.bindGroup).toBeUndefined();
    expect(scene.ready).toBe(false);

    // 有了一个三角形：建好 BLAS、TLAS 以后有绑定组
    game.meshes.batches = [triangleBatch()];
    for (let i = 0; i < 4; i++) {
      update();
      await settle();
    }
    expect(scene.instanceCount).toBe(1);
    expect(scene.bindGroup).toBeDefined();

    // 关了进光追场景（Model.visibleInRayTracing）的批不算
    game.meshes.batches = [triangleBatch(), { ...triangleBatch(), visibleInRayTracing: false }];
    update();
    await settle();
    expect(scene.instanceCount).toBe(1);
    game.meshes.batches = [triangleBatch()];

    // 又没了：绑定组撤掉（不拿旧的或者空的 TLAS 去遍历）
    game.meshes.batches = [];
    update();
    expect(scene.instanceCount).toBe(0);
    expect(scene.bindGroup).toBeUndefined();
  });
});
