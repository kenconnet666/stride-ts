// 对发来消息的那个标签执行 DevTools 协议的命令（chrome.debugger）。只接受本机页面的内容脚本发来的消息（manifest 的 matches），
// 只能调试发消息的标签自己；每个标签各管各的，几个游戏页面可以同时调试。
// 多会话：同一个标签可以有几个调试会话同时用（几个 agent 会话、几条 CLI 命令）。每条命令带会话 ID（没有的算 'default'），
// 第一个会话用时附加，最后一个会话 detach 时才真的断开（附加期间 Chrome 在页面顶部显示"正在调试此浏览器"）。哪些会话附加着
// 记在 chrome.storage.session 里：service worker 空闲被回收后也不丢。
// 扩展是"不受信任"的调试客户端：Chrome 不给它 V8 的 Profiler 域，CPU 剖析改用 Tracing（CLI 的 cpu-profile）。
const PROTOCOL_VERSION = '1.3';
const EVENT_TIMEOUT_MS = 60_000;

/** 等着的事件：`标签 事件名` → 等这个事件的函数（几个会话可以同时等同一个事件，来了都给）。 */
const waiters = new Map();

chrome.debugger.onEvent.addListener((source, method, params) => {
  const key = `${source.tabId} ${method}`;
  const list = waiters.get(key);
  if (!list) return;
  waiters.delete(key);
  for (const resolve of list) resolve(params ?? {});
});

// 标签断开了（用户点了提示条上的"取消"、标签关了）：这个标签的会话都作废
chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId !== undefined) void setSessions(source.tabId, []);
});

async function sessionsOf(tabId) {
  const key = `sessions:${tabId}`;
  return (await chrome.storage.session.get(key))[key] ?? [];
}

async function setSessions(tabId, sessions) {
  const key = `sessions:${tabId}`;
  if (sessions.length) await chrome.storage.session.set({ [key]: sessions });
  else await chrome.storage.session.remove(key);
}

// 自己的文件改了就重新加载（未打包的扩展从磁盘读文件）：省得每次在 chrome://extensions 里点刷新。页面打招呼、每条命令来时比
// 一次指纹，变了就回一个"正在更新"的错误、重新加载；重新加载后把内容脚本注入已经开着的本机页面，页面不用刷新。
const OWN_FILES = ['manifest.json', 'service-worker.js', 'content.js'];
let fingerprint;

async function currentFingerprint() {
  const texts = await Promise.all(OWN_FILES.map((file) => fetch(chrome.runtime.getURL(file), { cache: 'no-store' }).then((r) => r.text()).catch(() => '')));
  return texts.join('\n--\n');
}

async function updatedOnDisk() {
  const now = await currentFingerprint();
  fingerprint ??= now;
  return now !== fingerprint;
}

// 先让回复送出去再重新加载（马上 reload 的话回复会丢，页面那边一直等到超时）
function reloadSoon() {
  setTimeout(() => chrome.runtime.reload(), 300);
}

chrome.runtime.onInstalled.addListener(async () => {
  fingerprint = await currentFingerprint();
  const tabs = await chrome.tabs.query({ url: ['http://localhost/*', 'http://127.0.0.1/*'] });
  for (const tab of tabs) {
    if (tab.id !== undefined) await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ['content.js'] }).catch(() => {});
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab?.id;
  if (tabId === undefined) return false;
  if (message?.method === 'hello') {
    // 页面打开时内容脚本打个招呼：借这个机会看文件有没有改
    updatedOnDisk().then((updated) => {
      sendResponse({ result: { version: chrome.runtime.getManifest().version } });
      if (updated) reloadSoon();
    });
    return true;
  }
  updatedOnDisk().then((updated) => {
    if (updated) {
      sendResponse({ error: 'the Stride Debug Bridge extension was updated on disk and is reloading itself; run the command again' });
      reloadSoon();
      return;
    }
    run(tabId, message).then(
      (result) => sendResponse({ result }),
      (error) => sendResponse({ error: error?.message ?? String(error) }),
    );
  });
  return true; // 异步回复
});

/** 执行一条命令；给了 waitFor 时先登记等这个事件，回复的是事件的参数（Tracing.end 之后的 Tracing.tracingComplete）。 */
async function run(tabId, { method, params, waitFor, session = 'default' }) {
  const target = { tabId };
  const sessions = await sessionsOf(tabId);
  if (method === 'detach') {
    const rest = sessions.filter((s) => s !== session);
    await setSessions(tabId, rest);
    // 还有别的会话在用：不断开
    if (rest.length === 0) await chrome.debugger.detach(target).catch(() => {}); // 没附加时也算成功
    return { sessions: rest.length };
  }
  await attach(target);
  if (!sessions.includes(session)) await setSessions(tabId, [...sessions, session]);
  const event = waitFor ? waitForEvent(tabId, waitFor) : undefined;
  const result = await send(target, method, params ?? {});
  return event ?? result;
}

// 扩展刚重新加载、标签刚被断开时，附加和 Chrome 的"断开了"通知会撞上：碰到"没附加"就重新附加、再发一次
async function send(target, method, params) {
  try {
    return await chrome.debugger.sendCommand(target, method, params);
  } catch (error) {
    if (!/not attached/i.test(error?.message ?? '')) throw error;
    await attach(target);
    return chrome.debugger.sendCommand(target, method, params);
  }
}

function waitForEvent(tabId, method) {
  const key = `${tabId} ${method}`;
  return new Promise((resolve, reject) => {
    const onEvent = (params) => {
      clearTimeout(timer);
      resolve(params);
    };
    const timer = setTimeout(() => {
      const list = waiters.get(key)?.filter((f) => f !== onEvent) ?? [];
      if (list.length) waiters.set(key, list);
      else waiters.delete(key);
      reject(new Error(`${method}: no event in ${EVENT_TIMEOUT_MS} ms`));
    }, EVENT_TIMEOUT_MS);
    waiters.set(key, [...(waiters.get(key) ?? []), onEvent]);
  });
}

// service worker 可能在两条命令之间被回收：已经附加着时 attach 报错，当成成功
async function attach(target) {
  try {
    await chrome.debugger.attach(target, PROTOCOL_VERSION);
  } catch (error) {
    if (!/already attached/i.test(error?.message ?? '')) throw error;
  }
}
