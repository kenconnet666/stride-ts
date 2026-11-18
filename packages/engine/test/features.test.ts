// 核心的补充功能：向量和对象类属性、sealed / inherit / stat、变体、校验器、事件和钩子、系统的 added / removed。
import { describe, expect, test } from 'vitest';
import {
  component,
  EventKey,
  Game,
  hook,
  prop,
  SyncScript,
  system,
  validator,
  Vector3,
  type EntityId,
  type StandardSchema,
} from '../src/index';

const frame = (game: Game, seconds = 1 / 60) => {
  game.updateTime.advance(seconds);
  game.entities.update(game.updateTime);
};

/** 一个最小的 Standard Schema：正整数列表。代替 zod，省掉依赖。 */
const positiveInts: StandardSchema<number[]> = {
  '~standard': {
    version: 1,
    vendor: 'test',
    validate: (value) =>
      Array.isArray(value) && value.every((v) => Number.isInteger(v) && v > 0)
        ? { value: value as number[] }
        : { issues: [{ message: 'expected positive integers', path: [0] }] },
  },
};

describe('属性类型', () => {
  test('脚本里的向量是数学对象，每个实例各自一份；数据组件里是交错存放的列，视图是活的', () => {
    class Mover extends SyncScript.props({ offset: prop.vec3().default([1, 2, 3]), tint: prop.color() }) {}
    const game = new Game();
    const a = game.entities.create({ components: [Mover] }).require(Mover);
    const b = game.entities.create({ components: [Mover.with({ offset: { x: 5, y: 0, z: 0 } })] }).require(Mover);
    expect(a.offset).toBeInstanceOf(Vector3);
    a.offset.add({ x: 1, y: 1, z: 1 });
    expect([a.offset.x, a.offset.y, a.offset.z]).toEqual([2, 3, 4]);
    expect(b.offset.x).toBe(5);
    expect([a.tint.r, a.tint.a]).toEqual([1, 1]);

    const Body = component({ position: prop.vec3(), rotation: prop.quat(), mass: 1 });
    const e = game.entities.create({ components: [Body.with({ position: [1, 2, 3] })] });
    const body = e.require(Body);
    expect([body.position.x, body.position.y, body.position.z, body.rotation.w]).toEqual([1, 2, 3, 1]);
    body.position.y = 7;
    body.rotation = { x: 0, y: 0, z: 1, w: 0 };
    let seen: number[] = [];
    game.entities.addSystems(
      system({
        with: { body: Body },
        update({ body: columns, count }) {
          for (let i = 0; i < count; i++) seen = [...columns.position.subarray(i * 3, i * 3 + 3), columns.rotation[i * 4 + 2]!];
        },
      }),
    );
    frame(game);
    expect(seen).toEqual([1, 7, 3, 1]);
  });

  test('list、object、union、json、component 只给脚本用，值被复制和校验', () => {
    const Health = component({ current: 100 });
    class Loadout extends SyncScript.props({
      waypoints: prop.list(prop.vec3()),
      bounds: prop.object({ min: prop.vec3(), max: prop.vec3().default([1, 1, 1]) }),
      shape: prop.union('kind', { box: { size: prop.vec3().default([1, 1, 1]) }, sphere: { radius: prop.number() } }),
      ids: prop.json(positiveInts).default([1]),
      target: prop.component(() => Health).optional(),
    }) {}
    const game = new Game();
    const enemy = game.entities.create({ components: [Health] });
    const loadout = game.entities
      .create({
        components: [
          Loadout.with({
            waypoints: [[0, 0, 0], { x: 1, y: 2, z: 3 }],
            shape: { kind: 'sphere', radius: 2 },
            target: enemy.require(Health),
          }),
        ],
      })
      .require(Loadout);
    expect(loadout.waypoints[1]).toBeInstanceOf(Vector3);
    expect(loadout.bounds.max.x).toBe(1);
    expect(loadout.shape).toEqual({ kind: 'sphere', radius: 2 });
    expect(loadout.ids).toEqual([1]);
    expect(loadout.target?.current).toBe(100);

    expect(() => game.entities.create({ components: [Loadout.with({ shape: { kind: 'cone' } as never })] })).toThrow("kind must be one of 'box', 'sphere'");
    expect(() => game.entities.create({ components: [Loadout.with({ shape: { kind: 'box' }, ids: [0] })] })).toThrow('expected positive integers');
    // 数据组件不能有对象类属性
    expect(() => component({ items: prop.list(prop.int()) as never })).toThrow('data components cannot have list props');
  });
});

describe('修饰', () => {
  test('sealed 的属性不能从外面给值，由拥有者自己驱动', () => {
    const Wheel = component({ radius: 0.4, steerAngle: prop.f32().default(0).sealed() });
    const game = new Game();
    expect(() => game.entities.create({ components: [Wheel.with({ steerAngle: 1 } as never)] })).toThrow('steerAngle is sealed');
    const wheel = game.entities.create({ components: [Wheel] }).require(Wheel);
    wheel.steerAngle = 0.5;
    expect(wheel.steerAngle).toBe(0.5);
  });

  test('inherit 的属性可以由作用域默认值统一设置，之后创建的实例都用它', () => {
    const Surface = component({ friction: prop.f32().default(1).inherit(), bounciness: 0 });
    class Voice extends SyncScript.props({ volume: prop.number().default(1).inherit() }) {}
    const game = new Game();
    game.defaults.set(Surface, { friction: 0.25 });
    game.defaults.set(Voice, { volume: 0.5 });
    expect(game.entities.create({ components: [Surface] }).require(Surface).friction).toBe(0.25);
    expect(game.entities.create({ components: [Surface.with({ friction: 0.75 })] }).require(Surface).friction).toBe(0.75);
    expect(game.entities.create({ components: [Voice] }).require(Voice).volume).toBe(0.5);
    expect(() => game.defaults.set(Surface, { bounciness: 1 } as never)).toThrow('bounciness is not marked inherit()');
    game.defaults.reset(Surface);
    expect(game.entities.create({ components: [Surface] }).require(Surface).friction).toBe(1);
  });

  test('stat：加值和乘数叠加、按 min/max 截断、到期或释放后恢复', () => {
    class Runner extends SyncScript.props({ speed: prop.number().min(0).default(10).stat() }) {}
    const game = new Game();
    const runner = game.entities.create({ components: [Runner] }).require(Runner);
    const slow = runner.stats.speed.multiply(0.5);
    runner.stats.speed.add(2, { duration: 1 });
    expect(runner.speed).toBe(6);
    runner.speed = 20; // 赋值改的是基础值
    expect(runner.speed).toBe(11);
    slow[Symbol.dispose]();
    expect(runner.speed).toBe(22);
    frame(game, 0.6);
    expect(runner.speed).toBe(22);
    frame(game, 0.6);
    expect(runner.speed).toBe(20);
    runner.stats.speed.add(-100);
    expect(runner.speed).toBe(0);
  });

  test('变体：先取变体的值，再叠加 init', () => {
    const Enemy = component({ health: 100, level: prop.int().default(1) }, { variants: { elite: { health: 300 }, boss: { health: 1000, level: 10 } } });
    class Guard extends SyncScript.props({ alertness: 0.5 }, { variants: { sleepy: { alertness: 0.1 } } }) {}
    const game = new Game();
    const elite = game.entities.create({ components: [Enemy.variant('elite', { level: 3 }), Guard.variant('sleepy')] });
    expect([elite.require(Enemy).health, elite.require(Enemy).level]).toEqual([300, 3]);
    expect(elite.require(Guard).alertness).toBe(0.1);
    expect(() => Enemy.variant('minion' as never)).toThrow("has no variant 'minion'");
    expect(() => component({ health: prop.f32().min(0).default(1) }, { variants: { broken: { health: -1 } } })).toThrow("variant 'broken'");
  });
});

test('validator 按声明产出 Standard Schema 校验器', () => {
  const Health = component({ max: prop.f32().min(0).default(100), team: prop.enum(['red', 'blue']) });
  const check = validator(Health)['~standard'];
  expect(check.validate({ team: 'red' })).toEqual({ value: { team: 'red' } });
  expect(check.validate({ max: -1, mana: 2 })).toEqual({
    issues: [
      { message: 'is not a property', path: ['mana'] },
      { message: '-1 is below the minimum 0', path: ['max'] },
      { message: 'is required', path: ['team'] },
    ],
  });
});

describe('事件', () => {
  test('EventKey：每个接收者各有队列，同步取或异步等', async () => {
    const damaged = new EventKey<{ amount: number }>();
    const a = damaged.receiver();
    damaged.broadcast({ amount: 1 });
    const b = damaged.receiver();
    damaged.broadcast({ amount: 2 });
    expect(a.drain().map((e) => e.amount)).toEqual([1, 2]);
    expect(b.tryReceive()?.amount).toBe(2);
    const next = b.receive();
    damaged.broadcast({ amount: 3 });
    expect((await next).amount).toBe(3);
    b[Symbol.dispose]();
    expect(damaged.receiverCount).toBe(1);
  });

  test('钩子：使用方先处理，preventDefault 跳过组件自己的行为；事件对象不能留到之后', () => {
    const opening = hook<{ by: string }>('opening');
    let opened = 0;
    const open = () => opening.run({ by: 'player' }, () => opened++);
    let kept: { readonly value: { by: string } } | undefined;
    const handler = opening.on((e) => {
      kept = e;
      if (e.value.by === 'player') e.preventDefault();
    });
    expect(open()).toBe(false);
    expect(opened).toBe(0);
    expect(() => kept!.value).toThrow('was kept after its handler returned');
    handler[Symbol.dispose]();
    expect(open()).toBe(true);
    expect(opened).toBe(1);
  });

  test('脚本里的 on 和 receive 随脚本移除一起释放', () => {
    const ping = new EventKey<number>();
    const ring = hook<number>('ring');
    class Listener extends SyncScript {
      heard: number[] = [];
      rx = this.receive(ping);
      override start(): void {
        this.on(ring, (e) => this.heard.push(e.value));
      }
      override update(): void {
        for (const value of this.rx.drain()) this.heard.push(value * 10);
      }
    }
    const game = new Game();
    const e = game.entities.create({ components: [Listener] });
    const listener = e.require(Listener);
    frame(game);
    ring.run(1);
    ping.broadcast(2);
    frame(game);
    expect(listener.heard).toEqual([1, 20]);
    e.remove(Listener);
    ring.run(3);
    expect(ping.receiverCount).toBe(0);
    expect(listener.heard).toEqual([1, 20]);
  });
});

test('系统的 added / removed：开始或不再满足条件时各调一次，removed 时还能读数据', () => {
  const Body = component({ mass: 1 });
  const Sleeping = component({});
  const game = new Game();
  const before = game.entities.create({ components: [Body.with({ mass: 5 })] });
  const log: string[] = [];
  const physics = system({
    with: { body: Body },
    without: [Sleeping],
    update: () => {},
    added: (id) => log.push(`added ${game.entities.entity(id).require(Body).mass}`),
    removed: (id, commands) => {
      log.push(`removed ${game.entities.entity(id).require(Body).mass}`);
      if (game.entities.entity(id).require(Body).mass === 7) commands.create({ components: [Body.with({ mass: 9 })] });
    },
  });
  game.entities.addSystems(physics);
  const later = game.entities.create({ components: [Body.with({ mass: 7 })] });
  later.add(Sleeping); // 不再满足 without
  before.destroy();
  game.entities.removeSystems(physics);
  // later 的 removed 里记下的命令建了一个新实体（mass 9），它进来时也收到 added
  expect(log).toEqual(['added 5', 'added 7', 'removed 7', 'added 9', 'removed 5', 'removed 9']);
  expect(game.entities.count).toBe(2);
  void (later.id as EntityId);
});
