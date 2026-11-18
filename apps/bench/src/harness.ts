/** One benchmark case: setup builds the state for n entities and returns the work timed per iteration. */
export interface Case {
  readonly group: string;
  readonly name: string;
  readonly sizes: readonly number[];
  setup(n: number): Promise<Run> | Run;
}

export interface Run {
  /** One iteration: a frame's worth of work, or one whole creation pass. */
  iterate(): void;
  /** Called between timed batches, outside the timing (flushes GPU work, resets state). */
  between?(): Promise<void> | void;
  dispose?(): void;
}

export interface Result {
  readonly group: string;
  readonly name: string;
  readonly n: number;
  /** Median milliseconds per iteration over the batches. */
  readonly ms: number;
  readonly nsPerEntity: number;
  readonly error?: string;
}

const WARMUP_MS = 150;
const BATCH_MS = 60;
const BATCHES = 7;

/** Times run.iterate() in batches long enough to be above timer resolution, and reports the median batch. */
export async function measure(run: Run): Promise<number> {
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
