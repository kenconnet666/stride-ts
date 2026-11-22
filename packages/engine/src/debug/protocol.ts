/**
 * 调试桥的协议：页面里的游戏（Debug）连到开发服务器上的调试中枢（@stride-ts/cli 的 hub），CLI 通过中枢的 HTTP 接口
 * 调用页面登记的命令、读日志。引擎和 CLI 包共用这些类型。
 */

/** 页面连中枢的 WebSocket 路径（同源）。 */
export const DEBUG_SOCKET_PATH = '/__stride/ws';
/** 中枢给 CLI 的 HTTP 接口的前缀。 */
export const DEBUG_API_PATH = '/__stride/api';
/**
 * 调试桥扩展连中枢的 WebSocket 路径（带页面拿到的一次性桥票 `?ticket=`）：扩展直接替这个页面执行 DevTools 协议的命令、转发事件，
 * 不经过页面的 JS（页面停在断点上时照样能发"继续"）。
 */
export const BRIDGE_SOCKET_PATH = '/__stride/bridge';
/** CLI 经中枢、调试桥扩展对一个页面开 DevTools 会话的 WebSocket 路径（`?page=<id>`，要带令牌头）。 */
export const DEVTOOLS_SOCKET_PATH = '/__stride/devtools';
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
  /** server：开发服务器自己的错误（模块编译失败这类：页面上只是停在加载，游戏连不上中枢），页号是 0。 */
  readonly source: 'console' | 'error' | 'engine' | 'native' | 'event' | 'server';
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

/** 中枢发给页面：调试桥扩展连中枢用的一次性桥票（页面转给扩展的内容脚本）。 */
export interface BridgeTicketMessage {
  readonly type: 'bridge';
  readonly ticket: string;
}

/** 中枢发给页面的消息。 */
export type HubMessage = CallMessage | BridgeTicketMessage;

/** 中枢的 HTTP 接口里列出的页面。 */
export interface PageInfo {
  readonly id: number;
  readonly url: string;
  readonly title: string;
  readonly connectedAt: number;
  /** 这个页面所在标签的调试桥扩展直接连着中枢（DEVTOOLS_SOCKET_PATH 能用，会话不经过页面）。 */
  readonly bridge?: boolean;
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
