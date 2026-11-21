// 本机页面里的内容脚本：页面（引擎的 devtools 调试命令）用 window.postMessage 发 DevTools 协议的命令，这里转给扩展的
// service worker（它用 chrome.debugger 对这个标签执行），回复再 postMessage 回页面。<html> 上的 data-stride-debug-bridge
// 告诉页面扩展装着（值是扩展的版本）。
// 扩展重新加载（改了文件自己重载）以后，旧的这份内容脚本和扩展断了联系，新的一份会被注入进来：旧的发现断了就退出，不抢着回复。
(() => {
  const SOURCE = 'stride-debug-bridge';
  document.documentElement.dataset.strideDebugBridge = chrome.runtime.getManifest().version;

  const onMessage = async (event) => {
    if (event.source !== window || event.data?.source !== SOURCE || event.data.direction !== 'request') return;
    if (!chrome.runtime?.id) {
      window.removeEventListener('message', onMessage);
      return;
    }
    const { id, method, params, waitFor } = event.data;
    let reply;
    try {
      reply = await chrome.runtime.sendMessage({ method, params, waitFor });
    } catch (error) {
      reply = { error: `the Stride Debug Bridge extension did not answer: ${error.message}` };
    }
    window.postMessage({ source: SOURCE, direction: 'reply', id, ...reply }, window.location.origin);
  };
  window.addEventListener('message', onMessage);
  // 打个招呼：service worker 借这个机会看自己的文件有没有改，改了就重新加载
  chrome.runtime.sendMessage({ method: 'hello' }).catch(() => {});
})();
