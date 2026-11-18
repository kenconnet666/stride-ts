#!/usr/bin/env node
/**
 * stride：从命令行查看和操作正在运行的 stride-ts 游戏，给 agent 和开发者调试用。结果是 JSON（打到 stdout），
 * 出错时信息打到 stderr，退出码 1。游戏要打开 debug（开发服务器上默认开），开发服务器带调试中枢（tools/vite-app.ts）。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs, type ParseArgsConfig } from 'node:util';
import type { HubLogEntry, LogLevel } from '@stride-ts/engine/debug-protocol';
import { closeBrowser, openUrl } from './chrome.ts';
import { HubClient } from './client.ts';
import { formatJson } from './format.ts';
import { decodePng, diffImages, encodePng } from './png.ts';
import { listHubs } from './state.ts';

const HELP = `stride <command> [options]   (from the repository: pnpm exec stride <command>)

Browser and connection
  open <url> [--headless] [--size 1400x900] [--dpr 2] [--chrome-arg <arg>]...
                          open the url in a stride-launched Chrome (new tab if one is running), wait until the game runs
  close                   close the stride-launched Chrome
  hubs                    running debug hubs (dev and preview servers) and their pages
  wait [--timeout 30]     wait until a page is connected and its game is running

Game
  status                  status, frame, time, fps, canvas, GPU adapter, counters, watches
  commands                commands the page registered (games add their own with game.debug.command)
  call <command> [json]   call any page command with JSON args
  entities [--name <text>] [--with <Component|Script>] [--limit 200]
  inspect <entity>        all component values and script properties (entity: id or name)
  set <entity> <Component.field[.x]> <json value>
  pause | resume | step [frames] | time [--scale <x>] [--fixed <seconds>|off]
  key <code> [--hold <ms> | --down | --up]          KeyboardEvent.code, e.g. KeyW, Space, ArrowLeft
  mouse move <dx> <dy> | mouse <left|middle|right> [--hold <ms> | --down | --up]
  shot <out.png> [--diff <reference.png>] [--diff-out <file>] [--threshold 2]
  perf [--seconds 3] [--no-gpu]                     frame times, CPU per system/phase, GPU per pass
  raycast <x,y,z> <dx,dy,dz> [--max 1000] [--mask <bits>]
  logs [-f] [--since <seq>] [--level info|warn|error] [--source console|error|engine|native|event] [--json]
  eval <code | ->         run JavaScript in the page (strideGame, strideEngine are globals); - reads stdin

Common options
  --hub <text>            pick a hub by name or url (default: the one whose page connected last)
  --page <id>             pick a page of the hub (default: the last connected)
  --timeout <seconds>     how long a page command may take (default 120)
`;

// 负数（-5、-5,0,1）是位置参数，不是选项：先换个前缀藏起来，解析完再换回
const NEGATIVE = '\u0000';
const argv = process.argv.slice(2).map((arg) => (/^-[\d.]/.test(arg) ? NEGATIVE + arg : arg));

const { values: options, positionals: rawPositionals } = parseArgsOrExit({
  args: argv,
  allowPositionals: true,
  options: {
    help: { type: 'boolean', short: 'h' },
    hub: { type: 'string' },
    page: { type: 'string' },
    timeout: { type: 'string' },
    headless: { type: 'boolean' },
    size: { type: 'string' },
    dpr: { type: 'string' },
    'chrome-arg': { type: 'string', multiple: true },
    name: { type: 'string' },
    with: { type: 'string' },
    limit: { type: 'string' },
    hold: { type: 'string' },
    down: { type: 'boolean' },
    up: { type: 'boolean' },
    diff: { type: 'string' },
    'diff-out': { type: 'string' },
    threshold: { type: 'string' },
    seconds: { type: 'string' },
    'no-gpu': { type: 'boolean' },
    scale: { type: 'string' },
    fixed: { type: 'string' },
    max: { type: 'string' },
    mask: { type: 'string' },
    follow: { type: 'boolean', short: 'f' },
    since: { type: 'string' },
    level: { type: 'string' },
    source: { type: 'string' },
    json: { type: 'boolean' },
  },
});

const positionals = rawPositionals.map((arg) => (arg.startsWith(NEGATIVE) ? arg.slice(1) : arg));
const [command, ...rest] = positionals;
const page = options.page === undefined ? undefined : Number(options.page);
const timeout = options.timeout === undefined ? undefined : Number(options.timeout) * 1000;

/** 调页面命令的简写。 */
async function call(name: string, args: Record<string, unknown> = {}, extraTimeout = 0): Promise<unknown> {
  const client = await HubClient.find(options.hub);
  return client.call(name, args, { ...(page === undefined ? {} : { page }), ...(timeout === undefined && extraTimeout === 0 ? {} : { timeout: (timeout ?? 120_000) + extraTimeout }) });
}

function required(value: string | undefined, what: string): string {
  if (value === undefined) throw new Error(`missing ${what}; see stride --help`);
  return value;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text; // 不是 JSON 就当字符串
  }
}

const vector = (text: string | undefined, what: string) => required(text, what).split(',').map(Number);

/** 按键或鼠标键的动作：--hold 毫秒、--down、--up，默认按一下。 */
function pressAction(): Record<string, unknown> {
  if (options.hold !== undefined) return { action: 'hold', ms: Number(options.hold) };
  return { action: options.down ? 'down' : options.up ? 'up' : 'press' };
}

const LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

function formatLog(entry: HubLogEntry): string {
  const time = new Date(entry.time).toISOString().slice(11, 23);
  const frame = entry.frame === undefined ? '' : ` f${entry.frame}`;
  const data = entry.data === undefined ? '' : ` ${typeof entry.data === 'string' ? entry.data : JSON.stringify(entry.data)}`;
  return `[${entry.seq}] ${time}${frame} p${entry.page} ${entry.level} ${entry.source}: ${entry.message}${data}`;
}

/** 等到有页面连上、游戏在运行（或失败）；urlPrefix 给了时只认这个地址的页面。 */
async function waitForGame(seconds: number, urlPrefix?: string): Promise<unknown> {
  const deadline = Date.now() + seconds * 1000;
  let last = 'no debug hub';
  while (Date.now() < deadline) {
    for (const hub of listHubs()) {
      const client = new HubClient(hub);
      const pages = await client.pages().catch(() => []);
      const target = pages.filter((p) => !urlPrefix || p.url.startsWith(urlPrefix)).at(-1);
      if (!target) {
        last = `no page${urlPrefix ? ` at ${urlPrefix}` : ''} connected to ${hub.name}`;
        continue;
      }
      const status = (await client.call('status', {}, { page: target.id }).catch((error: unknown) => ({ status: String(error) }))) as { status: string };
      if (status.status === 'running' || status.status === 'failed') return { hub: hub.name, page: target, ...status };
      last = `game is ${status.status}`;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`timed out after ${seconds} s: ${last}`);
}

const commands: Record<string, () => Promise<unknown>> = {
  async open() {
    const url = required(rest[0], 'url');
    const size = options.size?.split('x').map(Number) as [number, number] | undefined;
    const browser = await openUrl(url, {
      ...(options.headless ? { headless: true } : {}),
      ...(size ? { size } : {}),
      ...(options.dpr ? { dpr: Number(options.dpr) } : {}),
      ...(options['chrome-arg'] ? { chromeArgs: options['chrome-arg'] } : {}),
    });
    return { browser, game: await waitForGame(Number(options.timeout ?? 60), url.replace(/\/$/, '')) };
  },
  async close() {
    return { closed: await closeBrowser() };
  },
  async hubs() {
    return Promise.all(listHubs().map(async (hub) => ({ name: hub.name, url: hub.url, pid: hub.pid, pages: await new HubClient(hub).pages().catch((error: unknown) => String(error)) })));
  },
  wait: () => waitForGame(Number(options.timeout ?? 30)),
  status: () => call('status'),
  commands: () => call('commands'),
  call: () => call(required(rest[0], 'command'), rest[1] === undefined ? {} : (JSON.parse(rest[1]) as Record<string, unknown>)),
  entities: () => call('entities', { ...(options.name ? { name: options.name } : {}), ...(options.with ? { with: options.with } : {}), ...(options.limit ? { limit: Number(options.limit) } : {}) }),
  inspect: () => call('inspect', { entity: required(rest[0], 'entity') }),
  set: () => call('set', { entity: required(rest[0], 'entity'), path: required(rest[1], 'path'), value: parseJson(required(rest[2], 'value')) }),
  pause: () => call('time', { pause: true }),
  resume: () => call('time', { resume: true }),
  step: () => call('time', { step: Number(rest[0] ?? 1) }),
  time: () => call('time', {
    ...(options.scale ? { timeScale: Number(options.scale) } : {}),
    ...(options.fixed ? { fixedTimeStep: options.fixed === 'off' ? null : Number(options.fixed) } : {}),
  }),
  key: () => call('input', { key: required(rest[0], 'key code'), ...pressAction() }, Number(options.hold ?? 0)),
  mouse() {
    if (rest[0] === 'move') return call('input', { mouse: [Number(rest[1] ?? 0), Number(rest[2] ?? 0)] });
    return call('input', { button: required(rest[0], "'move' or a button"), ...pressAction() }, Number(options.hold ?? 0));
  },
  async shot() {
    const file = required(rest[0], 'output file');
    const { png, ...info } = (await call('screenshot')) as { png: string; width: number; height: number; frame: number };
    const bytes = Buffer.from(png, 'base64');
    writeFileSync(file, bytes);
    if (!options.diff) return { file, ...info };
    const diff = diffImages(decodePng(readFileSync(options.diff)), decodePng(bytes), { threshold: Number(options.threshold ?? 2) });
    const diffFile = options['diff-out'] ?? file.replace(/\.png$/i, '') + '-diff.png';
    writeFileSync(diffFile, encodePng(diff.image));
    const { image: _, ...summary } = diff;
    return { file, ...info, diff: { reference: options.diff, image: diffFile, ...summary } };
  },
  perf() {
    const seconds = Number(options.seconds ?? 3);
    return call('perf', { seconds, gpu: !options['no-gpu'] }, seconds * 1000);
  },
  raycast: () => call('raycast', {
    origin: vector(rest[0], 'origin x,y,z'),
    direction: vector(rest[1], 'direction x,y,z'),
    ...(options.max ? { maxDistance: Number(options.max) } : {}),
    ...(options.mask ? { mask: Number(options.mask) } : {}),
  }),
  async logs() {
    const client = await HubClient.find(options.hub);
    const minimum = LEVELS.indexOf((options.level ?? 'debug') as LogLevel);
    for await (const entry of client.logs({ since: Number(options.since ?? 0), follow: options.follow ?? false, ...(page === undefined ? {} : { page }) })) {
      if (LEVELS.indexOf(entry.level) < minimum || (options.source && entry.source !== options.source)) continue;
      console.log(options.json ? JSON.stringify(entry) : formatLog(entry));
    }
    return undefined;
  },
  async eval() {
    const code = rest[0] === '-' ? readFileSync(0, 'utf8') : rest.join(' ');
    return call('eval', { code: required(code || undefined, 'code') });
  },
};

/** parseArgs，选项写错时打一行错误（而不是调用栈）并退出。 */
function parseArgsOrExit<T extends ParseArgsConfig>(config: T): ReturnType<typeof parseArgs<T>> {
  try {
    return parseArgs(config);
  } catch (error) {
    console.error(`stride: ${error instanceof Error ? error.message : String(error)}; see stride --help`);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  if (options.help || !command) return void console.log(HELP);
  const run = commands[command];
  if (!run) throw new Error(`unknown command '${command}'; see stride --help`);
  const result = await run();
  if (result !== undefined) console.log(formatJson(result));
}

main().catch((error: unknown) => {
  console.error(`stride ${command ?? ''}: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
