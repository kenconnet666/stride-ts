import { createStrideNative, type StrideNative } from '@stride-ts/native';
import { physics } from '@stride-ts/native/physics';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Collider, Game, Mesh, Model, Simulation, SoftBody, Static, Transform, weldModel } from '../../src';

let native: StrideNative;

beforeAll(async () => {
  native = await createStrideNative({ workerThreads: 1, features: [physics] });
});

afterAll(() => native?.shutdown());

describe('软体', () => {
  test('焊顶点：球的接缝上重复的顶点焊成一个，三角形里没有退化的', async () => {
    const game = new Game();
    const sphere = await game.content.createProceduralModel({ type: 'sphere', tessellation: 16 }, [null], 'ball');
    const { positions, indices, welded } = weldModel(sphere);
    const raw = sphere.meshes[0]!.mesh.vertexCount;
    expect(positions.length / 3).toBeLessThan(raw);
    expect(welded[0]!.length).toBe(raw);
    for (let t = 0; t < indices.length; t += 3) expect(new Set([indices[t], indices[t + 1], indices[t + 2]]).size).toBe(3);
  });

  test('充了气的球落地还是圆的、没充气的瘪下去；画的网格是动态的，脚本去掉时一起没了', async () => {
    const game = new Game();
    game.native = native;
    game.transforms = native.createTransforms(64);
    game.simulation = new Simulation(native, game.transforms, game.entities, 64);
    const simulation = game as Game & { simulation: Simulation };
    game.entities.create({ name: 'Ground', components: [Transform.with({ position: [0, -0.5, 0] }), Static.with({ collider: new Collider([{ type: 'box', size: [20, 1, 20] }]).id })] });
    const sphere = await game.content.createProceduralModel({ type: 'sphere', tessellation: 16 }, [null], 'ball');
    const inflated = game.entities.create({ name: 'Inflated', components: [Transform.with({ position: [0, 1.5, 0] })] });
    const flat = game.entities.create({ name: 'Flat', components: [Transform.with({ position: [3, 1.5, 0] })] });
    game.transforms.update();
    inflated.add({ script: SoftBody, init: { model: sphere, pressure: 500, mass: 0.5 } });
    flat.add({ script: SoftBody, init: { model: sphere, pressure: 0, mass: 0.5, stretch: 0.001, bend: 0.1 } });
    for (let i = 0; i < 180; i++) {
      game.updateTime.advance(1 / 60);
      game.entities.update(game.updateTime, (time) => simulation.simulation.update(time));
      game.transforms.update();
      await Promise.resolve();
    }
    const height = (entity: typeof flat) => {
      const mesh = Mesh.byId(entity.require(SoftBody).surface!.require(Model).mesh)!;
      expect(mesh.dynamic).toBe(true);
      return mesh.bounds.max[1] - mesh.bounds.min[1];
    };
    // 直径 1 米的球
    expect(height(inflated)).toBeGreaterThan(0.75);
    expect(height(flat)).toBeLessThan(height(inflated) - 0.2);
    const surface = inflated.require(SoftBody).surface!;
    inflated.remove(SoftBody);
    expect(surface.alive).toBe(false);
  });
});
