// 对发来消息的那个标签执行 DevTools 协议的命令（chrome.debugger）：第一次用时附加，`detach` 时断开（附加期间 Chrome 在页面
// 顶部显示"正在调试此浏览器"）。只接受本机页面的内容脚本发来的消息（manifest 的 matches），只能调试发消息的标签自己。
// 每个标签各管各的，几个游戏页面可以同时调试。
// 扩展是"不受信任"的调试客户端：Chrome 不给它 V8 的 Profiler 域，CPU 剖析改用 Tracing（CLI 的 cpu-profile）。
const PROTOCOL_VERSION = '1.3';
const EVENT_TIMEOUT_MS = 60_000;

/** 等着的事件：`标签 事件名` → 收到事件时调用的函数。 */
const waiters = new Map();

chrome.debugger.onEvent.addListener((source, method, params) => {
  const key = `${source.tabId} ${method}`;
  const resolve = waiters.get(key);
  if (!resolve) return;
  waiters.delete(key);
  resolve(params ?? {});
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab?.id;
  if (tabId === undefined) return false;
  run(tabId, message).then(
    (result) => sendResponse({ result }),
    (error) => sendResponse({ error: error?.message ?? String(error) }),
  );
  return true; // 异步回复
});

/** 执行一条命令；给了 waitFor 时先登记等这个事件，回复的是事件的参数（Tracing.end 之后的 Tracing.tracingComplete）。 */
async function run(tabId, { method, params, waitFor }) {
  const target = { tabId };
  if (method === 'detach') {
    await chrome.debugger.detach(target).catch(() => {}); // 没附加时也算成功
    return {};
  }
  await attach(target);
  if (!waitFor) return chrome.debugger.sendCommand(target, method, params ?? {});
  const event = waitForEvent(tabId, waitFor);
  await chrome.debugger.sendCommand(target, method, params ?? {});
  return event;
}

function waitForEvent(tabId, method) {
  const key = `${tabId} ${method}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiters.delete(key);
      reject(new Error(`${method}: no event in ${EVENT_TIMEOUT_MS} ms`));
    }, EVENT_TIMEOUT_MS);
    waiters.set(key, (params) => {
      clearTimeout(timer);
      resolve(params);
    });
  });
}

// service worker 可能在两条命令之间被回收，附加状态不记在内存里：已经附加着时 attach 报错，当成成功
async function attach(target) {
  try {
    await chrome.debugger.attach(target, PROTOCOL_VERSION);
  } catch (error) {
    if (!/already attached/i.test(error?.message ?? '')) throw error;
  }
}
