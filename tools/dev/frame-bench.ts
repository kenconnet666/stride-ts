// 4K 帧时间的预算（项目的帧率目标：这台机器上稳定的 4K 30 Hz，用户 2026-11-24；4K 守住了 1080p 不另量）：在几个代表性的
// 画面里开 3840×2160 的无头 Chrome（画质用默认的极高），等画面稳下来，stride perf 量几秒，看
//   CPU：每帧的更新加绘制（updateMs + drawMs）的 p99；
//   GPU：每帧各通道加起来（gpu.frameTotalMs）的 p99 和最长；
// 都要在一帧 33.3 毫秒以内，--check 时还和 tools/frame-budgets.json 里记的基线比（基线是上次 --update 量到的乘 1.15）。
//   node tools/dev/frame-bench.ts [--check] [--update] [--only <名字的一部分>] [--seconds 4]
// 要独占显卡（量帧时间），别和回归、别的测量同时跑；借各样例的开发服务器（没开就开一个，用完 pwsh tools/stop-dev.ps1 停）。
import { spawn, spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..', '..');
const budgetsFile = path.join(root, 'tools', 'frame-budgets.json');
/** 一帧的上限（毫秒）：30 Hz。 */
const FRAME_LIMIT_MS = 1000 / 30;
/** --update 时基线比量到的宽多少。 */
const MARGIN = 1.15;

interface Case {
  readonly name: string;
  readonly app: string;
  readonly port: number;
  readonly query: string;
}

/** 照片比对的两个场景（光追阴影、反射、辐照度体都开着），开放世界的山谷（地形、植被、水、城镇）。 */
const CASES: readonly Case[] = [
  { name: 'photoreal Subway', app: 'photoreal', port: 5234, query: 'scene=Subway' },
  { name: 'photoreal Supermarket', app: 'photoreal', port: 5234, query: 'scene=Supermarket' },
  { name: 'open-world Valley', app: 'open-world', port: 5232, query: 'world=Worlds/Valley' },
];

interface Budget {
  readonly cpuP99: number;
  readonly gpuP99: number;
}

interface Measured extends Budget {
  readonly gpuMax: number;
}

const option = (name: string, fallback: string) => {
  const at = process.argv.indexOf(name);
  return at < 0 ? fallback : process.argv[at + 1]!;
};
const seconds = Number(option('--seconds', '4'));
const only = option('--only', '');
const check = process.argv.includes('--check');
const update = process.argv.includes('--update');

/** 跑调试 CLI，返回解析后的 JSON 输出。 */
function stride(...args: string[]): unknown {
  // 参数都是这里拼的（地址已带引号）：整条命令交给 shell
  const result = spawnSync(`pnpm exec stride ${args.join(' ')}`, { cwd: root, shell: true, encoding: 'utf8', timeout: 300_000 });
  if (result.status !== 0) throw new Error(`stride ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  const text = result.stdout.trim();
  return text.startsWith('{') || text.startsWith('[') ? JSON.parse(text) : text;
}

async function ensureServer(app: string, port: number): Promise<void> {
  const reachable = () => fetch(`http://localhost:${port}/`).then(() => true, () => false);
  if (await reachable()) return;
  spawn(`pnpm -F @stride-ts/${app} dev --strictPort --port ${port}`, { cwd: root, shell: true, detached: true, stdio: 'ignore' }).unref();
  // 第一次开要补烘生成的模型，可能要一两分钟
  for (let i = 0; i < 240 && !(await reachable()); i++) await new Promise((resolve) => setTimeout(resolve, 1000));
  if (!(await reachable())) throw new Error(`the ${app} dev server did not start on port ${port}`);
}

async function measure(entry: Case): Promise<Measured> {
  await ensureServer(entry.app, entry.port);
  stride('open', `"http://localhost:${entry.port}/?${entry.query}"`, '--headless', '--size', '3840x2160', '--dpr', '1');
  try {
    stride('wait');
    // 时间累积的效果、流式加载的格子、后台编的管线都稳下来
    stride('wait', '--game', '5');
    const perf = stride('perf', '--seconds', String(seconds)) as {
      updateMs: { p99: number } | null;
      drawMs: { p99: number } | null;
      gpu: { frameTotalMs: { p99: number; max: number } } | string;
    };
    if (typeof perf.gpu === 'string') throw new Error(`${entry.name}: ${perf.gpu}`);
    return { cpuP99: (perf.updateMs?.p99 ?? 0) + (perf.drawMs?.p99 ?? 0), gpuP99: perf.gpu.frameTotalMs.p99, gpuMax: perf.gpu.frameTotalMs.max };
  } finally {
    stride('close');
  }
}

const budgets = JSON.parse(await readFile(budgetsFile, 'utf8').catch(() => '{}')) as Record<string, Budget>;
const round = (value: number) => Math.round(value * 100) / 100;
let failed = false;
for (const entry of CASES.filter((c) => c.name.includes(only))) {
  const measured = await measure(entry);
  const budget = budgets[entry.name];
  const problems: string[] = [];
  if (measured.cpuP99 > FRAME_LIMIT_MS) problems.push(`CPU p99 ${round(measured.cpuP99)} ms over the 30 Hz frame`);
  if (measured.gpuP99 > FRAME_LIMIT_MS) problems.push(`GPU p99 ${round(measured.gpuP99)} ms over the 30 Hz frame`);
  if (check && budget && measured.cpuP99 > budget.cpuP99) problems.push(`CPU p99 ${round(measured.cpuP99)} ms over the budget ${budget.cpuP99}`);
  if (check && budget && measured.gpuP99 > budget.gpuP99) problems.push(`GPU p99 ${round(measured.gpuP99)} ms over the budget ${budget.gpuP99}`);
  console.log(`${problems.length ? 'FAIL' : 'ok  '} ${entry.name}: CPU p99 ${round(measured.cpuP99)} ms, GPU p99 ${round(measured.gpuP99)} ms (max ${round(measured.gpuMax)})${budget ? ` budget CPU ${budget.cpuP99} GPU ${budget.gpuP99}` : ''}`);
  for (const problem of problems) console.log(`     ${problem}`);
  failed ||= problems.length > 0;
  if (update) budgets[entry.name] = { cpuP99: round(Math.min(FRAME_LIMIT_MS, measured.cpuP99 * MARGIN)), gpuP99: round(Math.min(FRAME_LIMIT_MS, measured.gpuP99 * MARGIN)) };
}
if (update) await writeFile(budgetsFile, `${JSON.stringify(budgets, null, 2)}\n`);
process.exit(failed ? 1 : 0);
