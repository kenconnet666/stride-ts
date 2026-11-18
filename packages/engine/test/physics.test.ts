import { createStrideNative, type StrideNative } from '@stride-ts/native';
import { physics } from '@stride-ts/native/physics';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Body, Character, Collider, Game, hullPoints, Mesh, Quaternion, Simulation, Static, Transform, TriggerHandler, Vector3, type Entity } from '../src/index';

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
    // 建了物体以后：重力能改，阻尼只能设成一样的值
    game.simulation.configure({ gravity: [0, -9, 0], linearDamping: game.simulation.settings.linearDamping });
    expect(game.simulation.settings.gravity).toEqual([0, -9, 0]);
    expect(() => game.simulation.configure({ angularDamping: 0.5 })).toThrow(/angularDamping must be set before the first physics body/);
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

describe('Vector3、Quaternion', () => {
  test('绕 Y 转 90° 把 +Z 转到 +X，同 Stride 的 Quaternion.Rotate', () => {
    const q = new Quaternion().setAxisAngle({ x: 0, y: 1, z: 0 }, Math.PI / 2);
    const v = new Vector3(0, 0, 1).rotate(q);
    expect(v.x).toBeCloseTo(1);
    expect(v.y).toBeCloseTo(0);
    expect(v.z).toBeCloseTo(0);
  });

  test('Quaternion.slerp 走短的一边：0° 到 90° 的一半是 45°；目标取反（同一个旋转）结果一样', () => {
    const y = { x: 0, y: 1, z: 0 };
    const to = new Quaternion().setAxisAngle(y, Math.PI / 2);
    const half = new Quaternion().slerp(to, 0.5);
    const expected = new Quaternion().setAxisAngle(y, Math.PI / 4);
    expect([half.x, half.y, half.z, half.w].map((c, i) => c - [expected.x, expected.y, expected.z, expected.w][i]!).every((d) => Math.abs(d) < 1e-6)).toBe(true);
    const flipped = new Quaternion().slerp({ x: -to.x, y: -to.y, z: -to.z, w: -to.w }, 0.5);
    expect(Math.abs(flipped.y - half.y) < 1e-6 && Math.abs(flipped.w - half.w) < 1e-6).toBe(true);
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

describe('接触事件和移除（Stride 的 IContactHandler、Trigger）', () => {
  test('Trigger 的碰撞体带 TriggerHandler，物体进出时通知；脚本设的处理器两边都收到；实体销毁时移除物体', () => {
    const game = createGame();
    const box = (size: [number, number, number]) => new Collider([{ type: 'box', size }]).id;
    const ground = game.entities.create({ components: [Transform.with({ position: [0, -0.5, 0] }), Static.with({ collider: box([20, 1, 20]) })] });
    const zone = game.entities.create({ components: [Transform.with({ position: [0, 3, 0] }), Static.with({ collider: box([4, 2, 4]), trigger: true })] });
    const crate = game.entities.create({ components: [Transform.with({ position: [0, 8, 0] }), Body.with({ collider: box([1, 1, 1]) })] });

    const trigger = game.simulation.contactHandler(zone);
    expect(trigger).toBeInstanceOf(TriggerHandler);
    const log: string[] = [];
    (trigger as TriggerHandler).onEnter(({ entity, other }) => log.push(`enter ${entity === zone.id} ${other === crate.id}`));
    (trigger as TriggerHandler).onLeave(() => log.push('leave'));
    // 地面上设一个脚本的处理器：落地时地面和箱子两边都收到
    game.simulation.setContactHandler(ground, { onStartedTouching: ({ other }) => log.push(`ground touched ${other === crate.id}`) });
    game.simulation.setContactHandler(crate, { onStartedTouching: ({ other }) => other === ground.id && log.push('crate landed') });
    run(game, 180);
    expect(log).toEqual(['enter true true', 'leave', 'ground touched true', 'crate landed']);
    // 触发器不挡东西
    expect(position(crate).y).toBeCloseTo(0.5, 1);

    crate.destroy();
    run(game, 10);
    // 射线从触发器下面往下打（射线也打得到触发器，同 Bepu）：箱子没了，打到地面
    expect(game.simulation.rayCast([0, 1.5, 0], [0, -1, 0], 10)?.entity).toBe(ground.id);
  });
});

describe('仿真的时间倍率和开关（Stride 的 BepuSimulation.TimeScale、Enabled）', () => {
  test('timeScale 是 0.5 时同样的帧数落一半的时间；关掉后不动，新物体照常建好', () => {
    const fall = (setup: (game: Game & { simulation: Simulation }) => void) => {
      const game = createGame();
      setup(game);
      const crate = game.entities.create({ components: [Transform.with({ position: [0, 100, 0] }), Body.with({ collider: new Collider([{ type: 'sphere', radius: 0.5 }]).id })] });
      run(game, 30);
      return { game, crate, drop: 100 - position(crate).y };
    };
    const normal = fall(() => {}).drop;
    const slow = fall((game) => (game.simulation.timeScale = 0.5)).drop;
    // 自由落体的距离和时间的平方成正比
    expect(slow / normal).toBeCloseTo(0.25, 1);
    const { game, crate, drop } = fall((game) => (game.simulation.enabled = false));
    expect(drop).toBe(0);
    expect(() => game.simulation.body(crate)).not.toThrow();
  });
});

describe('约束（Stride.BepuPhysics 的约束组件）', () => {
  test('单体线性伺服（重力枪）：把物体拉向目标；update 改目标，enabled 关掉后自由落下；onStep 每个物理步调一次', () => {
    const game = createGame();
    const crate = game.entities.create({ components: [Transform, Body.with({ collider: new Collider([{ type: 'box', size: [1, 1, 1] }]).id, sleepThreshold: -1 })] });
    let steps = 0;
    const listening = game.simulation.onStep((timeStep) => void (steps += timeStep > 0 ? 1 : 0));
    const servo = game.simulation.addConstraint({ type: 'oneBodyLinearServo', bodyA: crate, target: [0, 5, 0] });
    run(game, 120);
    expect(position(crate).y).toBeCloseTo(5, 1);
    servo.update({ target: [3, 5, 0] });
    expect(servo.settings.target).toEqual([3, 5, 0]);
    run(game, 120);
    expect(position(crate).x).toBeCloseTo(3, 1);
    servo.enabled = false;
    run(game, 30);
    expect(position(crate).y).toBeLessThan(4);
    expect(steps).toBe(270);
    listening[Symbol.dispose]();
    run(game, 10);
    expect(steps).toBe(270);
    servo.remove();
    servo.enabled = true;
    expect(servo.enabled).toBe(false);
  });

  test('addConstraint 接实体；remove 后自由落下；实体销毁时约束一起移除；sleepThreshold 为负时一直醒着', () => {
    const game = createGame();
    game.simulation.configure({ gravity: [0, -9, 0] });
    const cube = game.entities.create({ components: [Transform.with({ position: [2, 0, -9] }), Body.with({ collider: new Collider([{ type: 'box', size: [2, 2, 2] }]).id, kinematic: true })] });
    const sphere = game.entities.create({ components: [Transform.with({ position: [-2, 0, -9] }), Body.with({ collider: new Collider([{ type: 'sphere', radius: 1 }]).id })] });
    const sphereBody = game.simulation.body(sphere);
    sphereBody.sleepThreshold = -1;
    expect(sphere.require(Body).sleepThreshold).toBe(-1);
    const socket = game.simulation.addConstraint({ type: 'ballSocket', bodyA: cube, bodyB: sphere, localOffsetB: [4, 0, 0] });
    sphereBody.applyLinearImpulse({ x: 0, y: 0, z: 18 });
    run(game, 90);
    const distance = () => {
      const a = position(cube), b = position(sphere);
      return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
    };
    expect(distance()).toBeCloseTo(4, 1);
    expect(sphereBody.awake).toBe(true);

    socket.remove();
    const height = position(sphere).y;
    run(game, 60);
    expect(position(sphere).y).toBeLessThan(height - 3);

    // 焊接以后销毁立方体：约束跟着移除，球继续落
    const cubeBody = game.simulation.body(cube);
    game.simulation.addConstraint({ type: 'weld', bodyA: cube, bodyB: sphere, localOffset: [-4, 0, 0] });
    cube.destroy();
    // 移除后的物体（同 Stride 离开仿真的 BodyComponent）：设置只记下，冲量、瞬移忽略
    cubeBody.kinematic = false;
    cubeBody.applyLinearImpulse({ x: 0, y: 1, z: 0 });
    cubeBody.teleport(new Vector3(0, 0, 0), new Quaternion());
    expect([cubeBody.kinematic, cubeBody.awake, cubeBody.linearVelocity.y]).toEqual([false, false, 0]);
    const before = position(sphere).y;
    run(game, 30);
    expect(position(sphere).y).toBeLessThan(before - 0.5);
  });
});
