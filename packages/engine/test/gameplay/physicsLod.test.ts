import { createStrideNative, type StrideNative } from '@stride-ts/native';
import { physics } from '@stride-ts/native/physics';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Body, Collider, Game, Simulation, Transform } from '../../src';

let native: StrideNative;

beforeAll(async () => {
  native = await createStrideNative({ workerThreads: 1, features: [physics] });
});

afterAll(() => native?.shutdown());

describe('远处物理的降级', () => {
  test('离关注点远的落体停在半空，关注点过去以后接着落；没有关注点时不降级', () => {
    const game = new Game();
    game.native = native;
    game.transforms = native.createTransforms(64);
    game.simulation = new Simulation(native, game.transforms, game.entities, 64);
    const simulation = game.simulation;
    const sphere = new Collider([{ type: 'sphere', radius: 0.5 }]).id;
    const near = game.entities.create({ name: 'Near', components: [Transform.with({ position: [0, 100, 0] }), Body.with({ collider: sphere })] });
    const far = game.entities.create({ name: 'Far', components: [Transform.with({ position: [600, 100, 0] }), Body.with({ collider: sphere })] });
    game.transforms.update();
    const run = (seconds: number) => {
      for (let i = 0; i < seconds * 60; i++) {
        game.updateTime.advance(1 / 60);
        game.entities.update(game.updateTime, (time) => simulation.update(time));
        game.transforms.update();
      }
    };
    const y = (entity: typeof near) => entity.require(Transform).position.y;
    simulation.focus = [0, 0, 0];
    run(1);
    expect(simulation.lodStats.frozen).toBe(1);
    const stopped = y(far);
    run(1);
    expect(y(far)).toBe(stopped);
    expect(y(near)).toBeLessThan(100 - 15);
    simulation.focus = [600, 0, 0];
    run(1);
    expect(y(far)).toBeLessThan(stopped - 1);
    // 关掉以后不再冻新的：醒着的远处那个接着落
    simulation.lod.sleepDistance = 0;
    simulation.focus = undefined;
    const before = y(far);
    run(0.5);
    expect(y(far)).toBeLessThan(before);
  });
});
