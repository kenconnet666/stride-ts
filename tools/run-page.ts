// 在自己的无头 Chrome 里打开一个不连调试中枢的页面（apps/bench 的各个页面），等它把结果放到全局变量上，打印页面的文字，
// 结果写成 JSON。和平时用的浏览器分开（记录和用户目录在 ~/.stride-ts/run-page），跑完就关。
//   node tools/run-page.ts <url> <结果的全局变量> [--error <出错的全局变量>] [--out <json 文件>] [--screenshot <png 文件>] [--timeout <秒，默认 300>]
//     [--chrome-arg <Chrome 的参数>]...（可以给几个，比如 CI 里用软件 WebGPU：--chrome-arg=--use-webgpu-adapter=swiftshader）
//   node tools/run-page.ts http://localhost:5182/displacement.html displacementResults --error displacementError
import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

// packages/cli 的状态目录在模块加载时读环境变量，所以先设好再导入
process.env['STRIDE_BROWSER_DIR'] = path.join(homedir(), '.stride-ts', 'run-page');
const { CdpSession, closeBrowser, openUrl, pageTarget } = await import('../packages/cli/src/chrome.ts');

const [url, result] = process.argv.slice(2);
const option = (name: string) => {
  const at = process.argv.indexOf(name);
  return at < 0 ? undefined : process.argv[at + 1];
};
if (!url || !result) throw new Error('usage: run-page.ts <url> <result global> [--error <error global>] [--out <file>] [--timeout <seconds>]');
const errorGlobal = option('--error'), deadline = Date.now() + Number(option('--timeout') ?? 300) * 1000;
const chromeArgs = process.argv.flatMap((arg, i) => (arg.startsWith('--chrome-arg=') ? [arg.slice('--chrome-arg='.length)] : arg === '--chrome-arg' ? [process.argv[i + 1]!] : []));

await closeBrowser();
const browser = await openUrl(url, { headless: true, size: [1280, 720], dpr: 1, chromeArgs });
let failed = false;
try {
  const cdp = await CdpSession.connect((await pageTarget(browser, url)).webSocketDebuggerUrl);
  const evaluate = async (expression: string) =>
    ((await cdp.send('Runtime.evaluate', { expression, returnByValue: true })) as { result: { value?: unknown } }).result.value;
  for (;;) {
    const state = (await evaluate(`({ done: globalThis[${JSON.stringify(result)}] !== undefined, error: ${errorGlobal ? `globalThis[${JSON.stringify(errorGlobal)}]` : 'undefined'} ?? null })`)) as { done: boolean; error: string | null };
    if (state.done || state.error !== null) {
      failed = state.error !== null;
      break;
    }
    if (Date.now() > deadline) throw new Error(`${url}: globalThis.${result} was not set in time`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  console.log(await evaluate('document.body.innerText'));
  const screenshot = option('--screenshot');
  if (screenshot) {
    const { data } = (await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })) as { data: string };
    writeFileSync(screenshot, Buffer.from(data, 'base64'));
  }
  const out = option('--out');
  if (out && !failed) writeFileSync(out, JSON.stringify(await evaluate(`globalThis[${JSON.stringify(result)}]`), null, 2));
} finally {
  await closeBrowser();
}
process.exit(failed ? 1 : 0);
