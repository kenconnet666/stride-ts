/**
 * `stride open` 启动的 Chrome：独立进程（CLI 退出后还在），用自己的用户目录（~/.stride-ts/chrome，和用户平时的
 * Chrome 分开），开着远程调试端口（CDP），后续的 open 在同一个浏览器里开新标签，`stride close` 关掉它。
 * 默认带 --enable-webgpu-developer-features（时间戳不量化到 100 µs，GpuProfiler 才测得细）。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { readBrowser, STATE_DIR, writeBrowser, type BrowserRecord } from './state.ts';

const PROFILE_DIR = path.join(STATE_DIR, 'chrome');

const CHROME_PATHS: Partial<Record<NodeJS.Platform, readonly string[]>> = {
  win32: ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'],
  darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
  linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium'],
};

export interface OpenOptions {
  readonly headless?: boolean;
  /** 窗口大小 [宽, 高]（无头时就是视口；有窗口时含浏览器边框）。 */
  readonly size?: readonly [number, number];
  /** 设备像素比（--force-device-scale-factor），测高分屏用。 */
  readonly dpr?: number;
  /** 再加的 Chrome 命令行参数，比如 --enable-dawn-features=dump_shaders。 */
  readonly chromeArgs?: readonly string[];
}

/** 打开 url：已经有 stride 启动的 Chrome 时开新标签，否则启动一个。 */
export async function openUrl(url: string, options: OpenOptions = {}): Promise<BrowserRecord> {
  const running = readBrowser();
  if (running) {
    const response = await fetch(`http://127.0.0.1:${running.port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
    if (!response.ok) throw new Error(`Chrome refused to open a tab: ${response.status} ${await response.text()}`);
    return running;
  }
  return launch(url, options);
}

async function launch(url: string, { headless = false, size, dpr, chromeArgs = [] }: OpenOptions): Promise<BrowserRecord> {
  const executable = process.env['CHROME_PATH'] ?? CHROME_PATHS[process.platform]?.find((candidate) => existsSync(candidate));
  if (!executable) throw new Error('Chrome is not installed in the usual place; set CHROME_PATH');
  mkdirSync(PROFILE_DIR, { recursive: true });
  const portFile = path.join(PROFILE_DIR, 'DevToolsActivePort');
  rmSync(portFile, { force: true });
  const args = [
    `--user-data-dir=${PROFILE_DIR}`,
    // 端口 0：Chrome 自己挑一个空闲端口，写进用户目录的 DevToolsActivePort
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--enable-webgpu-developer-features',
    ...(headless ? ['--headless=new'] : []),
    ...(size ? [`--window-size=${size[0]},${size[1]}`] : []),
    ...(dpr ? [`--force-device-scale-factor=${dpr}`] : []),
    ...chromeArgs,
    url,
  ];
  const child = spawn(executable, args, { detached: true, stdio: 'ignore' });
  child.unref();
  const port = await waitForPort(portFile);
  const record: BrowserRecord = { pid: child.pid!, port, headless, started: Date.now() };
  writeBrowser(record);
  return record;
}

async function waitForPort(file: string): Promise<number> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const port = Number(readFileSync(file, 'utf8').split('\n')[0]);
      if (port > 0) return port;
    } catch {
      // 还没写出来
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Chrome did not start (no DevToolsActivePort after 20 s)');
}

/** 关掉 stride 启动的 Chrome；没有时返回 false。 */
export async function closeBrowser(): Promise<boolean> {
  const running = readBrowser();
  if (!running) return false;
  try {
    // CDP 的 Browser.close：让 Chrome 自己正常退出
    const { webSocketDebuggerUrl } = (await (await fetch(`http://127.0.0.1:${running.port}/json/version`)).json()) as { webSocketDebuggerUrl: string };
    await cdp(webSocketDebuggerUrl, 'Browser.close');
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

/** 发一条 CDP 命令（Node 自带的 WebSocket），返回结果。 */
export function cdp(socketUrl: string, method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(socketUrl);
    socket.onopen = () => socket.send(JSON.stringify({ id: 1, method, params }));
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: { message: string } };
      if (message.id !== 1) return;
      socket.close();
      if (message.error) reject(new Error(`${method}: ${message.error.message}`));
      else resolve(message.result);
    };
    // Browser.close 时连接直接断开，不回结果
    socket.onclose = () => resolve(undefined);
    socket.onerror = () => reject(new Error(`cannot connect to ${socketUrl}`));
  });
}
