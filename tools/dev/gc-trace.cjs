// 用法：node gc-trace.cjs <playwright 路径> <apps/bench/gc.html 的 url> [trace.json]
// 在开着 tracing 的无头 Chrome 里跑 GC 场景，按场景报告页面测到的帧节奏，
// 以及 V8 在该场景时间窗口内记录的主线程 GC 停顿。
const { chromium } = require(process.argv[2]);
const fs = require('node:fs');

const CATEGORIES = ['devtools.timeline', 'v8', 'disabled-by-default-v8.gc', 'blink.user_timing'];

(async () => {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  const page = await browser.newPage();
  await browser.startTracing(page, { categories: CATEGORIES });
  await page.goto(process.argv[3]);
  await page.waitForFunction(() => globalThis.gcResults || globalThis.gcError, null, { timeout: 600000 });
  const failed = await page.evaluate(() => globalThis.gcError);
  if (failed) throw new Error(failed);
  const results = await page.evaluate(() => globalThis.gcResults);
  const trace = JSON.parse((await browser.stopTracing()).toString());
  if (process.argv[4]) fs.writeFileSync(process.argv[4], JSON.stringify(trace));
  await browser.close();

  const events = trace.traceEvents ?? trace;
  const marks = new Map(events.filter((e) => e.name?.startsWith('gc:')).map((e) => [e.name, e]));
  const mainThread = [...marks.values()][0];
  // 页面主线程上的顶层 GC 停顿：嵌套的阶段（MajorGC 里面的 V8.GC_MC_MARK）跳过，避免重复计算
  const gcEvents = events
    .filter((e) => e.pid === mainThread.pid && e.tid === mainThread.tid && e.ph === 'X' && /GC/.test(e.name) && e.dur > 0)
    .sort((a, b) => a.ts - b.ts);
  const topLevel = [];
  for (const e of gcEvents) {
    const outer = topLevel.at(-1);
    if (outer && e.ts < outer.ts + outer.dur) continue;
    topLevel.push(e);
  }

  const ms = (us) => (us / 1000).toFixed(2);
  for (const r of results) {
    const start = marks.get(`gc:${r.name}:start`).ts;
    const end = marks.get(`gc:${r.name}:end`).ts;
    const inside = topLevel.filter((e) => e.ts >= start && e.ts < end);
    const byName = {};
    for (const e of inside) {
      const entry = (byName[e.name] ??= { count: 0, total: 0, max: 0 });
      entry.count++;
      entry.total += e.dur;
      entry.max = Math.max(entry.max, e.dur);
    }
    const total = inside.reduce((sum, e) => sum + e.dur, 0);
    const max = inside.reduce((m, e) => Math.max(m, e.dur), 0);
    const seconds = (end - start) / 1e6;
    console.log(`\n${r.name}`);
    console.log(`  frames ${r.frames} (${r.fps.toFixed(0)}/s), gap p50 ${r.gapP50.toFixed(2)} p99 ${r.gapP99.toFixed(2)} max ${r.gapMax.toFixed(2)} ms, over 20 ms: ${r.framesOver20ms}, allocation ~${r.allocatedMBPerSecond.toFixed(0)} MB/s`);
    console.log(`  GC on the main thread: ${inside.length} pauses, ${ms(total)} ms total (${((total / 1e3 / seconds / 1000) * 100).toFixed(2)}% of the time), longest ${ms(max)} ms`);
    for (const [name, e] of Object.entries(byName)) {
      console.log(`    ${name.padEnd(36)} ${String(e.count).padStart(5)} x, total ${ms(e.total).padStart(8)} ms, max ${ms(e.max).padStart(7)} ms`);
    }
  }
})().catch((e) => { console.error(e); process.exit(1); });
