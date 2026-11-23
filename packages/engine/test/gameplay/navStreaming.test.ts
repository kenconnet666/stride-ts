import { createStrideNative, type StrideNative } from '@stride-ts/native';
import { navigation } from '@stride-ts/native/navigation';
import { physics } from '@stride-ts/native/physics';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Collider, CrowdAgent, DEFAULT_NAVIGATION_STREAMING, Game, NavigationInvoker, NavigationSystem, Simulation, Static, Transform } from '../../src';

let native: StrideNative;

beforeAll(async () => {
  native = await createStrideNative({ workerThreads: 2, features: [physics, navigation] });
});

afterAll(() => native?.shutdown());

function setup() {
  const game = new Game();
  game.native = native;
  game.transforms = native.createTransforms(256);
  game.simulation = new Simulation(native, game.transforms, game.entities, 64);
  const nav = new NavigationSystem(native, game.simulation, game.entities);
  game.navigation = nav;
  // 块 9.6 米；引子周围 20 米，30 米外去掉
  nav.settings = {
    ...nav.settings,
    build: { ...nav.settings.build, cellSize: 0.3, tileSize: 32, agentRadius: 0.4 },
    streaming: { ...DEFAULT_NAVIGATION_STREAMING, radius: 20, removeRadius: 30, tilesPerBatch: 16 },
  };
  const box = (position: [number, number, number], size: [number, number, number]) =>
    game.entities.create({ components: [Transform.with({ position }), Static.with({ collider: new Collider([{ type: 'box', size }]).id })] });
  // 一条 200 米长、10 米宽的走廊，远离原点（x 从 100000 起）：导航网格的坐标相对原点，精度不丢
  const x0 = 100_000;
  box([x0 + 100, -0.5, 0], [200, 1, 10]);
  const frame = async () => {
    game.updateTime.advance(1 / 30);
    game.entities.update(game.updateTime, (time) => {
      game.simulation!.update(time);
      nav.update(time);
    });
    game.transforms.update();
    // 建块在工作线程上：让出去，等它回来
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  const run = async (frames: number) => {
    for (let i = 0; i < frames; i++) await frame();
  };
  return { game, nav, box, x0, run };
}

describe('分块流式的导航网格', () => {
  test('在人周围建块、走远的去掉；路上摆的墙只重建盖到的块，人绕不过去时停在墙前、拿走后接着走', async () => {
    const { game, nav, box, x0, run } = setup();
    const walker = game.entities.create({ components: [Transform.with({ position: [x0 + 10, 0, 0] })] });
    walker.add({ script: CrowdAgent, init: { maxSpeed: 8, maxAcceleration: 20 } });
    await run(20);
    expect(nav.ready).toBe(true);
    const first = nav.streamStats.tiles;
    expect(first).toBeGreaterThan(0);
    // 20 米半径加半块的对角线以内的块（没有路面的块也算建过）：直径 53.6 米，最多 7 × 7 块
    expect(nav.streamStats.tiles).toBeLessThanOrEqual(7 * 7);
    // 寻路只在建了的块里：60 米外还没有
    expect(nav.findPath({ x: x0 + 10, y: 0, z: 0 }, { x: x0 + 25, y: 0, z: 0 })?.at(-1)?.x).toBeCloseTo(x0 + 25, 0);
    expect(nav.findPath({ x: x0 + 10, y: 0, z: 0 }, { x: x0 + 70, y: 0, z: 0 })).toBeUndefined();

    // 往东 150 米外走（目标还不在导航网格上）：先朝它走，前面的块跟着建出来、后面的去掉，建到了按真的目标走
    const agent = walker.require(CrowdAgent);
    agent.moveTo({ x: x0 + 160, y: 0, z: 0 });
    await run(30 * 30);
    const at = () => walker.require(Transform).world[12]! - x0;
    expect(at()).toBeGreaterThan(150);
    expect(nav.streamStats.removed).toBeGreaterThan(0);
    expect(nav.findPath({ x: x0 + 10, y: 0, z: 0 }, { x: x0 + 12, y: 0, z: 0 })).toBeUndefined();

    // 前面横一堵墙：只重建盖到的块，人停在墙前
    const built = nav.streamStats.built;
    const wall = box([x0 + 175, 1.5, 0], [1, 3, 12]);
    agent.moveTo({ x: x0 + 190, y: 0, z: 0 });
    await run(150);
    // 墙盖到的 2 × 2 块重建，加上走到墙前新进范围的块（不是所有的块都重建）
    expect(nav.streamStats.built - built).toBeLessThan(nav.streamStats.tiles);
    expect(at()).toBeLessThan(175);
    wall.destroy();
    await run(150);
    agent.moveTo({ x: x0 + 190, y: 0, z: 0 });
    await run(150);
    expect(at()).toBeGreaterThan(185);
  });

  test('NavigationInvoker 也是引子：没有人的地方挂了它也建块', async () => {
    const { game, nav, x0, run } = setup();
    game.entities.create({ components: [Transform.with({ position: [x0 + 150, 0, 0] }), NavigationInvoker.with({ radius: 12 })] });
    await run(10);
    expect(nav.streamStats.tiles).toBeGreaterThan(0);
    expect(nav.findPath({ x: x0 + 145, y: 0, z: 0 }, { x: x0 + 155, y: 0, z: 0 })?.at(-1)?.x).toBeCloseTo(x0 + 155, 0);
    expect(nav.findPath({ x: x0 + 100, y: 0, z: 0 }, { x: x0 + 101, y: 0, z: 0 })).toBeUndefined();
  });
});
