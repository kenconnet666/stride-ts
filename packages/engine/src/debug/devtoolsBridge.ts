/**
 * 经"Stride Debug Bridge"扩展（仓库的 tools/debug-bridge）对这个标签执行 DevTools 协议的命令：CLI 的 cpu-profile、
 * mouse --trusted 在用户平时的 Chrome 里也能用（Chrome 不许对默认配置文件开远程调试端口）。页面 postMessage 请求，
 * 扩展的内容脚本转给 service worker 用 chrome.debugger 执行，回复再 postMessage 回来。
 */
const SOURCE = 'stride-debug-bridge';

interface Reply {
  readonly source: string;
  readonly direction: string;
  readonly id: number;
  readonly result?: unknown;
  readonly error?: string;
}

let nextId = 1;
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
let listening = false;

/** 扩展装着时它的版本（内容脚本写在 <html> 的 data-stride-debug-bridge 上），没装时是 undefined。 */
export function devtoolsBridgeVersion(): string | undefined {
  return document.documentElement.dataset['strideDebugBridge'];
}

/**
 * 执行一条 DevTools 协议的命令（method 为 'detach' 时断开调试，Chrome 顶部的提示条随之消失）。给了 waitFor 时等命令之后的
 * 这个事件，返回事件的参数（Tracing.end 之后的 Tracing.tracingComplete）。
 */
export function sendDevtools(method: string, params: Readonly<Record<string, unknown>> = {}, waitFor?: string): Promise<unknown> {
  if (!devtoolsBridgeVersion()) {
    return Promise.reject(new Error('the Stride Debug Bridge extension is not installed in this browser (load tools/debug-bridge as an unpacked extension)'));
  }
  listen();
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    window.postMessage({ source: SOURCE, direction: 'request', id, method, params, ...(waitFor ? { waitFor } : {}) }, window.location.origin);
  });
}

function listen(): void {
  if (listening) return;
  listening = true;
  window.addEventListener('message', (event: MessageEvent<Reply>) => {
    const reply = event.data;
    if (event.source !== window || reply?.source !== SOURCE || reply.direction !== 'reply') return;
    const request = pending.get(reply.id);
    pending.delete(reply.id);
    if (reply.error !== undefined) request?.reject(new Error(reply.error));
    else request?.resolve(reply.result);
  });
}
