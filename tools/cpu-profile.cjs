// 用法：node cpu-profile.cjs <playwright> <url> [秒数] [符号文件]
// 不限帧率的无头 Chrome：场景开始绘制后，对主线程采样若干秒，按类别（wasm、JS、GC、空闲）打印自身时间，
// 以及最耗时的函数和主要调用者的包含时间。符号文件（每行 "下标:名字"，来自 WasmEmitSymbolMap）
// 给去掉符号的构建里的 wasm 函数补上名字。
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
