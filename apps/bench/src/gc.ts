// Frame pacing under different allocation patterns. Each scenario runs on requestAnimationFrame for a few
// seconds between performance marks; tools/gc-trace.cjs records a Chrome trace and adds the GC events that
// fall inside each window, so pauses are measured by V8 itself rather than guessed from frame gaps.

interface Scenario {
  readonly name: string;
  /** Long-lived objects to hold during the run, like a game world's object graph. */
  readonly retained?: number;
  /** Short-lived objects allocated per frame; they escape into a ring, so the JIT cannot remove them. */
  readonly garbagePerFrame?: number;
  /** Per-frame work without allocation over this many entities (typed-array columns). */
  readonly columns?: number;
  /** How long the garbage stays reachable, in frames (default 1): longer lives get objects promoted to the old generation. */
  readonly garbageFrames?: number;
  readonly runMs?: number;
}

export interface ScenarioResult {
  readonly name: string;
  readonly frames: number;
  readonly fps: number;
  readonly gapP50: number;
  readonly gapP99: number;
  readonly gapMax: number;
  readonly framesOver20ms: number;
  readonly allocatedMBPerSecond: number;
}

declare global {
  var gcResults: ScenarioResult[] | undefined;
  var gcError: string | undefined;
}

const RUN_MS = 5000;
const SETTLE_MS = 1000;
/** Approximate bytes per Point in V8 (header and three compressed fields, plus the boxed double in y); for the MB/s estimate. */
const OBJECT_BYTES = 40;

const scenarios: Scenario[] = [
  { name: 'idle frame loop' },
  { name: 'columns: 100k entities updated, no allocation', columns: 100_000 },
  { name: 'garbage: 1k objects per frame', garbagePerFrame: 1_000 },
  { name: 'garbage: 10k objects per frame', garbagePerFrame: 10_000 },
  { name: 'garbage: 100k objects per frame', garbagePerFrame: 100_000 },
  { name: 'retained 1M objects, no garbage', retained: 1_000_000 },
  { name: 'retained 1M objects + 10k garbage per frame', retained: 1_000_000, garbagePerFrame: 10_000 },
  { name: 'retained 1M objects + 100k garbage per frame', retained: 1_000_000, garbagePerFrame: 100_000 },
  // Objects that live about 2 s (projectiles, effects, queued events): they survive scavenges, get promoted
  // and are only freed by major GCs.
  { name: 'mid-lived: 1k objects per frame, each kept ~2 s', garbagePerFrame: 1_000, garbageFrames: 330, runMs: 15_000 },
  { name: 'mid-lived: 5k objects per frame, each kept ~2 s, 1M retained', retained: 1_000_000, garbagePerFrame: 5_000, garbageFrames: 330, runMs: 15_000 },
];

class Point {
  x: number;
  y: number;
  z: number;
  constructor(x: number, y: number, z: number) {
    this.x = x;
    this.y = y;
    this.z = z;
  }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const percentile = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;

async function run(scenario: Scenario): Promise<ScenarioResult> {
  // A large live heap, like a game world's objects: every major GC has to mark all of it.
  let retained: Point[] | undefined;
  if (scenario.retained) {
    retained = Array.from({ length: scenario.retained }, (_, i) => new Point(i, i * 0.5, 0));
  }
  const perFrame = scenario.garbagePerFrame ?? 0;
  // A ring holding the last garbageFrames frames of objects: each object is dropped that many frames later
  const garbage: Point[] = new Array(perFrame * (scenario.garbageFrames ?? 1));
  const y = new Float32Array(scenario.columns ?? 0);
  const v = new Float32Array(scenario.columns ?? 0).fill(1);
  const runMs = scenario.runMs ?? RUN_MS;
  await wait(SETTLE_MS);

  const gaps: number[] = [];
  let sink = 0;
  let cursor = 0;
  performance.mark(`gc:${scenario.name}:start`);
  await new Promise<void>((resolve) => {
    let last = performance.now();
    const end = last + runMs;
    const frame = (now: number) => {
      gaps.push(now - last);
      last = now;
      for (let i = 0; i < perFrame; i++) {
        garbage[cursor] = new Point(i, now, 1);
        cursor = cursor + 1 === garbage.length ? 0 : cursor + 1;
      }
      for (let i = 0; i < y.length; i++) y[i]! += v[i]! * 0.016;
      sink += perFrame > 0 ? garbage[cursor === 0 ? garbage.length - 1 : cursor - 1]!.y : 0;
      if (now < end) requestAnimationFrame(frame);
      else resolve();
    };
    requestAnimationFrame(frame);
  });
  performance.mark(`gc:${scenario.name}:end`);
  if (retained) sink += retained[retained.length - 1]!.x;
  if (sink === -1) console.log(sink);

  const sorted = [...gaps].sort((a, b) => a - b);
  const seconds = runMs / 1000;
  return {
    name: scenario.name,
    frames: gaps.length,
    fps: gaps.length / seconds,
    gapP50: percentile(sorted, 0.5),
    gapP99: percentile(sorted, 0.99),
    gapMax: sorted[sorted.length - 1]!,
    framesOver20ms: gaps.filter((gap) => gap > 20).length,
    allocatedMBPerSecond: (perFrame * gaps.length * OBJECT_BYTES) / seconds / 1e6,
  };
}

async function main(): Promise<void> {
  const out = document.getElementById('out')!;
  const results: ScenarioResult[] = [];
  for (const scenario of scenarios) {
    out.textContent = `running ${scenario.name}...`;
    results.push(await run(scenario));
  }
  out.textContent = JSON.stringify(results, null, 2);
  globalThis.gcResults = results;
}

main().catch((error: unknown) => {
  globalThis.gcError = error instanceof Error ? (error.stack ?? error.message) : String(error);
});
