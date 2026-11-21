// 本机页面里的内容脚本：页面（引擎的 devtools 调试命令）用 window.postMessage 发 DevTools 协议的命令，这里转给扩展的
// service worker（它用 chrome.debugger 对这个标签执行），回复再 postMessage 回页面。<html> 上的 data-stride-debug-bridge
// 告诉页面扩展装着（值是扩展的版本）。
// 扩展重新加载（改了文件自己重载）以后，旧的这份内容脚本和扩展断了联系，新的一份会被注入进来：旧的发现断了就退出，不抢着回复。
(() => {
  const SOURCE = 'stride-debug-bridge';
  let hubUrl;
  document.documentElement.dataset.strideDebugBridge = chrome.runtime.getManifest().version;

  const onMessage = async (event) => {
    if (event.source !== window || event.data?.source !== SOURCE) return;
    if (!chrome.runtime?.id) {
      window.removeEventListener('message', onMessage);
      return;
    }
    // 页面转来中枢的桥票：交给 service worker 直连中枢（记下来，扩展重新加载后的新内容脚本会再要一次）
    if (event.data.direction === 'hub') {
      hubUrl = event.data.url;
      chrome.runtime.sendMessage({ method: 'connect-hub', url: hubUrl }).catch(() => {});
      return;
    }
    if (event.data.direction !== 'request') return;
    const { id, method, params, waitFor, session } = event.data;
    let reply;
    try {
      reply = await chrome.runtime.sendMessage({ method, params, waitFor, session });
    } catch (error) {
      reply = { error: `the Stride Debug Bridge extension did not answer: ${error.message}` };
    }
    window.postMessage({ source: SOURCE, direction: 'reply', id, ...reply }, window.location.origin);
  };
  window.addEventListener('message', onMessage);
  // 打个招呼：service worker 借这个机会看自己的文件有没有改，改了就重新加载
  chrome.runtime.sendMessage({ method: 'hello' }).catch(() => {});
  // 向页面要中枢的桥票（页面连中枢时只发一次；扩展重新加载后注入的这份内容脚本错过了）
  window.postMessage({ source: SOURCE, direction: 'want-hub' }, window.location.origin);
})();
