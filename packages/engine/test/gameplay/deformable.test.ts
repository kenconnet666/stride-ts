import { createStrideNative, type StrideNative } from '@stride-ts/native';
import { physics } from '@stride-ts/native/physics';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Body, Collider, Deformable, Game, Mesh, Model, Simulation, Static, subdivideMesh, Transform } from '../../src';

let native: StrideNative;

beforeAll(async () => {
  native = await createStrideNative({ workerThreads: 1, features: [physics] });
});

afterAll(() => native?.shutdown());

function run(game: Game & { simulation: Simulation }, frames: number): void {
  for (let i = 0; i < frames; i++) {
    game.updateTime.advance(1 / 60);
    game.entities.update(game.updateTime, (time) => game.simulation.update(time));
    game.transforms.update();
  }
}

describe('撞了会瘪', () => {
  test('细分：每条边不超过给定长度，面积不变，共用的边中点只建一个', () => {
    // 一个 1 米的直角三角形，每个顶点 3 个数（只有位置）
    const { vertices, indices } = subdivideMesh(Float32Array.of(0, 0, 0, 1, 0, 0, 0, 1, 0), Uint32Array.of(0, 1, 2), 0.3, 3);
    let area = 0, longest = 0;
    for (let t = 0; t < indices.length; t += 3) {
      const [a, b, c] = [0, 1, 2].map((k) => Array.from(vertices.subarray(indices[t + k]! * 3, indices[t + k]! * 3 + 3)));
      area += Math.abs((b![0]! - a![0]!) * (c![1]! - a![1]!) - (c![0]! - a![0]!) * (b![1]! - a![1]!)) / 2;
      for (const [p, q] of [[a, b], [b, c], [c, a]]) longest = Math.max(longest, Math.hypot(p![0]! - q![0]!, p![1]! - q![1]!));
    }
    expect(longest).toBeLessThanOrEqual(0.3);
    expect(area).toBeCloseTo(0.5, 9);
    // 细分了 3 次：64 个三角形，顶点（三角形网格的）45 个
    expect(indices.length / 3).toBe(64);
    expect(vertices.length / 3).toBe(45);
  });

  test('箱子从 3 米落地：底面附近的顶点往上推，网格是这个实体自己的（同一个模型的别的实例不变）；轻轻放下不瘪', async () => {
    const game = new Game();
    game.native = native;
    game.transforms = native.createTransforms(64);
    game.simulation = new Simulation(native, game.transforms, game.entities, 64);
    const simulation = game as Game & { simulation: Simulation };
    const cube = await game.content.createProceduralModel({ type: 'cube' }, [null], 'crate');
    game.entities.create({ name: 'Ground', components: [Transform.with({ position: [0, -0.5, 0] }), Static.with({ collider: new Collider([{ type: 'box', size: [20, 1, 20] }]).id })] });
    const drop = (name: string, height: number, x: number) => {
      const crate = game.entities.create({ name, components: [Transform.with({ position: [x, 0.5 + height, 0] }), Body.with({ collider: new Collider([{ type: 'box', size: [1, 1, 1], mass: 20 }]).id })] });
      game.content.addModel(crate, cube);
      return crate;
    };
    const high = drop('High', 3, 0), low = drop('Low', 0.02, 3), plain = drop('Plain', 0, 6);
    game.transforms.update();
    high.add({ script: Deformable, init: { subdivide: 0.1, radius: 0.6 } });
    low.add({ script: Deformable, init: { subdivide: 0.1 } });
    run(simulation, 90);
    const dented = high.require(Deformable);
    expect(dented.dents).toBeGreaterThanOrEqual(1);
    expect(dented.deepest).toBeGreaterThan(0.02);
    const mesh = Mesh.byId(high.require(Model).mesh)!;
    expect(mesh.dynamic).toBe(true);
    expect(mesh).not.toBe(cube.meshes[0]!.mesh);
    // 底面中间（接触点附近）的顶点被推上去，四个角（在影响半径的边上）几乎不动
    const v = mesh.data.vertices as Float32Array, stride = mesh.vertexStride / 4;
    let centre = Infinity;
    for (let i = 0; i < v.length; i += stride) if (Math.abs(v[i]!) < 0.15 && Math.abs(v[i + 2]!) < 0.15 && v[i + 1]! < 0) centre = Math.min(centre, v[i + 1]!);
    expect(centre).toBeGreaterThan(-0.5 + 0.03);
    expect(mesh.bounds.min[1]).toBeLessThan(-0.49);
    expect(low.require(Deformable).dents).toBe(0);
    expect(Mesh.byId(plain.require(Model).mesh)!.bounds.min[1]).toBeCloseTo(-0.5, 6);
  });
});
