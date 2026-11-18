/**
 * 标了 .stat() 的脚本属性的运行时修饰：加成和减益。脚本读到的值是 (基础值 + 所有加值) * 所有乘数，
 * 再按属性的 min、max 截断；只在修饰增减时重算，读取没有额外开销。
 *
 *   using slow = this.stats.maxRunSpeed.multiply(0.5);   // 作用域结束时移除
 *   this.stats.maxRunSpeed.add(2, { duration: 5 });        // 游戏时间 5 秒后移除
 */
import type { PropOptions } from '../data/prop';

/** 能报游戏时间、能在限时修饰到期时移除它们的东西。 */
export interface StatClock {
  readonly now: number;
  /** 游戏时间到 `at` 时调用 expire。 */
  schedule(at: number, expire: () => void): void;
}

export interface StatModifierOptions {
  /** 过了多少秒游戏时间后修饰自行移除。 */
  readonly duration?: number;
}

export class Stat {
  #base: number;
  #value = 0;
  readonly #adds = new Set<{ amount: number }>();
  readonly #factors = new Set<{ factor: number }>();
  readonly #options: PropOptions;
  readonly #clock: StatClock;

  constructor(base: number, options: PropOptions, clock: StatClock) {
    this.#base = base;
    this.#options = options;
    this.#clock = clock;
    this.#recompute();
  }

  /** 算上所有修饰后的值。 */
  get value(): number {
    return this.#value;
  }

  /** 修饰之前的值；给属性赋值改的就是它。 */
  get base(): number {
    return this.#base;
  }

  set base(value: number) {
    this.#base = value;
    this.#recompute();
  }

  add(amount: number, options: StatModifierOptions = {}): Disposable {
    const entry = { amount };
    this.#adds.add(entry);
    return this.#modifier(() => this.#adds.delete(entry), options);
  }

  multiply(factor: number, options: StatModifierOptions = {}): Disposable {
    const entry = { factor };
    this.#factors.add(entry);
    return this.#modifier(() => this.#factors.delete(entry), options);
  }

  #modifier(remove: () => void, { duration }: StatModifierOptions): Disposable {
    this.#recompute();
    let active = true;
    const dispose = () => {
      if (!active) return;
      active = false;
      remove();
      this.#recompute();
    };
    if (duration !== undefined) this.#clock.schedule(this.#clock.now + duration, dispose);
    return { [Symbol.dispose]: dispose };
  }

  #recompute(): void {
    let value = this.#base;
    for (const { amount } of this.#adds) value += amount;
    for (const { factor } of this.#factors) value *= factor;
    const { min, max } = this.#options;
    if (min !== undefined && value < min) value = min;
    if (max !== undefined && value > max) value = max;
    this.#value = value;
  }
}
