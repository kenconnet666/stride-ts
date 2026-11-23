import { createStrideNative, type StrideNative } from '@stride-ts/native';
import { physics } from '@stride-ts/native/physics';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Cloth, clothGrid, Game, Model, Mesh, Simulation, Transform } from '../../src';

let native: StrideNative;

beforeAll(async () => {
  native = await createStrideNative({ workerThreads: 1, features: [physics] });
});

afterAll(() => native?.shutdown());

async function run(game: Game & { simulation: Simulation }, frames: number): Promise<void> {
  for (let i = 0; i < frames; i++) {
    game.updateTime.advance(1 / 60);
    game.entities.update(game.updateTime, (time) => game.simulation.update(time));
    game.transforms.update();
    await Promise.resolve();
  }
}

describe('布料', () => {
  test('格子：点数、三角形、按 pin 选的固定点', () => {
    const grid = clothGrid(1, 0.5, 0.25, 'top');
    expect(grid.positions.length / 3).toBe(5 * 3);
    expect(grid.indices.length / 3).toBe(4 * 2 * 2);
    expect(grid.pinned).toEqual([0, 1, 2, 3, 4]);
    expect(clothGrid(1, 0.5, 0.25, 'left').pinned).toEqual([0, 5, 10]);
    expect(clothGrid(1, 0.5, 0.25, 'topCorners').pinned).toEqual([0, 4]);
    expect(clothGrid(1, 0.5, 0.25, 'none').pinned).toEqual([]);
  });

  test('上边钉住的窗帘：下边垂着，实体往旁边挪时跟着走；网格是动态的，脚本去掉时布和画它的实体一起没了', async () => {
    const game = new Game();
    game.native = native;
    game.transforms = native.createTransforms(64);
    game.simulation = new Simulation(native, game.transforms, game.entities, 64);
    const simulation = game as Game & { simulation: Simulation };
    const rail = game.entities.create({ name: 'Rail', components: [Transform.with({ position: [0, 3, 0], rotation: [-Math.SQRT1_2, 0, 0, Math.SQRT1_2] })] });
    game.transforms.update();
    // 绕 x 转了 -90°：布开始是水平的，钉住的上边在 z = 0 那条线上，往下垂
    rail.add({ script: Cloth, init: { width: 1, height: 1, spacing: 0.1, windDrag: 0 } });
    await run(simulation, 150);
    const cloth = rail.require(Cloth);
    const surface = cloth.surface!;
    const mesh = Mesh.byId(surface.require(Model).mesh)!;
    expect(mesh.dynamic).toBe(true);
    expect(mesh.vertexVersion).toBeGreaterThan(100);
    // 最低点垂到上边下面接近 1 米
    expect(surface.require(Transform).position.y + mesh.bounds.min[1]).toBeLessThan(3 - 0.8);
    // 挪走实体：钉住的上边跟过去
    rail.require(Transform).position.x = 2;
    await run(simulation, 120);
    expect(surface.require(Transform).position.x + (mesh.bounds.min[0] + mesh.bounds.max[0]) / 2).toBeGreaterThan(1.8);
    rail.remove(Cloth);
    expect(surface.alive).toBe(false);
  });
});
