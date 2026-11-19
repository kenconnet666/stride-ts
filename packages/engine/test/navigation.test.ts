import { createStrideNative, type StrideNative } from '@stride-ts/native';
import { navigation } from '@stride-ts/native/navigation';
import { physics } from '@stride-ts/native/physics';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Collider, Game, NavigationSystem, RecastNavigationComponent, Simulation, Static, Transform } from '../src/index';

let native: StrideNative;

beforeAll(async () => {
  native = await createStrideNative({ workerThreads: 2, features: [physics, navigation] });
});

afterAll(() => native?.shutdown());

describe('导航（Stride 的 RecastMeshSystem、RecastNavigationComponent）', () => {
  test('静态碰撞体建导航网格（只取 includedLayers 的层，触发器不算），寻路绕过墙；重建前找不到路径', async () => {
    const game = new Game();
    game.native = native;
    game.transforms = native.createTransforms(64);
    game.simulation = new Simulation(native, game.transforms, game.entities, 64);
    game.navigation = new NavigationSystem(native, game.simulation);
    game.navigation.settings = { ...game.navigation.settings, build: { ...game.navigation.settings.build, cellSize: 0.1, cellHeight: 0.1, agentRadius: 0.5, agentHeight: 1.2 }, includedLayers: 1 << 6 };
    const box = (position: [number, number, number], size: [number, number, number], layer: number, trigger = false) =>
      game.entities.create({ components: [Transform.with({ position }), Static.with({ collider: new Collider([{ type: 'box', size }]).id, layer, trigger })] });
    box([0, -0.5, 0], [20, 1, 20], 6);
    box([0, 1, -2], [1, 2, 16], 6);
    // 层 0 的墙不进导航网格：路径直接穿过去
    box([-6, 1, 0], [1, 2, 20], 0);
    box([0, 1, 8], [4, 2, 4], 6, true);
    const walker = game.entities.create({ components: [Transform.with({ position: [-3, 0, -5] })] });
    walker.add(RecastNavigationComponent);
    game.updateTime.advance(1 / 60);
    game.entities.update(game.updateTime, (time) => game.simulation!.update(time));
    game.transforms.update();
    const agent = walker.require(RecastNavigationComponent);

    expect(agent.tryFindPath({ x: 3, y: 0, z: -5 })).toBe(false);
    expect(agent.state).toBe('pathIsInvalid');
    await game.navigation.rebuild();
    expect(agent.tryFindPath({ x: 3, y: 0, z: -5 })).toBe(true);
    expect(agent.state).toBe('pathIsReady');
    // 墙挡在 z = -10 到 6：绕过 z = 6 那头；触发器不挡路
    expect(Math.max(...agent.path.map((p) => p.z))).toBeGreaterThan(6);
    expect(agent.path.at(-1)!.x).toBeCloseTo(3, 1);
    // 层 0 的墙在 x = -6：到 x = -8 的路直走
    expect(agent.tryFindPath({ x: -8, y: 0, z: -5 })).toBe(true);
    expect(agent.path.length).toBe(2);

    // 排队寻路（setTarget）：下一帧排上，再下一帧算好
    const frame = () => {
      game.updateTime.advance(1 / 60);
      game.entities.update(game.updateTime, (time) => game.simulation!.update(time));
      game.transforms.update();
    };
    agent.path = [];
    agent.setTarget({ x: -8, y: 0, z: -5 });
    expect(agent.state).toBe('queuePathPlanning');
    frame();
    expect(agent.state).toBe('planningPath');
    frame();
    expect(agent.state).toBe('pathIsReady');
    expect(agent.path.length).toBe(2);
    // 沿路径走：每帧挪 speed / 60，朝着前进的方向（-X）；走完路径空了
    agent.startFollowingPath();
    const position = walker.require(Transform).position;
    for (let i = 0; i < 12; i++) frame();
    expect(position.x).toBeLessThan(-3.5);
    expect(position.x).toBeGreaterThan(-4.2);
    expect(position.z).toBeCloseTo(-5, 1);
    for (let i = 0; i < 80; i++) frame();
    expect(position.x).toBeCloseTo(-8, 1);
    expect(agent.path).toEqual([]);
    expect(agent.state).toBe('pathIsInvalid');
    agent.stopFollowingPath();
    expect(agent.isMoving).toBe(false);
    game.navigation.destroy();
    game.simulation.destroy();
  });
});
