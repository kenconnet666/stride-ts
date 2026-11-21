/** CLI 这一头：找到调试中枢，调用页面的命令、读日志。 */
import { randomUUID } from 'node:crypto';
import { DEBUG_API_PATH, DEBUG_TOKEN_HEADER, DEVTOOLS_SOCKET_PATH, type CallResponse, type HubLogEntry, type PageInfo } from '@stride-ts/engine/debug-protocol';
import { WebSocket } from 'ws';
import { listHubs, type HubRecord } from './state.ts';

/** 对一个页面执行 DevTools 协议命令的会话：stride 启动的 Chrome 里直连 CDP（CdpSession），别的 Chrome 经调试桥扩展。 */
export interface DevtoolsSession extends AsyncDisposable {
  send(method: string, params?: Record<string, unknown>, timeout?: number): Promise<unknown>;
  /** 发命令并等它之后的 event 事件，返回事件的参数。 */
  sendAndWait(method: string, params: Record<string, unknown>, event: string, timeout?: number): Promise<unknown>;
}

export class HubClient {
  readonly hub: HubRecord;

  constructor(hub: HubRecord) {
    this.hub = hub;
  }

  /**
   * 选一个中枢：selector 按名字或地址里的文字筛选。没给时，多个中枢里取有页面连着、页面连上得最晚的那个
   * （同时开着 dev 和 preview 时，就是刚打开的那个）。
   */
  static async find(selector?: string): Promise<HubClient> {
    const hubs = listHubs().filter((hub) => !selector || hub.name.includes(selector) || hub.url.includes(selector));
    if (hubs.length === 0) {
      throw new Error(selector
        ? `no debug hub matches '${selector}'; running hubs: ${listHubs().map((h) => `${h.name} ${h.url}`).join(', ') || 'none'}`
        : 'no debug hub is running: start an app dev server (pnpm --filter <app> dev) or preview server');
    }
    if (hubs.length === 1) return new HubClient(hubs[0]!);
    const latest = await Promise.all(hubs.map(async (hub) => {
      const pages = await new HubClient(hub).pages().catch(() => []);
      return { hub, connectedAt: Math.max(0, ...pages.map((p) => p.connectedAt)) };
    }));
    latest.sort((a, b) => b.connectedAt - a.connectedAt || b.hub.started - a.hub.started);
    return new HubClient(latest[0]!.hub);
  }

  async pages(): Promise<PageInfo[]> {
    return (await this.#request('GET', '/pages')) as PageInfo[];
  }

  /** 调一个页面命令；页面报错时抛 Error。 */
  async call(command: string, args: Record<string, unknown> = {}, { page, timeout }: { page?: number; timeout?: number } = {}): Promise<unknown> {
    const response = (await this.#request('POST', '/call', { command, args, ...(page === undefined ? {} : { page }), ...(timeout === undefined ? {} : { timeout }) })) as CallResponse;
    if (!response.ok) throw new Error(response.error);
    return response.value;
  }

  /** 经页面的 devtools 命令（调试桥扩展，tools/debug-bridge）对这个页面执行 DevTools 协议的命令。 */
  /**
   * 经中枢、调试桥扩展直连的 DevTools 会话（页面的 info.bridge 为真时有）：命令和事件不经过页面的 JS，页面停在断点上也能控制，
   * 能收事件（stride debug 用）。
   */
  async devtoolsSocket(page: number): Promise<HubDevtoolsSession> {
    const url = `${this.hub.url.replace(/^http/, 'ws')}${DEVTOOLS_SOCKET_PATH}?page=${page}`;
    const socket = new WebSocket(url, { headers: { [DEBUG_TOKEN_HEADER]: this.hub.token } });
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });
    return new HubDevtoolsSession(socket);
  }

  /** 经调试桥扩展的一个 DevTools 会话：带自己的会话 ID，几个会话（几个 agent、几条命令）可以同时用同一个标签，各自断开。 */
  devtools(page: number): DevtoolsSession {
    const session = randomUUID();
    return {
      send: (method, params = {}, timeout = 60_000) => this.call('devtools', { method, params, session }, { page, timeout }),
      sendAndWait: (method, params, event, timeout = 60_000) => this.call('devtools', { method, params, waitFor: event, session }, { page, timeout }),
      [Symbol.asyncDispose]: async () => void (await this.call('devtools', { method: 'detach', session }, { page }).catch(() => undefined)),
    };
  }

  /** 日志；follow 时一直等新的，直到 signal 中止。 */
  async *logs({ since = 0, follow = false, page, signal }: { since?: number; follow?: boolean; page?: number; signal?: AbortSignal } = {}): AsyncGenerator<HubLogEntry> {
    const query = new URLSearchParams({ since: String(since), ...(follow ? { follow: '1' } : {}), ...(page === undefined ? {} : { page: String(page) }) });
    const response = await fetch(`${this.hub.url}${DEBUG_API_PATH}/logs?${query}`, { headers: { [DEBUG_TOKEN_HEADER]: this.hub.token }, ...(signal ? { signal } : {}) });
    if (!response.ok || !response.body) throw new Error(`hub ${this.hub.url}: ${response.status} ${await response.text()}`);
    const decoder = new TextDecoder();
    let buffered = '';
    for await (const chunk of response.body) {
      buffered += decoder.decode(chunk as Uint8Array, { stream: true });
      const lines = buffered.split('\n');
      buffered = lines.pop()!;
      for (const line of lines) if (line) yield JSON.parse(line) as HubLogEntry;
    }
  }

  async #request(method: string, route: string, body?: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(`${this.hub.url}${DEBUG_API_PATH}${route}`, {
        method,
        headers: { [DEBUG_TOKEN_HEADER]: this.hub.token, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      throw new Error(`cannot reach the debug hub ${this.hub.name} at ${this.hub.url}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const text = await response.text();
    if (response.status === 404 && !text.startsWith('{')) throw new Error(`${this.hub.url} has no debug hub (an old dev server? restart it)`);
    // 中枢的调用结果（含页面里报的错）都是 200；别的状态是中枢自己拒了，比如过期的登记文件指着别的服务器（强杀的开发服务器
    // 没来得及删登记，Windows 又把进程号给了别的进程），令牌对不上是 403
    if (!response.ok) {
      const error = text.startsWith('{') ? (JSON.parse(text) as { error?: string }).error : text;
      throw new Error(`debug hub ${this.hub.name} at ${this.hub.url}: ${response.status} ${error ?? ''}`.trimEnd());
    }
    return JSON.parse(text);
  }
}

/** 经中枢、调试桥扩展的 DevTools 会话（同 chrome.ts 的 CdpSession 的用法：send、sendAndWait、on）。 */
export class HubDevtoolsSession implements DevtoolsSession {
  readonly #socket: WebSocket;
  #nextId = 1;
  readonly #pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  readonly #listeners = new Map<string, ((params: unknown) => void)[]>();

  constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.on('message', (data) => {
      const message = JSON.parse(String(data)) as { id?: number; result?: unknown; error?: string; method?: string; params?: unknown };
      if (message.id === undefined) {
        for (const listener of this.#listeners.get(message.method ?? '') ?? []) listener(message.params);
        return;
      }
      const pending = this.#pending.get(message.id);
      this.#pending.delete(message.id);
      if (message.error !== undefined) pending?.reject(new Error(message.error));
      else pending?.resolve(message.result);
    });
    socket.on('close', () => {
      for (const { reject } of this.#pending.values()) reject(new Error('the DevTools session through the hub closed'));
      this.#pending.clear();
    });
  }

  send(method: string, params: Record<string, unknown> = {}, timeout = 60_000): Promise<unknown> {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${method}: no reply in ${timeout} ms`));
      }, timeout);
      this.#pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.#socket.send(JSON.stringify({ id, method, params }));
    });
  }

  on(event: string, listener: (params: unknown) => void): void {
    this.#listeners.set(event, [...(this.#listeners.get(event) ?? []), listener]);
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
