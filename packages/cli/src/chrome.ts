/**
 * `stride open` 启动的 Chrome：独立进程（CLI 退出后还在），用自己的用户目录（~/.stride-ts/chrome，和用户平时的
 * Chrome 分开；装在里面的扩展会保留，比如 Claude 插件），开着远程调试端口（CDP），后续的 open 在同一个浏览器里开新标签，
 * `stride close` 关掉它。无头的（回归脚本用）另用 ~/.stride-ts/chrome-headless，不加载有界面的那个目录里装的扩展。
 * 默认带 --enable-webgpu-developer-features（时间戳不量化到 100 µs，GpuProfiler 才测得细）。
 * Chrome 自己的日志（GPU 进程崩溃、看门狗、Dawn 的报错，页面的控制台看不到）写在用户目录的 chrome.log，见 chromeLogFile。
 */
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { DevtoolsSession } from './client.ts';
import { BROWSER_DIR, readBrowser, writeBrowser, type BrowserRecord } from './state.ts';

const PROFILE_DIR = path.join(BROWSER_DIR, 'chrome');
const HEADLESS_PROFILE_DIR = path.join(BROWSER_DIR, 'chrome-headless');

const CHROME_PATHS: Partial<Record<NodeJS.Platform, readonly string[]>> = {
  win32: ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'],
  darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
  linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium'],
};

/** stride 启动的 Chrome 的标准错误输出（--enable-logging=stderr）：每次启动重写。 */
export function chromeLogFile(headless: boolean): string {
  return path.join(headless ? HEADLESS_PROFILE_DIR : PROFILE_DIR, 'chrome.log');
}

/**
 * stride open --gpu-debug 加的 Chrome 参数：Dawn 的完整校验（装了 Windows 的"图形工具"时还开 D3D12 的调试层）、把 WGSL 和翻译出来的
 * HLSL 存进日志（不改名、带调试符号，PIX 里能按源码看着色器）、调试标签带到 D3D12 的对象上（PIX 的截帧里按我们的标签分组）。
 * 慢一些，只在查 GPU 的问题时用；在 stride 自己的 Chrome 里开，卡死、崩了不影响用户的主 Chrome。
 */
export const GPU_DEBUG_ARGS: readonly string[] = [
  '--enable-dawn-backend-validation',
  '--enable-dawn-features=dump_shaders,disable_symbol_renaming,emit_hlsl_debug_symbols,use_user_defined_labels_in_backend',
];

export interface OpenOptions {
  readonly headless?: boolean;
  /** 视口大小 [宽, 高]（CSS 像素）：启动后按页面量出的边框差调整窗口。 */
  readonly size?: readonly [number, number];
  /** 设备像素比（--force-device-scale-factor），测高分屏用。 */
  readonly dpr?: number;
  /** 再加的 Chrome 命令行参数，比如 --enable-dawn-features=dump_shaders。 */
  readonly chromeArgs?: readonly string[];
}

/**
 * 打开 url：已经有 stride 启动的 Chrome 时用它——同一个开发服务器（同源）的标签、空白页优先换成这个地址，同源的多余标签关掉
 * （每次开新标签的话标签越开越多，后台的游戏页还在按满帧率画）；都没有才开新标签。没有就启动一个。给了 size 时把视口调成这么大。
 */
export async function openUrl(url: string, options: OpenOptions = {}): Promise<BrowserRecord> {
  let browser = readBrowser();
  if (browser) {
    const base = `http://127.0.0.1:${browser.port}`;
    const origin = new URL(url).origin;
    const pages = ((await (await fetch(`${base}/json/list`)).json()) as (PageTarget & { readonly type: string })[]).filter((target) => target.type === 'page');
    const sameOrigin = pages.filter((page) => URL.canParse(page.url) && new URL(page.url).origin === origin);
    const blank = pages.filter((page) => page.url === 'about:blank' || page.url.startsWith('chrome://newtab'));
    const [reuse, ...extra] = [...sameOrigin, ...blank];
    if (reuse) {
      {
        await using page = await CdpSession.connect(reuse.webSocketDebuggerUrl);
        await page.send('Page.navigate', { url });
      }
      for (const page of extra.filter((candidate) => sameOrigin.includes(candidate))) await fetch(`${base}/json/close/${page.id}`).catch(() => undefined);
      await fetch(`${base}/json/activate/${reuse.id}`).catch(() => undefined);
    } else {
      const response = await fetch(`${base}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
      if (!response.ok) throw new Error(`Chrome refused to open a tab: ${response.status} ${await response.text()}`);
    }
  } else {
    browser = await launch(url, options);
  }
  if (options.size) await setViewport(browser, url, options.size);
  return browser;
}

/** 把 url 所在窗口的视口调成 size：量出页面的 innerWidth、innerHeight 和窗口大小的差，按差值设窗口。 */
async function setViewport(browser: BrowserRecord, url: string, [width, height]: readonly [number, number]): Promise<void> {
  const target = await pageTarget(browser, url);
  await using page = await CdpSession.connect(target.webSocketDebuggerUrl);
  await using root = await CdpSession.connect(await browserSocket(browser));
  const { windowId, bounds } = (await root.send('Browser.getWindowForTarget', { targetId: target.id })) as { windowId: number; bounds: { width: number; height: number } };
  const innerSize = async (): Promise<[number, number]> => {
    // 刚打开的标签还在加载时没有执行上下文：等它
    for (const deadline = Date.now() + 10_000; ; await new Promise((resolve) => setTimeout(resolve, 100))) {
      try {
        const { result } = (await page.send('Runtime.evaluate', { expression: '[innerWidth, innerHeight]', returnByValue: true })) as { result: { value: [number, number] } };
        return result.value;
      } catch (error) {
        if (Date.now() > deadline) throw error;
      }
    }
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    const [innerWidth, innerHeight] = await innerSize();
    if (innerWidth === width && innerHeight === height) return;
    const current = attempt === 0 ? bounds : ((await root.send('Browser.getWindowBounds', { windowId })) as { bounds: { width: number; height: number } }).bounds;
    await root.send('Browser.setWindowBounds', { windowId, bounds: { width: current.width + width - innerWidth, height: current.height + height - innerHeight, windowState: 'normal' } });
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

export interface PageTarget {
  readonly id: string;
  readonly url: string;
  readonly webSocketDebuggerUrl: string;
}

/** stride 启动的 Chrome 里地址以 urlPrefix 开头的标签（最近打开的在前）；等它出现最多 10 秒。 */
export async function pageTarget(browser: BrowserRecord, urlPrefix: string): Promise<PageTarget> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const targets = (await (await fetch(`http://127.0.0.1:${browser.port}/json/list`)).json()) as (PageTarget & { type: string })[];
    // 编辑器的视口是同源的 iframe，不是单独的目标：找不到完全对上的就用同一个源的顶层标签（整个编辑器）
    const origin = URL.canParse(urlPrefix) ? new URL(urlPrefix).origin : undefined;
    const found = targets.find((t) => t.type === 'page' && t.url.startsWith(urlPrefix)) ?? targets.find((t) => t.type === 'page' && origin !== undefined && t.url.startsWith(`${origin}/`));
    if (found) return found;
    if (Date.now() > deadline) throw new Error(`no tab at ${urlPrefix} in the stride Chrome (tabs: ${targets.map((t) => t.url).join(', ')})`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function browserSocket(browser: BrowserRecord): Promise<string> {
  return ((await (await fetch(`http://127.0.0.1:${browser.port}/json/version`)).json()) as { webSocketDebuggerUrl: string }).webSocketDebuggerUrl;
}

async function launch(url: string, { headless = false, size, dpr, chromeArgs = [] }: OpenOptions): Promise<BrowserRecord> {
  const executable = process.env['CHROME_PATH'] ?? CHROME_PATHS[process.platform]?.find((candidate) => existsSync(candidate));
  if (!executable) throw new Error('Chrome is not installed in the usual place; set CHROME_PATH');
  const profile = headless ? HEADLESS_PROFILE_DIR : PROFILE_DIR;
  mkdirSync(profile, { recursive: true });
  const portFile = path.join(profile, 'DevToolsActivePort');
  rmSync(portFile, { force: true });
  const args = [
    `--user-data-dir=${profile}`,
    // 端口 0：Chrome 自己挑一个空闲端口，写进用户目录的 DevToolsActivePort
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--enable-webgpu-developer-features',
    '--enable-logging=stderr',
    // 窗口被挡住、标签在后台时也不节流（requestAnimationFrame、定时器照常跑）：用户一边用电脑，这里一边测帧时间、跑冒烟
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    // 测试的页面照常建声音、播放（声音的冒烟照样查），只是不出声，不打扰用户用电脑（用户 2026-11-22）；要听时设 STRIDE_AUDIO=1
    ...(process.env['STRIDE_AUDIO'] === '1' ? [] : ['--mute-audio']),
    ...(headless ? ['--headless=new'] : []),
    ...(size ? [`--window-size=${size[0]},${size[1]}`] : []),
    ...(dpr ? [`--force-device-scale-factor=${dpr}`] : []),
    ...chromeArgs,
    url,
  ];
  const log = openSync(chromeLogFile(headless), 'w');
  const child = spawn(executable, args, { detached: true, stdio: ['ignore', log, log] });
  closeSync(log);
  child.unref();
  const port = await waitForPort(portFile);
  const record: BrowserRecord = { pid: child.pid!, port, headless, started: Date.now() };
  writeBrowser(record);
  return record;
}

async function waitForPort(file: string): Promise<number> {
  // CI 的运行器上冷启动偶尔要二十多秒；正常几百毫秒就写出来了
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const port = Number(readFileSync(file, 'utf8').split('\n')[0]);
      if (port > 0) return port;
    } catch {
      // 还没写出来
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Chrome did not start (no DevToolsActivePort after 60 s)');
}

/** 关掉 stride 启动的 Chrome；没有时返回 false。 */
export async function closeBrowser(): Promise<boolean> {
  const running = readBrowser();
  if (!running) return false;
  try {
    // CDP 的 Browser.close：让 Chrome 自己正常退出（连接随之断开，不等回复）
    const session = await CdpSession.connect(await browserSocket(running));
    session.send('Browser.close').catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 500));
  } catch {
    try {
      process.kill(running.pid);
    } catch {
      // 已经退出了
    }
  }
  writeBrowser(undefined);
  return true;
}

/** 一个 CDP 连接（Node 自带的 WebSocket）：按 id 配对命令和回复，收到的事件交给 on 登记的回调。 */
export class CdpSession implements DevtoolsSession {
  readonly #socket: WebSocket;
  #nextId = 1;
  readonly #pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  readonly #listeners = new Map<string, (params: unknown) => void>();

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: { message: string }; method?: string; params?: unknown };
      if (message.id === undefined) return void (message.method && this.#listeners.get(message.method)?.(message.params));
      const pending = this.#pending.get(message.id);
      this.#pending.delete(message.id);
      if (message.error) pending?.reject(new Error(message.error.message));
      else pending?.resolve(message.result);
    };
    socket.onclose = () => {
      for (const { reject } of this.#pending.values()) reject(new Error('the CDP connection closed'));
      this.#pending.clear();
    };
  }

  static connect(url: string): Promise<CdpSession> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      socket.onopen = () => resolve(new CdpSession(socket));
      socket.onerror = () => reject(new Error(`cannot connect to ${url}`));
    });
  }

  /**
   * 发一条命令，等回复。每条带超时：Node 自带的 WebSocket 不让事件循环保持运行，没有这个计时器的话，等回复时
   * 进程会以为无事可做而退出。
   */
  send(method: string, params: Record<string, unknown> = {}, timeout = 60_000): Promise<unknown> {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${method}: no reply in ${timeout} ms`));
      }, timeout);
      this.#pending.set(id, {
        resolve: (value) => (clearTimeout(timer), resolve(value)),
        reject: (error) => (clearTimeout(timer), reject(new Error(`${method}: ${error.message}`))),
      });
      this.#socket.send(JSON.stringify({ id, method, params }));
    });
  }

  on(event: string, listener: (params: unknown) => void): void {
    this.#listeners.set(event, listener);
  }

  async sendAndWait(method: string, params: Record<string, unknown>, event: string, timeout = 60_000): Promise<unknown> {
    const received = new Promise((resolve) => this.on(event, resolve));
    await this.send(method, params, timeout);
    return received;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.#socket.close();
  }
}
