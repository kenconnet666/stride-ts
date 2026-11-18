import { describe, expect, test, vi } from 'vitest';
import { AsyncScript, component, Game, prop, StartupScript, SyncScript, type GameTime } from '../src/index';

const frame = (game: Game, seconds = 1 / 60) => {
  game.updateTime.advance(seconds);
  game.entities.update(game.updateTime);
};
/** AsyncScript continuations run once the frame's task returns; let them. */
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
    // A script created during start() starts in the same frame
    this.game.entities.create({ name: 'child', components: [Mover] });
  }
}

describe('scripts', () => {
  test('props have defaults and init values; start runs once before the first update', () => {
    const game = new Game();
    const e = game.entities.create({ components: [Mover.with({ speed: 4 }), Health] });
    const mover = e.require(Mover);
    expect([mover.speed, mover.label, mover.entity]).toEqual([4, 'mover', e]);
    frame(game, 0.5);
    frame(game, 0.5);
    expect(mover.log).toEqual(['start 4']);
    expect(mover.position).toBe(4);
  });

  test('disabled scripts are not updated', () => {
    const game = new Game();
    const mover = game.entities.create({ components: [Mover] }).require(Mover);
    mover.enabled = false;
    frame(game, 1);
    expect(mover.position).toBe(0);
  });

  test('scripts added during start() start in the same frame', () => {
    const game = new Game();
    game.entities.create({ components: [Spawner] });
    frame(game, 1);
    expect(game.entities.count).toBe(2);
  });

  test('removal aborts the signal, releases disposables, then calls cancel', () => {
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

  test('async scripts continue once per frame and stop when removed', async () => {
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
    // execute() starts in frame 1; each nextFrame() continues after the frame ends, before the next one
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

  test('delay resolves after the given game time', async () => {
    const game = new Game();
    let done = false;
    class Waiter extends AsyncScript {
      override async execute(): Promise<void> {
        await this.delay(1);
        done = true;
      }
    }
    game.entities.create({ components: [Waiter] });
    // execute() calls delay(1) in the first frame, at total 0.6: it resolves at the first frame ending at 1.6 or later
    frame(game, 0.6);
    await settle();
    frame(game, 0.6);
    await settle();
    expect(done).toBe(false);
    frame(game, 0.6);
    await settle();
    expect(done).toBe(true);
  });

  test('an error in execute reaches onError', async () => {
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

  test('property names that shadow script members are rejected', () => {
    expect(() => SyncScript.props({ update: 1 })).toThrow("'update' is reserved");
  });
});
