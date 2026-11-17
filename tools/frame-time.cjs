// Usage: node frame-time.cjs <path of playwright> <url>
// Headless Chrome without frame rate limit: the average frame time over 600 frames once the scene is there.
const { chromium } = require(process.argv[2]);
(async () => {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--enable-unsafe-webgpu', '--disable-gpu-vsync', '--disable-frame-rate-limit'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(process.argv[3]);
  await page.waitForFunction(() => globalThis.strideGame && globalThis.strideGame.frames > (globalThis.strideGame.sceneFrame ?? Infinity) + 120, null, { timeout: 300000 });
  const a = await page.evaluate(() => [globalThis.strideGame.frames, performance.now()]);
  await page.waitForFunction(n => globalThis.strideGame.frames >= n, a[0] + 600, { timeout: 300000 });
  const b = await page.evaluate(() => [globalThis.strideGame.frames, performance.now()]);
  console.log(((b[1] - a[1]) / (b[0] - a[0])).toFixed(2) + ' ms a frame');
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
