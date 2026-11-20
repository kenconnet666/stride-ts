// 样例冒烟脚本（apps/*/scripts/smoke.ts）共用的部分：调用调试 CLI、记录检查结果、最后看有没有错误日志。
//   const smoke = startSmoke('physics-sample');   // 命令行的 --hub 覆盖默认的中枢名
//   smoke.check('在跑', (smoke.stride('status') as { status: string }).status === 'running', ...);
//   smoke.finish();                                // 查本次运行以来的错误日志，按结果退出
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'packages', 'cli', 'src', 'cli.ts');

export interface Smoke {
  /** 跑一条调试 CLI 命令，返回它输出的 JSON。 */
  stride(...args: string[]): unknown;
  sleep(ms: number): Promise<void>;
  check(name: string, ok: boolean, detail: unknown): void;
  /** 检查本次运行以来没有错误日志（中枢留着之前的页面的日志，不算），然后按结果退出。 */
  finish(): never;
}

/**
 * 页面里的帮手：冒烟脚本开头 `stride('eval', PAGE_HELPERS)` 装一次，之后的 eval 里直接用。
 *   frames(n)                        等 n 帧（只用来等事件传到下一帧；表示一段时间用 seconds）
 *   seconds(s)                       等游戏时间走过 s 秒：帧率随机器变（无头 Chrome 在有的机器上 60、有的 120 fps），按帧数等的时长跟着变
 *   lines()                          屏幕上的调试文字
 *   named(name)                      这个名字的实体（数组）
 *   position(name)、rotation(name)   第一个这个名字的实体的本地位置、旋转（数组）
 *   tap(code)、hold(code, n)          按一下键、按住 n 帧（返回按着时的调试文字）；code 是 KeyboardEvent.code
 *   holdFor(code, s, sample?)        按住 s 秒游戏时间再松开，返回松开前一刻 sample() 的值。要"按多久"时用它，不用 CLI 的
 *                                    key --down/--up：每条 CLI 命令是一个新进程，单核慢的机器上一条要接近一秒，松开就晚到了
 *   frame()                          等一帧
 *   until(fn, s)                     每帧看一次 fn()，真了就返回它的值；最多等 s 秒游戏时间，到了返回最后一次的值。"等到某个状态"都用它，
 *                                    不按墙钟等（CI 的软件 WebGPU 上一帧几百毫秒），也不按帧数等（帧率随机器变）
 *   sceneChanged(from)               等根场景从 from 换掉、新场景画过一帧（换场景要加载、编管线，慢的机器上几秒到几十秒）；返回新场景的名字
 *   pointerAt(type, x, y, target?)   在画布的 (x, y)（CSS 像素）发一个合成的指针事件（连同对应的鼠标事件）；松开发给 window
 *   click(x, y, button = 0)          在画布的 (x, y)（CSS 像素）点一下鼠标（合成事件，锁不了指针）
 *   uiElements()                     所有页面的全部 UI 元素
 *   uiFind(name)                     这个名字的 UI 元素
 *   uiPoint(nameOrElement)           全屏 UI 的元素的中心在画布上的位置（CSS 像素）
 *   uiClick(nameOrElement)           点它的中心
 * 样例自己的帮手在它之后装，用这些拼。
 */
export const PAGE_HELPERS = `(() => {
  const E = strideEngine, G = strideGame, canvas = G.graphicsDevice.canvas;
  const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
  const key = (type, code) => window.dispatchEvent(new KeyboardEvent(type, { code }));
  const pointer = (type, x, y, button, target = canvas) => {
    const r = canvas.getBoundingClientRect();
    const init = { clientX: r.left + x, clientY: r.top + y, pointerId: 1, pointerType: 'mouse', bubbles: true, button };
    target.dispatchEvent(new PointerEvent(type, init));
    const mouse = { pointermove: 'mousemove', pointerdown: 'mousedown', pointerup: 'mouseup' }[type];
    (type === 'pointerdown' ? canvas : window).dispatchEvent(new MouseEvent(mouse, init));
  };
  globalThis.frame = frame;
  globalThis.pointerAt = (type, x, y, target = canvas) => pointer(type, x, y, 0, target);
  globalThis.frames = async (n) => { for (let i = 0; i < n; i++) await frame(); };
  globalThis.seconds = async (s) => { const end = G.updateTime.total + s; while (G.updateTime.total < end) await frame(); };
  globalThis.until = async (fn, s) => {
    // 墙钟的上限只是防止游戏停着时卡死（hub 的 eval 两分钟超时）
    const end = G.updateTime.total + s, wall = performance.now() + 100000;
    for (let value = fn(); ; value = fn()) {
      if (value || G.updateTime.total >= end || performance.now() > wall) return value;
      await frame();
    }
  };
  globalThis.sceneChanged = async (from) => {
    // 上限只是防止卡死（hub 的 eval 两分钟超时）；正常是换完就返回
    const end = performance.now() + 100000;
    while ((G.rootScene?.name === from || G.sceneFrame === undefined || G.frames <= G.sceneFrame) && performance.now() < end) await frame();
    return G.rootScene?.name ?? null;
  };
  globalThis.lines = () => G.debugText.lines.map((l) => l.text);
  globalThis.named = (name) => G.entities.ids().map((i) => G.entities.entity(i)).filter((e) => e.name === name);
  globalThis.position = (name) => { const p = named(name)[0].require(E.Transform).position; return [p.x, p.y, p.z]; };
  globalThis.rotation = (name) => { const q = named(name)[0].require(E.Transform).rotation; return [q.x, q.y, q.z, q.w]; };
  globalThis.tap = async (code) => { key('keydown', code); await frames(2); key('keyup', code); await frames(2); };
  globalThis.hold = async (code, n) => { key('keydown', code); await frames(n); const seen = lines(); key('keyup', code); await frames(2); return seen; };
  globalThis.holdFor = async (code, s, sample) => { key('keydown', code); await seconds(s); const seen = sample?.(); key('keyup', code); await frames(2); return seen; };
  globalThis.click = async (x, y, button = 0) => {
    pointer('pointermove', x, y, button); await frame();
    pointer('pointerdown', x, y, button); await frames(2);
    pointer('pointerup', x, y, button, window); await frames(2);
  };
  const all = (e, out = []) => { out.push(e); for (const c of e.visualChildren) all(c, out); return out; };
  const pages = () => G.ui.components.filter((c) => c.page?.rootElement);
  globalThis.uiElements = () => pages().flatMap((c) => all(c.page.rootElement));
  globalThis.uiFind = (name) => { for (const c of pages()) { const e = c.page.rootElement.findName(name); if (e) return e; } return null; };
  globalThis.uiPoint = (target) => {
    const e = typeof target === 'string' ? uiFind(target) : target;
    if (!e) throw new Error('no UI element ' + target);
    const c = pages().find((c) => all(c.page.rootElement).includes(e));
    // 元素的位置是页面的虚拟分辨率里的，换到画布的 CSS 像素
    const [vx, vy] = E.UISystem.virtualResolution(c, [canvas.width, canvas.height]);
    return [e.worldPosition[0] / vx * canvas.clientWidth, e.worldPosition[1] / vy * canvas.clientHeight];
  };
  globalThis.uiClick = async (target) => click(...uiPoint(target));
  return 1;
})()`;

interface SmokeMetric {
  readonly name: string;
  readonly unit: 'count' | 'bytes' | 'ms';
  readonly value: number;
}

/** 各个样例冒烟跑完时的统计量（`stride metrics`）记下的基线，见 checkBudgets。 */
const BUDGETS_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'budgets.json');
/** 进基线的量：和机器快慢无关的（实体数、绘制次数、显存、原生内存）。帧时间另由 tools/measure.ps1 和桌面 Stride 比。 */
const BUDGETED = ['entities', 'render.drawCalls', 'render.instances', 'gpu.buffers', 'gpu.buffers.bytes', 'gpu.textures', 'gpu.textures.bytes', 'gpu.pipelines.sync', 'native.allocated.bytes'];
/** 允许比基线高多少：冒烟跑完时的状态每次略有不同（随机的关卡、还没回收的子弹），所以留得宽，抓的是成倍的退步和泄漏。 */
const TOLERANCE = { count: { factor: 1.5, slack: 16 }, bytes: { factor: 1.3, slack: 4 * 1024 * 1024 }, ms: { factor: Infinity, slack: 0 } } as const;

/** 不留余量的量。当场建的管线（卡帧的那种）：多出来的就是没预热到的，要么补上预热，要么有意地重记基线；留 2 条给时序。 */
const EXACT: Readonly<Record<string, { factor: number; slack: number }>> = { 'gpu.pipelines.sync': { factor: 1, slack: 2 } };

/**
 * 预算：冒烟跑完时的统计量不能比记下的基线高出太多（docs/roadmap.md 的原则："预算和实测值进回归，变慢了要能自动发现"）。
 * 环境变量 STRIDE_UPDATE_BUDGETS=1 时不比，把这次的值记成新的基线（有意的变化之后重记：
 * `$env:STRIDE_UPDATE_BUDGETS = 1; pwsh tools/regress.ps1`）；还没有基线的样例跳过。
 */
function checkBudgets(app: string, metrics: readonly SmokeMetric[], check: Smoke['check']): void {
  const all = (existsSync(BUDGETS_FILE) ? JSON.parse(readFileSync(BUDGETS_FILE, 'utf8')) : {}) as Record<string, Record<string, number>>;
  const measured = Object.fromEntries(metrics.filter((metric) => BUDGETED.includes(metric.name)).map((metric) => [metric.name, Math.round(metric.value)]));
  if (process.env['STRIDE_UPDATE_BUDGETS']) {
    all[app] = measured;
    const sorted = Object.fromEntries(Object.keys(all).sort().map((key) => [key, all[key]]));
    writeFileSync(BUDGETS_FILE, `${JSON.stringify(sorted, null, 2)}\n`);
    console.log(`     budgets recorded for ${app}`);
    return;
  }
  const baseline = all[app];
  if (!baseline) return void console.log(`     no budgets recorded for ${app} (STRIDE_UPDATE_BUDGETS=1 records them)`);
  const over = metrics.flatMap((metric) => {
    const recorded = baseline[metric.name];
    if (recorded === undefined) return [];
    const { factor, slack } = EXACT[metric.name] ?? TOLERANCE[metric.unit];
    const limit = recorded * factor + slack;
    return metric.value > limit ? [`${metric.name}: ${Math.round(metric.value)} > ${Math.round(limit)} (recorded ${recorded})`] : [];
  });
  check('统计量在预算内（实体数、绘制次数、显存、原生内存）', over.length === 0, over);
}

export function startSmoke(defaultHub: string): Smoke {
  const hubIndex = process.argv.indexOf('--hub');
  const hub = hubIndex >= 0 ? process.argv[hubIndex + 1]! : defaultHub;
  // 截图的 PNG 可能有几 MB（默认的输出上限是 1 MB）
  const run = (...args: string[]) => execFileSync(process.execPath, [cli, ...args, '--hub', hub], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  // logs --json 一行一条，seq 递增
  const lastSeq = (): number => {
    const lines = run('logs', '--json').trim().split('\n').filter(Boolean);
    return lines.length > 0 ? (JSON.parse(lines.at(-1)!) as { seq: number }).seq : 0;
  };
  const since = lastSeq();
  let failed = 0;
  const check = (name: string, ok: boolean, detail: unknown): void => {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `: ${JSON.stringify(detail)}`}`);
    if (!ok) failed++;
  };
  return {
    // wait 默认等 30 秒；CI 的软件 WebGPU 上重新加载页面、编着色器要久得多（只在慢的时候多等，快的机器上照样马上返回）
    stride: (...args) => JSON.parse(run(...args, ...(args[0] === 'wait' && !args.includes('--timeout') ? ['--timeout', '180'] : []))),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    check,
    finish: () => {
      const errors = run('logs', '--since', String(since), '--level', 'error').trim();
      check('没有错误日志', errors === '', errors.split('\n'));
      checkBudgets(defaultHub, JSON.parse(run('metrics')) as SmokeMetric[], check);
      process.exit(failed > 0 ? 1 : 0);
    },
  };
}
