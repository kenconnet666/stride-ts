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

/** 直连中枢（0.4 起）：标签 → 连着中枢的 WebSocket。页面把中枢给的桥票交过来，这里拿票连上，替这个标签执行 CLI 的命令、转发事件。 */
const hubs = new Map();

function connectHub(tabId, url) {
  const open = hubs.get(tabId);
  if (open && open.url === url && open.socket.readyState <= WebSocket.OPEN) return;
  open?.socket.close();
  const socket = new WebSocket(url);
  hubs.set(tabId, { url, socket });
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    // 中枢的心跳：回一下（WebSocket 上有消息往来，service worker 就不会被停）
    if (message.type === 'ping') return socket.send(JSON.stringify({ type: 'pong' }));
    const { id, session, method, params, waitFor } = message;
    // 同内容脚本那条路：文件改了就先回"正在更新"、重新加载（新注入的内容脚本向页面要票，重新连上中枢）
    updatedOnDisk().then(async (updated) => {
      if (updated) {
        socket.send(JSON.stringify({ id, error: UPDATING }));
        return reloadSoon();
      }
      try {
        socket.send(JSON.stringify({ id, result: await run(tabId, { method, params, waitFor, session }) }));
      } catch (error) {
        socket.send(JSON.stringify({ id, error: error?.message ?? String(error) }));
      }
    });
  };
  socket.onclose = () => {
    if (hubs.get(tabId)?.socket === socket) hubs.delete(tabId);
  };
}

chrome.tabs.onRemoved.addListener((tabId) => {
  hubs.get(tabId)?.socket.close();
  hubs.delete(tabId);
});

chrome.debugger.onEvent.addListener((source, method, params) => {
  // 事件转给直连的中枢（CLI 的会话收得到，比如断点的 Debugger.paused）
  const hub = hubs.get(source.tabId);
  if (hub?.socket.readyState === WebSocket.OPEN) hub.socket.send(JSON.stringify({ event: method, params: params ?? {} }));
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
const UPDATING = 'the Stride Debug Bridge extension was updated on disk and is reloading itself; run the command again';
async function currentFingerprint() {
  const texts = await Promise.all(OWN_FILES.map((file) => fetch(chrome.runtime.getURL(file), { cache: 'no-store' }).then((r) => r.text()).catch(() => '')));
  return texts.join('\n--\n');
}

// 加载时的指纹记在 chrome.storage.session 里：Chrome 把闲着的 service worker 停了再起时变量清空，要是那时再拿磁盘上（已经改过的）
// 文件当基准，就永远发现不了改动。磁盘上 manifest 的版本和正在跑的不一样也算改了（基准丢了的时候兜底）。
async function updatedOnDisk() {
  const [now, stored] = await Promise.all([currentFingerprint(), chrome.storage.session.get('fingerprint')]);
  if (stored.fingerprint === undefined) await chrome.storage.session.set({ fingerprint: now });
  const diskVersion = (() => { try { return JSON.parse(now.split('\n--\n')[0]).version; } catch { return undefined; } })();
  return (stored.fingerprint !== undefined && now !== stored.fingerprint) || (diskVersion !== undefined && diskVersion !== chrome.runtime.getManifest().version);
}

// 先让回复送出去再重新加载（马上 reload 的话回复会丢，页面那边一直等到超时）
function reloadSoon() {
  setTimeout(() => chrome.runtime.reload(), 300);
}

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.storage.session.set({ fingerprint: await currentFingerprint() });
  const tabs = await chrome.tabs.query({ url: ['http://localhost/*', 'http://127.0.0.1/*'] });
  for (const tab of tabs) {
    if (tab.id !== undefined) await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ['content.js'] }).catch(() => {});
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab?.id;
  if (tabId === undefined) return false;
  if (message?.method === 'connect-hub') {
    connectHub(tabId, message.url);
    sendResponse({ result: { connecting: true } });
    return false;
  }
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
      sendResponse({ error: UPDATING });
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
    // 还有别的会话在用：不断开；最后一个也先留着附加一会儿（见 detachLater）
    if (rest.length === 0) detachLater(tabId);
    return { sessions: rest.length };
  }
  clearTimeout(lingering.get(tabId));
  lingering.delete(tabId);
  await attach(target);
  if (!sessions.includes(session)) await setSessions(tabId, [...sessions, session]);
  const event = waitFor ? waitForEvent(tabId, waitFor) : undefined;
  const result = await send(target, method, params ?? {});
  if (method === 'Page.bringToFront') await raiseWindow(tabId);
  return event ?? result;
}

// Page.bringToFront 只在窗口里切到这个标签：窗口最小化着时页面照样是 hidden、不出帧。把窗口也还原、拿到前面
async function raiseWindow(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const window = await chrome.windows.get(tab.windowId);
  await chrome.windows.update(tab.windowId, { focused: true, ...(window.state === 'minimized' ? { state: 'normal' } : {}) });
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

// 最后一个会话断开以后先留着附加 LINGER_MS 再断：附加期间 Chrome 在页面顶部显示"正在调试此浏览器"的提示条，条一出一收页面的高度
// 就变（56 像素），一条条命令之间页面重新布局，上一条命令读到的坐标下一条就对不上了（agent 截图、找元素再点的时候）。连着的命令
// 之间不断开，提示条一直在，布局稳定；闲下来才断开、提示条消失。
const LINGER_MS = 5 * 60_000;
const lingering = new Map();

function detachLater(tabId) {
  clearTimeout(lingering.get(tabId));
  lingering.set(tabId, setTimeout(async () => {
    lingering.delete(tabId);
    // 这期间又有会话来了：不断
    if ((await sessionsOf(tabId)).length === 0) await chrome.debugger.detach({ tabId }).catch(() => {}); // 没附加时也算成功
  }, LINGER_MS));
}

// service worker 可能在两条命令之间被回收：已经附加着时 attach 报错，当成成功
async function attach(target) {
  try {
    await chrome.debugger.attach(target, PROTOCOL_VERSION);
  } catch (error) {
    if (!/already attached/i.test(error?.message ?? '')) throw error;
  }
}
