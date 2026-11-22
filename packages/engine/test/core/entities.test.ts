import { describe, expect, test } from 'vitest';
import { component, Game, GameTime, prop, system, tag } from '../../src';

const Health = component({ max: prop.f32().min(0).default(100), current: 100 });
const Regen = component({ rate: 5 });
const Team = component({ id: prop.u8().default(0), name: prop.enum(['red', 'blue']).default('red') });
const Dead = tag();

const frame = (game: Game, seconds = 1 / 60) => {
  game.updateTime.advance(seconds);
  game.entities.update(game.updateTime);
};

describe('实体', () => {
  test('create 把数据组件连同取值放进表；视图读写那一行', () => {
    const game = new Game();
    const hero = game.entities.create({ name: 'hero', components: [Health.with({ current: 40 }), Regen] });
    const health = hero.require(Health);
    expect([health.max, health.current]).toEqual([100, 40]);
    health.current = 55;
    expect(hero.get(Health)!.current).toBe(55);
    expect(hero.get(Team)).toBeUndefined();
    expect(() => hero.require(Team)).toThrow("entity 'hero'");
  });

  test('加删组件会搬行，值保留', () => {
    const game = new Game();
    const others = game.entities.spawn(3, [Health.with({ current: 1 })]);
    const e = game.entities.create({ components: [Health.with({ current: 7 })] });
    e.add(Team.with({ id: 3, name: 'blue' }));
    expect(e.require(Health).current).toBe(7);
    expect(e.require(Team).name).toBe('blue');
    e.remove(Health);
    expect(e.has(Health)).toBe(false);
    expect(e.require(Team).id).toBe(3);
    // 留在原表里的实体在交换删除之后数据完好
    for (const id of others.ids) expect(game.entities.entity(id).require(Health).current).toBe(1);
  });

  test('销毁后的 id 即使下标被复用也不算活着', () => {
    const game = new Game();
    const [first] = game.entities.spawn(1, [Health]).ids;
    game.entities.destroy(first!);
    expect(game.entities.isAlive(first!)).toBe(false);
    const [second] = game.entities.spawn(1, [Health]).ids;
    expect(second).not.toBe(first);
    expect(game.entities.isAlive(second!)).toBe(true);
    expect(() => game.entities.entity(first!)).toThrow('does not exist');
    expect(game.entities.count).toBe(1);
  });

  test('已销毁实体的视图会抛错，不会读到别的行', () => {
    const game = new Game();
    const e = game.entities.create({ components: [Health] });
    const view = e.require(Health);
    e.destroy();
    expect(() => view.current).toThrow('does not exist');
  });

  test('批量生成占连续的行，可以按列写值', () => {
    const game = new Game();
    game.entities.spawn(5, [Health, Regen]);
    const batch = game.entities.spawn(100, [Health, Regen]);
    expect(batch.firstRow).toBe(5);
    const regen = batch.columns(Regen);
    for (let i = 0; i < batch.count; i++) regen.rate[batch.firstRow + i] = i;
    expect(game.entities.entity(batch.ids[42]!).require(Regen).rate).toBe(42);
    expect(() => batch.columns(Team)).toThrow('have no');
  });

  test('创建实体时检查取值', () => {
    const game = new Game();
    expect(() => game.entities.create({ components: [Health.with({ max: -5 })] })).toThrow('below the minimum 0');
  });
});

describe('系统', () => {
  test('update 按表拿到带类型的列，without 排除，writes 让 changed 看到改动', () => {
    const game = new Game();
    const living = game.entities.spawn(1000, [Health.with({ current: 50 }), Regen]);
    const dead = game.entities.spawn(10, [Health.with({ current: 50 }), Regen, Dead]);
    let visited = 0;
    const regen = system({
      with: { health: Health, regen: Regen },
      without: [Dead],
      writes: [Health],
      update({ health, regen, count }, time) {
        visited += count;
        for (let i = 0; i < count; i++) health.current[i] = Math.min(health.max[i]!, health.current[i]! + regen.rate[i]! * time.elapsed);
      },
    });
    let changedRuns = 0;
    const watcher = system({ with: { health: Health }, changed: [Health], after: [regen], update: () => void changedRuns++ });
    game.entities.addSystems(watcher, regen);
    frame(game, 1);
    expect(visited).toBe(1000);
    expect(game.entities.entity(living.ids[0]!).require(Health).current).toBe(55);
    expect(game.entities.entity(dead.ids[0]!).require(Health).current).toBe(50);
    // watcher 虽然先加入，但按 `after` 排在 regen 之后，并且看到两张表都改过
    expect(changedRuns).toBe(2);
  });

  test('changed 跳过上次运行以来没人写过的表', () => {
    const game = new Game();
    game.entities.spawn(5, [Health]);
    let runs = 0;
    game.entities.addSystems(system({ with: { health: Health }, changed: [Health], update: () => void runs++ }));
    frame(game);
    frame(game);
    expect(runs).toBe(1);
    game.entities.spawn(1, [Health]);
    frame(game);
    expect(runs).toBe(2);
  });

  test('结构性改动走命令缓冲，系统跑完后执行', () => {
    const game = new Game();
    game.entities.spawn(4, [Health.with({ current: 0 })]);
    game.entities.spawn(4, [Health.with({ current: 10 })]);
    game.entities.addSystems(
      system({
        with: { health: Health },
        update({ health, entities, count }, _time, commands) {
          for (let i = 0; i < count; i++) if (health.current[i] === 0) commands.destroy(entities[i]!);
        },
      }),
    );
    frame(game);
    expect(game.entities.count).toBe(4);

    const direct = system({ with: { health: Health }, update: () => void game.entities.spawn(1, [Health]) });
    game.entities.addSystems(direct);
    expect(() => frame(game)).toThrow("record it in the system's commands");
  });

  test('after 里的循环依赖会报错', () => {
    const game = new Game();
    const a = system({ with: { health: Health }, update: () => {} });
    const b = system({ with: { health: Health }, after: [a], update: () => {} });
    (a.spec as { after?: unknown }).after = [b];
    game.entities.addSystems(a, b);
    game.entities.spawn(1, [Health]);
    expect(() => frame(game)).toThrow('cycle');
  });

  test('系统加入之后才建的表也会被匹配上', () => {
    const game = new Game();
    let seen = 0;
    game.entities.addSystems(system({ with: { regen: Regen }, update: ({ count }) => void (seen += count) }));
    frame(game);
    game.entities.spawn(2, [Regen]);
    game.entities.spawn(3, [Regen, Team]);
    frame(game);
    expect(seen).toBe(5);
  });

  test('时间步进由 GameTime 记录', () => {
    const time = new GameTime();
    time.advance(0.5);
    expect([time.elapsed, time.total, time.frameCount]).toEqual([0.5, 0.5, 1]);
  });
});
