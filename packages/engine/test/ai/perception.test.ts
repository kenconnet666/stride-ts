import { createStrideNative, type StrideNative } from '@stride-ts/native';
import { physics } from '@stride-ts/native/physics';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Collider, Game, Perceiver, PerceptionStimulus, Simulation, StateTreeInstance, Static, Transform } from '../../src';
import { STATE_TREE, checkStateTree } from '../../src/content/formats/format';
import '../../src/ai/stateTreeTasks';

let native: StrideNative;

beforeAll(async () => {
  native = await createStrideNative({ workerThreads: 2, features: [physics] });
});

afterAll(() => native?.shutdown());

function setup() {
  const game = new Game();
  game.native = native;
  game.transforms = native.createTransforms(64);
  game.simulation = new Simulation(native, game.transforms, game.entities, 64);
  const step = (seconds: number) => {
    for (let t = 0; t < seconds - 1e-9; t += 0.05) {
      game.updateTime.advance(0.05);
      game.entities.update(game.updateTime, (time) => game.simulation!.update(time));
      game.transforms.update();
      game.perception.update(game);
    }
  };
  return { game, step };
}

describe('感知', () => {
  test('看得见前面视野里的、看不见身后的和墙后的；看丢以后记着最后的位置，过了记忆的时间忘掉', () => {
    const { game, step } = setup();
    // 守卫在原点朝 +Z（视野 120°，20 米）
    const guard = game.entities.create({ name: 'Guard', components: [Transform, Perceiver.with({ memory: 1 })] });
    const front = game.entities.create({ name: 'Front', components: [Transform.with({ position: [2, 0, 10] }), PerceptionStimulus.with({ tag: 'player' })] });
    game.entities.create({ name: 'Behind', components: [Transform.with({ position: [0, 0, -5] }), PerceptionStimulus.with({ tag: 'player' })] });
    const hidden = game.entities.create({ name: 'Hidden', components: [Transform.with({ position: [-6, 0, 8] }), PerceptionStimulus.with({ tag: 'player' })] });
    // 守卫和 Hidden 之间一堵墙
    game.entities.create({ components: [Transform.with({ position: [-3, 1.5, 4] }), Static.with({ collider: new Collider([{ type: 'box', size: [1, 3, 1] }]).id })] });
    step(0.3);
    const seen = () => game.perception.of(guard).filter((item) => item.seeing).map((item) => item.entity?.name ?? "").sort((a, b) => a.localeCompare(b));
    expect(seen()).toEqual(['Front']);
    expect(game.perception.stats.perceivers).toBe(1);
    // 拿掉墙后的人的可见：躲起来
    front.require(PerceptionStimulus).visible = false;
    step(0.3);
    const remembered = game.perception.of(guard).find((item) => item.entity === front)!;
    expect(remembered.seeing).toBe(false);
    expect(remembered.position.z).toBeCloseTo(10, 3);
    step(1.2);
    expect(game.perception.of(guard)).toEqual([]);
    expect(hidden.require(PerceptionStimulus).visible).toBe(true);
  });

  test('声音：传播距离乘听力以内听到，记下声音的位置；状态树的 sense 任务把它写进参数', () => {
    const { game, step } = setup();
    const guard = game.entities.create({ name: 'Guard', components: [Transform, Perceiver.with({ hearing: 2 })] });
    const thief = game.entities.create({ name: 'Thief', components: [Transform.with({ position: [0, 0, -30] })] });
    game.perception.noise({ x: 0, y: 0, z: -12 }, 5, 'glass', thief);
    step(0.1);
    expect(game.perception.of(guard)).toEqual([]);
    game.perception.noise({ x: 0, y: 0, z: -9 }, 5, 'glass', thief);
    step(0.1);
    const heard = game.perception.of(guard)[0]!;
    expect([heard.sense, heard.tag, heard.entity?.name, heard.position.z]).toEqual(['hearing', 'glass', 'Thief', -9]);
    const tree = new StateTreeInstance({
      path: 'Guard',
      data: checkStateTree(STATE_TREE.parse({
        name: 'Guard',
        parameters: [{ name: 'alert', type: 'bool' }, { name: 'where', type: 'vector' }],
        states: [
          { name: 'Watch', tasks: [{ type: 'sense', tag: 'glass', store: 'where', flag: 'alert' }], transitions: [{ on: 'tick', when: [{ type: 'perceives', tag: 'glass', sense: 'hearing' }], to: 'Investigate' }] },
          { name: 'Investigate', tasks: [{ type: 'stand' }] },
        ],
      }, 'test'), 'test'),
    }, { entity: guard, game });
    tree.update(0.1);
    expect(tree.get('alert')).toBe(1);
    expect(tree.vector('where').z).toBe(-9);
    expect(tree.activePath).toEqual(['Investigate']);
  });
});
