/**
 * 世界时钟和日历（`game.clock`，Stride 没有）：世界里"现在是几点、第几天"只有这一个来源。日夜循环跟着它转太阳，以后行人的日程、
 * 店的营业时间、存档都读写它。
 *
 * - 世界时间 `time` 是从第 0 年第 1 天 0 点起的秒数，双精度：一千年以后刻度仍是微秒级。日历是简化的：一年 365 天、没有闰年，
 *   第 0 天是星期一。
 * - `rate` 是世界时间比游戏时间快多少倍（游戏时间受 Game.timeScale 影响）：0 是停着，60 是游戏里一秒过一分钟，720 是两分钟一天。
 *   编辑状态下不走。
 * - 没有游戏代码、存档设过它时（`isSet` 是假），场景里的日夜循环在开始运行的第一帧按自己的时刻、日期、一天多长设它（DayNightCycle）。
 * - 定时：`at(8, 开门)` 每到世界时间 8 点调一次，`after(秒, …)` 世界时间过了这么久调一次。时钟一帧走过好几天（倍速很大）时，每
 *   个定时这一帧只调一次，错过的不补。
 *
 * 列车的时刻表、天气的过渡这类"真实地过了多久"的东西仍按游戏时间走：世界时钟拨快、倍速调大时它们不跟着快。
 */
export const SECONDS_PER_DAY = 86400;
export const DAYS_PER_YEAR = 365;
const SECONDS_PER_HOUR = 3600;

/** 时钟的状态（存档、调试命令用）。 */
export interface WorldClockState {
  /** 世界时间（秒）。 */
  readonly time: number;
  /** 世界时间比游戏时间快多少倍。 */
  readonly rate: number;
}

interface Timer {
  /** 下一次到点的世界时间（秒）。 */
  due: number;
  /** 每天重复（`at`）；`after` 是一次性的。 */
  readonly daily: boolean;
  readonly callback: (clock: WorldClock) => void;
  removed: boolean;
}

export class WorldClock {
  /** 世界时间：从第 0 年第 1 天 0 点起的秒数。直接改它不触发错过的定时；要按日历设用 set。 */
  time = 0;
  /** 世界时间比游戏时间快多少倍：0 是停着。 */
  rate = 0;
  #set = false;
  readonly #timers: Timer[] = [];

  /** 游戏代码、存档设过（set、restore）：日夜循环不再拿自己的字段设它，只跟着它走。 */
  get isSet(): boolean {
    return this.#set;
  }

  /** 第几天（从 0 起，不按年折回）。 */
  get day(): number {
    return Math.floor(this.time / SECONDS_PER_DAY);
  }

  /** 一天里的时刻（小时，0 到 24）。 */
  get timeOfDay(): number {
    return (this.time - this.day * SECONDS_PER_DAY) / SECONDS_PER_HOUR;
  }

  /** 一年里的第几天（1 到 365）。 */
  get dayOfYear(): number {
    return (this.day % DAYS_PER_YEAR) + 1;
  }

  /** 第几年（从 0 起）。 */
  get year(): number {
    return Math.floor(this.day / DAYS_PER_YEAR);
  }

  /** 星期几：0 是星期一，6 是星期日。 */
  get weekday(): number {
    return this.day % 7;
  }

  /**
   * 按日历设时钟，没给的项不变：`set({ hours: 18 })` 拨到当天 18 点，`set({ dayOfYear: 172, hours: 6, rate: 60 })`。time 直接给
   * 世界时间。设了以后 isSet 为真。往回拨不触发定时；往前拨跳过的定时不补，下一次到点照常。
   */
  set({ time, year, dayOfYear, hours, rate }: { readonly time?: number; readonly year?: number; readonly dayOfYear?: number; readonly hours?: number; readonly rate?: number }): void {
    if (time !== undefined) {
      this.time = time;
    } else if (year !== undefined || dayOfYear !== undefined || hours !== undefined) {
      const day = (year ?? this.year) * DAYS_PER_YEAR + ((dayOfYear ?? this.dayOfYear) - 1);
      this.time = day * SECONDS_PER_DAY + (hours ?? this.timeOfDay) * SECONDS_PER_HOUR;
    }
    if (rate !== undefined) this.rate = Math.max(0, rate);
    this.#set = true;
    this.#reschedule();
  }

  /** 存档用的状态。 */
  state(): WorldClockState {
    return { time: this.time, rate: this.rate };
  }

  /** 从存档恢复。 */
  restore(state: WorldClockState): void {
    this.set(state);
  }

  /** 每到世界时间的这个时刻（小时）调一次 callback。返回的 Disposable 取消它（脚本里放进 this.disposables，脚本去掉时跟着取消）。 */
  at(hours: number, callback: (clock: WorldClock) => void): Disposable {
    const offset = (((hours % 24) + 24) % 24) * SECONDS_PER_HOUR;
    let due = this.day * SECONDS_PER_DAY + offset;
    if (due <= this.time) due += SECONDS_PER_DAY;
    return this.#add({ due, daily: true, callback, removed: false });
  }

  /** 世界时间再过 seconds 秒调一次 callback。 */
  after(seconds: number, callback: (clock: WorldClock) => void): Disposable {
    return this.#add({ due: this.time + Math.max(0, seconds), daily: false, callback, removed: false });
  }

  /** @internal Game 每帧在脚本之前调（编辑状态不调）：按游戏时间走世界时间，调到点的定时。 */
  advance(gameSeconds: number): void {
    if (this.rate <= 0 || gameSeconds <= 0) return;
    this.time += gameSeconds * this.rate;
    // 按到点的先后调；回调里加的、取消的定时也照顾到（取消的标记 removed，加的这一帧到点也调）
    for (;;) {
      const timer = this.#timers.reduce<Timer | undefined>((first, next) => (!next.removed && next.due <= this.time && (!first || next.due < first.due) ? next : first), undefined);
      if (!timer) break;
      if (timer.daily) timer.due = this.#nextDaily(timer.due);
      else timer.removed = true;
      timer.callback(this);
    }
    this.#prune();
  }

  /** 每天的定时下一次到点：错过的天数跳过，排到现在之后。 */
  #nextDaily(due: number): number {
    const missed = Math.floor((this.time - due) / SECONDS_PER_DAY) + 1;
    return due + Math.max(1, missed) * SECONDS_PER_DAY;
  }

  /** 拨了时钟以后，每天的定时排到新的时间之后最近的那一次，一次性的不动。 */
  #reschedule(): void {
    for (const timer of this.#timers) {
      if (!timer.daily) continue;
      const offset = timer.due - Math.floor(timer.due / SECONDS_PER_DAY) * SECONDS_PER_DAY;
      let due = this.day * SECONDS_PER_DAY + offset;
      if (due <= this.time) due += SECONDS_PER_DAY;
      timer.due = due;
    }
  }

  #add(timer: Timer): Disposable {
    this.#timers.push(timer);
    return { [Symbol.dispose]: () => { timer.removed = true; } };
  }

  #prune(): void {
    for (let i = this.#timers.length - 1; i >= 0; i--) if (this.#timers[i]!.removed) this.#timers.splice(i, 1);
  }
}
