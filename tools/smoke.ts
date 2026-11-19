// 样例冒烟脚本（apps/*/scripts/smoke.ts）共用的部分：调用调试 CLI、记录检查结果、最后看有没有错误日志。
//   const smoke = startSmoke('physics-sample');   // 命令行的 --hub 覆盖默认的中枢名
//   smoke.check('在跑', (smoke.stride('status') as { status: string }).status === 'running', ...);
//   smoke.finish();                                // 查本次运行以来的错误日志，按结果退出
import { execFileSync } from 'node:child_process';
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
 *   frames(n)                        等 n 帧
 *   lines()                          屏幕上的调试文字
 *   named(name)                      这个名字的实体（数组）
 *   position(name)、rotation(name)   第一个这个名字的实体的本地位置、旋转（数组）
 *   tap(code)、hold(code, n)          按一下键、按住 n 帧（返回按着时的调试文字）；code 是 KeyboardEvent.code
 *   click(x, y, button = 0)          在画布的 (x, y)（CSS 像素）点一下鼠标（合成事件，锁不了指针）
 *   uiFind(name)、uiClick(name)       UI 元素、点它的中心
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
  globalThis.frames = async (n) => { for (let i = 0; i < n; i++) await frame(); };
  globalThis.lines = () => G.debugText.lines.map((l) => l.text);
  globalThis.named = (name) => G.entities.ids().map((i) => G.entities.entity(i)).filter((e) => e.name === name);
  globalThis.position = (name) => { const p = named(name)[0].require(E.Transform).position; return [p.x, p.y, p.z]; };
  globalThis.rotation = (name) => { const q = named(name)[0].require(E.Transform).rotation; return [q.x, q.y, q.z, q.w]; };
  globalThis.tap = async (code) => { key('keydown', code); await frames(2); key('keyup', code); await frames(2); };
  globalThis.hold = async (code, n) => { key('keydown', code); await frames(n); const seen = lines(); key('keyup', code); await frames(2); return seen; };
  globalThis.click = async (x, y, button = 0) => {
    pointer('pointermove', x, y, button); await frame();
    pointer('pointerdown', x, y, button); await frames(2);
    pointer('pointerup', x, y, button, window); await frames(2);
  };
  globalThis.uiFind = (name) => { for (const c of G.ui.components) { const e = c.page?.rootElement?.findName(name); if (e) return e; } return null; };
  globalThis.uiClick = async (name) => {
    const e = uiFind(name), s = canvas.clientWidth / canvas.width;
    if (!e) throw new Error('no UI element ' + name);
    await click(e.worldPosition[0] * s, e.worldPosition[1] * s);
  };
  return 1;
})()`;

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
    stride: (...args) => JSON.parse(run(...args)),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    check,
    finish: () => {
      const errors = run('logs', '--since', String(since), '--level', 'error').trim();
      check('没有错误日志', errors === '', errors.split('\n'));
      process.exit(failed > 0 ? 1 : 0);
    },
  };
}
