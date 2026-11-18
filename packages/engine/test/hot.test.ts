import { describe, expect, test } from 'vitest';
import { component, Game, prop, Registry, SyncScript, system, type GameTime } from '../src/index';

// 模拟 Vite 的热更新：同一个模块重新执行一次，导出同名的新对象。没改的模块还是原来的对象。

const PATH = './game/units.ts';

function unitsV1() {
  const Health = component({ max: prop.f32().default(100), current: 100 });
  const regen = system({
    with: { health: Health },
    writes: [Health],
    update({ health, count }) {
      for (let i = 0; i < count; i++) health.current[i] = Math.min(health.max[i]!, health.current[i]! + 1);
    },
  });
  class Mover extends SyncScript.props({ speed: 2 }) {
    x = 0;
    override update(): void {
      this.x += this.speed;
    }
  }
  return { Health, regen, Mover };
}

function unitsV2() {
  // max 改名为 maxHealth，新加 armor；系统改成每帧回 10；脚本的 speed 改名为 velocity，新加 boost 和一个字段
  const Health = component({ maxHealth: prop.f32().renamedFrom('max').default(100), current: 100, armor: 5 });
  const regen = system({
    with: { health: Health },
    writes: [Health],
    update({ health, count }) {
      for (let i = 0; i < count; i++) health.current[i] = Math.min(health.maxHealth[i]!, health.current[i]! + 10);
    },
  });
  class Mover extends SyncScript.props({ velocity: prop.number().renamedFrom('speed').default(1), boost: 3 }) {
    x = 0;
    label = 'v2';
    override update(): void {
      this.x += this.velocity * this.boost;
    }
  }
  return { Health, regen, Mover };
}

const frame = (game: Game) => {
  game.updateTime.advance(1 / 60);
  game.entities.update(game.updateTime as GameTime);
};

describe('热重载', () => {
  test('数据组件换新版本：列按字段名搬过去，改名认 renamedFrom，新字段取默认值；系统换成新代码', () => {
    const game = new Game();
    const v1 = unitsV1();
    game.registry.registerModules({ [PATH]: v1 });
    game.entities.addSystems(v1.regen);
    const batch = game.entities.spawn(3, [v1.Health.with({ max: 50, current: 10 })]);
    frame(game);
    expect(game.entities.entity(batch.ids[0]!).require(v1.Health).current).toBe(11);

    const v2 = unitsV2();
    game.hotUpdate({ [PATH]: v2 });
    const unit = game.entities.entity(batch.ids[0]!);
    const health = unit.require(v2.Health);
    expect([health.maxHealth, health.current, health.armor]).toEqual([50, 11, 5]);
    // 旧代码手里的旧版本看到的是同一组列，按新布局读
    expect(unit.has(v1.Health)).toBe(true);
    expect((unit.require(v1.Health) as unknown as { maxHealth: number }).maxHealth).toBe(50);

    frame(game);
    expect(unit.require(v2.Health).current).toBe(21);
    expect(game.registry.get('game/units#Health')).toBe(v2.Health);
  });

  test('脚本换新版本：实例跑新代码，状态保留，属性按新 schema 赋值，新字段补上', () => {
    const game = new Game();
    const v1 = unitsV1();
    game.registry.registerModules({ [PATH]: v1 });
    const entity = game.entities.create({ components: [v1.Mover.with({ speed: 4 })] });
    frame(game);
    const mover = entity.require(v1.Mover);
    expect(mover.x).toBe(4);

    const v2 = unitsV2();
    game.hotUpdate({ [PATH]: v2 });
    // 同一个实例：入口之类没重新执行的代码手里的旧类也能找到它
    expect(entity.require(v2.Mover)).toBe(mover);
    expect(entity.get(v1.Mover)).toBe(mover);
    const updated = entity.require(v2.Mover);
    expect([updated.x, updated.velocity, updated.boost, updated.label]).toEqual([4, 4, 3, 'v2']);
    expect('speed' in updated).toBe(false);

    frame(game);
    expect(updated.x).toBe(4 + 4 * 3);
  });

  test('没改的模块跳过；种类变了要整页刷新', () => {
    const registry = new Registry();
    const v1 = unitsV1();
    const other = { Tag: component({}) };
    registry.registerModules({ [PATH]: v1, './game/other.ts': other });
    const changes = registry.update({ [PATH]: unitsV2(), './game/other.ts': other });
    expect(changes.map((c) => c.name).sort()).toEqual(['game/units#Health', 'game/units#Mover', 'game/units#regen']);
    expect(() => registry.update({ [PATH]: { ...unitsV2(), Health: system({ with: {}, update() {} }) } })).toThrow('changed from a component to a system');
  });

  test('Game.hotEntry：第一次新建，之后返回同一个游戏，换成新类并交给 hotUpdate', () => {
    const hot = { data: {} as Record<string, unknown> };
    class GameV1 extends Game {
      greeting(): string {
        return 'v1';
      }
    }
    class GameV2 extends Game {
      greeting(): string {
        return 'v2';
      }
    }
    const first = Game.hotEntry(hot, { [PATH]: unitsV1() }, GameV1);
    expect(first.created).toBe(true);
    first.game.registry.registerModules({ [PATH]: unitsV1() });

    const second = Game.hotEntry(hot, { [PATH]: unitsV2() }, GameV2);
    expect(second.created).toBe(false);
    expect(second.game).toBe(first.game);
    expect(second.game.greeting()).toBe('v2');
    expect(Game.hotEntry(undefined, {}, GameV1).created).toBe(true);
  });
});
