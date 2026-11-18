import { createStrideNative, type StrideNative } from '@stride-ts/native';
import { physics } from '@stride-ts/native/physics';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Body, Character, Collider, Game, hullPoints, Mesh, Quaternion, Simulation, Static, Transform, Vector3, type Entity } from '../src/index';

let native: StrideNative;

beforeAll(async () => {
  native = await createStrideNative({ workerThreads: 1, features: [physics] });
});

afterAll(() => native?.shutdown());

/** 带原生变换存储和仿真、但不跑帧循环的游戏。 */
function createGame(): Game & { simulation: Simulation } {
  const game = new Game();
  game.native = native;
  game.transforms = native.createTransforms(64);
  game.simulation = new Simulation(native, game.transforms, game.entities, 64);
  return game as Game & { simulation: Simulation };
}

/** 跑 n 帧（每帧 1/60 秒）：脚本和系统、仿真、世界矩阵。 */
function run(game: Game & { simulation: Simulation }, frames: number): void {
  for (let i = 0; i < frames; i++) {
    game.updateTime.advance(1 / 60);
    game.entities.update(game.updateTime, (time) => game.simulation.update(time));
    game.transforms.update();
  }
}

const position = (entity: Entity) => entity.require(Transform).position;

describe('Simulation', () => {
  test('静态体和角色：第一帧建物体，角色站稳、按 MoveVector 走、起跳；射线按层找到实体', () => {
    const game = createGame();
    game.simulation.configure({ gravity: [0, -40, 0] });
    const floor = game.entities.create({
      components: [Transform.with({ position: [0, -1, 0] }), Static.with({ collider: new Collider([{ type: 'box', size: [100, 2, 100] }]).id })],
    });
    const player = game.entities.create({
      components: [
        Transform.with({ position: [0, 0.05, 0] }),
        Character.with({ collider: new Collider([{ type: 'capsule', radius: 0.4, length: 1.2, position: [0, 0.95, 0] }]).id, layer: 2, jumpForce: 13 }),
      ],
    });
    run(game, 30);
    const character = player.require(Character);
    expect(character.grounded).toBe(true);
    // 胶囊底部在原点下方 0.05 米：站在 y = 0 的地面上时原点在 0.05
    expect(position(player).y).toBeCloseTo(0.05, 2);

    // 角色没转：MoveVector 的 y 是本地 +Z，乘 speed（默认 10）
    character.moveY = 1;
    run(game, 30);
    expect(position(player).z).toBeGreaterThan(4.5);
    expect(position(player).z).toBeLessThan(5.2);
    expect(Math.abs(position(player).x)).toBeLessThan(0.01);

    character.moveY = 0;
    character.jump = true;
    run(game, 3);
    expect(character.jump).toBe(false);
    expect(character.grounded).toBe(false);
    expect(position(player).y).toBeGreaterThan(0.5);
    run(game, 60);
    expect(character.grounded).toBe(true);

    const above = [position(player).x, 10, position(player).z] as const;
    expect(game.simulation.rayCast(above, [0, -1, 0], 20)?.entity).toBe(player.id);
    expect(game.simulation.rayCast(above, [0, -1, 0], 20, { mask: 1 << 0 })?.entity).toBe(floor.id);
    expect(() => game.simulation.configure({ gravity: [0, -9.8, 0] })).toThrow(/before the first physics body/);
    game.simulation.configure({ maxStepsPerFrame: 2 });
    game.simulation.destroy();
  });

  test('角色转了 90° 时，MoveVector 按角色的基换到世界', () => {
    const game = createGame();
    game.entities.create({ components: [Transform.with({ position: [0, -1, 0] }), Static.with({ collider: new Collider([{ type: 'box', size: [100, 2, 100] }]).id })] });
    const turned = new Quaternion().setAxisAngle({ x: 0, y: 1, z: 0 }, Math.PI / 2);
    const player = game.entities.create({
      components: [
        Transform.with({ position: [0, 0.05, 0], rotation: [turned.x, turned.y, turned.z, turned.w] }),
        Character.with({ collider: new Collider([{ type: 'capsule', radius: 0.4, length: 1.2, position: [0, 0.95, 0] }]).id }),
      ],
    });
    run(game, 10);
    // 绕 Y 转 90°：本地 +Z（前）转到世界 +X
    player.require(Character).moveY = 1;
    run(game, 30);
    expect(position(player).x).toBeGreaterThan(4.5);
    expect(Math.abs(position(player).z)).toBeLessThan(0.01);
    game.simulation.destroy();
  });
});

describe('Vector3.rotate', () => {
  test('绕 Y 转 90° 把 +Z 转到 +X，同 Stride 的 Quaternion.Rotate', () => {
    const q = new Quaternion().setAxisAngle({ x: 0, y: 1, z: 0 }, Math.PI / 2);
    const v = new Vector3(0, 0, 1).rotate(q);
    expect(v.x).toBeCloseTo(1);
    expect(v.y).toBeCloseTo(0);
    expect(v.z).toBeCloseTo(0);
  });
});

describe('Body（Stride 的 BodyComponent）', () => {
  /** 单位立方体的 8 个角做成的网格（凸包形状用它的顶点）。 */
  const cubeMesh = () => Mesh.cube(1);

  test('凸包的刚体落到地面；body() 控制运动学、瞬移、速度、冲量、重力、唤醒，kinematic、gravity 写回列', () => {
    const game = createGame();
    game.entities.create({ components: [Transform.with({ position: [0, -0.5, 0] }), Static.with({ collider: new Collider([{ type: 'box', size: [20, 1, 20] }]).id })] });
    const crate = game.entities.create({
      components: [Transform.with({ position: [0, 3, 0] }), Body.with({ collider: new Collider([{ type: 'convexHull', meshes: [cubeMesh()] }]).id, sleepThreshold: -1 })],
    });
    // 物体还没建时 body() 先建好
    const body = game.simulation.body(crate);
    expect(body.awake).toBe(true);
    run(game, 120);
    expect(position(crate).y).toBeCloseTo(0.5, 1);

    body.applyLinearImpulse({ x: 0, y: 5, z: 0 });
    expect(body.linearVelocity.y).toBeCloseTo(5, 3);

    body.kinematic = true;
    expect(crate.require(Body).kinematic).toBe(true);
    body.teleport({ x: 0, y: 10, z: 0 }, new Quaternion());
    expect(position(crate).y).toBe(10);
    body.linearVelocity = { x: 1, y: 0, z: 0 };
    run(game, 60);
    expect(position(crate).x).toBeCloseTo(1, 1);
    expect(position(crate).y).toBeCloseTo(10, 3);

    body.kinematic = false;
    body.linearVelocity = { x: 0, y: 0, z: 0 };
    body.gravity = false;
    expect(crate.require(Body).gravity).toBe(false);
    run(game, 30);
    expect(position(crate).y).toBeCloseTo(10, 3);
    expect(() => game.simulation.body(game.entities.create({ components: [Transform] }))).toThrow(/no Body/);
  });

  test('凸包的点按 hull 的缩放、旋转、平移变换', () => {
    // 绕 Y 转 90°：x 轴转到 -z
    const points = hullPoints([cubeMesh()], { scale: [2, 1, 1], rotation: [0, Math.SQRT1_2, 0, Math.SQRT1_2], offset: [0, 5, 0] });
    const xs = new Set<number>(), ys = new Set<number>(), zs = new Set<number>();
    for (let i = 0; i < points.length; i += 3) {
      xs.add(Math.round(points[i]! * 1000) / 1000 + 0);
      ys.add(Math.round(points[i + 1]! * 1000) / 1000 + 0);
      zs.add(Math.round(points[i + 2]! * 1000) / 1000 + 0);
    }
    expect([...xs].sort()).toEqual([-0.5, 0.5]);
    expect([...ys].sort()).toEqual([4.5, 5.5]);
    expect([...zs].sort((a, b) => a - b)).toEqual([-1, 1]);
  });
});
