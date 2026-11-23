import { describe, expect, test } from 'vitest';
import { GameEventBus } from '../../src/engine/GameEvents';

declare module '../../src/engine/GameEvents' {
  interface GameEvents {
    'test.door': { readonly door: number };
  }
}

describe('全局的命名事件', () => {
  test('同名的是同一个键；发了进每个接收者的队列、记进最近的事件；没人收也记；不查类型地发同样送到', () => {
    let frame = 7;
    const bus = new GameEventBus(() => frame);
    expect(bus.key('test.door')).toBe(bus.key('test.door'));
    bus.emit('test.door', { door: 1 });
    const a = bus.key('test.door').receiver(), b = bus.key('test.door').receiver();
    frame = 8;
    bus.emit('test.door', { door: 2 });
    bus.emitUnchecked('test.door', { door: 3 });
    expect(a.drain()).toEqual([{ door: 2 }, { door: 3 }]);
    expect(b.tryReceive()).toEqual({ door: 2 });
    expect(bus.listeners()).toEqual({ 'test.door': 2 });
    expect(bus.recent.map((event) => [event.frame, (event.value as { door: number }).door])).toEqual([[7, 1], [8, 2], [8, 3]]);
    a[Symbol.dispose]();
    b[Symbol.dispose]();
    expect(bus.listeners()).toEqual({});
    for (let i = 0; i < 100; i++) bus.emitUnchecked('noise', i);
    expect(bus.recent).toHaveLength(64);
    expect(bus.recent.at(-1)!.value).toBe(99);
  });
});
