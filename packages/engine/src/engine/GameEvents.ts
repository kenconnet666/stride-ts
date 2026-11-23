/**
 * 全局的命名事件（`game.events`）：按名字找到同一个 EventKey，所以数据（时间轴的事件、以后的状态树、调试命令、MCP）也能发和收，
 * 不用拿着某个对象上的 EventKey。收发和 EventKey 一样：脚本 `this.receive(this.game.events.key('door.opened'))` 每帧取空或 await，
 * 发 `this.game.events.emit('door.opened', { door: id })`。
 *
 * 事件的名字和值的类型用声明合并登记，拼错的名字、值的形状过不了类型检查：
 *
 *   declare module '@stride-ts/engine' { interface GameEvents { 'door.opened': { readonly door: number } } }
 *
 * 引擎自己发的：`timeline`（时间轴的事件点：放它的实体和事件名）。最近发过的留一份（`recent`，`stride call events` 看），查"为什么
 * 没反应"时先看事件发没发。
 */
import { EventKey } from './events';

/** 事件名 → 值的类型。游戏、插件用声明合并加自己的。 */
export interface GameEvents {
  /** 时间轴的事件点到了：放时间轴的实体（TimelinePlayer 所在）和事件名。 */
  timeline: { readonly entity: number; readonly name: string };
}

/** 登记过的事件名。 */
export type GameEventName = Extract<keyof GameEvents, string>;

/** 最近发过的一个事件。 */
export interface RecentGameEvent {
  readonly name: string;
  readonly value: unknown;
  /** 发的时候是第几帧。 */
  readonly frame: number;
}

/** 留多少条最近的事件。 */
const RECENT = 64;

export class GameEventBus {
  readonly #keys = new Map<string, EventKey<unknown>>();
  readonly #recent: RecentGameEvent[] = [];
  readonly #frame: () => number;

  constructor(frame: () => number) {
    this.#frame = frame;
  }

  /** 这个名字的事件键（同一个名字总是同一个）。 */
  key<N extends GameEventName>(name: N): EventKey<GameEvents[N]> {
    return this.#key(name) as EventKey<GameEvents[N]>;
  }

  /** 发一个事件：放进每个接收者的队列，记进最近的事件。 */
  emit<N extends GameEventName>(name: N, value: GameEvents[N]): void {
    this.emitUnchecked(name, value);
  }

  /** 不查类型地发（调试命令、MCP 按字符串发）。 */
  emitUnchecked(name: string, value: unknown): void {
    this.#recent.push({ name, value, frame: this.#frame() });
    if (this.#recent.length > RECENT) this.#recent.shift();
    this.#keys.get(name)?.broadcast(value);
  }

  /** 最近发过的事件，从早到晚。 */
  get recent(): readonly RecentGameEvent[] {
    return this.#recent;
  }

  /** 有人收的事件名和各有几个接收者。 */
  listeners(): Record<string, number> {
    return Object.fromEntries([...this.#keys].filter(([, key]) => key.receiverCount > 0).map(([name, key]) => [name, key.receiverCount]));
  }

  #key(name: string): EventKey<unknown> {
    let key = this.#keys.get(name);
    if (!key) this.#keys.set(name, (key = new EventKey<unknown>()));
    return key;
  }
}
