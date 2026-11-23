import { createStrideNative, type StrideNative } from '@stride-ts/native';
import { physics } from '@stride-ts/native/physics';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Body, Collider, Game, Rope, ropePoints, Simulation, Transform, Vector3 } from '../../src';

let native: StrideNative;

beforeAll(async () => {
  native = await createStrideNative({ workerThreads: 1, features: [physics] });
});

afterAll(() => native?.shutdown());

/** 跑 n 帧（每帧 1/60 秒），每帧之间让出一次（绳子在 start 里异步建好）。 */
async function run(game: Game & { simulation: Simulation }, frames: number): Promise<void> {
  for (let i = 0; i < frames; i++) {
    game.updateTime.advance(1 / 60);
    game.entities.update(game.updateTime, (time) => game.simulation.update(time));
    game.transforms.update();
    await Promise.resolve();
  }
}

describe('绳子', () => {
  test('开始的折线：每段一样长；挂两头时中点往下垂到总长对得上，只挂一头时直直往下', () => {
    const from = new Vector3(0, 5, 0), to = new Vector3(4, 5, 0);
    const points = ropePoints(from, to, 5, 10, true);
    const lengths = points.slice(1).map((p, i) => Math.hypot(p.x - points[i]!.x, p.y - points[i]!.y, p.z - points[i]!.z));
    for (const length of lengths) expect(length).toBeCloseTo(0.5, 9);
    expect(points[5]!.y).toBeCloseTo(5 - 1.5, 9);
    expect(ropePoints(from, new Vector3(0, 2, 0), 3, 3, false).map((p) => p.y)).toEqual([5, 4, 3, 2]);
  });

  test('一头固定在不动的锚上、另一头吊着重物：重物荡下来，离锚不超过绳长；脚本去掉时段和锚一起没了', async () => {
    const game = new Game();
    game.native = native;
    game.transforms = native.createTransforms(64);
    game.simulation = new Simulation(native, game.transforms, game.entities, 64);
    const simulation = game as Game & { simulation: Simulation };
    const weight = game.entities.create({ name: 'Weight', components: [Transform.with({ position: [3, 5, 0] }), Body.with({ collider: new Collider([{ type: 'sphere', radius: 0.2, mass: 5 }]).id })] });
    const anchor = game.entities.create({ name: 'Anchor', components: [Transform.with({ position: [0, 5, 0] })] });
    game.transforms.update();
    anchor.add({ script: Rope, init: { end: weight.id, length: 3.2, segments: 8 } });
    // 像单摆一样荡：记最低点和离锚最远的距离
    let lowest = Infinity, farthest = 0;
    for (let i = 0; i < 240; i++) {
      await run(simulation, 1);
      const p = weight.require(Transform).position;
      lowest = Math.min(lowest, p.y);
      farthest = Math.max(farthest, Math.hypot(p.x, p.y - 5, p.z));
    }
    const rope = anchor.require(Rope);
    expect(rope.pieces).toHaveLength(8);
    expect(lowest).toBeLessThan(2.3);
    expect(farthest).toBeLessThan(3.2 + 0.15);
    const pieces = [...rope.pieces];
    anchor.remove(Rope);
    expect(pieces.every((piece) => !piece.alive)).toBe(true);
  });
});
