import { createStrideNative, type StrideNative } from '@stride-ts/native';
import { navigation } from '@stride-ts/native/navigation';
import { physics } from '@stride-ts/native/physics';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Collider, CrowdAgent, Game, NavigationSystem, Simulation, SmartObject, StateTreeRunner, Static, Transform } from '../../src';
import { STATE_TREE, checkStateTree } from '../../src/content/formats/format';

let native: StrideNative;

beforeAll(async () => {
  native = await createStrideNative({ workerThreads: 2, features: [physics, navigation] });
});

afterAll(() => native?.shutdown());

describe('智能物体', () => {
  test('槽的位置跟着物体转；占最近的空槽、占满了没有；人用完放开', async () => {
    const game = new Game();
    game.native = native;
    game.transforms = native.createTransforms(64);
    game.simulation = new Simulation(native, game.transforms, game.entities, 64);
    game.navigation = new NavigationSystem(native, game.simulation, game.entities);
    game.navigation.settings = { ...game.navigation.settings, build: { ...game.navigation.settings.build, cellSize: 0.2, cellHeight: 0.1, agentRadius: 0.3 } };
    game.entities.create({ components: [Transform.with({ position: [0, -0.5, 0] }), Static.with({ collider: new Collider([{ type: 'box', size: [30, 1, 30] }]).id })] });
    const run = (frames: number) => {
      for (let i = 0; i < frames; i++) {
        game.updateTime.advance(1 / 30);
        game.entities.update(game.updateTime, (time) => game.simulation!.update(time));
        game.transforms.update();
      }
    };
    run(1);
    await game.navigation.rebuild();
    // 长椅在 (5, 0, 0)，绕 Y 转了 90°（本地 +Z 朝世界 +X）：两个座位在本地 x = ±0.6、往前 0.5
    const bench = game.entities.create({ name: 'Bench', components: [Transform.with({ position: [5, 0, 0], rotation: [0, Math.SQRT1_2, 0, Math.SQRT1_2] })] });
    bench.add({ script: SmartObject, init: { slots: [{ position: [-0.6, 0, 0.5], activity: 'sit' }, { position: [0.6, 0, 0.5], activity: 'sit' }, { position: [0, 0, -1], activity: 'lean', yaw: 180 }] } });
    run(1);
    const pose = game.smartObjects.slotPose(bench.require(SmartObject), 0);
    expect([pose.position.x, pose.position.z].map((v) => +v.toFixed(3))).toEqual([5.5, 0.6]);
    expect(pose.yaw).toBeCloseTo(Math.PI / 2, 5);
    expect(game.smartObjects.stats).toEqual({ objects: 1, slots: 3, claimed: 0 });

    // 三个人都想坐，坐了一会儿起来走
    const tree = {
      path: 'Sitter',
      data: checkStateTree(STATE_TREE.parse({
        name: 'Sitter',
        states: [
          { name: 'Sit', tasks: [{ type: 'useSmartObject', activity: 'sit', seconds: 3, random: 0 }], transitions: [{ on: 'succeeded', to: 'Done' }, { on: 'failed', to: 'NoSeat' }] },
          { name: 'Done', tasks: [{ type: 'stand' }] },
          { name: 'NoSeat', tasks: [{ type: 'stand' }] },
        ],
      }, 'test'), 'test'),
    };
    const people = [-2, 0, 2].map((z, i) => {
      const person = game.entities.create({ name: `P${i}`, components: [Transform.with({ position: [-5 + i, 0, z] })] });
      person.add({ script: CrowdAgent, init: { radius: 0.3, maxSpeed: 2 } });
      person.add({ script: StateTreeRunner, init: { tree, loop: false } });
      return person;
    });
    run(60);
    const paths = () => people.map((person) => person.require(StateTreeRunner).activePath.join('/'));
    expect(paths().filter((path) => path === 'Sit')).toHaveLength(2);
    expect(paths().filter((path) => path === 'NoSeat')).toHaveLength(1);
    expect(game.smartObjects.stats.claimed).toBe(2);
    // 走到座位开始坐（不再朝走的方向转）：在座位上、朝着座位的方向（+X）
    const sitters = people.filter((person) => person.require(StateTreeRunner).activePath[0] === 'Sit');
    for (let i = 0; i < 300 && sitters.some((person) => person.require(CrowdAgent).faceMovement); i++) run(1);
    for (const sitter of sitters) {
      const world = sitter.require(Transform).world;
      expect(Math.hypot(world[12]! - 5.5, Math.abs(world[14]!) - 0.6)).toBeLessThan(0.7);
      expect(world[8]!).toBeGreaterThan(0.9);
    }
    // 坐 3 秒起来，放开座位
    run(120);
    expect(paths().filter((path) => path === 'Done')).toHaveLength(2);
    expect(game.smartObjects.stats.claimed).toBe(0);
    // 物体去掉时它的槽都放开
    const lean = game.smartObjects.claim(people[0]!, { activity: 'lean', near: { x: 5, y: 0, z: 0 } });
    expect(lean?.slot).toBe(2);
    expect(game.smartObjects.claim(people[1]!, { activity: 'lean', near: { x: 5, y: 0, z: 0 } })).toBeUndefined();
    bench.remove(SmartObject);
    run(1);
    expect(game.smartObjects.stats).toEqual({ objects: 0, slots: 0, claimed: 0 });
  });
});
