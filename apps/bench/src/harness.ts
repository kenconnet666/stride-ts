/** 一个基准用例：setup 准备 n 个实体的状态，返回每次迭代要计时的工作。 */
export interface Case {
  readonly group: string;
  readonly name: string;
  readonly sizes: readonly number[];
  setup(n: number): Promise<Run> | Run;
}

export interface Run {
  /** 一次迭代：一帧的工作量，或一整轮创建。 */
  iterate(): void;
  /** 在两批计时之间调用，不计入时间（等 GPU 做完、重置状态）。 */
  between?(): Promise<void> | void;
  dispose?(): void;
}

export interface Result {
  readonly group: string;
  readonly name: string;
  readonly n: number;
  /** 各批每次迭代耗时（毫秒）的中位数。 */
  readonly ms: number;
  readonly nsPerEntity: number;
  readonly error?: string;
}

const WARMUP_MS = 150;
const BATCH_MS = 60;
const BATCHES = 7;

/** 把 run.iterate() 分批计时，每批足够长、超过计时器精度，报告中位数那一批。 */
async function measure(run: Run): Promise<number> {
  let iterations = 0;
  const warmupEnd = performance.now() + WARMUP_MS;
  while (performance.now() < warmupEnd) {
    run.iterate();
    iterations++;
  }
  await run.between?.();
  const perBatch = Math.max(1, Math.round((iterations * BATCH_MS) / WARMUP_MS));
  const samples: number[] = [];
  for (let b = 0; b < BATCHES; b++) {
    const start = performance.now();
    for (let i = 0; i < perBatch; i++) run.iterate();
    samples.push((performance.now() - start) / perBatch);
    await run.between?.();
  }
  samples.sort((a, b) => a - b);
  return samples[samples.length >> 1]!;
}

export async function runCases(cases: readonly Case[], report: (result: Result) => void): Promise<Result[]> {
  const results: Result[] = [];
  for (const c of cases) {
    for (const n of c.sizes) {
      let result: Result;
      try {
        const run = await c.setup(n);
        const ms = await measure(run);
        run.dispose?.();
        result = { group: c.group, name: c.name, n, ms, nsPerEntity: (ms * 1e6) / n };
      } catch (error) {
        result = { group: c.group, name: c.name, n, ms: NaN, nsPerEntity: NaN, error: String(error) };
      }
      results.push(result);
      report(result);
    }
  }
  return results;
}
