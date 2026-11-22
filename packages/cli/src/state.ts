/**
 * CLI 的本机状态，放在 ~/.stride-ts/：
 * - hubs/<pid>-<port>.json：正在运行的调试中枢（开发服务器）的地址和令牌，CLI 按它找中枢；进程退出时删掉，
 *   残留的（进程已经不在）在列出时清理；
 * - browser.json：`stride open` 启动的 Chrome（进程号、远程调试端口）；
 * - chrome/：那个 Chrome 的用户目录（和用户自己的 Chrome 分开）。
 * 环境变量 STRIDE_STATE_DIR 换掉整个目录（回归脚本用，自己起开发服务器）；STRIDE_BROWSER_DIR 只换浏览器的那两项，中枢照旧
 * （截图脚本用：对着开着的开发服务器开自己的无头 Chrome，不关 `stride open` 开着的窗口）。
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export const STATE_DIR = process.env['STRIDE_STATE_DIR'] ?? path.join(homedir(), '.stride-ts');
const HUBS_DIR = path.join(STATE_DIR, 'hubs');
/** 浏览器的记录和用户目录放在哪。 */
export const BROWSER_DIR = process.env['STRIDE_BROWSER_DIR'] ?? STATE_DIR;
const BROWSER_FILE = path.join(BROWSER_DIR, 'browser.json');

export interface HubRecord {
  /** 开发服务器的地址，比如 http://localhost:5184。 */
  readonly url: string;
  readonly token: string;
  readonly pid: number;
  /** 应用的名字加服务器种类，比如 @stride-ts/platformer (dev)。 */
  readonly name: string;
  readonly started: number;
}

export interface BrowserRecord {
  readonly pid: number;
  /** 远程调试（CDP）端口。 */
  readonly port: number;
  readonly headless: boolean;
  readonly started: number;
}

/** 登记一个中枢，返回登记文件的路径（退出时传给 unregisterHub）。 */
export function registerHub(record: HubRecord): string {
  mkdirSync(HUBS_DIR, { recursive: true });
  const file = path.join(HUBS_DIR, `${record.pid}-${new URL(record.url).port}.json`);
  writeFileSync(file, JSON.stringify(record, null, 2));
  return file;
}

export function unregisterHub(file: string): void {
  rmSync(file, { force: true });
}

/** 活着的中枢，最新启动的在前；进程不在了的登记顺手删掉。 */
export function listHubs(): HubRecord[] {
  let files: string[];
  try {
    files = readdirSync(HUBS_DIR).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
  const hubs: HubRecord[] = [];
  for (const name of files) {
    const file = path.join(HUBS_DIR, name);
    try {
      const record = JSON.parse(readFileSync(file, 'utf8')) as HubRecord;
      if (isAlive(record.pid)) hubs.push(record);
      else rmSync(file, { force: true });
    } catch {
      rmSync(file, { force: true });
    }
  }
  return hubs.sort((a, b) => b.started - a.started);
}

export function readBrowser(): BrowserRecord | undefined {
  try {
    const record = JSON.parse(readFileSync(BROWSER_FILE, 'utf8')) as BrowserRecord;
    if (isAlive(record.pid)) return record;
  } catch {
    // 没有或坏了：当作没有
  }
  rmSync(BROWSER_FILE, { force: true });
  return undefined;
}

export function writeBrowser(record: BrowserRecord | undefined): void {
  if (!record) {
    rmSync(BROWSER_FILE, { force: true });
    return;
  }
  mkdirSync(BROWSER_DIR, { recursive: true });
  writeFileSync(BROWSER_FILE, JSON.stringify(record, null, 2));
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM：进程在，只是没权限发信号
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
