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
import { checkEval, runTypeQuery, TS_USAGE, TypeScriptServer } from './lsp.ts';
import { runDebugPlan, type DebugPlan } from './debugger.ts';
import { setCursorEnabled, pageClick, pageDrag, pageEval, pageFind, pageHover, pageKey, pageScroll, pageShot, pageText, pageTree, pageType } from './page.ts';
import { listHubs, readBrowser } from './state.ts';

const HELP = `stride <command> [options]   (from the repository: pnpm exec stride <command>)

Browser and connection
  open <url> [--headless] [--size 1400x900] [--dpr 2] [--chrome-arg <arg>]...
                          open the url in a stride-launched Chrome (new tab if one is running), wait until the game runs
  close                   close the stride-launched Chrome
  hubs                    running debug hubs (dev and preview servers) and their pages
  wait [--timeout 30]     wait until a page is connected and its game is running
  wait --game <seconds>   wait until the game time has advanced that much (slow frames, paused tabs: not wall-clock)

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
  page tree [--interactive] [--max 400]             the page's accessibility tree (the editor UI too, iframes included),
                                                    each element with a ref (e123)
  page find <text> | page text                      elements whose name or value has the text; the page's text
  page eval <expr> | --file <f>                     evaluate in the top page (the editor UI, not the game iframe)
  page click <ref|x,y> [--button left|right|middle] [--count 2] [--modifiers ctrl+shift]
  page hover <ref|x,y> | page drag <from> <to> [--steps 12] | page scroll <ref|x,y> [--dy 300] [--dx 0]
  page type <text> | page key <combo>... [--repeat n]  (combo: Enter, ctrl+s, shift+Tab, F2, a)
                                                    mouse and keyboard actions draw an agent cursor on the page (--no-cursor: don't)
  page shot <out.png> [--ref e123]                  screenshot of the viewport or an element, in CSS pixels (the
                                                    coordinates click takes); real user input (trusted events) through
                                                    the DevTools protocol, like a person at the screen
  throttle <rate> [--seconds s]                     slow the page's CPU down rate times (DevTools' CPU throttling) to reproduce
                                                    CI's software WebGPU timing; held until --seconds pass or Ctrl+C
  viewport <WxH> [--dpr 2] [--mobile] [--seconds s] | viewport off
                                                    emulate a screen size and pixel ratio (phone portrait: 390x844 --dpr 3 --mobile)
  front                                             bring the game's tab to the front (a background tab does not run frames;
                                                    status.visibility says hidden)
  pick <x> <y>                                      entity under a canvas pixel (CSS pixels from the top-left; meshes and sprites)
  wireframe [on|off|toggle]                                overlay the wireframe of the meshes on the main view (no argument reports; toggle flips)
  quality [low|medium|high|ultra]                   quality tier: caps on shadows and post effects (no argument shows the current one)
  taa [on|off|toggle]                                      temporal anti-aliasing instead of FXAA (no argument reports; toggle flips)
  ao [on|off|toggle] [--radius <m>]                        screen-space ambient occlusion, GTAO (no argument reports; toggle flips)
  blur [on|off|toggle] [--shutter s] [--maxPixels n]       motion blur (no argument reports; toggle flips)
  sss [on|off|toggle] [--entity e] [--width m] [--translucency t]
                                                    subsurface scattering blur; --entity gives that entity's models skin scattering (no argument reports; toggle flips)
  ssgi [on|off|toggle] [--radius m] [--thickness m] [--intensity x] [--feedback f]
                                                    screen-space global illumination (indirect diffuse light, replaces GTAO; no argument toggles)
  contact [on|off|toggle] [--length m] [--steps n] [--thickness t]
                                                    contact shadows of the shadow-casting directional light (no argument reports; toggle flips)
  ssr [on|off|toggle] [--maxRoughness r] [--thickness t] [--maxSteps n] [--debug off|hits|reflection]
                                                    screen-space reflections (no argument reports; toggle flips)
  raycast <x,y,z> <dx,dy,dz> [--max 1000] [--mask <bits>]
  logs [-f] [--since <seq>] [--level info|warn|error] [--source console|error|engine|native|event] [--json]
  eval <code | -> | --file <script.js> [--check]
                          run JavaScript in the page. An expression: its value, await works, and in scope are game, engine,
                          entity(name | id), named(name), frames(n), seconds(s) (game time). Statements: the value of the
                          last one (global scope); with a top-level await they run as an async function body (use return).
                          - reads stdin; --file reads a file (no shell quoting); --check type-checks it first against the
                          engine's types (as TypeScript, eval scope declared) and does not run it on errors
  debug [plan | - | --file <plan.json>] [--break <file:line>]... [--log <file:line>=<expr>]... [--watch <expr>]...
        [--run <code>] [--exceptions uncaught|all] [--steps n] [--max hits] [--seconds s]
                          one-shot debugging session (needs a Chrome from stride open; pauses never go through the page).
                          plan (JSON): breakpoints [{ at: "file:line" (TS source; a path suffix is enough), condition,
                          hitCount, log (logpoint: record this expression's value, do not pause), watch: [expr] }],
                          exceptions ("uncaught" | "all"), watch [expr] (at every pause), steps (step over n times after a
                          pause), run (code to eval in the page once breakpoints are set, like stride eval), maxHits (10),
                          seconds (10), depth (1). Reports where breakpoints resolved, each pause (reason, stack in source
                          positions, locals, watches, steps) and the logpoint records; pauses resume on their own
  slow <ms>               make every frame that much longer (busy wait) to reproduce CI's software WebGPU; 0 stops
  particles [--name <text>]                         particle emitters: CPU or GPU, pool size, living particles and where they are

Types (TypeScript 7's language server; positions are 1-based like the compiler's messages)
  ${TS_USAGE}

Common options
  --hub <text>            pick a hub by name or url (default: the one whose page connected last)
  --page <id>             pick a page of the hub (default: the last connected)
  --timeout <seconds>     how long a page command may take (default 120, or STRIDE_TIMEOUT)
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
    game: { type: 'string' },
    file: { type: 'string' },
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
    entity: { type: 'string' },
    width: { type: 'string' },
    translucency: { type: 'string' },
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
    check: { type: 'boolean' },
    in: { type: 'string' },
    break: { type: 'string', multiple: true },
    log: { type: 'string', multiple: true },
    watch: { type: 'string', multiple: true },
    run: { type: 'string' },
    exceptions: { type: 'string' },
    interactive: { type: 'boolean' },
    button: { type: 'string' },
    count: { type: 'string' },
    modifiers: { type: 'string' },
    dy: { type: 'string' },
    dx: { type: 'string' },
    repeat: { type: 'string' },
    ref: { type: 'string' },
    'no-cursor': { type: 'boolean' },
    mobile: { type: 'boolean' },
  },
});

const positionals = rawPositionals.map((arg) => (arg.startsWith(NEGATIVE) ? arg.slice(1) : arg));
const [command, ...rest] = positionals;
const page = options.page === undefined ? undefined : Number(options.page);
// 没给 --timeout 时看环境变量 STRIDE_TIMEOUT（秒）：CI 的软件 WebGPU 上一帧零点几秒，按帧等的命令要更久
// open、wait 等页面连上来也按它（CI 上软件 WebGPU 的页面起来要一分多钟，冒烟在这里超时过）
const timeoutSeconds = options.timeout ?? process.env['STRIDE_TIMEOUT'];
const timeout = timeoutSeconds === undefined ? undefined : Number(timeoutSeconds) * 1000;

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
  // 扩展直连着中枢：会话走中枢（不经过页面，能收事件）；只装了旧扩展：经页面转发；都没有：直连 stride open 的 Chrome
  if (info.bridge) return { client, info, cdp: await client.devtoolsSocket(info.id) };
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
  // Tracing 整个浏览器同时只能有一个（别的会话、别的标签在录时报"already been started"）：排队等它录完，最多等 2 分钟
  for (const deadline = Date.now() + 120_000; ;) {
    try {
      await cdp.send('Tracing.start', { traceConfig: { includedCategories: categories, excludedCategories: ['*'] }, transferMode: 'ReturnAsStream' });
      break;
    } catch (error) {
      if (!/already been started/i.test(String(error)) || Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
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
 * 锁定。--hold 按住这么久，--down、--up 只按下或只松开；默认按住到游戏跑过一帧（至少 100 ms）再松开：按下、松开落在同一帧里时
 * 脚本的 isMouseButtonDown 一直是 false（帧很慢的机器上，比如 CI 的软件 WebGPU，100 ms 不到一帧）；只多按一帧，按住连发的枪不会多打一发。
 */
/** 页面里等 100 ms、再等游戏的帧号走过一帧（页面里没有游戏时只等 100 ms；暂停时帧号不走，最多等 5 秒）。 */
const HOLD_ONE_FRAME = `new Promise((resolve) => setTimeout(() => {
  const game = globalThis.strideGame, start = game?.frames ?? 0, end = performance.now() + 5000;
  const next = () => (!game || game.frames >= start + 1 || performance.now() > end ? resolve(1) : requestAnimationFrame(next));
  next();
}, 100))`;

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
  if (!options.up) {
    if (options.hold !== undefined) await new Promise((resolve) => setTimeout(resolve, Number(options.hold)));
    else await cdp.send('Runtime.evaluate', { expression: HOLD_ONE_FRAME, awaitPromise: true });
  }
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
    return { browser, game: await waitForGame(Number(timeoutSeconds ?? 60), gamePagePrefix(url)) };
  },
  async close() {
    return { closed: await closeBrowser() };
  },
  async hubs() {
    return Promise.all(listHubs().map(async (hub) => ({ name: hub.name, url: hub.url, pid: hub.pid, pages: await new HubClient(hub).pages().catch((error: unknown) => String(error)) })));
  },
  wait: () => (options.game === undefined ? waitForGame(Number(timeoutSeconds ?? 30)) : call('eval', { code: `(async () => { const start = game.updateTime.total; await seconds(${Number(options.game)}); return { waited: game.updateTime.total - start, total: game.updateTime.total }; })()` })),
  particles: () => call('particles', options.name ? { name: options.name } : {}),
  slow: () => call('slow', { ms: Number(required(rest[0], 'ms')) }),
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
    // 和参考图比时那一帧不加输出的抖动（每个像素 ±半个色阶的噪声）
    const { png, ...info } = (await call('screenshot', options.diff ? { exact: true } : {})) as { png: string; width: number; height: number; frame: number };
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
  async page() {
    const [sub, ...args] = rest;
    const { cdp: session } = await pageCdp(`page ${sub ?? ''}`);
    // 下面的 return 都要 await：await using 在 return 时就释放会话（关掉 WebSocket），命令还没回复
    await using cdp = session;
    setCursorEnabled(options['no-cursor'] !== true);
    const at = (i: number, what: string) => required(args[i], what);
    switch (sub) {
      // 树和文字原样打（给人和 agent 读的多行文字）；别的命令的结果按 JSON（脚本解析 CLI 的输出）
      case 'tree':
        return void console.log(await pageTree(cdp, { interactive: options.interactive === true, max: Number(options.max ?? 400) }));
      case 'find':
        return void console.log(await pageFind(cdp, args.join(' ')));
      case 'text':
        return void console.log(await pageText(cdp));
      case 'eval':
        return await pageEval(cdp, options.file ? readFileSync(options.file, 'utf8') : args.join(' '));
      case 'click':
        return await pageClick(cdp, at(0, 'element ref or x,y'), {
          ...(options.button ? { button: options.button as 'left' | 'right' | 'middle' } : {}),
          ...(options.count ? { count: Number(options.count) } : {}),
          ...(options.modifiers ? { modifiers: options.modifiers } : {}),
        });
      case 'hover':
        return await pageHover(cdp, at(0, 'element ref or x,y'));
      case 'drag':
        return await pageDrag(cdp, at(0, 'from (ref or x,y)'), at(1, 'to (ref or x,y)'), {
          ...(options.steps ? { steps: Number(options.steps) } : {}),
          ...(options.button ? { button: options.button as 'left' | 'right' | 'middle' } : {}),
          ...(options.modifiers ? { modifiers: options.modifiers } : {}),
        });
      case 'scroll':
        return await pageScroll(cdp, at(0, 'element ref or x,y'), Number(options.dy ?? 300), Number(options.dx ?? 0));
      case 'type':
        await pageType(cdp, args.join(' '));
        return { typed: args.join(' ').length };
      case 'key':
        await pageKey(cdp, args, Number(options.repeat ?? 1));
        return { pressed: args };
      case 'shot': {
        const out = at(0, 'output .png');
        const png = await pageShot(cdp, options.ref);
        writeFileSync(out, png);
        return { written: out, bytes: png.length };
      }
      default:
        throw new Error('page <tree|find|text|click|hover|drag|scroll|type|key|shot>; see stride --help');
    }
  },
  async throttle() {
    // CPU 降速（DevTools 的"性能"里那个）：复现 CI 上软件 WebGPU、慢机器的时序。1 是不降速；同一个会话断开时 Chrome 会恢复，所以
    // 降速期间要一直挂着：给 --seconds 时降速这么久再恢复，不给时降到按 Ctrl+C 为止
    const rate = Number(required(rest[0], 'rate (1 = off, 4 = 4x slower)'));
    const { cdp: session } = await pageCdp('throttle');
    await using cdp = session;
    await cdp.send('Emulation.setCPUThrottlingRate', { rate });
    if (rate === 1) return { rate };
    const seconds = options.seconds ? Number(options.seconds) : undefined;
    console.error(`CPU throttled ${rate}x${seconds ? ` for ${seconds} s` : '; Ctrl+C to stop'}`);
    await new Promise<void>((resolve) => {
      const timer = seconds ? setTimeout(resolve, seconds * 1000) : undefined;
      process.once('SIGINT', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    return { rate, restored: true };
  },
  async viewport() {
    // 视口的大小和像素比（测不同的屏幕、手机竖屏）；off 恢复。同 throttle：会话断开时 Chrome 恢复，所以挂着直到 Ctrl+C 或 --seconds
    const { cdp: session } = await pageCdp('viewport');
    await using cdp = session;
    if (rest[0] === 'off') {
      await cdp.send('Emulation.clearDeviceMetricsOverride', {});
      return { viewport: 'off' };
    }
    const [width, height] = required(rest[0], 'size (e.g. 390x844) or off').split('x').map(Number);
    const deviceScaleFactor = options.dpr ? Number(options.dpr) : 0;
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor, mobile: options.mobile === true });
    const seconds = options.seconds ? Number(options.seconds) : undefined;
    console.error(`viewport ${width}x${height}${deviceScaleFactor ? ` @${deviceScaleFactor}x` : ''}${seconds ? ` for ${seconds} s` : '; Ctrl+C to stop'}`);
    await new Promise<void>((resolve) => {
      const timer = seconds ? setTimeout(resolve, seconds * 1000) : undefined;
      process.once('SIGINT', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    await cdp.send('Emulation.clearDeviceMetricsOverride', {});
    return { width, height, restored: true };
  },
  async front() {
    // 后台的标签不跑 requestAnimationFrame（启动参数也管不了）：把游戏标签切到前面
    const { cdp: session } = await pageCdp('front');
    await using cdp = session;
    await cdp.send('Page.bringToFront', {});
    return { front: true };
  },
  draws: () => call('draws', {}),
  metrics: () => call('metrics', options.over ? { over: true } : {}),
  ao: () => call('ao', { ...switchArgs(rest[0]), ...(options.radius ? { radius: Number(options.radius) } : {}) }),
  blur: () => call('blur', {
    ...switchArgs(rest[0]),
    ...Object.fromEntries((['shutter', 'maxPixels'] as const).filter((key) => options[key] !== undefined).map((key) => [key, Number(options[key])])),
  }),
  contact: () => call('contact', {
    ...switchArgs(rest[0]),
    ...Object.fromEntries((['length', 'steps', 'thickness'] as const).filter((key) => options[key] !== undefined).map((key) => [key, Number(options[key])])),
  }),
  sss: () => call('sss', {
    ...switchArgs(rest[0]),
    ...(options.entity ? { entity: options.entity } : {}),
    ...Object.fromEntries((['width', 'translucency'] as const).filter((key) => options[key] !== undefined).map((key) => [key, Number(options[key])])),
  }),
  ssgi: () => call('ssgi', {
    ...switchArgs(rest[0]),
    ...Object.fromEntries((['radius', 'thickness', 'intensity', 'feedback'] as const).filter((key) => options[key] !== undefined).map((key) => [key, Number(options[key])])),
  }),
  ssr: () => call('ssr', {
    ...switchArgs(rest[0]),
    ...Object.fromEntries((['maxRoughness', 'thickness', 'maxSteps'] as const).filter((key) => options[key] !== undefined).map((key) => [key, Number(options[key])])),
    ...(options.debug ? { debug: options.debug } : {}),
  }),
  taa: () => call('taa', switchArgs(rest[0])),
  quality: () => call('quality', rest[0] === undefined ? {} : { tier: rest[0] }),
  wireframe: () => call('wireframe', switchArgs(rest[0])),
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
    const code = required((options.file ? readFileSync(options.file, 'utf8') : rest[0] === '-' ? readFileSync(0, 'utf8') : rest.join(' ')) || undefined, 'code');
    if (options.check) {
      const server = await TypeScriptServer.start();
      const errors = await checkEval(server, code).finally(() => server.close());
      if (errors.some((diagnostic) => diagnostic.severity === 'error')) {
        process.exitCode = 1;
        return { ran: false, diagnostics: errors };
      }
    }
    return call('eval', { code });
  },
  ts: () => runTypeQuery(rest[0], rest.slice(1), options),
  async debug() {
    const text = options.file ? readFileSync(options.file, 'utf8') : rest[0] === '-' ? readFileSync(0, 'utf8') : rest.join(' ');
    // 简单的会话不用写 JSON：--break、--log 文件:行=表达式、--watch、--run、--exceptions、--steps、--max、--seconds 拼成计划
    const flags = {
      breakpoints: [
        ...(options.break ?? []).map((at) => ({ at })),
        ...(options.log ?? []).map((spec) => ({ at: spec.slice(0, spec.indexOf('=')), log: spec.slice(spec.indexOf('=') + 1) })),
      ],
      ...(options.watch ? { watch: options.watch } : {}),
      ...(options.run === undefined ? {} : { run: options.run }),
      ...(options.exceptions ? { exceptions: options.exceptions as 'uncaught' | 'all' } : {}),
      ...(options.steps ? { steps: Number(options.steps) } : {}),
      ...(options.max ? { maxHits: Number(options.max) } : {}),
      ...(options.seconds ? { seconds: Number(options.seconds) } : {}),
    };
    const base = text ? (JSON.parse(text) as DebugPlan & { run?: string }) : {};
    const plan: DebugPlan & { run?: string } = { ...base, ...flags, breakpoints: [...(base.breakpoints ?? []), ...flags.breakpoints] };
    if (!plan.breakpoints?.length && !plan.exceptions) throw new Error('debug: give a plan (JSON) or --break / --log / --exceptions; see stride --help');
    // 停在断点上时页面的 JS 都不走：要不经过页面的 DevTools 连接——调试桥扩展直连中枢（0.4 起，主 Chrome 也行），或者 stride open
    // 起的 Chrome 的调试端口
    const client = await HubClient.find(options.hub);
    const pages = await client.pages();
    const info = page === undefined ? pages.at(-1) : pages.find((p) => p.id === page);
    if (!info) throw new Error('no page is connected');
    const browser = readBrowser();
    if (!info.bridge && !browser) throw new Error('debug pauses the page, so it needs a DevTools connection that does not go through the page: the Stride Debug Bridge extension 0.4+ (connects to the hub by itself) or a Chrome from `stride open <url>`');
    await using cdp = info.bridge ? await client.devtoolsSocket(info.id) : await CdpSession.connect((await pageTarget(browser!, info.url)).webSocketDebuggerUrl);
    let ran: Promise<unknown> | undefined;
    const trigger = plan.run === undefined ? undefined : () => {
      ran = client.call('eval', { code: plan.run }, { page: info.id, timeout: (plan.seconds ?? 10) * 1000 + 60_000 }).catch((error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }));
    };
    const result = await runDebugPlan(cdp, plan, trigger);
    // 触发的代码多半在放走断点以后很快跑完：等它一会儿，结果一起报
    const run = ran && (await Promise.race([ran, new Promise((resolve) => setTimeout(() => resolve('<still running>'), 3000))]));
    return { ...result, ...(ran ? { run } : {}) };
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

/** 开关类命令的第一个参数：on、off、toggle（翻过来）；没给时不改，只报告现在的状态。 */
function switchArgs(word: string | undefined): { on?: boolean | 'toggle' } {
  if (word === undefined) return {};
  if (word === 'toggle') return { on: 'toggle' };
  if (word !== 'on' && word !== 'off') throw new Error(`expected on, off or toggle, got '${word}'`);
  return { on: word === 'on' };
}
