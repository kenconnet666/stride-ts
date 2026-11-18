import { describe, expect, test, vi } from 'vitest';
import { AsyncScript, component, Game, prop, StartupScript, SyncScript, type GameTime } from '../src/index';

const frame = (game: Game, seconds = 1 / 60) => {
  game.updateTime.advance(seconds);
  game.entities.update(game.updateTime);
};
/** AsyncScript 的后续代码在这一帧的任务返回后才运行；这里让它们跑完。 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const Health = component({ current: 100 });

class Mover extends SyncScript.props({
  speed: prop.number().min(0).default(2),
  label: 'mover',
}) {
  readonly log: string[] = [];
  position = 0;

  override start(): void {
    this.log.push(`start ${this.speed}`);
  }

  override update(time: GameTime): void {
    this.position += this.speed * time.elapsed;
  }
}

class Spawner extends StartupScript {
  override start(): void {
    // 在 start() 里创建的脚本在同一帧启动
    this.game.entities.create({ name: 'child', components: [Mover] });
  }
}

describe('脚本', () => {
  test('属性有默认值和 init 值；start 在第一次 update 之前只跑一次', () => {
    const game = new Game();
    const e = game.entities.create({ components: [Mover.with({ speed: 4 }), Health] });
    const mover = e.require(Mover);
    expect([mover.speed, mover.label, mover.entity]).toEqual([4, 'mover', e]);
    frame(game, 0.5);
    frame(game, 0.5);
    expect(mover.log).toEqual(['start 4']);
    expect(mover.position).toBe(4);
  });

  test('停用的脚本不再 update', () => {
    const game = new Game();
    const mover = game.entities.create({ components: [Mover] }).require(Mover);
    mover.enabled = false;
    frame(game, 1);
    expect(mover.position).toBe(0);
  });

  test('在 start() 里加的脚本同一帧启动', () => {
    const game = new Game();
    game.entities.create({ components: [Spawner] });
    frame(game, 1);
    expect(game.entities.count).toBe(2);
  });

  test('移除时先中止 signal、释放 disposables，再调用 cancel', () => {
    const game = new Game();
    const order: string[] = [];
    class Owner extends SyncScript {
      override start(): void {
        this.disposables.defer(() => order.push(`dispose (aborted ${this.signal.aborted})`));
      }
      override cancel(): void {
        order.push('cancel');
      }
    }
    const e = game.entities.create({ components: [Owner] });
    frame(game);
    const owner = e.require(Owner);
    e.remove(Owner);
    expect(order).toEqual(['dispose (aborted true)', 'cancel']);
    expect(owner.attached).toBe(false);
    expect(e.get(Owner)).toBeUndefined();
  });

  test('异步脚本每帧继续一次，移除后停止', async () => {
    const game = new Game();
    let ticks = 0;
    let finished = false;
    class Ticker extends AsyncScript {
      override async execute(): Promise<void> {
        try {
          for (;;) {
            ticks++;
            await this.nextFrame();
          }
        } finally {
          finished = true;
        }
      }
    }
    const e = game.entities.create({ components: [Ticker] });
    // execute() 在第 1 帧开始；每次 nextFrame() 都在当前帧结束后、下一帧开始前继续
    frame(game);
    expect(ticks).toBe(1);
    await settle();
    expect(ticks).toBe(2);
    frame(game);
    await settle();
    frame(game);
    await settle();
    expect(ticks).toBe(4);
    e.destroy();
    frame(game);
    await settle();
    expect(finished).toBe(true);
    expect(ticks).toBe(4);
  });

  test('delay 在过了给定的游戏时间后兑现', async () => {
    const game = new Game();
    let done = false;
    class Waiter extends AsyncScript {
      override async execute(): Promise<void> {
        await this.delay(1);
        done = true;
      }
    }
    game.entities.create({ components: [Waiter] });
    // execute() 在第一帧（total 0.6）调用 delay(1)：在第一个结束时 total 不小于 1.6 的帧兑现
    frame(game, 0.6);
    await settle();
    frame(game, 0.6);
    await settle();
    expect(done).toBe(false);
    frame(game, 0.6);
    await settle();
    expect(done).toBe(true);
  });

  test('execute 里的错误交给 onError', async () => {
    const game = new Game();
    const onError = vi.fn();
    game.entities.onError = onError;
    class Broken extends AsyncScript {
      override async execute(): Promise<void> {
        await this.nextFrame();
        throw new Error('boom');
      }
    }
    game.entities.create({ components: [Broken] });
    frame(game);
    await settle();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'boom' }));
  });

  test('会盖掉脚本成员的属性名被拒绝', () => {
    expect(() => SyncScript.props({ update: 1 })).toThrow("'update' is reserved");
  });
});
