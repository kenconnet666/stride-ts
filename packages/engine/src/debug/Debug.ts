/**
 * 调试桥和埋点（`game.debug`）：给 agent 和开发者用的 CLI（@stride-ts/cli 的 `stride` 命令）通过它查看、操作正在运行的游戏。
 *
 * - 命令：`debug.command(name, description, handler)` 登记，CLI 用 `stride call <name>` 调（引擎自带的见 commands.ts）；
 * - 计数器：`debug.counter('ai.agents', n)` 记一个当前值，`stride status` 里列出；
 * - 观察项：`debug.watch('player.speed', () => speed)`，读状态时才求值；
 * - 事件：`debug.event('player.jump', { height })` 进日志（只在连着中枢时发送，没连时什么都不做）；
 * - 日志：连上以后，页面的 console 输出、未捕获的异常和引擎的日志都转给中枢，`stride logs` 读。
 *
 * 连接：Game.run 的 debug 选项打开时（默认在地址带 ?debug 时），连同源的 DEBUG_SOCKET_PATH。中枢由开发服务器的
 * Vite 插件提供（tools/vite-app.ts）；静态部署的页面没有中枢，连一次失败就不再试。
 */
import { DEBUG_SOCKET_PATH, type CallMessage, type CommandInfo, type LogEntry, type LogLevel, type PageMessage } from './protocol';

export type DebugHandler = (args: Readonly<Record<string, unknown>>) => unknown;

/** 没连上时最多攒这么多条日志，多了丢最早的。 */
const MAX_QUEUED_LOGS = 1000;
/** 连上过、后来断开时重连的次数（开发服务器重启）。 */
const MAX_RECONNECTS = 5;
const CONSOLE_LEVELS = ['debug', 'info', 'log', 'warn', 'error'] as const;

/** 最近若干帧的耗时（毫秒），环形存放。 */
export class FrameTimings {
  /** 和上一帧的真实间隔。 */
  readonly interval: Float64Array;
  /** update（脚本、系统、物理）的 CPU 时间。 */
  readonly update: Float64Array;
  /** draw（提取、编码、提交）的 CPU 时间。 */
  readonly draw: Float64Array;
  #next = 0;
  #count = 0;
  /** 记录过的总帧数（不受容量限制），算一段时间里有几帧用。 */
  total = 0;

  constructor(capacity: number) {
    this.interval = new Float64Array(capacity);
    this.update = new Float64Array(capacity);
    this.draw = new Float64Array(capacity);
  }

  get count(): number {
    return this.#count;
  }

  record(interval: number, update: number, draw: number): void {
    this.interval[this.#next] = interval;
    this.update[this.#next] = update;
    this.draw[this.#next] = draw;
    this.#next = (this.#next + 1) % this.interval.length;
    this.#count = Math.min(this.#count + 1, this.interval.length);
    this.total++;
  }

  /** 最近 n 帧（不超过记录的数目）的某一列，从旧到新。 */
  last(n: number, column: Float64Array): number[] {
    const count = Math.min(n, this.#count);
    const capacity = column.length;
    return Array.from({ length: count }, (_, i) => column[(this.#next - count + i + capacity) % capacity]!);
  }
}

export class Debug {
  readonly frames = new FrameTimings(4096);
  readonly #frameNumber: () => number | undefined;
  readonly #commands = new Map<string, { readonly description: string; readonly handler: DebugHandler }>();
  /** CLI 调来一条命令时调（命令跑完调它的返回值）：按需出帧的游戏在命令跑着的时候一直出帧（Game.holdFrames）。 */
  onCall: (() => () => void) | undefined;
  readonly #counters = new Map<string, number>();
  readonly #watches = new Map<string, () => unknown>();
  #socket: WebSocket | undefined;
  #url: string | undefined;
  #everConnected = false;
  #reconnects = 0;
  #queue: LogEntry[] = [];
  #flushScheduled = false;
  #consoleCaptured = false;
  #afterDraw: (() => void)[] = [];

  /** frameNumber：当前帧号，记日志用。 */
  constructor(frameNumber: () => number | undefined) {
    this.#frameNumber = frameNumber;
  }

  /** 连着调试中枢。 */
  get connected(): boolean {
    return this.#socket?.readyState === WebSocket.OPEN;
  }

  /** 登记一个命令（同名的覆盖）；handler 的返回值（可以是 Promise）转成能 JSON 的值交给 CLI，抛错时 CLI 拿到错误信息。 */
  command(name: string, description: string, handler: DebugHandler): Disposable {
    this.#commands.set(name, { description, handler });
    return { [Symbol.dispose]: () => this.#commands.delete(name) };
  }

  /** 在页面里调一条命令（同 `stride call`）：冒烟脚本的 eval、页面里的代码用。没有这条命令时报错。 */
  run(name: string, args: Readonly<Record<string, unknown>> = {}): unknown {
    const entry = this.#commands.get(name);
    if (!entry) throw new Error(`unknown command '${name}'; 'commands' lists them`);
    return entry.handler(args);
  }

  commands(): CommandInfo[] {
    return [...this.#commands].map(([name, { description }]) => ({ name, description })).sort((a, b) => a.name.localeCompare(b.name));
  }

  /** 记一个计数器的当前值。 */
  counter(name: string, value: number): void {
    this.#counters.set(name, value);
  }

  counters(): Record<string, number> {
    return Object.fromEntries(this.#counters);
  }

  /** 观察一个值，读状态时才调用 getter。 */
  watch(name: string, getter: () => unknown): Disposable {
    this.#watches.set(name, getter);
    return { [Symbol.dispose]: () => this.#watches.delete(name) };
  }

  /** 所有观察项现在的值；getter 抛错时值是错误信息。 */
  watches(): Record<string, unknown> {
    const values: Record<string, unknown> = {};
    for (const [name, getter] of this.#watches) {
      try {
        values[name] = describe(getter());
      } catch (error) {
        values[name] = `error: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    return values;
  }

  /** 埋一个事件；只在连着中枢时记录。 */
  event(name: string, data?: unknown): void {
    if (this.#socket) this.#push({ time: Date.now(), level: 'info', source: 'event', message: name, ...(data === undefined ? {} : { data: describe(data) }) });
  }

  /** 引擎或游戏自己记的日志（也照常打到 console 上，但不重复转发）。 */
  log(level: LogLevel, message: string, data?: unknown, source: LogEntry['source'] = 'engine'): void {
    this.#push({ time: Date.now(), level, source, message, ...(data === undefined ? {} : { data: describe(data) }) });
  }

  /** 连到中枢（默认是同源的 DEBUG_SOCKET_PATH），并开始转发 console 输出和未捕获的异常。 */
  connect(url = new URL(DEBUG_SOCKET_PATH, location.href).href.replace(/^http/, 'ws')): void {
    if (this.#socket) return;
    this.#url = url;
    this.#captureConsole();
    this.#open();
  }

  disconnect(): void {
    const socket = this.#socket;
    this.#socket = undefined;
    socket?.close();
  }

  /** 下一帧画完时、还在同一个任务里调用 capture（这时画布上是这一帧的内容，可以截图），兑现它的返回值。 */
  afterNextDraw<T>(capture: () => T): Promise<T> {
    return new Promise((resolve, reject) => this.#afterDraw.push(() => {
      try {
        resolve(capture());
      } catch (error) {
        reject(error);
      }
    }));
  }

  /** @internal Game 每帧画完之后调用。 */
  endFrame(): void {
    if (this.#afterDraw.length === 0) return;
    const callbacks = this.#afterDraw;
    this.#afterDraw = [];
    for (const callback of callbacks) callback();
  }

  #open(): void {
    const socket = new WebSocket(this.#url!);
    this.#socket = socket;
    socket.onopen = () => {
      this.#everConnected = true;
      this.#reconnects = 0;
      this.#send({ type: 'hello', url: location.href, title: document.title });
      this.#flush();
    };
    socket.onmessage = (event) => void this.#call(JSON.parse(String(event.data)) as CallMessage);
    socket.onclose = () => {
      if (this.#socket !== socket) return; // disconnect() 关的
      this.#socket = undefined;
      // 从没连上过：页面不在有中枢的服务器上，不再试（每次失败浏览器都会在控制台报一条错）
      if (!this.#everConnected || this.#reconnects >= MAX_RECONNECTS) return;
      this.#reconnects++;
      setTimeout(() => {
        if (!this.#socket) this.#open();
      }, 1000 * this.#reconnects);
    };
  }

  async #call({ id, command, args }: CallMessage): Promise<void> {
    const release = this.onCall?.();
    try {
      this.#send({ type: 'result', id, ok: true, value: describe(await this.run(command, args)) });
    } catch (error) {
      this.#send({ type: 'result', id, ok: false, error: error instanceof Error ? (error.stack ?? error.message) : String(error) });
    } finally {
      release?.();
    }
  }

  #send(message: PageMessage): void {
    if (this.connected) this.#socket!.send(JSON.stringify(message));
  }

  #push(entry: LogEntry): void {
    const frame = this.#frameNumber();
    this.#queue.push(frame === undefined ? entry : { ...entry, frame });
    if (this.#queue.length > MAX_QUEUED_LOGS) this.#queue.splice(0, this.#queue.length - MAX_QUEUED_LOGS);
    if (this.#flushScheduled || !this.connected) return;
    this.#flushScheduled = true;
    setTimeout(() => this.#flush(), 0);
  }

  #flush(): void {
    this.#flushScheduled = false;
    if (!this.connected || this.#queue.length === 0) return;
    this.#send({ type: 'logs', entries: this.#queue });
    this.#queue = [];
  }

  /** console 的输出照常打印，同时转发；未捕获的异常和被拒绝的 Promise 也转发。 */
  #captureConsole(): void {
    if (this.#consoleCaptured) return;
    this.#consoleCaptured = true;
    for (const method of CONSOLE_LEVELS) {
      const original = console[method].bind(console);
      const level: LogLevel = method === 'log' ? 'info' : method;
      console[method] = (...args: unknown[]) => {
        original(...args);
        const strings = args.filter((arg) => typeof arg === 'string');
        const rest = args.filter((arg) => typeof arg !== 'string');
        this.log(level, strings.join(' ') || (rest[0] instanceof Error ? rest[0].message : ''), rest.length === 0 ? undefined : rest.length === 1 ? rest[0] : rest, 'console');
      };
    }
    window.addEventListener('error', (event) => this.log('error', event.message, event.error, 'error'));
    window.addEventListener('unhandledrejection', (event) => this.log('error', `unhandled rejection: ${event.reason instanceof Error ? event.reason.message : String(event.reason)}`, event.reason, 'error'));
  }
}

/**
 * 转成能 JSON 的值给 CLI：实体写成 { entity, name }，类型数组和向量写成数组，Error 写成调用栈，Map、Set 展开，
 * 视图对象（访问器属性）按可枚举的属性读出。太深、太长、循环引用的部分截断，总共最多展开 MAX_NODES 个值。
 */
export function describe(value: unknown): unknown {
  return describeValue(value, 0, { nodes: MAX_NODES, seen: new Set() });
}

const MAX_NODES = 5000;
const MAX_ITEMS = 256;
const MAX_DEPTH = 6;

function describeValue(value: unknown, depth: number, budget: { nodes: number; readonly seen: Set<object> }): unknown {
  if (value === null || value === undefined || typeof value === 'boolean' || typeof value === 'string') return value ?? null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'function') return `[function ${value.name || 'anonymous'}]`;
  if (typeof value === 'symbol') return value.toString();
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`;
  const object = value as object;
  if (budget.seen.has(object)) return '[circular]';
  // 实体（Entity）：只写 id 和名字，否则会顺着 manager 展开整个游戏
  if ('manager' in object && 'id' in object && 'name' in object && typeof object.id === 'number') return { entity: object.id, name: object.name };
  if (depth >= MAX_DEPTH || --budget.nodes < 0) return `[${object.constructor?.name ?? 'object'}]`;
  budget.seen.add(object);
  try {
    const items = (source: Iterable<unknown>, length: number) => {
      const out = Array.from(source).slice(0, MAX_ITEMS).map((item) => describeValue(item, depth + 1, budget));
      return length > MAX_ITEMS ? [...out, `… ${length - MAX_ITEMS} more`] : out;
    };
    if (ArrayBuffer.isView(object) && !(object instanceof DataView)) {
      const array = object as unknown as ArrayLike<number | bigint>;
      return items(Array.prototype.slice.call(array, 0, MAX_ITEMS) as unknown[], array.length);
    }
    if (Array.isArray(object)) return items(object, object.length);
    if (object instanceof Set) return items(object, object.size);
    if (object instanceof Map) return Object.fromEntries([...object].slice(0, MAX_ITEMS).map(([k, v]) => [String(k), describeValue(v, depth + 1, budget)]));
    const result: Record<string, unknown> = {};
    let keys = 0;
    for (const key in object) {
      if (++keys > MAX_ITEMS) {
        result['…'] = 'more keys';
        break;
      }
      try {
        result[key] = describeValue((object as Record<string, unknown>)[key], depth + 1, budget);
      } catch (error) {
        result[key] = `[error: ${error instanceof Error ? error.message : String(error)}]`;
      }
    }
    return result;
  } finally {
    budget.seen.delete(object);
  }
}
