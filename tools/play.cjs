// 用法：node play.cjs <playwright 路径> <url> <script.json> <输出目录> [轮数]
// 按脚本里的步骤在 Chrome 里试玩游戏，可以跑几轮（每轮重新加载页面），报告页面错误、帧数和最长的帧间隔，并截图。
// 步骤（画布坐标是页面上 canvas 元素的像素，原点在左上角）：
//   {"wait": ms}                     {"shot": "name"}
//   {"key": "Space"}                 按下再松开
//   {"down": "KeyW"} {"up": "KeyW"}
//   {"hold": "KeyW", "ms": 1500}     按住一段时间
//   {"click": [x, y]} {"rclick": [x, y]}   在画布上点击
//   {"mousedown": [x, y]} {"mouseup": true}
//   {"move": [x, y], "steps": 10}    鼠标移到画布上的一点
//   {"look": [dx, dy], "steps": 10}  鼠标从当前位置移动一段偏移
//   {"repeat": n, "steps": [...]}
const { chromium } = require(process.argv[2]);
const fs = require('fs');
const path = require('path');
(async () => {
  const [url, scriptFile, out] = process.argv.slice(3);
  const rounds = +(process.argv[6] ?? 1);
  const script = JSON.parse(fs.readFileSync(scriptFile, 'utf8'));
  fs.mkdirSync(out, { recursive: true });
  // 默认无头；PLAY_HEADED=1 时开窗口（指针锁定需要窗口）。隐藏的窗口不出新帧，截不到图
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: process.env.PLAY_HEADED !== '1', args: ['--enable-unsafe-webgpu'] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  // 记下提交给 GPU 的次数和完成的次数，用来区分 GPU 卡住和页面没出新帧
  await page.addInitScript(() => {
    globalThis.gpuStats = { submitted: 0, done: 0 };
    const submit = GPUQueue.prototype.submit;
    GPUQueue.prototype.submit = function (buffers) {
      const r = submit.call(this, buffers);
      const n = ++globalThis.gpuStats.submitted;
      if (n % 10 === 0) this.onSubmittedWorkDone().then(() => { globalThis.gpuStats.done = Math.max(globalThis.gpuStats.done, n); });
      return r;
    };
  });
  let errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + String(e).slice(0, 400)));
  page.on('console', m => { if (m.type() === 'error' && !/favicon|404/.test(m.text())) errors.push(m.text().slice(0, 400)); });
  // PLAY_LOG=<文字>：控制台里包含这段文字的行，带时间实时打印
  const logStart = Date.now();
  if (process.env.PLAY_LOG) page.on('console', m => { if (m.text().includes(process.env.PLAY_LOG)) console.log(`  ${((Date.now() - logStart) / 1000).toFixed(1)}s ${m.text().slice(0, 300)}`); });
  const state = () => page.evaluate(() => {
    const s = globalThis.strideGame ?? globalThis.sampleResult;
    return s && { status: s.status, frames: s.frames, error: s.error ?? s.managedError ?? null };
  });
  for (let round = 1; round <= rounds; round++) {
    errors = [];
    await page.goto(url);
    await page.waitForFunction(() => {
      const s = globalThis.strideGame ?? globalThis.sampleResult;
      return s && (s.status === 'failed' || (s.status === 'running' && (s.sceneFrame !== undefined ? s.frames > s.sceneFrame + 30 : s.entities > 0)));
    }, null, { timeout: 400000 });
    // 帧间隔：页面记下帧计数每次变化的时间
    await page.evaluate(() => {
      const s = globalThis.strideGame ?? globalThis.sampleResult;
      globalThis.playGaps = []; let last = performance.now(), frames = s.frames;
      const tick = () => { const now = performance.now(); if (s.frames !== frames) { globalThis.playGaps.push(now - last); last = now; frames = s.frames; } requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    });
    const canvas = page.locator('canvas').first();
    const box = await canvas.boundingBox();
    let mouse = [box.x + box.width / 2, box.y + box.height / 2];
    const at = p => [box.x + p[0], box.y + p[1]];
    let shot = 0;
    const run = async steps => {
      for (const step of steps) {
        if (step.wait) await page.waitForTimeout(step.wait);
        // 画布在页面上的区域：对元素截图会等页面定位好它
        else if (step.shot) {
          try { await page.screenshot({ path: path.join(out, `r${round}-${String(shot++).padStart(2, '0')}-${step.shot}.png`), clip: box, timeout: 20000 }); }
          catch {
            const s = await Promise.race([page.evaluate(() => ({ frames: (globalThis.strideGame ?? globalThis.sampleResult).frames, gpu: globalThis.gpuStats })), new Promise(r => setTimeout(() => r('no answer'), 3000))]);
            console.log(`  no screenshot "${step.shot}" in 20 s: ${JSON.stringify(s)}`);
          }
        }
        else if (step.key) await page.keyboard.press(step.key);
        else if (step.eval) await page.evaluate(step.eval);
        else if (step.down) await page.keyboard.down(step.down);
        else if (step.up) await page.keyboard.up(step.up);
        else if (step.hold) { await page.keyboard.down(step.hold); await page.waitForTimeout(step.ms ?? 500); await page.keyboard.up(step.hold); }
        // 一次点击持续 80 ms，和人手一样：按帧检查按键是否按下的游戏能看到它
        else if (step.click) { mouse = at(step.click); await page.mouse.click(...mouse, { delay: 80 }); }
        else if (step.rclick) { mouse = at(step.rclick); await page.mouse.click(...mouse, { button: 'right', delay: 80 }); }
        else if (step.mousedown) { mouse = at(step.mousedown); await page.mouse.move(...mouse); await page.mouse.down(); }
        else if (step.mouseup) await page.mouse.up();
        else if (step.move) { mouse = at(step.move); await page.mouse.move(...mouse, { steps: step.steps ?? 10 }); }
        else if (step.look) { mouse = [mouse[0] + step.look[0], mouse[1] + step.look[1]]; await page.mouse.move(...mouse, { steps: step.steps ?? 10 }); }
        else if (step.repeat) for (let i = 0; i < step.repeat; i++) await run(step.steps);
      }
    };
    const before = await state();
    const start = Date.now();
    await run(script);
    const after = await state();
    const gaps = await page.evaluate(() => globalThis.playGaps.slice().sort((a, b) => b - a));
    const seconds = (Date.now() - start) / 1000;
    console.log(`round ${round}: ${after.status}, ${after.frames - before.frames} frames in ${seconds.toFixed(0)} s` +
      ` (${((after.frames - before.frames) / seconds).toFixed(1)}/s), longest gaps ${gaps.slice(0, 3).map(g => g.toFixed(0)).join(', ')} ms` +
      (after.error ? `\n  error: ${String(after.error).slice(0, 800)}` : ''));
    for (const e of [...new Set(errors)].slice(0, 6)) console.log('  ' + e.replace(/\s+/g, ' ').slice(0, 300));
    // PLAY_RECORD=<文件>：页面请求过的效果合并进这个效果请求文件
    if (process.env.PLAY_RECORD) {
      const captured = new Map();
      try { for (const r of JSON.parse(fs.readFileSync(process.env.PLAY_RECORD, 'utf8'))) captured.set(r.hash, r); } catch { }
      const count = captured.size;
      for (const r of await page.evaluate(() => globalThis.sampleEffectRequests || globalThis.strideEffectRequests || [])) captured.set(r.hash, r);
      fs.writeFileSync(process.env.PLAY_RECORD, JSON.stringify([...captured.values()].sort((a, b) => a.hash.localeCompare(b.hash)), null, 2));
      console.log(`  effect requests: ${count} -> ${captured.size}`);
    }
    if (after.status !== 'running') break;
  }
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
