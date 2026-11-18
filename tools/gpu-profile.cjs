// 打开 GpuProfiler 测几秒，打印各渲染通道（按作用域分组）的平均 GPU 毫秒数；DETAIL=1 时再列出每个"作用域/通道"。
// 开着 --enable-webgpu-developer-features（时间戳不量化）、去掉帧率上限；CHROME_ARGS 里的参数（空格分隔）也传给 Chrome，比如 --enable-dawn-features=use_dxc。
// 用法：node gpu-profile.cjs <playwright> <地址> [秒数]
const { chromium } = require(process.argv[2]);
const seconds = Number(process.argv[4] ?? 3);
(async () => {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', args: ['--enable-webgpu-developer-features', '--disable-frame-rate-limit', '--disable-gpu-vsync', ...(process.env.CHROME_ARGS?.split(' ').filter(Boolean) ?? [])] });
  // VIEWPORT=宽x高 改视口（默认 1400x900），比如 VIEWPORT=3840x2160 测 4K
  const [width, height] = (process.env.VIEWPORT ?? '1400x900').split('x').map(Number);
  const page = await browser.newPage({ viewport: { width, height } });
  await page.goto(process.argv[3]);
  await page.waitForFunction(() => globalThis.strideGame?.frames > 120, null, { timeout: 60000 });
  const supported = await page.evaluate(() => { const p = globalThis.strideGame.graphicsDevice.profiler; p.enabled = true; return p.supported; });
  await page.waitForTimeout(500);
  await page.evaluate(() => globalThis.strideGame.graphicsDevice.profiler.reset());
  const a = await page.evaluate(() => [globalThis.strideGame.frames, performance.now()]);
  await page.waitForTimeout(seconds * 1000);
  const b = await page.evaluate(() => [globalThis.strideGame.frames, performance.now()]);
  const report = await page.evaluate(() => globalThis.strideGame.graphicsDevice.profiler.report());
  console.log(`timestamp-query: ${supported}; frame ${((b[1] - a[1]) / (b[0] - a[0])).toFixed(2)} ms`);
  const groups = new Map();
  for (const [label, t] of report) {
    const group = label.includes('/') ? label.slice(0, label.indexOf('/')) : label;
    const g = groups.get(group) ?? { ms: 0, passes: 0 };
    g.ms += t.milliseconds; g.passes += t.passes; groups.set(group, g);
  }
  let total = 0;
  for (const [group, g] of [...groups].sort((x, y) => y[1].ms - x[1].ms)) { total += g.ms; console.log(`  ${group.padEnd(28)} ${g.ms.toFixed(3)} ms  ${g.passes.toFixed(0)} passes`); }
  console.log(`  ${'sum of passes'.padEnd(28)} ${total.toFixed(3)} ms`);
  if (process.env.DETAIL) for (const [label, t] of report) console.log(`    ${label.padEnd(44)} ${t.milliseconds.toFixed(3)} ms x${t.passes.toFixed(0)}`);
  await browser.close();
})();
