/**
 * 调试中枢：挂在开发服务器（Vite 的 dev 和 preview，见 vite.ts）上，一头是页面里的游戏（同源的 WebSocket，
 * DEBUG_SOCKET_PATH），一头是 CLI（HTTP，DEBUG_API_PATH）。CLI 的调用转给页面登记的命令，页面的日志攒在这里给 CLI 读。
 *
 * 安全：只接受同源页面的 WebSocket（Origin 的主机等于 Host）；HTTP 接口要带令牌头，令牌只写在本机的登记文件里，
 * 并且拒绝带 Origin 头的请求，别的网页没法借用户的浏览器调用。
 *
 * 调试桥扩展（tools/debug-bridge）：页面连上时中枢发给它一张桥票（页面连着时有效），页面经内容脚本交给扩展，扩展的 service
 * worker 拿票连 BRIDGE_SOCKET_PATH（扩展的 Origin 不是同源，只认票），替这个标签执行 DevTools 协议的命令、把事件转过来；中枢每 20 秒
 * 发一次心跳，service worker 就不会闲置被停。CLI 带令牌连 DEVTOOLS_SOCKET_PATH?page=<id> 开 DevTools 会话（每条连接一个会话），
 * 命令、事件经中枢和扩展来回，不经过页面的 JS：页面停在断点上时照样能控制（stride debug 在用户平时的 Chrome 里也能用）。
 *
 * HTTP 接口：
 *   GET  /pages                         连着的页面
 *   POST /call  { page?, command, args?, timeout? }   调一个命令，page 省略时用最近连上的页面
 *   GET  /logs?since=<seq>&follow=1&page=<id>         日志，NDJSON；follow 时一直推送新的
 */
import { socketText } from './socketText.ts';
import { randomBytes } from 'node:crypto';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import {
  BRIDGE_SOCKET_PATH, DEBUG_API_PATH, DEBUG_SOCKET_PATH, DEBUG_TOKEN_HEADER, DEVTOOLS_SOCKET_PATH,
  type CallMessage, type CallRequest, type CallResponse, type HubLogEntry, type PageInfo, type PageMessage,
} from '@stride-ts/engine/debug-protocol';
import { WebSocketServer, type WebSocket } from 'ws';
import { registerHub, unregisterHub } from './state.ts';

/** 中枢最多留这么多条日志。 */
const MAX_LOGS = 5000;
const DEFAULT_TIMEOUT = 120_000;

interface Page {
  readonly info: PageInfo;
  readonly socket: WebSocket;
  readonly pending: Map<number, (response: CallResponse) => void>;
  /** 调试桥扩展拿来连中枢的票。 */
  readonly ticket: string;
  /** 调试桥扩展连着的 WebSocket（替这个标签执行 DevTools 命令）。 */
  bridge: WebSocket | undefined;
  /** 发给扩展、等回复的命令：中枢的编号 → 回调。 */
  readonly bridgePending: Map<number, (reply: { result?: unknown; error?: string }) => void>;
  /** CLI 开着的 DevTools 会话（事件转给它们）。 */
  readonly devtools: Set<WebSocket>;
}

/** 心跳的间隔：扩展的 service worker 闲置 30 秒会被停，WebSocket 上有消息就不会。 */
const BRIDGE_PING_MS = 20_000;

export class DebugHub {
  readonly token = randomBytes(16).toString('hex');
  readonly name: string;
  readonly #pages = new Map<number, Page>();
  #nextPage = 1;
  #nextCall = 1;
  #logs: HubLogEntry[] = [];
  #seq = 0;
  readonly #followers = new Set<{ readonly response: ServerResponse; readonly page: number | undefined }>();
  readonly #sockets = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024 * 1024 });
  #registration: string | undefined;

  constructor(name: string) {
    this.name = name;
  }

  /** 挂到 HTTP 服务器上：升级请求和 API 请求；服务器开始监听时登记，关闭时注销。use 是中间件的挂载函数（connect 的 use）。 */
  attach(server: Server, use: (handler: (request: IncomingMessage, response: ServerResponse, next: () => void) => void) => void): void {
    use((request, response, next) => {
      if (!request.url?.startsWith(DEBUG_API_PATH)) return next();
      void this.#handle(request, response);
    });
    server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      const forbid = () => socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      if (url.pathname === BRIDGE_SOCKET_PATH) {
        // 扩展的 Origin 是 chrome-extension://…：不看 Origin，只认页面拿到的票
        const page = [...this.#pages.values()].find((p) => p.ticket === url.searchParams.get('ticket'));
        if (!page) return forbid();
        return this.#sockets.handleUpgrade(request, socket, head, (ws) => this.#connectBridge(page, ws));
      }
      if (url.pathname === DEVTOOLS_SOCKET_PATH) {
        // CLI：同 HTTP 接口，要令牌、不许浏览器来连
        if (request.headers.origin !== undefined || request.headers[DEBUG_TOKEN_HEADER] !== this.token) return forbid();
        const page = this.#pages.get(Number(url.searchParams.get('page')));
        if (!page) return forbid();
        return this.#sockets.handleUpgrade(request, socket, head, (ws) => this.#connectDevtools(page, ws));
      }
      if (url.pathname !== DEBUG_SOCKET_PATH) return; // Vite 的 HMR 之类，交给别的监听器
      if (!sameOrigin(request)) return forbid();
      this.#sockets.handleUpgrade(request, socket, head, (ws) => this.#connect(ws));
    });
    const register = () => {
      const address = server.address();
      if (!address || typeof address === 'string') return;
      this.#registration = registerHub({ url: `http://localhost:${address.port}`, token: this.token, pid: process.pid, name: this.name, started: Date.now() });
    };
    if (server.listening) register();
    else server.once('listening', register);
    server.once('close', () => this.close());
    // 进程退出时（Ctrl+C）也删掉登记；exit 里只能做同步的事
    process.once('exit', () => this.close());
  }

  close(): void {
    if (this.#registration) unregisterHub(this.#registration);
    this.#registration = undefined;
    for (const { socket } of this.#pages.values()) socket.close();
    for (const { response } of this.#followers) response.end();
    this.#followers.clear();
  }

  #connect(socket: WebSocket): void {
    const id = this.#nextPage++;
    let page: Page | undefined;
    socket.on('message', (data) => {
      const message = JSON.parse(socketText(data)) as PageMessage;
      if (message.type === 'hello') {
        page = { info: { id, url: message.url, title: message.title, connectedAt: Date.now() }, socket, pending: new Map(), ticket: randomBytes(16).toString('hex'), bridge: undefined, bridgePending: new Map(), devtools: new Set() };
        this.#pages.set(id, page);
        // 桥票：页面转给调试桥扩展（没装时页面什么也不做）
        socket.send(JSON.stringify({ type: 'bridge', ticket: page.ticket }));
        this.#log(id, { time: Date.now(), level: 'info', source: 'engine', message: `page ${id} connected: ${message.url}` });
      } else if (message.type === 'result') {
        const resolve = page?.pending.get(message.id);
        page?.pending.delete(message.id);
        resolve?.(message.ok ? { ok: true, value: message.value } : { ok: false, error: message.error });
      } else if (message.type === 'logs') {
        for (const entry of message.entries) this.#log(id, entry);
      }
    });
    socket.on('close', () => {
      this.#pages.delete(id);
      page?.bridge?.close();
      for (const client of page?.devtools ?? []) client.close();
      for (const resolve of page?.pending.values() ?? []) resolve({ ok: false, error: `page ${id} disconnected (reloaded or closed)` });
      this.#log(id, { time: Date.now(), level: 'info', source: 'engine', message: `page ${id} disconnected` });
    });
  }

  /** 调试桥扩展连上来了：替这个页面的标签执行命令（CLI 的 DevTools 会话转过来）、把事件转给会话。 */
  #connectBridge(page: Page, socket: WebSocket): void {
    page.bridge?.close();
    page.bridge = socket;
    const ping = setInterval(() => socket.send(JSON.stringify({ type: 'ping' })), BRIDGE_PING_MS);
    socket.on('message', (data) => {
      const message = JSON.parse(socketText(data)) as { id?: number; result?: unknown; error?: string; event?: string; params?: unknown; type?: string };
      if (message.id !== undefined) {
        const resolve = page.bridgePending.get(message.id);
        page.bridgePending.delete(message.id);
        resolve?.(message);
      } else if (message.event) {
        const event = JSON.stringify({ method: message.event, params: message.params });
        for (const client of page.devtools) client.send(event);
      }
    });
    socket.on('close', () => {
      clearInterval(ping);
      if (page.bridge !== socket) return;
      page.bridge = undefined;
      for (const resolve of page.bridgePending.values()) resolve({ error: 'the Stride Debug Bridge extension disconnected (reloaded or the tab closed)' });
      page.bridgePending.clear();
    });
    this.#log(page.info.id, { time: Date.now(), level: 'info', source: 'engine', message: `page ${page.info.id}: Stride Debug Bridge connected` });
  }

  /** 发给扩展一条 DevTools 命令（这个会话的），等它的回复。 */
  #bridgeCommand(page: Page, session: string, method: string, params: unknown): Promise<{ result?: unknown; error?: string }> {
    const bridge = page.bridge;
    if (!bridge) return Promise.resolve({ error: 'the Stride Debug Bridge extension is not connected to this page' });
    const id = this.#nextCall++;
    return new Promise((resolve) => {
      page.bridgePending.set(id, resolve);
      bridge.send(JSON.stringify({ id, session, method, params }));
    });
  }

  /** CLI 的 DevTools 会话：命令转给扩展、回复按编号回；会话断开时替它 detach（扩展按会话计数，最后一个才真断开）。 */
  #connectDevtools(page: Page, socket: WebSocket): void {
    const session = randomBytes(8).toString('hex');
    page.devtools.add(socket);
    socket.on('message', (data) => {
      const { id, method, params } = JSON.parse(socketText(data)) as { id: number; method: string; params?: unknown };
      // 只取结果和错误：扩展的回复里的 id 是中枢自己的编号，不能盖掉 CLI 命令的
      void this.#bridgeCommand(page, session, method, params ?? {}).then(({ result, error }) => socket.send(JSON.stringify({ id, result, error })));
    });
    socket.on('close', () => {
      page.devtools.delete(socket);
      void this.#bridgeCommand(page, session, 'detach', {});
    });
  }

  /** 开发服务器的错误（vite.ts 接的 Vite 日志）：记成页号 0、来源 server 的错误。 */
  serverError(message: string): void {
    this.#log(0, { time: Date.now(), level: 'error', source: 'server', message });
  }

  #log(page: number, entry: Omit<HubLogEntry, 'seq' | 'page'>): void {
    const logged: HubLogEntry = { ...entry, seq: ++this.#seq, page };
    this.#logs.push(logged);
    if (this.#logs.length > MAX_LOGS) this.#logs = this.#logs.slice(-MAX_LOGS);
    const line = `${JSON.stringify(logged)}\n`;
    for (const follower of this.#followers) if (follower.page === undefined || follower.page === page) follower.response.write(line);
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const reply = (status: number, body: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    if (request.headers.origin !== undefined || request.headers[DEBUG_TOKEN_HEADER] !== this.token) return reply(403, { ok: false, error: 'forbidden: wrong token or a browser request' });
    const url = new URL(request.url!, 'http://localhost');
    const route = url.pathname.slice(DEBUG_API_PATH.length);
    try {
      if (request.method === 'GET' && route === '/pages') return reply(200, [...this.#pages.values()].map((p) => ({ ...p.info, bridge: p.bridge !== undefined })));
      if (request.method === 'POST' && route === '/call') return reply(200, await this.#call(JSON.parse(await readBody(request)) as CallRequest & { timeout?: number }));
      if (request.method === 'GET' && route === '/logs') return this.#logsResponse(url.searchParams, response);
      reply(404, { ok: false, error: `no route ${request.method} ${route}` });
    } catch (error) {
      reply(500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  #call({ page: pageId, command, args = {}, timeout = DEFAULT_TIMEOUT }: CallRequest & { timeout?: number }): Promise<CallResponse> {
    const page = pageId === undefined ? [...this.#pages.values()].at(-1) : this.#pages.get(pageId);
    if (!page) return Promise.resolve({ ok: false, error: pageId === undefined ? 'no page is connected to this hub' : `page ${pageId} is not connected` });
    const id = this.#nextCall++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        page.pending.delete(id);
        resolve({ ok: false, error: `'${command}' timed out after ${timeout} ms` });
      }, timeout);
      page.pending.set(id, (result) => {
        clearTimeout(timer);
        resolve(result);
      });
      const message: CallMessage = { type: 'call', id, command, args };
      page.socket.send(JSON.stringify(message));
    });
  }

  #logsResponse(params: URLSearchParams, response: ServerResponse): void {
    const since = Number(params.get('since') ?? 0);
    const page = params.has('page') ? Number(params.get('page')) : undefined;
    response.writeHead(200, { 'content-type': 'application/x-ndjson' });
    for (const entry of this.#logs) if (entry.seq > since && (page === undefined || entry.page === page)) response.write(`${JSON.stringify(entry)}\n`);
    if (params.get('follow') !== '1') return void response.end();
    const follower = { response, page };
    this.#followers.add(follower);
    response.on('close', () => this.#followers.delete(follower));
  }
}

function sameOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  if (!origin) return false;
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}
