// 页面外壳的加载骨架的时间线（路线图"加载与缓存"的第 1 步，docs/stages.md）：重新加载一个游戏页面，记下加载骨架出现、各个阶段
// （native、content、scene）、淡出、摘掉的时刻，和第一帧的时刻（相对导航开始），顺便在每个阶段截一张图。
//   node tools/dev/loading-timeline.ts [--url http://localhost:5232/?world=Worlds/Valley] [--shots <目录>]
// 要先有开发服务器（或 preview）开着；用 stride 自己的无头 Chrome。
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

process.env['STRIDE_BROWSER_DIR'] = path.join(homedir(), '.stride-ts', 'loading-timeline');
const { CdpSession, closeBrowser, openUrl, pageTarget } = await import('@stride-ts/cli/chrome');

const option = (name: string, fallback: string) => {
  const at = process.argv.indexOf(name);
  return at < 0 ? fallback : process.argv[at + 1]!;
};
const url = option('--url', 'http://localhost:5232/?world=Worlds/Valley');
const shots = option('--shots', '');

/** 每个新文档开头注入：用 MutationObserver 记骨架元素的出现、data-phase 的变化、摘掉的时刻。 */
const RECORDER = `(() => {
  const timeline = (window.__loadingTimeline = []);
  const note = (what) => timeline.push([what, Math.round(performance.now())]);
  const watch = () => {
    const element = document.getElementById('stride-loading');
    if (!element) return false;
    note('shown:' + (element.dataset.phase ?? 'boot'));
    new MutationObserver(() => note('phase:' + element.dataset.phase)).observe(element, { attributes: true, attributeFilter: ['data-phase'] });
    new MutationObserver((_, observer) => { if (!document.getElementById('stride-loading')) { note('removed'); observer.disconnect(); } }).observe(document.body, { childList: true });
    return true;
  };
  new MutationObserver((_, observer) => { if (watch()) observer.disconnect(); }).observe(document, { childList: true, subtree: true });
})();`;

await closeBrowser();
const record = await openUrl('about:blank', { headless: true, size: [1280, 720], dpr: 1, chromeArgs: ['--disable-frame-rate-limit'] });
const target = await pageTarget(record, 'about:blank');
const cdp = await CdpSession.connect(target.webSocketDebuggerUrl);
try {
  await cdp.send('Page.enable', {});
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: RECORDER });
  await cdp.send('Page.navigate', { url });
  const evaluate = async (expression: string) => ((await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })) as { result: { value?: unknown } }).result.value;
  if (shots) await mkdir(shots, { recursive: true });
  const seen = new Set<string>();
  for (let i = 0; i < 400; i++) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    const phase = (await evaluate(`document.getElementById('stride-loading')?.dataset.phase ?? (document.getElementById('stride-loading') ? 'boot' : 'gone')`)) as string | undefined;
    if (phase && !seen.has(phase) && shots) {
      seen.add(phase);
      const { data } = (await cdp.send('Page.captureScreenshot', { format: 'png' })) as { data: string };
      await writeFile(path.join(shots, `${seen.size}-${phase}.png`), Buffer.from(data, 'base64'));
    }
    if (phase === 'gone') break;
  }
  const result = await evaluate(`({ timeline: window.__loadingTimeline, firstFrame: Math.round(strideGame?.startup?.firstFrame ?? -1), startup: strideGame?.startup })`);
  console.log(JSON.stringify(result, null, 2));
} finally {
  await closeBrowser();
}
process.exit(0);
