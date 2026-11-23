import { createStrideNative, type StrideNative } from '@stride-ts/native';
import { navigation } from '@stride-ts/native/navigation';
import { physics } from '@stride-ts/native/physics';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Collider, CrowdAgent, Game, NavigationSystem, Simulation, Static, Transform } from '../../src';

let native: StrideNative;

beforeAll(async () => {
  native = await createStrideNative({ workerThreads: 2, features: [physics, navigation] });
});

afterAll(() => native?.shutdown());

describe('人群（DetourCrowd）', () => {
  test('两队人相向走、穿过墙上的口子：都走到、路上不叠在一起、朝着走的方向；去掉的人出人群', async () => {
    const game = new Game();
    game.native = native;
    game.transforms = native.createTransforms(256);
    game.simulation = new Simulation(native, game.transforms, game.entities, 64);
    game.navigation = new NavigationSystem(native, game.simulation, game.entities);
    game.navigation.settings = { ...game.navigation.settings, build: { ...game.navigation.settings.build, cellSize: 0.1, cellHeight: 0.1, agentRadius: 0.4, agentHeight: 1.8 } };
    const box = (position: [number, number, number], size: [number, number, number]) =>
      game.entities.create({ components: [Transform.with({ position }), Static.with({ collider: new Collider([{ type: 'box', size }]).id })] });
    box([0, -0.5, 0], [30, 1, 30]);
    // x = 0 一堵墙，中间留 6 米的口子（3 米时两队人对着挤住：DetourCrowd 在窄口的对向流里会僵住）
    box([0, 1, -10.5], [0.5, 2, 15]);
    box([0, 1, 10.5], [0.5, 2, 15]);
    const run = (frames: number) => {
      for (let i = 0; i < frames; i++) {
        game.updateTime.advance(1 / 30);
        game.entities.update(game.updateTime, (time) => game.simulation!.update(time));
        game.transforms.update();
      }
    };
    run(1);
    await game.navigation.rebuild();
    const people = [-1, 1].flatMap((side) => [-2, -1, 0, 1, 2].map((row) => {
      const entity = game.entities.create({ components: [Transform.with({ position: [side * 8, 0, row * 1.2] })] });
      entity.add({ script: CrowdAgent, init: { maxSpeed: 1.6 } });
      // 目标比起点排得稀一点：挨着的目标上人群的分开（separation）会把两头的人往外推
      return { entity, target: { x: -side * 8, y: 0, z: row * 1.6 } };
    }));
    run(1);
    for (const { entity, target } of people) entity.require(CrowdAgent).moveTo(target);
    let closest = Infinity;
    for (let step = 0; step < 600; step++) {
      run(1);
      const positions = people.map(({ entity }) => entity.require(Transform).world);
      for (let a = 0; a < positions.length; a++) {
        for (let b = a + 1; b < positions.length; b++) closest = Math.min(closest, Math.hypot(positions[a]![12]! - positions[b]![12]!, positions[a]![14]! - positions[b]![14]!));
      }
    }
    for (const { entity } of people) expect(entity.require(CrowdAgent).arrived(0.6)).toBe(true);
    // 半径 0.4：中心不靠近到 0.6 米以内（允许一点挤）
    expect(closest).toBeGreaterThan(0.6);
    expect(game.navigation.crowdStats.agents).toBe(10);
    // 朝向：往 -x 走的人 +z 转到 -x 附近（绕 y 转 -90°）
    const walker = people[5]!.entity;
    walker.require(CrowdAgent).moveTo({ x: 8, y: 0, z: 5 });
    run(20);
    const r = walker.require(Transform).rotation;
    expect(2 * Math.atan2(r.y, r.w)).toBeGreaterThan(0);
    walker.remove(CrowdAgent);
    run(1);
    expect(game.navigation.crowdStats.agents).toBe(9);
  });
});
