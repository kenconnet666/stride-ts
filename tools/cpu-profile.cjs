// Usage: node cpu-profile.cjs <playwright> <url> [seconds] [symbols file]
// Headless Chrome without frame rate limit: once the scene draws, samples the main thread for some seconds and prints
// the self time by kind (wasm, JS, GC, idle) and the costliest functions, with the inclusive time of the top callers.
// A symbols file (lines "index:name", from WasmEmitSymbolMap) names the wasm functions of a stripped build.
const { chromium } = require(process.argv[2]);
const fs = require('fs');
(async () => {
  const [url, seconds = '5', symbolsFile] = process.argv.slice(3);
  const symbols = new Map();
  if (symbolsFile) for (const line of fs.readFileSync(symbolsFile, 'utf8').split('\n')) { const i = line.indexOf(':'); if (i > 0) symbols.set(+line.slice(0, i), line.slice(i + 1).trim()); }
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--enable-unsafe-webgpu', '--disable-gpu-vsync', '--disable-frame-rate-limit'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(url);
  await page.waitForFunction(() => globalThis.strideGame && globalThis.strideGame.frames > (globalThis.strideGame.sceneFrame ?? Infinity) + 120, null, { timeout: 300000 });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 100 });
  const f0 = await page.evaluate(() => globalThis.strideGame.frames);
  await cdp.send('Profiler.start');
  await page.waitForTimeout(+seconds * 1000);
  const { profile } = await cdp.send('Profiler.stop');
  if (process.env.PROFILE_OUT) fs.writeFileSync(process.env.PROFILE_OUT, JSON.stringify(profile));
  const f1 = await page.evaluate(() => globalThis.strideGame.frames);
  const frames = f1 - f0;

  const nodes = new Map(profile.nodes.map(n => [n.id, n]));
  const parent = new Map();
  for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const dt = new Map();
  for (let i = 0; i < profile.samples.length; i++) dt.set(i, profile.timeDeltas[i + 1] ?? 0);
  const name = n => {
    const cf = n.callFrame;
    let f = cf.functionName || '(anonymous)';
    const m = /^\$?wasm-function\[(\d+)\]$/.exec(f) ?? /^\$func(\d+)$/.exec(f);
    if (m && symbols.has(+m[1])) f = symbols.get(+m[1]);
    const where = cf.url.endsWith('.wasm') ? 'wasm' : cf.url ? cf.url.split('/').pop() : '';
    return `${f} [${where}]`;
  };
  const kind = n => {
    const cf = n.callFrame;
    if (cf.url.endsWith('.wasm') || cf.url.startsWith('wasm://')) return 'wasm';
    if (['(idle)', '(program)', '(garbage collector)', '(root)'].includes(cf.functionName)) return cf.functionName;
    return 'js ' + (cf.url.split('/').pop() || '(native)');
  };
  const self = new Map(), total = new Map(), kinds = new Map();
  let all = 0;
  profile.samples.forEach((id, i) => {
    const t = dt.get(i) / 1000; all += t;
    const n = nodes.get(id);
    self.set(name(n), (self.get(name(n)) ?? 0) + t);
    kinds.set(kind(n), (kinds.get(kind(n)) ?? 0) + t);
    const seen = new Set();
    for (let p = id; p !== undefined; p = parent.get(p)) { const k = name(nodes.get(p)); if (!seen.has(k)) { seen.add(k); total.set(k, (total.get(k) ?? 0) + t); } }
  });
  const perFrame = ms => (ms / frames).toFixed(2).padStart(7);
  console.log(`${frames} frames in ${all.toFixed(0)} ms: ${(all / frames).toFixed(2)} ms a frame`);
  console.log('-- self time by kind (ms a frame)');
  for (const [k, v] of [...kinds].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(perFrame(v), k);
  console.log('-- self time (ms a frame)');
  for (const [k, v] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 45)) console.log(perFrame(v), k.slice(0, 160));
  console.log('-- inclusive time (ms a frame)');
  for (const [k, v] of [...total].sort((a, b) => b[1] - a[1]).slice(0, 60)) console.log(perFrame(v), k.slice(0, 160));
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
