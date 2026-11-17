// Usage: node play.cjs <path of playwright> <url> <script.json> <output folder> [rounds]
// Plays a game in a visible Chrome with the steps of a script, several rounds (the page is loaded again for each), and
// reports the errors of the page, the frames and the longest frame gaps, with screenshots.
// Steps (canvas pixels are those of the canvas element on the page, origin at its top left):
//   {"wait": ms}                     {"shot": "name"}
//   {"key": "Space"}                 a press and a release
//   {"down": "KeyW"} {"up": "KeyW"}
//   {"hold": "KeyW", "ms": 1500}     a key held for a time
//   {"click": [x, y]} {"rclick": [x, y]}   a click on the canvas
//   {"mousedown": [x, y]} {"mouseup": true}
//   {"move": [x, y], "steps": 10}    the mouse to a point of the canvas
//   {"look": [dx, dy], "steps": 10}  the mouse by an offset from where it is
//   {"repeat": n, "steps": [...]}
const { chromium } = require(process.argv[2]);
const fs = require('fs');
const path = require('path');
(async () => {
  const [url, scriptFile, out] = process.argv.slice(3);
  const rounds = +(process.argv[6] ?? 1);
  const script = JSON.parse(fs.readFileSync(scriptFile, 'utf8'));
  fs.mkdirSync(out, { recursive: true });
  // Headless unless PLAY_HEADED=1 (the pointer lock needs a window): a hidden window gives no new frame to screenshot
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: process.env.PLAY_HEADED !== '1', args: ['--enable-unsafe-webgpu'] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  // GPU submits and the ones done, to tell a stuck GPU from a page without a new frame
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
  // PLAY_LOG=<text>: the console lines with that text are printed as they come, with the time
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
    // Frame gaps: the page records the time of each frame counter change
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
        // The area of the canvas on the page: a screenshot of the element waits for the page to locate it
        else if (step.shot) {
          try { await page.screenshot({ path: path.join(out, `r${round}-${String(shot++).padStart(2, '0')}-${step.shot}.png`), clip: box, timeout: 20000 }); }
          catch {
            const s = await Promise.race([page.evaluate(() => ({ frames: (globalThis.strideGame ?? globalThis.sampleResult).frames, gpu: globalThis.gpuStats })), new Promise(r => setTimeout(() => r('no answer'), 3000))]);
            console.log(`  no screenshot "${step.shot}" in 20 s: ${JSON.stringify(s)}`);
          }
        }
        else if (step.key) await page.keyboard.press(step.key);
        else if (step.down) await page.keyboard.down(step.down);
        else if (step.up) await page.keyboard.up(step.up);
        else if (step.hold) { await page.keyboard.down(step.hold); await page.waitForTimeout(step.ms ?? 500); await page.keyboard.up(step.hold); }
        // A click lasts 80 ms, as a hand's does: a game that reads whether a button is down sees it in a frame
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
    // PLAY_RECORD=<file>: the effects the page asked for are merged into that effect request file
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
