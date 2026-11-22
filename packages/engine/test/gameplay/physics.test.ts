import { createStrideNative, type StrideNative } from '@stride-ts/native';
import { physics } from '@stride-ts/native/physics';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AnimationComponent, AnimationSystem, Morphed, Body, Character, Collider, Game, hullPoints, Mesh, ModelNodeLink, OneBodyAngularMotorConstraintComponent, Quaternion, Simulation, Static, Transform, TriggerHandler, Vector3, type AnimationClip, type Entity } from '../../src';
import { modelNodeLinkSystem } from '../../src/animation/ModelNodeLink';

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
  test('缩放：形状默认跟着实体的世界缩放；absoluteSize（Stride 的规则）按世界单位', () => {
    const game = createGame();
    game.entities.create({ components: [Transform.with({ position: [0, -1, 0] }), Static.with({ collider: new Collider([{ type: 'box', size: [100, 2, 100] }]).id })] });
    const cube = (x: number, absoluteSize: boolean) => game.entities.create({
      components: [Transform.with({ position: [x, 3, 0], scale: [2, 2, 2] }), Body.with({ collider: new Collider([{ type: 'box', size: [1, 1, 1] }], { absoluteSize }).id })],
    });
    const scaled = cube(-5, false), absolute = cube(5, true);
    // 放大的球：默认半径跟着放大，absoluteSize 的照写的半径
    const ball = (x: number, absoluteSize: boolean) => game.entities.create({
      components: [Transform.with({ position: [x, 3, 5], scale: [2, 2, 2] }), Body.with({ collider: new Collider([{ type: 'sphere', radius: 0.5 }], { absoluteSize }).id })],
    });
    const scaledBall = ball(-5, false), absoluteBall = ball(5, true);
    run(game, 180);
    expect(position(scaled).y).toBeCloseTo(1, 1);
    expect(position(absolute).y).toBeCloseTo(0.5, 1);
    expect(position(scaledBall).y).toBeCloseTo(1, 1);
    expect(position(absoluteBall).y).toBeCloseTo(0.5, 1);
  });

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
    // 穿透的射线（Stride 的 RayCastPenetrating）：穿过的每个物体各一个命中，从近到远；按遮罩筛
    const through = game.simulation.rayCastPenetrating(above, [0, -1, 0], 20);
    expect(through.map((hit) => hit.entity)).toEqual([player.id, floor.id]);
    expect(through[0]!.distance).toBeLessThan(through[1]!.distance);
    expect(game.simulation.rayCastPenetrating(above, [0, -1, 0], 20, { mask: 1 << 0 }).map((hit) => hit.entity)).toEqual([floor.id]);
    expect(game.simulation.rayCastPenetrating(above, [0, 1, 0], 20)).toEqual([]);
    // 重叠查询（Stride 的 Overlap）：站着的角色和地面都碰到，按遮罩只要地面，半空里什么都不碰
    const feet = { position: [position(player).x, 0.05, position(player).z] as [number, number, number] };
    expect(game.simulation.overlap({ type: 'sphere', radius: 0.3 }, feet).sort()).toEqual([floor.id, player.id].sort());
    expect(game.simulation.overlap({ type: 'box', size: [0.6, 0.6, 0.6] }, feet, { mask: 1 << 0 })).toEqual([floor.id]);
    expect(game.simulation.overlap({ type: 'capsule', radius: 0.2, length: 0.5 }, { position: [0, 30, 0], rotation: [0, 0, 0.7071068, 0.7071068] })).toEqual([]);
    // 建了物体以后：重力能改，阻尼只能设成一样的值
    game.simulation.configure({ gravity: [0, -9, 0], linearDamping: game.simulation.settings.linearDamping });
    expect(game.simulation.settings.gravity).toEqual([0, -9, 0]);
    expect(() => game.simulation.configure({ angularDamping: 0.5 })).toThrow(/angularDamping must be set before the first physics body/);
    game.simulation.configure({ maximumTimeToProcess: 0.1 });
    game.simulation.destroy();
  });

  test('慢帧：物理补到和游戏时间对上；一帧补的时间有上限，补不完的留到后面或者丢掉', () => {
    const game = createGame();
    game.entities.create({ components: [Transform.with({ position: [0, -1, 0] }), Static.with({ collider: new Collider([{ type: 'box', size: [10, 2, 10] }]).id })] });
    let steps = 0;
    using _ = game.simulation.onStep(() => void steps++);
    const frame = (seconds: number) => {
      steps = 0;
      game.updateTime.advance(seconds);
      game.entities.update(game.updateTime, (time) => game.simulation.update(time));
      return steps;
    };
    frame(1 / 60);
    // 默认的上限和 Game 一帧最长的间隔一样（0.25 秒）：4 帧每秒时一帧补 15 步，物理不比游戏时间慢
    expect(frame(0.25)).toBe(15);
    expect(frame(0.25)).toBe(15);
    // 上限 0.1 秒是 6 步；补不完的 9 步留到后面的帧
    game.simulation.configure({ maximumTimeToProcess: 0.1 });
    expect(frame(0.25)).toBe(6);
    expect(frame(1 / 60)).toBe(6);
    expect(frame(1 / 60)).toBe(5);
    expect(frame(1 / 60)).toBe(1);
    // 丢掉：只补上限以内的，之后照常一帧一步
    game.simulation.configure({ dropPostponedTicks: true });
    expect(frame(0.25)).toBe(6);
    expect(frame(1 / 60)).toBe(1);
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

  test('角色也能用 body()：teleport 绕 Y 转 180°（Platformer2D 的转身），实体跟着转，MoveVector 的 +X 变成世界 -X', () => {
    const game = createGame();
    game.entities.create({ components: [Transform.with({ position: [0, -1, 0] }), Static.with({ collider: new Collider([{ type: 'box', size: [100, 2, 100] }]).id })] });
    const player = game.entities.create({
      components: [Transform.with({ position: [0, 0.05, 0] }), Character.with({ collider: new Collider([{ type: 'capsule', radius: 0.4, length: 0.5 }]).id })],
    });
    run(game, 10);
    const body = game.simulation.body(player);
    const back = new Quaternion().setAxisAngle({ x: 0, y: 1, z: 0 }, Math.PI);
    body.teleport(position(player), back);
    expect([body.kinematic, body.gravity, body.sleepThreshold]).toEqual([false, true, 0.01]);
    player.require(Character).moveX = 1;
    run(game, 30);
    expect(position(player).x).toBeLessThan(-4);
    expect(Math.abs(player.require(Transform).rotation.y)).toBeCloseTo(1, 3);
    game.simulation.destroy();
  });

  test('setOrientation 只改朝向：每帧调也不打断位置的插值（第一人称相机转角色），实体立即跟着转', () => {
    const walk = (turnEachFrame: boolean) => {
      const game = createGame();
      game.entities.create({ components: [Transform.with({ position: [0, -1, 0] }), Static.with({ collider: new Collider([{ type: 'box', size: [100, 2, 100] }]).id })] });
      const player = game.entities.create({
        components: [Transform.with({ position: [0, 0.05, 0] }), Character.with({ collider: new Collider([{ type: 'capsule', radius: 0.4, length: 0.5 }]).id, interpolated: true })],
      });
      run(game, 10);
      player.require(Character).moveY = 1;
      const track: number[] = [];
      for (let frame = 0; frame < 30; frame++) {
        if (turnEachFrame) game.simulation.body(player).setOrientation(new Quaternion());
        run(game, 1);
        track.push(position(player).z);
      }
      return { game, player, track };
    };
    const plain = walk(false), turning = walk(true);
    expect(turning.track).toEqual(plain.track);
    expect(turning.track.at(-1)).toBeGreaterThan(4);

    // 转 90°：实体的旋转马上是新的，位置不变；接着走的方向跟着变（本地 +Z 转到世界 +X）
    const { game, player } = turning;
    const before = { ...position(player) };
    const turned = new Quaternion().setAxisAngle({ x: 0, y: 1, z: 0 }, Math.PI / 2);
    game.simulation.body(player).setOrientation(turned);
    expect(player.require(Transform).rotation.y).toBeCloseTo(turned.y, 5);
    expect(position(player)).toEqual(before);
    // 先让原来 +Z 方向的速度转过来，再量位移
    run(game, 30);
    const [x, z] = [position(player).x, position(player).z];
    run(game, 30);
    expect(position(player).x - x).toBeGreaterThan(4);
    expect(Math.abs(position(player).z - z)).toBeLessThan(0.05);
    plain.game.simulation.destroy();
    game.simulation.destroy();
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
    expect(() => game.simulation.body(game.entities.create({ components: [Transform] }))).toThrow(/no Body or Character/);
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
  test('去掉 Body 组件就移除物体（实体还在）；再加回来时按当时的位置重新建（TopDownRPG 出拳的碰撞体）', () => {
    const game = createGame();
    const ball = game.entities.create({ components: [Transform.with({ position: [0, 5, 0] }), Body.with({ collider: new Collider([{ type: 'sphere', radius: 0.5 }]).id, gravity: false })] });
    // 沿 +Z 的射线穿过 y 高度处
    const hitAt = (y: number) => game.simulation.rayCast([0, y, -5], [0, 0, 1], 10)?.entity;
    run(game, 2);
    expect(hitAt(5)).toBe(ball.id);
    ball.remove(Body);
    run(game, 2);
    expect(hitAt(5)).toBeUndefined();
    ball.require(Transform).position.y = 9;
    ball.add(Body.with({ collider: new Collider([{ type: 'sphere', radius: 0.5 }]).id, gravity: false }));
    run(game, 2);
    expect([hitAt(9), position(ball).y]).toEqual([ball.id, 9]);
    game.simulation.destroy();
  });

  test('挂在动态刚体下面的运动学刚体跟着它走（TopDownRPG 掉落的金币和它的拾取触发器）', () => {
    const game = createGame();
    game.entities.create({ components: [Transform.with({ position: [0, -1, 0] }), Static.with({ collider: new Collider([{ type: 'box', size: [20, 2, 20] }]).id })] });
    const coin = game.entities.create({ components: [Transform.with({ position: [0, 3, 0] }), Body.with({ collider: new Collider([{ type: 'cylinder', radius: 0.3, length: 0.1 }]).id })] });
    const pickup = game.entities.create({ components: [Transform, Body.with({ collider: new Collider([{ type: 'sphere', radius: 0.5 }]).id, kinematic: true, trigger: true })] });
    pickup.require(Transform).parent = coin;
    run(game, 90);
    expect(position(coin).y).toBeLessThan(0.2);
    const world = pickup.require(Transform).world;
    expect(world[13]).toBeCloseTo(position(coin).y, 1);
    expect(game.simulation.rayCast([0, 5, 0], [0, -1, 0], 10, { mask: 1 << 0 })?.entity).toBeDefined();
    game.simulation.destroy();
  });

  test('接触处理器有 onTouching 时每个物理步收到深度（Stride 的 OnTouching，TopDownRPG 的 SceneStreaming 按它加载分块）', () => {
    const game = createGame();
    const zone = game.entities.create({ components: [Transform.with({ position: [0, 3, 0] }), Static.with({ collider: new Collider([{ type: 'box', size: [4, 2, 4] }]).id })] });
    const box = game.entities.create({ components: [Transform.with({ position: [0, 6, 0] }), Body.with({ collider: new Collider([{ type: 'box', size: [1, 1, 1] }]).id })] });
    const events: string[] = [];
    const depths: number[] = [];
    run(game, 1);
    game.simulation.setContactHandler(zone, {
      noContactResponse: true,
      onStartedTouching: ({ other }) => events.push(`start ${other === box.id}`),
      onTouching: ({ other, depth }) => other === box.id && depths.push(depth),
      onStoppedTouching: () => events.push('stop'),
    });
    run(game, 90);
    expect(events).toEqual(['start true', 'stop']);
    expect(depths.length).toBeGreaterThan(5);
    expect(Math.max(...depths)).toBeGreaterThan(0.5);
    game.simulation.destroy();
  });

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
  test('约束组件（Stride 的 OneBodyAngularMotorConstraintComponent 等）：启动时加约束，enabled 开关，实体销毁时移除', () => {
    const game = createGame();
    game.simulation.configure({ gravity: [0, 0, 0] });
    const wheel = game.entities.create({ components: [Transform, Body.with({ collider: new Collider([{ type: 'cylinder', radius: 1, length: 0.5 }]).id, sleepThreshold: -1 })] });
    wheel.add(OneBodyAngularMotorConstraintComponent);
    const motor = wheel.require(OneBodyAngularMotorConstraintComponent);
    motor.settings = { type: 'oneBodyAngularMotor', bodyA: wheel, targetVelocity: [0, 3, 0] };
    run(game, 60);
    expect(game.simulation.body(wheel).angularVelocity.y).toBeCloseTo(3, 1);
    motor.enabled = false;
    game.simulation.body(wheel).angularVelocity = { x: 0, y: 0, z: 0 };
    run(game, 30);
    expect(game.simulation.body(wheel).angularVelocity.y).toBeCloseTo(0, 3);
    motor.enabled = true;
    motor.update({ targetVelocity: [0, -2, 0] });
    run(game, 60);
    expect(game.simulation.body(wheel).angularVelocity.y).toBeCloseTo(-2, 1);
    expect(() => wheel.destroy()).not.toThrow();
  });

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

describe('挂到骨骼节点（Stride 的 ModelNodeLinkComponent）', () => {
  test('世界矩阵 = 目标的世界 × 节点矩阵 × 本地，不看父节点；目标没有骨架时跟着目标；去掉组件后回到父节点', () => {
    const game = createGame();
    const animation = new AnimationSystem(native, game.entities);
    game.entities.addSystems(animation.system, modelNodeLinkSystem(game.entities, game.transforms, animation));
    const model = game.entities.create({ components: [Transform.with({ position: [10, 0, 0] })] });
    const holder = game.entities.create({ components: [Transform.with({ position: [0, 0, 50] })] });
    const hand = game.entities.create({ components: [Transform.with({ position: [1, 0, 0] }), ModelNodeLink.with({ target: model.id, nodeName: 'Palm' })] });
    hand.require(Transform).parent = holder;
    run(game, 1);
    expect([...hand.require(Transform).world.subarray(12, 15)]).toEqual([11, 0, 0]);
    // 目标是 -1：用父实体
    hand.require(ModelNodeLink).target = -1 as never;
    run(game, 1);
    expect([...hand.require(Transform).world.subarray(12, 15)]).toEqual([1, 0, 50]);
    hand.require(ModelNodeLink).target = model.id;
    run(game, 1);
    hand.remove(ModelNodeLink);
    run(game, 1);
    expect([...hand.require(Transform).world.subarray(12, 15)]).toEqual([1, 0, 50]);
    animation.destroy();
    game.simulation.destroy();
  });
});

describe('克隆带形变和动画的模型', () => {
  test('克隆有自己的一组形变权重（照抄现在的值，带形变的网格实体指向它），带着同样的剪辑；销毁克隆不影响原来的', () => {
    const game = createGame();
    const animation = new AnimationSystem(native, game.entities);
    game.entities.addSystems(animation.system, animation.morphSystem);
    const model = game.entities.create({ name: 'model', components: [Transform] });
    const part = game.entities.create({ name: 'part', components: [Transform] });
    part.require(Transform).parent = model;
    const morphs = animation.attachMorphs(model, ['Bigger', 'Taller'], [model, part]);
    morphs.setMorphWeight(1, 0.5);
    model.add({ script: AnimationComponent, init: {} });
    const idle = { name: 'Idle', duration: 1, repeatMode: 'loopInfinite' } as AnimationClip;
    model.require(AnimationComponent).animations.set('Idle', idle);

    const clone = model.clone();
    const [clonePart] = clone.require(Transform).children;
    const cloned = animation.morphs(clone)!;
    expect(cloned).not.toBe(morphs);
    expect([cloned.morphTargetNames, [...cloned.weights]]).toEqual([['Bigger', 'Taller'], [0, 0.5]]);
    expect(cloned.base).not.toBe(morphs.base);
    expect([clone.require(Morphed).weights, clonePart!.require(Morphed).weights]).toEqual([cloned.base, cloned.base]);
    expect(clone.require(AnimationComponent).animations.get('Idle')).toBe(idle);
    expect(clone.require(AnimationComponent).playingAnimations).toHaveLength(0);
    cloned.setMorphWeight(0, 1);
    clone.destroy();
    run(game, 1);
    expect([[...morphs.weights], animation.morphs(model)]).toEqual([[0, 0.5], morphs]);
    animation.destroy();
    game.simulation.destroy();
  });
});
