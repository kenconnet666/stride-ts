// 加载与流式加载的度量基线（路线图"十、大世界收尾"的"加载与缓存"第 0 步，docs/stages.md）：在开放世界样例里打开一个世界，量
//   出画面：打开页面到引擎启动各阶段（原生模块、内容、第一帧）、到近处的格子都加载好；
//   卡顿：按固定路线飞一圈时的帧间隔（中位数、p95、p99、最长、超过 50 毫秒的帧数）；
//   下载量：页面请求数、传输字节；
//   流式加载：飞行中加载、卸载的格子数；当场建的管线数（着色器的编译堵住一帧，应该是 0）和后台预热的数。
//   node tools/dev/streaming-bench.ts [--sync] [--check] [--headed] [--cold] [--world Worlds/Valley] [--seconds 30] [--speed 60] [--port 5232] [--size 1280x720] [--out result.json]
// --sync：对照用，关掉"管线没好先不画"（MeshRenderFeature.deferPipelines），回到当场编译的老做法。
// 借开放世界的开发服务器（没开就开一个，用完 pwsh tools/stop-dev.ps1 停）和自己的无头 Chrome（不限帧率、关垂直同步）。开发服务器
// 上每个模块一个请求，下载量比构建出来的大得多：要量发布的样子用 preview 的地址（--url）。路线：相机从 (0, 40, 0) 出发往 +X
// 飞 seconds 秒（速度 speed 米每秒），到一半时拐向 +Z。
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

// --cold：每次用全新的浏览器用户目录（没有磁盘上的着色器缓存），量第一次访问的启动；不加是同一个目录，量再次访问
process.env['STRIDE_BROWSER_DIR'] = path.join(homedir(), '.stride-ts', process.argv.includes('--cold') ? `streaming-bench-cold-${Date.now()}` : 'streaming-bench');
const { CdpSession, closeBrowser, openUrl, pageTarget } = await import('@stride-ts/cli/chrome');

const option = (name: string, fallback: string) => {
  const at = process.argv.indexOf(name);
  return at < 0 ? fallback : process.argv[at + 1]!;
};
const world = option('--world', 'Worlds/Valley');
const seconds = Number(option('--seconds', '30'));
const speed = Number(option('--speed', '60'));
const port = Number(option('--port', '5232'));
const size = option('--size', '1280x720').split('x').map(Number) as [number, number];
const out = option('--out', '');
const base = option('--url', `http://localhost:${port}/`);
const url = `${base}${base.includes('?') ? '&' : '?'}world=${world}&debug`;

let lastResult: unknown;
const reachable = () => fetch(base).then(() => true, () => false);
if (!(await reachable()) && !process.argv.includes('--url')) {
  spawn('pnpm -F @stride-ts/open-world dev', { cwd: path.resolve(import.meta.dirname, '..', '..'), shell: true, detached: true, stdio: 'ignore' }).unref();
  for (let i = 0; i < 90 && !(await reachable()); i++) await new Promise((resolve) => setTimeout(resolve, 1000));
}

/** 页面里：等引擎跑起来，记启动各阶段、等近处的格子加载完，然后按路线飞，返回所有数字。 */
const measure = `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const t0 = performance.now();
  const game = () => globalThis.strideGame;
  while (!game()?.rootScene) await wait(50);
  ${process.argv.includes('--sync') ? "game().meshes.deferPipelines = false;  // 对照：管线没好就当场编（改动之前的做法）" : ''}
  const rootAt = performance.now() - t0;
  // 有格子的世界等第一个格子；Valley 这样常驻场景里放着地形、摆放的世界没有格子，最多等 5 秒
  while (!(game().world?.loaded.length > 0) && performance.now() - t0 < 5000) await wait(50);
  const firstCellAt = game().world?.loaded.length > 0 ? performance.now() - t0 : null;
  // 近处的格子都加载完（没有在读的了），或者等了 60 秒
  let settleAt;
  for (;;) {
    await wait(100);
    if (game().world.loading.length === 0) { settleAt = performance.now() - t0; break; }
    if (performance.now() - t0 > 60000) { settleAt = null; break; }
  }
  const startup = { ...game().startup };
  const origin = performance.timeOrigin;
  const marks = Object.fromEntries(Object.entries(startup).map(([name, at]) => [name, Math.round(at)]));
  const resources = performance.getEntriesByType('resource');
  const loadStats = { requests: resources.length, transferKB: Math.round(resources.reduce((sum, entry) => sum + (entry.transferSize || 0), 0) / 1024) };
  const metric = (name) => game().metrics.snapshot().find((entry) => entry.name === name)?.value;
  const pipelinesBefore = { sync: game().graphicsDevice.pipelines.sync, warmed: game().graphicsDevice.pipelines.warmed };
  const worldBefore = { loads: game().world.loads, unloads: game().world.unloads };
  // 显存和内存：飞行前后各读一次，飞过的格子卸载以后应该基本回到原来的数（涨得多就是泄漏）
  const memoryNow = () => ({ entities: metric('entities'), gpuBufferMB: +(metric('gpu.buffers.bytes') / 1048576).toFixed(1), gpuTextureMB: +(metric('gpu.textures.bytes') / 1048576).toFixed(1), nativeMB: +(metric('native.allocated.bytes') / 1048576).toFixed(1) });
  const memoryBefore = memoryNow();
  // 飞一圈：相机按路线挪，每帧记间隔
  const camera = game().entities.ids().map((id) => game().entities.entity(id)).find((entity) => entity.name === 'Camera');
  const position = camera.require(strideEngine.Transform).position;
  const from = { x: position.x, y: position.y, z: position.z };
  const frames = [];
  let last = performance.now();
  const flightStart = last;
  await new Promise((resolve) => {
    const step = (now) => {
      frames.push(now - last);
      last = now;
      const t = (now - flightStart) / 1000;
      const distance = ${speed} * t;
      const half = ${seconds} * ${speed} / 2;
      position.x = from.x + Math.min(distance, half);
      position.z = from.z + Math.max(0, distance - half);
      if (t < ${seconds}) requestAnimationFrame(step); else resolve();
    };
    requestAnimationFrame(step);
  });
  // 最后一段时间飞完以后让加载的格子落定，再数一次
  await wait(2000);
  const sorted = [...frames].sort((a, b) => a - b);
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  return {
    url: location.href,
    startupMs: { ...marks, rootScene: Math.round(rootAt), firstCell: firstCellAt === null ? null : Math.round(firstCellAt), nearCellsReady: settleAt === null ? null : Math.round(settleAt) },
    initialDownload: loadStats,
    flight: {
      frames: frames.length, medianMs: +at(0.5).toFixed(2), p95Ms: +at(0.95).toFixed(2), p99Ms: +at(0.99).toFixed(2), maxMs: +sorted[sorted.length - 1].toFixed(1),
      over50ms: frames.filter((ms) => ms > 50).length, over100ms: frames.filter((ms) => ms > 100).length,
    },
    memory: { before: memoryBefore, after: memoryNow() },
    world: { cellsLoaded: game().world.loads - worldBefore.loads, cellsUnloaded: game().world.unloads - worldBefore.unloads, loadedNow: game().world.loaded.length },
    pipelines: { syncDuringFlight: game().graphicsDevice.pipelines.sync - pipelinesBefore.sync, warmedDuringFlight: game().graphicsDevice.pipelines.warmed - pipelinesBefore.warmed, recentSync: game().graphicsDevice.pipelines.recentSync.slice(-8) },
    finalDownload: { requests: performance.getEntriesByType('resource').length, transferKB: Math.round(performance.getEntriesByType('resource').reduce((sum, entry) => sum + (entry.transferSize || 0), 0) / 1024) },
  };
})()`;

await closeBrowser();
// 不限帧率、关垂直同步：量的是引擎能多快，不是显示器的刷新率
const browser = await openUrl(url, { headless: !process.argv.includes('--headed'), size, dpr: 1, chromeArgs: ['--disable-frame-rate-limit', '--disable-gpu-vsync'] });
try {
  const cdp = await CdpSession.connect((await pageTarget(browser, base)).webSocketDebuggerUrl);
  const reply = (await cdp.send('Runtime.evaluate', { expression: measure, awaitPromise: true, returnByValue: true }, (seconds + 120) * 1000)) as { result: { value?: unknown }; exceptionDetails?: { exception?: { description?: string } } };
  if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.exception?.description ?? 'the measurement failed');
  const result = reply.result.value;
  lastResult = result;
  console.log(JSON.stringify(result, null, 2));
  if (out) await writeFile(out, JSON.stringify(result, null, 2));
} finally {
  await closeBrowser();
}
// --check：和 tools/streaming-budgets.json 里这个世界的预算比，超了退出码非 0（回归、验证用；要在空闲的机器上量）
if (process.argv.includes('--check')) {
  const { readFile } = await import('node:fs/promises');
  const budgets = JSON.parse(await readFile(path.resolve(import.meta.dirname, '..', 'streaming-budgets.json'), 'utf8')) as Record<string, Record<string, number>>;
  const budget = budgets[world];
  if (!budget) {
    console.error(`no budget for ${world} in tools/streaming-budgets.json`);
    process.exit(2);
  }
  type Memory = { gpuBufferMB: number; gpuTextureMB: number; nativeMB: number };
  const result = lastResult as { flight: { maxMs: number; over50ms: number; over100ms: number }; pipelines: { syncDuringFlight: number }; memory: { before: Memory; after: Memory } };
  const { before, after } = result.memory;
  const actual: Record<string, number> = {
    maxMs: result.flight.maxMs, over50ms: result.flight.over50ms, over100ms: result.flight.over100ms, syncDuringFlight: result.pipelines.syncDuringFlight,
    // 飞过的格子卸载以后显存、原生内存应该基本回到原来的数：涨得多就是泄漏
    gpuBufferGrowthMB: +(after.gpuBufferMB - before.gpuBufferMB).toFixed(1), gpuTextureGrowthMB: +(after.gpuTextureMB - before.gpuTextureMB).toFixed(1), nativeGrowthMB: +(after.nativeMB - before.nativeMB).toFixed(1),
  };
  const failed = Object.entries(budget).filter(([name, limit]) => (actual[name] ?? 0) > limit);
  for (const [name, limit] of Object.entries(budget)) console.error(`${(actual[name] ?? 0) > limit ? 'FAIL' : 'ok  '} ${name}: ${actual[name]} (budget ${limit})`);
  process.exit(failed.length > 0 ? 1 : 0);
}
process.exit(0);
