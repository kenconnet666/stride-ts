import { createStrideNative, type StrideNative } from '@stride-ts/native';
import { navigation } from '@stride-ts/native/navigation';
import { physics } from '@stride-ts/native/physics';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Collider, CrowdAgent, Game, Model, NavigationSystem, Simulation, SimulationLod, Static, Transform, Vector3, levelFor } from '../../src';
import { followRoute } from '../../src/physics/NavigationSystem';

let native: StrideNative;

beforeAll(async () => {
  native = await createStrideNative({ workerThreads: 2, features: [physics, navigation] });
});

afterAll(() => native?.shutdown());

/** 只有变换的游戏：分档系统每帧跑一次（同 Game.update：脚本之前）。 */
function bareGame(): { game: Game; run: (frames: number, step?: number) => void } {
  const game = new Game();
  game.native = native;
  game.transforms = native.createTransforms(128);
  const run = (frames: number, step = 1 / 30) => {
    for (let i = 0; i < frames; i++) {
      game.updateTime.advance(step);
      game.transforms.update();
      game.simulationLod.update(game.entities, game.updateTime);
      game.entities.update(game.updateTime, game.simulation ? (time) => game.simulation!.update(time) : undefined);
    }
  };
  return { game, run };
}

describe('模拟细节层次（SimulationLod）', () => {
  test('按距离定档：越过边界就降档，回来要越过缩了 10% 的边界才升档', () => {
    const distances = [40, 120, 400];
    expect([10, 50, 200, 600].map((d) => levelFor(d, 0, distances, 0.1))).toEqual([0, 1, 2, 3]);
    // 在 1 档，走到 38 米（边界 40 以内、但没进 36）：还是 1 档；35 米升回 0 档
    expect(levelFor(38, 1, distances, 0.1)).toBe(1);
    expect(levelFor(35, 1, distances, 0.1)).toBe(0);
    // 从 3 档一下走近到 10 米：直接回 0 档
    expect(levelFor(10, 3, distances, 0.1)).toBe(0);
  });

  test('四档的个数；0 档封顶时远的降到 1 档；3 档藏模型、回来还原；距离倍数', () => {
    const { game, run } = bareGame();
    game.simulationLod.focus = [0, 0, 0];
    const at = (x: number, extra: object = {}) => game.entities.create({ name: `X${x}`, components: [Transform.with({ position: [x, 0, 0] }), SimulationLod.with(extra), Model.with({ mesh: 1 as never, material: 1 as never, isShadowCaster: false })] });
    const far = at(600);
    at(10);
    at(50);
    at(200);
    const important = at(60, { distanceScale: 2 });
    run(1);
    expect(game.simulationLod.stats.levels).toEqual([2, 1, 1, 1]);
    expect(important.require(SimulationLod).level).toBe(0);
    const model = far.require(Model);
    expect([model.visibleInCamera, model.isShadowCaster]).toEqual([false, false]);
    // 走近：回到 0 档，模型还原成藏之前的样子（本来就不投影）
    far.require(Transform).position = { x: 5, y: 0, z: 0 };
    run(1);
    expect(far.require(SimulationLod).level).toBe(0);
    expect([model.visibleInCamera, model.isShadowCaster]).toEqual([true, false]);
    // 0 档最多两个：近的三个里最远的降到 1 档
    game.simulationLod.settings.maxHigh = 2;
    run(1);
    expect(game.simulationLod.stats.levels[0]).toBe(2);
    expect(important.require(SimulationLod).level).toBe(1);
  });

  test('可变步长：2 档 0.5 秒推进一次，推进时给攒下的时间；一大群按编号错开', () => {
    const { game, run } = bareGame();
    game.simulationLod.focus = [0, 0, 0];
    const crowd = Array.from({ length: 20 }, (_, i) => game.entities.create({ components: [Transform.with({ position: [200, 0, i] }), SimulationLod] }));
    const elapsed = new Map<number, number>();
    const dueFrames = new Map<number, number>();
    for (let frame = 0; frame < 30; frame++) {
      run(1, 0.1);
      for (const entity of crowd) {
        const lod = entity.require(SimulationLod);
        if (!lod.due) continue;
        elapsed.set(entity.id, (elapsed.get(entity.id) ?? 0) + lod.elapsed);
        dueFrames.set(frame, (dueFrames.get(frame) ?? 0) + 1);
      }
    }
    // 3 秒里每个推进 5、6 次，推进的时间加起来接近 3 秒（第一次按相位少一点）
    for (const entity of crowd) expect(elapsed.get(entity.id)!).toBeGreaterThan(2.4);
    // 同一帧推进的不会是一整群
    expect(Math.max(...dueFrames.values())).toBeLessThan(20);
  });
});

describe('降了档的人群', () => {
  test('2 档离开人群直线走、按 0.5 秒一步推进；走近回到人群', async () => {
    const { game, run } = bareGame();
    game.simulation = new Simulation(native, game.transforms, game.entities, 64);
    game.navigation = new NavigationSystem(native, game.simulation, game.entities);
    game.navigation.settings = { ...game.navigation.settings, build: { ...game.navigation.settings.build, cellSize: 0.2, cellHeight: 0.1, agentRadius: 0.3 } };
    game.entities.create({ components: [Transform.with({ position: [0, -0.5, 0] }), Static.with({ collider: new Collider([{ type: 'box', size: [40, 1, 40] }]).id })] });
    run(1);
    await game.navigation.rebuild();
    const person = game.entities.create({ name: 'Walker', components: [Transform.with({ position: [-10, 0, 0] }), SimulationLod] });
    person.add({ script: CrowdAgent, init: { radius: 0.3, maxSpeed: 2 } });
    game.simulationLod.focus = [-300, 0, 0];
    run(1);
    person.require(CrowdAgent).moveTo({ x: 10, y: 0, z: 0 });
    run(60);
    const x = person.require(Transform).position.x;
    // 2 秒、2 米每秒：走了约 4 米（按 0.5 秒的步子，差不到一步）
    expect(person.require(SimulationLod).level).toBe(2);
    expect(x).toBeGreaterThan(-7.5);
    expect(x).toBeLessThan(-5);
    expect(game.navigation.crowdStats).toMatchObject({ agents: 0, coarse: 1 });
    // 相机走近：回到 0 档、进人群，接着走到目标
    game.simulationLod.focus = [0, 0, 0];
    run(30 * 12);
    expect(game.navigation.crowdStats).toMatchObject({ agents: 1, coarse: 0 });
    expect(person.require(CrowdAgent).arrived(0.5)).toBe(true);
  });

  test('沿拐点走：走过的拐点去掉，终点停住', () => {
    const route = [new Vector3(3, 0, 0), new Vector3(3, 0, 4)];
    expect(followRoute(route, 0, 0, 0, 5)).toEqual([3, 0, 2]);
    expect(route.length).toBe(1);
    expect(followRoute(route, 3, 0, 2, 10)).toEqual([3, 0, 4]);
    expect(route.length).toBe(1);
  });
});
