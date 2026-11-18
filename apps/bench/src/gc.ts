// 不同分配模式下的帧节奏。每个场景用 requestAnimationFrame 跑几秒，前后打 performance mark；
// tools/gc-trace.cjs 录 Chrome trace，统计落在每个窗口里的 GC 事件，停顿时长取自 V8 自己的记录，不靠帧间隔猜。

interface Scenario {
  readonly name: string;
  /** 运行期间一直持有的长寿对象，相当于游戏世界的对象图。 */
  readonly retained?: number;
  /** 每帧分配的短命对象；它们被存进环形数组，JIT 没法把分配优化掉。 */
  readonly garbagePerFrame?: number;
  /** 不分配内存的每帧工作，处理这么多个实体（TypedArray 列）。 */
  readonly columns?: number;
  /** 垃圾对象保持可达多少帧（默认 1）：活得越久越会被晋升到老生代。 */
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
/** V8 里每个 Point 大约多少字节（对象头、三个压缩字段，加上 y 装箱的 double）；用来估算 MB/s。 */
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
  // 活约 2 秒的对象（子弹、特效、排队的事件）：它们熬过新生代回收、被晋升，只能靠老生代回收释放。
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
  // 很大的存活堆，相当于游戏世界的对象：每次老生代回收都要把它全部标记一遍。
  let retained: Point[] | undefined;
  if (scenario.retained) {
    retained = Array.from({ length: scenario.retained }, (_, i) => new Point(i, i * 0.5, 0));
  }
  const perFrame = scenario.garbagePerFrame ?? 0;
  // 环形数组保存最近 garbageFrames 帧的对象：每个对象在这么多帧之后被丢弃
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
