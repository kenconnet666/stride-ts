// Usage: node aot-log.cjs <playwright> <url>: loads a page with Mono's AOT log on and prints the console lines about AOT.
const { chromium } = require(process.argv[2]);
(async () => {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--enable-unsafe-webgpu'] });
  const page = await browser.newPage();
  await page.route('**/main.js', async route => {
    const body = await (await route.fetch()).text();
    await route.fulfill({ contentType: 'text/javascript', body: body.replace('dotnet.create()', "dotnet.withEnvironmentVariable('MONO_LOG_LEVEL', 'debug').withEnvironmentVariable('MONO_LOG_MASK', 'aot').create()") });
  });
  const lines = [];
  page.on('console', m => lines.push(m.text()));
  page.on('pageerror', e => lines.push('pageerror ' + e));
  await page.goto(process.argv[3]);
  await page.waitForTimeout(25000);
  const aot = lines.filter(l => /AOT|aot|GUID|doesn't match|out of date|Failed/.test(l));
  console.log(aot.slice(-25).map(l => l.slice(0, 300)).join('\n'));
  await browser.close();
})();
