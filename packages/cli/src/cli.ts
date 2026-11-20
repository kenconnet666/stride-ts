#!/usr/bin/env node
/**
 * stride：从命令行查看和操作正在运行的 stride-ts 游戏，给 agent 和开发者调试用。结果是 JSON（打到 stdout），
 * 出错时信息打到 stderr，退出码 1。游戏要打开 debug（开发服务器上默认开），开发服务器带调试中枢（tools/vite-app.ts）。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs, type ParseArgsConfig } from 'node:util';
import type { HubLogEntry, LogLevel, PageInfo } from '@stride-ts/engine/debug-protocol';
import { CdpSession, closeBrowser, openUrl, pageTarget } from './chrome.ts';
import { HubClient, type DevtoolsSession } from './client.ts';
import { formatJson } from './format.ts';
import { COLLECT_GPU_COUNTERS, INSTALL_GPU_COUNTERS } from './gpu-calls.ts';
import { decodePng, diffImages, encodePng } from './png.ts';
import { profileCallers, profileFromTrace, summarizeProfile, type CpuProfile, type TraceEvent } from './profile.ts';
import { listHubs, readBrowser } from './state.ts';

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
  pause | resume | step [frames] | time [--scale <x>] [--fixed <seconds>|off] [--total <seconds>]
  key <code> [--hold <ms> | --down | --up]          KeyboardEvent.code or Stride key name: KeyW or W, ArrowLeft or Left
  mouse move <dx> <dy> | mouse <left|middle|right> [--hold <ms> | --down | --up] [--trusted]
                                                    --trusted: a real click at the canvas center through the DevTools
                                                    protocol (stride open's Chrome), so the page may lock the pointer
  shot <out.png> [--diff <reference.png>] [--diff-out <file>] [--threshold 2] [--region x,y,w,h]
                                                    --region: compare only that rectangle (e.g. leave out UI drawn differently)
  perf [--seconds 3] [--no-gpu]                     frame times, CPU per system/phase, native timings, GPU per pass
  native [--reset]                                  native counters (physics bodies, ...), timings, wasm memory
  draws                                             draw calls of the last frame per GPU render pass
  metrics [--over]                                  statistics and budgets: entities, draw calls, GPU and native memory, frame times
                                                    (--over: only those over their budget)
  gpu-calls [--seconds 2]                           WebGPU calls and writeBuffer bytes per frame
  cpu-profile [--seconds 5] [--out profile.json] [--callers <regex>]
                          sample the main thread (needs a Chrome from stride open): ms per frame by kind and function
  pick <x> <y>                                      entity under a canvas pixel (CSS pixels from the top-left; meshes and sprites)
  wireframe [on|off]                                overlay the wireframe of the meshes on the main view (no argument toggles)
  quality [low|medium|high|ultra]                   quality tier: caps on shadows and post effects (no argument shows the current one)
  taa [on|off]                                      temporal anti-aliasing instead of FXAA (no argument toggles)
  ao [on|off] [--radius <m>]                        screen-space ambient occlusion, GTAO (no argument toggles)
  blur [on|off] [--shutter s] [--maxPixels n]       motion blur (no argument toggles)
  ssgi [on|off] [--radius m] [--thickness m] [--intensity x] [--feedback f]
                                                    screen-space global illumination (indirect diffuse light, replaces GTAO; no argument toggles)
  contact [on|off] [--length m] [--steps n] [--thickness t]
                                                    contact shadows of the shadow-casting directional light (no argument toggles)
  ssr [on|off] [--maxRoughness r] [--thickness t] [--maxSteps n] [--debug off|hits|reflection]
                                                    screen-space reflections (no argument toggles)
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
    trusted: { type: 'boolean' },
    diff: { type: 'string' },
    'diff-out': { type: 'string' },
    threshold: { type: 'string' },
    region: { type: 'string' },
    seconds: { type: 'string' },
    'no-gpu': { type: 'boolean' },
    scale: { type: 'string' },
    fixed: { type: 'string' },
    total: { type: 'string' },
    max: { type: 'string' },
    mask: { type: 'string' },
    follow: { type: 'boolean', short: 'f' },
    since: { type: 'string' },
    level: { type: 'string' },
    source: { type: 'string' },
    over: { type: 'boolean' },
    json: { type: 'boolean' },
    reset: { type: 'boolean' },
    out: { type: 'string' },
    callers: { type: 'string' },
    radius: { type: 'string' },
    maxRoughness: { type: 'string' },
    thickness: { type: 'string' },
    maxSteps: { type: 'string' },
    intensity: { type: 'string' },
    feedback: { type: 'string' },
    debug: { type: 'string' },
    length: { type: 'string' },
    shutter: { type: 'string' },
    maxPixels: { type: 'string' },
    steps: { type: 'string' },
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
/**
 * 连到页面的 DevTools 协议：页面所在的浏览器装着调试桥扩展（tools/debug-bridge）时经它，否则直连 stride open 启动的 Chrome
 * 的调试端口（Chrome 不许对默认配置文件开远程调试，用户平时的 Chrome 只能走扩展）。
 */
async function pageCdp(command: string): Promise<{ client: HubClient; info: PageInfo; cdp: DevtoolsSession }> {
  const client = await HubClient.find(options.hub);
  const pages = await client.pages();
  const info = page === undefined ? pages.at(-1) : pages.find((p) => p.id === page);
  if (!info) throw new Error('no page is connected');
  const { devtoolsBridge } = (await client.call('status', {}, { page: info.id })) as { devtoolsBridge?: string | null };
  if (devtoolsBridge) return { client, info, cdp: client.devtools(info.id) };
  const browser = readBrowser();
  if (!browser) {
    throw new Error(`${command} uses the DevTools protocol: install the Stride Debug Bridge extension (tools/debug-bridge) in the page's Chrome, or run \`stride open <url> --headless\` and use that page`);
  }
  return { client, info, cdp: await CdpSession.connect((await pageTarget(browser, info.url)).webSocketDebuggerUrl) };
}

/**
 * 录一段 CPU 采样：用 Tracing（V8 的 cpu_profiler 分类，hires 是 0.1 ms 采样，同 DevTools 的性能面板），不用 Profiler 域——
 * 调试桥扩展是不受信任的客户端，Chrome 不给它 Profiler。跟踪按流读回（IO.read），拼成 Profiler.Profile 的样子。
 */
async function recordCpuProfile(cdp: DevtoolsSession, seconds: number): Promise<CpuProfile> {
  const categories = ['__metadata', 'disabled-by-default-v8.cpu_profiler', 'disabled-by-default-v8.cpu_profiler.hires'];
  await cdp.send('Tracing.start', { traceConfig: { includedCategories: categories, excludedCategories: ['*'] }, transferMode: 'ReturnAsStream' });
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  const { stream } = (await cdp.sendAndWait('Tracing.end', {}, 'Tracing.tracingComplete')) as { stream: string };
  let text = '';
  for (;;) {
    const { data, eof, base64Encoded } = (await cdp.send('IO.read', { handle: stream, size: 4 << 20 })) as { data: string; eof: boolean; base64Encoded?: boolean };
    text += base64Encoded ? Buffer.from(data, 'base64').toString('utf8') : data;
    if (eof) break;
  }
  await cdp.send('IO.close', { handle: stream });
  const trace = JSON.parse(text) as TraceEvent[] | { traceEvents: TraceEvent[] };
  return profileFromTrace(Array.isArray(trace) ? trace : trace.traceEvents);
}

/**
 * 在画布中央真实地按一下鼠标（DevTools 协议的 Input.dispatchMouseEvent）：和合成的 DOM 事件不同，它算用户操作，页面能拿到指针
 * 锁定。--hold 按住这么久，--down、--up 只按下或只松开；默认按下 100 ms（游戏至少跑过几帧）再松开。
 */
async function trustedClick(button: string): Promise<unknown> {
  if (!['left', 'middle', 'right'].includes(button)) throw new Error(`button must be left, middle or right, got '${button}'`);
  const { cdp: session } = await pageCdp('mouse --trusted');
  await using cdp = session;
  const { result } = (await cdp.send('Runtime.evaluate', {
    expression: "(() => { const r = document.querySelector('canvas').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()",
    returnByValue: true,
  })) as { result: { value: [number, number] } };
  const [x, y] = result.value;
  const send = (type: 'mousePressed' | 'mouseReleased') => cdp.send('Input.dispatchMouseEvent', { type, x, y, button, clickCount: 1 });
  if (!options.up) await send('mousePressed');
  if (options.down) return { pressed: [x, y] };
  if (!options.up) await new Promise((resolve) => setTimeout(resolve, Number(options.hold ?? 100)));
  await send('mouseReleased');
  return { clicked: [x, y] };
}

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

/**
 * 打开这个地址以后，连上来的游戏页面的地址以什么开头。编辑器的页面（`/__stride/editor/`）自己不是游戏，游戏是嵌在里面的
 * 同源 iframe（地址是应用的根加 `?debug&stride-edit`），所以只认同源。
 */
function gamePagePrefix(url: string): string {
  const parsed = new URL(url);
  return parsed.pathname.startsWith('/__stride/editor') ? `${parsed.origin}/` : url.replace(/\/$/, '');
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
    return { browser, game: await waitForGame(Number(options.timeout ?? 60), gamePagePrefix(url)) };
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
    ...(options.total ? { total: Number(options.total) } : {}),
  }),
  key: () => call('input', { key: required(rest[0], 'key code'), ...pressAction() }, Number(options.hold ?? 0)),
  mouse() {
    if (rest[0] === 'move') return call('input', { mouse: [Number(rest[1] ?? 0), Number(rest[2] ?? 0)] });
    const button = required(rest[0], "'move' or a button");
    if (options.trusted) return trustedClick(button);
    return call('input', { button, ...pressAction() }, Number(options.hold ?? 0));
  },
  async shot() {
    const file = required(rest[0], 'output file');
    const { png, ...info } = (await call('screenshot')) as { png: string; width: number; height: number; frame: number };
    const bytes = Buffer.from(png, 'base64');
    writeFileSync(file, bytes);
    if (!options.diff) return { file, ...info };
    const region = options.region?.split(',').map(Number);
    if (region && (region.length !== 4 || region.some((value) => !Number.isInteger(value)))) throw new Error(`--region takes x,y,w,h in pixels, got ${options.region}`);
    const diff = diffImages(decodePng(readFileSync(options.diff)), decodePng(bytes), {
      threshold: Number(options.threshold ?? 2),
      ...(region ? { region: region as [number, number, number, number] } : {}),
    });
    const diffFile = options['diff-out'] ?? file.replace(/\.png$/i, '') + '-diff.png';
    writeFileSync(diffFile, encodePng(diff.image));
    const { image: _, ...summary } = diff;
    return { file, ...info, diff: { reference: options.diff, image: diffFile, ...summary } };
  },
  perf() {
    const seconds = Number(options.seconds ?? 3);
    return call('perf', { seconds, gpu: !options['no-gpu'] }, seconds * 1000);
  },
  native: () => call('native', options.reset ? { reset: true } : {}),
  async 'gpu-calls'() {
    await call('eval', { code: INSTALL_GPU_COUNTERS });
    await new Promise((resolve) => setTimeout(resolve, Number(options.seconds ?? 2) * 1000));
    return call('eval', { code: COLLECT_GPU_COUNTERS });
  },
  async 'cpu-profile'() {
    const { client, info, cdp: session } = await pageCdp('cpu-profile');
    await using cdp = session;
    const frame = async () => ((await client.call('status', {}, { page: info.id })) as { frame: number }).frame;
    const first = await frame();
    const profile = await recordCpuProfile(cdp, Number(options.seconds ?? 5));
    const frames = (await frame()) - first;
    if (options.out) writeFileSync(options.out, JSON.stringify(profile));
    return {
      ...(options.out ? { file: options.out } : {}),
      ...(summarizeProfile(profile, frames) as object),
      ...(options.callers ? { callers: profileCallers(profile, new RegExp(options.callers), frames) } : {}),
    };
  },
  pick: () => call('pick', { x: Number(rest[0]), y: Number(rest[1]) }),
  draws: () => call('draws', {}),
  metrics: () => call('metrics', options.over ? { over: true } : {}),
  ao: () => call('ao', { ...(rest[0] === undefined ? {} : { on: rest[0] === 'on' }), ...(options.radius ? { radius: Number(options.radius) } : {}) }),
  blur: () => call('blur', {
    ...(rest[0] === undefined ? {} : { on: rest[0] === 'on' }),
    ...Object.fromEntries((['shutter', 'maxPixels'] as const).filter((key) => options[key] !== undefined).map((key) => [key, Number(options[key])])),
  }),
  contact: () => call('contact', {
    ...(rest[0] === undefined ? {} : { on: rest[0] === 'on' }),
    ...Object.fromEntries((['length', 'steps', 'thickness'] as const).filter((key) => options[key] !== undefined).map((key) => [key, Number(options[key])])),
  }),
  ssgi: () => call('ssgi', {
    ...(rest[0] === undefined ? {} : { on: rest[0] === 'on' }),
    ...Object.fromEntries((['radius', 'thickness', 'intensity', 'feedback'] as const).filter((key) => options[key] !== undefined).map((key) => [key, Number(options[key])])),
  }),
  ssr: () => call('ssr', {
    ...(rest[0] === undefined ? {} : { on: rest[0] === 'on' }),
    ...Object.fromEntries((['maxRoughness', 'thickness', 'maxSteps'] as const).filter((key) => options[key] !== undefined).map((key) => [key, Number(options[key])])),
    ...(options.debug ? { debug: options.debug } : {}),
  }),
  taa: () => call('taa', rest[0] === undefined ? {} : { on: rest[0] === 'on' }),
  quality: () => call('quality', rest[0] === undefined ? {} : { tier: rest[0] }),
  wireframe: () => call('wireframe', rest[0] === undefined ? {} : { on: rest[0] === 'on' }),
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
