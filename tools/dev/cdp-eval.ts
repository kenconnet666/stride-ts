// 页面没连上调试中枢时（游戏启动前就出错、卡在加载）直接经 DevTools 协议在 stride 启动的 Chrome 里求值，看报错和页面文字。
//   node tools/dev/cdp-eval.ts [--headless] [--reload] [<表达式>]   默认看页面文字；--reload 先重新加载、等 15 秒，报这期间的异常和控制台的错误
// 例：node tools/dev/cdp-eval.ts --headless "document.title"
import { CdpSession } from '../../packages/cli/src/chrome.ts';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const headless = args.includes('--headless');
const reload = args.includes('--reload');
const expression = args.find((arg) => !arg.startsWith('--')) ?? `JSON.stringify({ url: location.href, text: document.body?.innerText.slice(0, 2000), errors: window.__strideErrors ?? null })`;
const profile = path.join(os.homedir(), '.stride-ts', headless ? 'chrome-headless' : 'chrome');
const [port] = readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n');
const pages = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as { type: string; url: string; webSocketDebuggerUrl: string }[];
for (const target of pages.filter((page) => page.type === 'page')) {
  await using page = await CdpSession.connect(target.webSocketDebuggerUrl);
  const exceptions: string[] = [];
  page.on('Runtime.exceptionThrown', (params) => {
    const { exceptionDetails } = params as { exceptionDetails: { exception?: { description?: string }; text: string } };
    exceptions.push(exceptionDetails.exception?.description ?? exceptionDetails.text);
  });
  page.on('Runtime.consoleAPICalled', (params) => {
    const { type, args } = params as { type: string; args: { value?: unknown; description?: string }[] };
    if (type === 'error' || type === 'warning') exceptions.push(`console.${type}: ${args.map((arg) => arg.value ?? arg.description).join(' ')}`);
  });
  await page.send('Runtime.enable', {});
  if (reload) {
    await page.send('Page.reload', {});
    await new Promise((resolve) => setTimeout(resolve, 15_000));
  }
  const result = await page.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }) as { result: { value?: unknown; description?: string } };
  console.log(target.url, '\n', result.result.value ?? result.result.description);
  if (exceptions.length > 0) console.log('exceptions:', exceptions.join('\n'));
}
