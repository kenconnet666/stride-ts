/** CLI 这一头：找到调试中枢，调用页面的命令、读日志。 */
import { DEBUG_API_PATH, DEBUG_TOKEN_HEADER, type CallResponse, type HubLogEntry, type PageInfo } from '@stride-ts/engine/debug-protocol';
import { listHubs, type HubRecord } from './state.ts';

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
    return JSON.parse(text);
  }
}
