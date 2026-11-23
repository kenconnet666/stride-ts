import { createStrideNative, type StrideNative } from '@stride-ts/native';
import { navigation } from '@stride-ts/native/navigation';
import { physics } from '@stride-ts/native/physics';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Collider, Game, NavigationSystem, runEnvironmentQuery, Simulation, StateTreeInstance, Static, Transform, Vector3 } from '../../src';
import { ENVIRONMENT_QUERY, STATE_TREE, checkStateTree, type EnvironmentQueryFile } from '../../src/content/formats/format';
import '../../src/ai/stateTreeTasks';

let native: StrideNative;

beforeAll(async () => {
  native = await createStrideNative({ workerThreads: 2, features: [physics, navigation] });
});

afterAll(() => native?.shutdown());

/** 40 × 40 的地面，x = 4 处一堵南北向的墙（z -6..6）。 */
async function setup() {
  const game = new Game();
  game.native = native;
  game.transforms = native.createTransforms(64);
  game.simulation = new Simulation(native, game.transforms, game.entities, 64);
  game.navigation = new NavigationSystem(native, game.simulation, game.entities);
  const box = (position: [number, number, number], size: [number, number, number]) =>
    game.entities.create({ components: [Transform.with({ position }), Static.with({ collider: new Collider([{ type: 'box', size }]).id })] });
  box([0, -0.5, 0], [40, 1, 40]);
  box([4, 1.5, 0], [1, 3, 12]);
  game.updateTime.advance(1 / 30);
  game.entities.update(game.updateTime, (time) => game.simulation!.update(time));
  game.transforms.update();
  await game.navigation.rebuild();
  return game;
}

/** 躲开威胁：围着自己两圈点，威胁看不见的才留，离威胁越远越好，离自己近一点。 */
const HIDE: EnvironmentQueryFile = {
  generator: { type: 'rings', radius: 10, rings: 2, count: 16 },
  tests: [
    { type: 'visible', from: 'threat', want: false, mode: 'filter' },
    { type: 'reachable', mode: 'filter' },
    { type: 'distance', to: 'threat', prefer: 'far', weight: 1 },
    { type: 'distance', prefer: 'near', weight: 0.5 },
  ],
};

describe('环境查询', () => {
  test('躲起来：选到墙后面、威胁看不见的点；点都贴在导航网格上', async () => {
    const game = await setup();
    const threat = new Vector3(-8, 0, 0);
    const result = runEnvironmentQuery(ENVIRONMENT_QUERY.parse(HIDE, 'test'), { game, querier: { x: 2, y: 0, z: 0 }, parameter: () => threat });
    expect(result.generated).toBe(32);
    expect(result.onNavMesh).toBeGreaterThan(16);
    expect(result.kept).toBeGreaterThan(0);
    expect(result.kept).toBeLessThan(result.onNavMesh);
    const point = result.point!;
    // 墙后（x > 4.5），在墙挡住的范围里
    expect(point.x).toBeGreaterThan(4.5);
    expect(Math.abs(point.z)).toBeLessThan(6);
    expect(Math.abs(point.y)).toBeLessThan(0.3);
  });

  test('筛掉所有点时没有结果；状态树的 findSpot 把点写进参数，找不到时失败', async () => {
    const game = await setup();
    const none = runEnvironmentQuery(ENVIRONMENT_QUERY.parse({ generator: { type: 'grid', size: 4, spacing: 2 }, tests: [{ type: 'distance', min: 100, mode: 'filter' }] }, 'test'), { game, querier: { x: 0, y: 0, z: 0 }, parameter: () => ({ x: 0, y: 0, z: 0 }) });
    expect([none.generated, none.kept, none.point]).toEqual([9, 0, undefined]);
    const self = game.entities.create({ components: [Transform.with({ position: [2, 0, 0] })] });
    game.transforms.update();
    const tree = new StateTreeInstance({
      path: 'Hide',
      data: checkStateTree(STATE_TREE.parse({
        name: 'Hide',
        parameters: [{ name: 'threat', type: 'vector', defaultVector: [-8, 0, 0] }, { name: 'spot', type: 'vector' }],
        states: [
          { name: 'Find', tasks: [{ type: 'findSpot', query: HIDE, store: 'spot' }], transitions: [{ on: 'succeeded', to: 'Hidden' }, { on: 'failed', to: '$failed' }] },
          { name: 'Hidden', tasks: [{ type: 'stand' }] },
        ],
      }, 'test'), 'test'),
    }, { entity: self, game });
    tree.update(0.1);
    expect(tree.activePath).toEqual(['Hidden']);
    expect(tree.vector('spot').x).toBeGreaterThan(4.5);
  });
});
