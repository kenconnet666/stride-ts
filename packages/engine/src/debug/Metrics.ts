/**
 * 各系统的统计和预算（docs/principles.md："每个系统有预算，超了就是 bug；预算和实测值进回归"）：`game.metrics`。
 * 一个量是一个名字、一个单位和一个现读现算的函数；预算是这个量的上限。引擎登记自己的（实体数、绘制次数、显存、
 * 原生内存、帧时间……，见 Game），游戏和别的系统接着登记自己的：
 *
 *   game.metrics.gauge('enemies', 'count', () => this.enemies.length);
 *   game.metrics.budget('enemies', 200);
 *   game.metrics.over();          // 超了预算的量
 *
 * 读的时候才算（`stride metrics`、回归里的检查），平时不花时间。
 */

export type MetricUnit = 'count' | 'bytes' | 'ms';

export interface Metric {
  readonly name: string;
  readonly unit: MetricUnit;
  readonly value: number;
  /** 上限；没设预算的没有。 */
  readonly budget?: number;
  /** 超了预算。 */
  readonly over: boolean;
}

export class Metrics {
  readonly #gauges = new Map<string, { unit: MetricUnit; read: () => number }>();
  readonly #budgets = new Map<string, number>();

  /** 登记一个量（同名的换掉）。read 在读统计的时候调，要便宜、没有副作用。 */
  gauge(name: string, unit: MetricUnit, read: () => number): void {
    this.#gauges.set(name, { unit, read });
  }

  /** 给一个量设上限；undefined 是去掉。量可以还没登记（先设预算、后有系统）。 */
  budget(name: string, limit: number | undefined): void {
    if (limit === undefined) this.#budgets.delete(name);
    else this.#budgets.set(name, limit);
  }

  /** 现在的各个量，按名字排好。 */
  snapshot(): Metric[] {
    return [...this.#gauges].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([name, { unit, read }]) => {
      const value = read(), budget = this.#budgets.get(name);
      return { name, unit, value, ...(budget !== undefined ? { budget } : {}), over: budget !== undefined && value > budget };
    });
  }

  /** 超了预算的量。 */
  over(): Metric[] {
    return this.snapshot().filter((metric) => metric.over);
  }
}
