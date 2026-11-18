/**
 * 调试桥的协议：页面里的游戏（Debug）连到开发服务器上的调试中枢（@stride-ts/cli 的 hub），CLI 通过中枢的 HTTP 接口
 * 调用页面登记的命令、读日志。引擎和 CLI 包共用这些类型。
 */

/** 页面连中枢的 WebSocket 路径（同源）。 */
export const DEBUG_SOCKET_PATH = '/__stride/ws';
/** 中枢给 CLI 的 HTTP 接口的前缀。 */
export const DEBUG_API_PATH = '/__stride/api';
/** CLI 请求带的令牌头；令牌在中枢登记的文件里（~/.stride-ts/hubs/）。 */
export const DEBUG_TOKEN_HEADER = 'x-stride-token';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * 一条日志。source：console 是页面的 console 调用，error 是未捕获的异常和被拒绝的 Promise，engine 是引擎自己记的，
 * native 是原生模块的日志，event 是 debug.event 埋的事件。
 */
export interface LogEntry {
  /** Date.now()。 */
  readonly time: number;
  readonly level: LogLevel;
  readonly source: 'console' | 'error' | 'engine' | 'native' | 'event';
  readonly message: string;
  /** 事件的数据、日志里不是字符串的参数（已经转成能 JSON 的值）。 */
  readonly data?: unknown;
  /** 游戏的帧号（游戏还没开始时没有）。 */
  readonly frame?: number;
}

export interface CommandInfo {
  readonly name: string;
  readonly description: string;
}

/** 页面发给中枢。 */
export type PageMessage =
  | { readonly type: 'hello'; readonly url: string; readonly title: string }
  | { readonly type: 'result'; readonly id: number; readonly ok: true; readonly value: unknown }
  | { readonly type: 'result'; readonly id: number; readonly ok: false; readonly error: string }
  | { readonly type: 'logs'; readonly entries: readonly LogEntry[] };

/** 中枢发给页面：调用一个登记的命令。 */
export interface CallMessage {
  readonly type: 'call';
  readonly id: number;
  readonly command: string;
  readonly args: Readonly<Record<string, unknown>>;
}

/** 中枢的 HTTP 接口里列出的页面。 */
export interface PageInfo {
  readonly id: number;
  readonly url: string;
  readonly title: string;
  readonly connectedAt: number;
}

/** POST {DEBUG_API_PATH}/call 的请求体；page 省略时用最近连上的页面。 */
export interface CallRequest {
  readonly page?: number;
  readonly command: string;
  readonly args?: Readonly<Record<string, unknown>>;
}

export type CallResponse = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: string };

/** GET {DEBUG_API_PATH}/logs 返回的每一行（NDJSON）。 */
export interface HubLogEntry extends LogEntry {
  /** 中枢给的序号，`since` 参数按它续读。 */
  readonly seq: number;
  readonly page: number;
}
