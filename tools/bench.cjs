// Usage: node bench.cjs <path of playwright> <url> [out.json]
// Runs apps/bench in headless Chrome (WebGPU on, no frame rate limit) and prints its result table.
const { chromium } = require(process.argv[2]);
const fs = require('node:fs');
(async () => {
  const browser = await chromium.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: true,
    args: ['--enable-unsafe-webgpu', '--disable-gpu-vsync', '--disable-frame-rate-limit'],
  });
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('page error:', e.message));
  await page.goto(process.argv[3]);
  await page.waitForFunction(() => globalThis.benchResults || globalThis.benchError, null, { timeout: 600000 });
  console.log(await page.evaluate(() => document.getElementById('out').textContent));
  if (process.argv[4]) {
    fs.writeFileSync(process.argv[4], JSON.stringify(await page.evaluate(() => globalThis.benchResults), null, 2));
  }
  const failed = await page.evaluate(() => globalThis.benchError);
  await browser.close();
  if (failed) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
