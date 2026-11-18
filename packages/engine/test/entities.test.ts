import { describe, expect, test } from 'vitest';
import { component, Game, GameTime, prop, system, tag } from '../src/index';

const Health = component({ max: prop.f32().min(0).default(100), current: 100 });
const Regen = component({ rate: 5 });
const Team = component({ id: prop.u8().default(0), name: prop.enum(['red', 'blue']).default('red') });
const Dead = tag();

const frame = (game: Game, seconds = 1 / 60) => {
  game.updateTime.advance(seconds);
  game.entities.update(game.updateTime);
};

describe('entities', () => {
  test('create places data components with their values; views read and write the row', () => {
    const game = new Game();
    const hero = game.entities.create({ name: 'hero', components: [Health.with({ current: 40 }), Regen] });
    const health = hero.require(Health);
    expect([health.max, health.current]).toEqual([100, 40]);
    health.current = 55;
    expect(hero.get(Health)!.current).toBe(55);
    expect(hero.get(Team)).toBeUndefined();
    expect(() => hero.require(Team)).toThrow("entity 'hero'");
  });

  test('adding and removing components moves the row and keeps the values', () => {
    const game = new Game();
    const others = game.entities.spawn(3, [Health.with({ current: 1 })]);
    const e = game.entities.create({ components: [Health.with({ current: 7 })] });
    e.add(Team.with({ id: 3, name: 'blue' }));
    expect(e.require(Health).current).toBe(7);
    expect(e.require(Team).name).toBe('blue');
    e.remove(Health);
    expect(e.has(Health)).toBe(false);
    expect(e.require(Team).id).toBe(3);
    // The entities that stayed in the first table are intact after the swap-remove
    for (const id of others.ids) expect(game.entities.entity(id).require(Health).current).toBe(1);
  });

  test('destroyed ids are not alive even when the index is reused', () => {
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

  test('a view of a destroyed entity throws instead of reading another row', () => {
    const game = new Game();
    const e = game.entities.create({ components: [Health] });
    const view = e.require(Health);
    e.destroy();
    expect(() => view.current).toThrow('does not exist');
  });

  test('a spawned batch takes consecutive rows and sets values column by column', () => {
    const game = new Game();
    game.entities.spawn(5, [Health, Regen]);
    const batch = game.entities.spawn(100, [Health, Regen]);
    expect(batch.firstRow).toBe(5);
    const regen = batch.columns(Regen);
    for (let i = 0; i < batch.count; i++) regen.rate[batch.firstRow + i] = i;
    expect(game.entities.entity(batch.ids[42]!).require(Regen).rate).toBe(42);
    expect(() => batch.columns(Team)).toThrow('have no');
  });

  test('values are checked when entities are created', () => {
    const game = new Game();
    expect(() => game.entities.create({ components: [Health.with({ max: -5 })] })).toThrow('below the minimum 0');
  });
});

describe('systems', () => {
  test('update gets typed columns per table, without excludes, writes bump changed', () => {
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
    // watcher ran after regen (ordered by `after` although added first) and saw both tables changed
    expect(changedRuns).toBe(2);
  });

  test('changed skips tables nobody wrote since the last run', () => {
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

  test('structural changes go through commands, applied after the system', () => {
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

  test('cycles in after are reported', () => {
    const game = new Game();
    const a = system({ with: { health: Health }, update: () => {} });
    const b = system({ with: { health: Health }, after: [a], update: () => {} });
    (a.spec as { after?: unknown }).after = [b];
    game.entities.addSystems(a, b);
    game.entities.spawn(1, [Health]);
    expect(() => frame(game)).toThrow('cycle');
  });

  test('tables created after a system was added are picked up', () => {
    const game = new Game();
    let seen = 0;
    game.entities.addSystems(system({ with: { regen: Regen }, update: ({ count }) => void (seen += count) }));
    frame(game);
    game.entities.spawn(2, [Regen]);
    game.entities.spawn(3, [Regen, Team]);
    frame(game);
    expect(seen).toBe(5);
  });

  test('a time step uses GameTime', () => {
    const time = new GameTime();
    time.advance(0.5);
    expect([time.elapsed, time.total, time.frameCount]).toEqual([0.5, 0.5, 1]);
  });
});
