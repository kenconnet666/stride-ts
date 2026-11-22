/**
 * `stride debug`：给 agent 用的一次性调试会话（DevTools 协议的 Debugger 域）。不交互：一份计划（断点、日志点、要看的表达式、
 * 触发的代码）进去，结构化的结果（每次停下的调用栈、局部变量、表达式的值，日志点的记录）出来，停下的地方自动继续。
 * 位置都按 TS 源码写（`文件:行`，1 起），经 Vite 内联的 source map 换成浏览器里的脚本位置，报回来时再换回源码位置。
 *
 * 功能照 VS Code 的 js-debug、Chrome DevTools 里常用的挑：条件断点、命中次数、日志点（不停下，只记表达式的值）、异常时停下、
 * 停下后单步若干次、跳过第三方代码（node_modules 不进单步和调用栈）。
 *
 * 要停下的会话需要和页面无关的 DevTools 连接（`stride open` 起的 Chrome，无头的也行）：页面停在断点上时它自己的 JS（调试桥的
 * 内容脚本也是）都不走，经页面转发的连接没法再发"继续"。
 */
import type { DevtoolsSession } from './client.ts';

/** 一个断点：at 是 `文件:行`（文件是仓库里的路径或者它的结尾，比如 `world/TerrainSystem.ts:120`）。 */
export interface DebugBreakpoint {
  readonly at: string;
  /** 条件（源码作用域里的 JS 表达式），真的时才停。 */
  readonly condition?: string;
  /** 第几次经过才停（之后每次都停）。 */
  readonly hitCount?: number;
  /** 日志点：不停下，记下这个表达式每次经过时的值。 */
  readonly log?: string;
  /** 在这个断点停下时额外求的表达式。 */
  readonly watch?: readonly string[];
}

export interface DebugPlan {
  readonly breakpoints?: readonly DebugBreakpoint[];
  /** 抛异常时停下：uncaught 只停没人接的，all 连 catch 住的也停。默认不停。 */
  readonly exceptions?: 'none' | 'uncaught' | 'all';
  /** 每次停下都求的表达式（在停下的那一帧的作用域里）。 */
  readonly watch?: readonly string[];
  /** 停下以后再单步（跳过函数调用）几次，每步记位置和表达式。 */
  readonly steps?: number;
  /** 最多停几次（到了就清掉断点，让页面跑完）。默认 10。 */
  readonly maxHits?: number;
  /** 等停下最多几秒（墙钟）。默认 10。 */
  readonly seconds?: number;
  /** 局部变量展开几层（对象的属性）。默认 1。 */
  readonly depth?: number;
}

/** 浏览器里的一个脚本：DevTools 的 scriptId、地址和它的 source map（Vite 开发时内联在脚本末尾）。 */
interface Script {
  readonly id: string;
  readonly url: string;
  readonly sourceMapURL: string;
  map?: SourceMap | null;
}

export interface DebugFrame {
  readonly function: string;
  /** 源码位置 `文件:行:列`（换不回源码时是脚本地址）。 */
  readonly at: string;
}

export interface DebugHit {
  readonly reason: string;
  /** 停在哪个断点（计划里的 at）；异常、单步时没有。 */
  readonly breakpoint?: string;
  readonly stack: readonly DebugFrame[];
  readonly locals: Readonly<Record<string, unknown>>;
  readonly watch: Readonly<Record<string, unknown>>;
  /** 异常时：抛出来的值。 */
  readonly exception?: unknown;
  /** 单步记下的位置和表达式。 */
  readonly steps?: readonly { readonly at: string; readonly watch: Readonly<Record<string, unknown>> }[];
}

export interface DebugResult {
  readonly breakpoints: readonly { readonly at: string; readonly resolved: readonly string[]; readonly error?: string }[];
  readonly hits: readonly DebugHit[];
  readonly logs: readonly { readonly at: string; readonly value: unknown }[];
  /** 等到时间也没停够 maxHits 次。 */
  readonly timedOut: boolean;
}

/** 能收事件的 DevTools 会话（CdpSession）。 */
export interface EventedSession extends DevtoolsSession {
  on(event: string, listener: (params: unknown) => void): void;
}

// ---------------------------------------------------------------------------------------------
// source map（v3）：只解码 mappings，按行找映射。纯函数，测试见 test/debugger.test.ts。
// ---------------------------------------------------------------------------------------------

/** 一段映射：生成代码的列，和它对应的源文件、行、列（都从 0 起）。 */
export interface Mapping {
  readonly column: number;
  readonly source: number;
  readonly line: number;
  readonly sourceColumn: number;
}

export interface SourceMap {
  readonly sources: readonly string[];
  /** 生成代码每一行的映射（按列排好）。 */
  readonly lines: readonly (readonly Mapping[])[];
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE64_VALUE = new Map(Array.from(BASE64).map((char, i) => [char, i]));

/** 解析 source map 的 JSON（只认 mappings 和 sources；不处理 sections 的索引式 source map）。 */
export function parseSourceMap(json: { sources: readonly string[]; sourceRoot?: string; mappings: string }): SourceMap {
  const root = json.sourceRoot ? json.sourceRoot.replace(/\/?$/, '/') : '';
  const lines: Mapping[][] = [];
  let source = 0, line = 0, sourceColumn = 0;
  for (const text of json.mappings.split(';')) {
    const segments: Mapping[] = [];
    let column = 0;
    for (const segment of text.split(',')) {
      if (!segment) continue;
      const values = decodeVlq(segment);
      column += values[0]!;
      if (values.length < 4) continue; // 没有源位置的段
      source += values[1]!;
      line += values[2]!;
      sourceColumn += values[3]!;
      segments.push({ column, source, line, sourceColumn });
    }
    lines.push(segments);
  }
  return { sources: json.sources.map((s) => root + s), lines };
}

function decodeVlq(segment: string): number[] {
  const values: number[] = [];
  let value = 0, shift = 0;
  for (const char of segment) {
    const digit = BASE64_VALUE.get(char);
    if (digit === undefined) throw new Error(`source map: bad base64 '${char}'`);
    value += (digit & 31) << shift;
    if (digit & 32) {
      shift += 5;
      continue;
    }
    values.push(value & 1 ? -(value >>> 1) : value >>> 1);
    value = shift = 0;
  }
  return values;
}

/** 源码的第 line 行（0 起）在生成代码里最早的位置；这一行没有映射时往下找几行（空行、注释）。 */
export function generatedPosition(map: SourceMap, source: number, line: number): { line: number; column: number } | undefined {
  for (let target = line; target < line + 8; target++) {
    let best: { line: number; column: number } | undefined;
    map.lines.forEach((segments, generatedLine) => {
      for (const m of segments) {
        if (m.source !== source || m.line !== target) continue;
        if (!best || generatedLine < best.line || (generatedLine === best.line && m.column < best.column)) best = { line: generatedLine, column: m.column };
      }
    });
    if (best) return best;
  }
  return undefined;
}

/** 生成代码的位置（0 起）对应的源码位置。 */
export function originalPosition(map: SourceMap, line: number, column: number): { source: string; line: number; column: number } | undefined {
  const segments = map.lines[line];
  if (!segments?.length) return undefined;
  let found = segments[0]!;
  for (const m of segments) if (m.column <= column) found = m;
  return { source: map.sources[found.source]!, line: found.line, column: found.sourceColumn };
}

/** `文件:行` 拆开；文件统一成正斜杠。 */
export function parseLocation(at: string): { file: string; line: number } {
  const match = /^(.*):(\d+)$/.exec(at.trim());
  if (!match) throw new Error(`breakpoint '${at}' must be <file>:<line>`);
  return { file: match[1]!.replace(/\\/g, '/'), line: Number(match[2]) };
}

/** 脚本地址的路径和要找的文件的结尾对得上几段（按路径段从后往前比，大小写不敏感）；0 是对不上。 */
export function pathMatch(url: string, file: string): number {
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(url).pathname);
  } catch {
    return 0;
  }
  const a = pathname.toLowerCase().split('/').filter(Boolean), b = file.toLowerCase().split('/').filter((s) => s && s !== '.');
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n === 0 ? 0 : n;
}

// ---------------------------------------------------------------------------------------------
// 会话
// ---------------------------------------------------------------------------------------------

/** C、C++ 的源文件：断点在 wasm 模块里找。 */
const NATIVE_SOURCE = /\.(c|cc|cpp|cxx|h|hh|hpp|inl)$/i;
const WASM_URL = /\.wasm(\?|$)/i;

/**
 * 页面里的帮手：值的摘要（深度有限、不会被循环引用卡住）和日志点的记录。用到时在当前的执行上下文里建（DEBUG）：停在 iframe 里
 * （编辑器的视口）时那里没有顶层页面的全局，事先只在顶层装的话摘要、日志点在 iframe 里都会失败。
 */
const PAGE_HELPERS = `(() => {
  const summarize = (value, depth) => {
    if (value === null || value === undefined || typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') return value;
    if (typeof value === 'bigint') return value + 'n';
    if (typeof value === 'function') return 'function ' + (value.name || '(anonymous)');
    if (typeof value === 'symbol') return String(value);
    if (ArrayBuffer.isView(value)) return value.constructor.name + '(' + value.length + ') [' + Array.from(value.slice(0, 16)).join(', ') + (value.length > 16 ? ', …' : '') + ']';
    if (depth <= 0) return Array.isArray(value) ? 'Array(' + value.length + ')' : (value.constructor?.name ?? 'Object');
    if (Array.isArray(value)) return value.slice(0, 20).map((item) => summarize(item, depth - 1)).concat(value.length > 20 ? ['… ' + (value.length - 20) + ' more'] : []);
    if (value instanceof Map) return Object.fromEntries([...value].slice(0, 20).map(([k, v]) => [String(k), summarize(v, depth - 1)]));
    if (value instanceof Set) return [...value].slice(0, 20).map((v) => summarize(v, depth - 1));
    const out = {};
    let n = 0;
    for (const key in value) {
      if (n++ >= 30) { out['…'] = 'more'; break; }
      try { out[key] = summarize(value[key], depth - 1); } catch (error) { out[key] = '<' + error + '>'; }
    }
    return out;
  };
  return { summarize, logs: [], log(at, read) {
    if (this.logs.length >= 2000) return;
    let value;
    try { value = summarize(read(), 2); } catch (error) { value = '<' + error + '>'; }
    this.logs.push({ at, value });
  }, hits: {} };
})()`;

/** 当前执行上下文里的帮手（没有就建）。 */
const DEBUG = `(globalThis.__strideDebug ??= ${PAGE_HELPERS})`;

/** 一条断点在页面里的条件：日志点记值不停下；命中次数用页面里的计数。 */
function breakpointCondition(bp: DebugBreakpoint, index: number): string | undefined {
  const at = JSON.stringify(bp.at);
  if (bp.log !== undefined) return `(${DEBUG}.log(${at}, () => (${bp.log})), false)`;
  const parts: string[] = [];
  if (bp.hitCount !== undefined) parts.push(`((${DEBUG}.hits[${index}] = (globalThis.__strideDebug.hits[${index}] ?? 0) + 1) >= ${bp.hitCount})`);
  if (bp.condition !== undefined) parts.push(`(${bp.condition})`);
  return parts.length ? parts.join(' && ') : undefined;
}

interface RemoteObject {
  type: string;
  subtype?: string;
  value?: unknown;
  description?: string;
  objectId?: string;
  unserializableValue?: string;
}

interface CallFrame {
  callFrameId: string;
  functionName: string;
  location: { scriptId: string; lineNumber: number; columnNumber: number };
  url: string;
  scopeChain: { type: string; object: RemoteObject }[];
}

interface Paused {
  reason: string;
  callFrames: CallFrame[];
  hitBreakpoints?: string[];
  data?: RemoteObject;
}

/**
 * 跑一份调试计划。trigger 在断点都设好以后调用（比如经中枢在页面里 eval 一段代码，不等它完成——停在断点上时它不会完成）；
 * 没有 trigger 时只等页面自己跑到断点（帧循环里的代码）。
 */
export async function runDebugPlan(cdp: EventedSession, plan: DebugPlan, trigger?: () => void): Promise<DebugResult> {
  const scripts = new Map<string, Script>();
  cdp.on('Debugger.scriptParsed', (params) => {
    const p = params as { scriptId: string; url: string; sourceMapURL?: string };
    if (p.url) scripts.set(p.scriptId, { id: p.scriptId, url: p.url, sourceMapURL: p.sourceMapURL ?? '' });
  });
  const pauses: Paused[] = [];
  let wake: (() => void) | undefined;
  cdp.on('Debugger.paused', (params) => {
    pauses.push(params as Paused);
    wake?.();
  });
  const nextPause = (ms: number): Promise<Paused | undefined> => {
    if (pauses.length) return Promise.resolve(pauses.shift());
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        wake = undefined;
        resolve(undefined);
      }, ms);
      wake = () => {
        clearTimeout(timer);
        wake = undefined;
        resolve(pauses.shift());
      };
    });
  };

  // 页面的各个执行上下文（顶层和 iframe）：日志点记在命中的那个上下文里，最后挨个收
  const contexts = new Set<number>();
  cdp.on('Runtime.executionContextCreated', (params) => contexts.add((params as { context: { id: number } }).context.id));
  cdp.on('Runtime.executionContextDestroyed', (params) => contexts.delete((params as { executionContextId: number }).executionContextId));
  await cdp.send('Runtime.enable', {});
  await cdp.send('Debugger.enable', {});
  await cdp.send('Debugger.setAsyncCallStackDepth', { maxDepth: 8 });
  await cdp.send('Debugger.setBlackboxPatterns', { patterns: ['/node_modules/', '/@vite/', '/@id/'] });
  // scriptParsed 在 enable 时把已有的脚本都报一遍；等事件到齐
  await new Promise((resolve) => setTimeout(resolve, 300));

  const mapOf = async (script: Script): Promise<SourceMap | null> => {
    if (script.map !== undefined) return script.map;
    script.map = null;
    try {
      const url = script.sourceMapURL;
      if (!url) return null;
      const text = url.startsWith('data:') ? Buffer.from(url.slice(url.indexOf(',') + 1), url.includes(';base64,') ? 'base64' : 'utf8').toString('utf8') : await (await fetch(new URL(url, script.url))).text();
      script.map = parseSourceMap(JSON.parse(text) as Parameters<typeof parseSourceMap>[0]);
    } catch {
      script.map = null;
    }
    return script.map;
  };
  const describe = async (scriptId: string, line: number, column: number): Promise<string> => {
    const script = scripts.get(scriptId);
    if (!script) return `script ${scriptId}:${line + 1}:${column + 1}`;
    const map = await mapOf(script);
    const original = map && originalPosition(map, line, column);
    const where = (original ? original.source : script.url).replace(/^.*?\/(packages|apps|src)\//, '$1/');
    return `${where}:${(original?.line ?? line) + 1}:${(original?.column ?? column) + 1}`;
  };

  const scriptsAt = (file: string): Script[] => {
    const candidates = [...scripts.values()].map((script) => ({ script, score: pathMatch(script.url, file) })).filter((c) => c.score > 0);
    const best = Math.max(0, ...candidates.map((c) => c.score));
    return candidates.filter((c) => c.score === best).map((c) => c.script);
  };
  // C++ 的源文件：在 wasm 模块的 source map（调试版带着）里找
  const wasmScriptsWith = async (file: string): Promise<Script[]> => {
    const found: Script[] = [];
    for (const script of scripts.values()) {
      if (!WASM_URL.test(script.url)) continue;
      const map = await mapOf(script);
      if (map?.sources.some((source) => pathMatch(new URL(source, script.url).href, file) > 0)) found.push(script);
    }
    return found;
  };

  // 断点：找到脚本，源码行换成脚本里的位置
  const breakpointIds = new Map<string, DebugBreakpoint>();
  const resolvedList: { at: string; resolved: string[]; error?: string }[] = [];
  const breakpoints = plan.breakpoints ?? [];
  for (const [index, bp] of breakpoints.entries()) {
    const entry: { at: string; resolved: string[]; error?: string } = { at: bp.at, resolved: [] };
    resolvedList.push(entry);
    try {
      const { file, line } = parseLocation(bp.at);
      const matches = NATIVE_SOURCE.test(file) ? await wasmScriptsWith(file) : scriptsAt(file);
      if (matches.length === 0) throw new Error(NATIVE_SOURCE.test(file) ? `no loaded wasm module has a source map with '${file}' (run the game with debugNative so the debug modules, which carry source maps, are loaded)` : `no loaded script matches '${file}'`);
      for (const script of matches) {
        const map = await mapOf(script);
        let position = { line: line - 1, column: 0 };
        if (map) {
          const source = map.sources.findIndex((s) => pathMatch(new URL(s, script.url).href, file) > 0);
          const mapped = generatedPosition(map, source < 0 ? 0 : source, line - 1);
          if (!mapped) throw new Error(`line ${line} of '${file}' has no code`);
          position = mapped;
        }
        const condition = breakpointCondition(bp, index);
        const { breakpointId, locations } = (await cdp.send('Debugger.setBreakpointByUrl', {
          url: script.url, lineNumber: position.line, columnNumber: position.column, ...(condition ? { condition } : {}),
        })) as { breakpointId: string; locations: { scriptId: string; lineNumber: number; columnNumber: number }[] };
        breakpointIds.set(breakpointId, bp);
        for (const location of locations) entry.resolved.push(await describe(location.scriptId, location.lineNumber, location.columnNumber));
      }
    } catch (error) {
      entry.error = error instanceof Error ? error.message : String(error);
    }
  }
  await cdp.send('Debugger.setPauseOnExceptions', { state: plan.exceptions ?? 'none' });

  const depth = plan.depth ?? 1;
  // 表达式展开 depth + 1 层（看的就是它），局部变量 depth 层（一般只要看清是什么）
  const summarize = async (callFrameId: string, expression: string, levels = depth + 1): Promise<unknown> => {
    const { result, exceptionDetails } = (await cdp.send('Debugger.evaluateOnCallFrame', {
      callFrameId, expression: `${DEBUG}.summarize((${expression}), ${levels})`, returnByValue: true, silent: true,
    })) as { result: RemoteObject; exceptionDetails?: { exception?: RemoteObject; text: string } };
    return exceptionDetails ? `<${exceptionDetails.exception?.description ?? exceptionDetails.text}>` : result.value;
  };
  // wasm 的帧里不能跑 JS：表达式按 DevTools 的 wasm 求值（$局部变量名），值直接取
  const isWasm = (frame: CallFrame) => WASM_URL.test(frame.url || scripts.get(frame.location.scriptId)?.url || '');
  const valueOf = (object: RemoteObject | undefined): unknown => object === undefined ? undefined : object.value ?? object.unserializableValue ?? object.description ?? object.type;
  const evaluateIn = async (frame: CallFrame, expression: string): Promise<unknown> => {
    if (!isWasm(frame)) return summarize(frame.callFrameId, expression);
    const { result, exceptionDetails } = (await cdp.send('Debugger.evaluateOnCallFrame', { callFrameId: frame.callFrameId, expression, silent: true })) as { result: RemoteObject; exceptionDetails?: { text: string } };
    return exceptionDetails ? `<${exceptionDetails.text}>` : wasmValue(result);
  };
  // V8 把 wasm 的值包成 { type, value } 的对象（subtype wasmvalue）：取里面的值，i64 是 bigint
  const wasmValue = async (object: RemoteObject | undefined): Promise<unknown> => {
    if (object?.subtype !== 'wasmvalue' || !object.objectId) return valueOf(object);
    const { result } = (await cdp.send('Runtime.callFunctionOn', {
      objectId: object.objectId, returnByValue: true,
      functionDeclaration: 'function () { const v = this.value; return typeof v === "bigint" ? v + "n" : v; }',
    })) as { result: RemoteObject };
    return result.value ?? valueOf(object);
  };
  const watchAll = async (frame: CallFrame, expressions: readonly string[]) =>
    Object.fromEntries(await Promise.all(expressions.map(async (e) => [e, await evaluateIn(frame, e)] as const)));
  const localsOf = async (frame: CallFrame): Promise<Record<string, unknown>> => {
    const out: Record<string, unknown> = {};
    for (const scope of frame.scopeChain.filter((s) => s.type === 'local' || s.type === 'block').slice(0, 3)) {
      const { result } = (await cdp.send('Runtime.getProperties', { objectId: scope.object.objectId, ownProperties: true })) as { result: { name: string; value?: RemoteObject }[] };
      for (const { name, value } of result.slice(0, 40)) {
        if (!(name in out)) out[name] = isWasm(frame) ? await wasmValue(value) : await summarize(frame.callFrameId, name, depth);
      }
    }
    return out;
  };

  const hits: DebugHit[] = [];
  const maxHits = plan.maxHits ?? 10;
  const deadline = Date.now() + (plan.seconds ?? 10) * 1000;
  trigger?.();
  let timedOut = false;
  while (hits.length < maxHits) {
    const paused = await nextPause(Math.max(0, deadline - Date.now()));
    if (!paused) {
      timedOut = true;
      break;
    }
    const top = paused.callFrames[0]!;
    const bp = paused.hitBreakpoints?.map((id) => breakpointIds.get(id)).find(Boolean);
    const stack = await Promise.all(paused.callFrames.slice(0, 12).map(async (f) => ({ function: f.functionName || '(anonymous)', at: await describe(f.location.scriptId, f.location.lineNumber, f.location.columnNumber) })));
    const watch = await watchAll(top, [...(plan.watch ?? []), ...(bp?.watch ?? [])]);
    const fields = {
      reason: paused.reason, ...(bp ? { breakpoint: bp.at } : {}), stack, locals: await localsOf(top), watch,
      ...(paused.reason === 'exception' && paused.data ? { exception: paused.data.description ?? paused.data.value } : {}),
    };
    const steps: { at: string; watch: Record<string, unknown> }[] = [];
    for (let i = 0; i < (plan.steps ?? 0); i++) {
      await cdp.send('Debugger.stepOver', {});
      const step = await nextPause(5000);
      if (!step) break;
      const frame = step.callFrames[0]!;
      steps.push({ at: await describe(frame.location.scriptId, frame.location.lineNumber, frame.location.columnNumber), watch: await watchAll(frame, [...(plan.watch ?? []), ...(bp?.watch ?? [])]) });
    }
    const hit: DebugHit = { ...fields, ...(plan.steps ? { steps } : {}) };
    hits.push(hit);
    if (hits.length >= maxHits) await clearBreakpoints(cdp, breakpointIds);
    await cdp.send('Debugger.resume', {}).catch(() => undefined);
  }
  await clearBreakpoints(cdp, breakpointIds);
  await cdp.send('Debugger.setPauseOnExceptions', { state: 'none' });
  // 清断点的时候可能又停了一次：放走
  while (pauses.length) {
    pauses.shift();
    await cdp.send('Debugger.resume', {}).catch(() => undefined);
  }
  const logs: { at: string; value: unknown }[] = [];
  for (const contextId of contexts) {
    const reply = (await cdp.send('Runtime.evaluate', { contextId, expression: '(() => { const logs = globalThis.__strideDebug?.logs ?? []; delete globalThis.__strideDebug; return logs; })()', returnByValue: true }).catch(() => undefined)) as
      { result: { value?: { at: string; value: unknown }[] } } | undefined;
    logs.push(...(reply?.result.value ?? []));
  }
  await cdp.send('Debugger.disable', {});
  await cdp.send('Runtime.disable', {}).catch(() => undefined);
  return { breakpoints: resolvedList, hits, logs, timedOut };
}

async function clearBreakpoints(cdp: DevtoolsSession, ids: Map<string, DebugBreakpoint>): Promise<void> {
  for (const id of ids.keys()) await cdp.send('Debugger.removeBreakpoint', { breakpointId: id }).catch(() => undefined);
  ids.clear();
}
