// 本机页面里的内容脚本：页面（引擎的 devtools 调试命令）用 window.postMessage 发 DevTools 协议的命令，这里转给扩展的
// service worker（它用 chrome.debugger 对这个标签执行），回复再 postMessage 回页面。<html> 上的 data-stride-debug-bridge
// 告诉页面扩展装着（值是扩展的版本）。
const SOURCE = 'stride-debug-bridge';

document.documentElement.dataset.strideDebugBridge = chrome.runtime.getManifest().version;

window.addEventListener('message', async (event) => {
  if (event.source !== window || event.data?.source !== SOURCE || event.data.direction !== 'request') return;
  const { id, method, params, waitFor } = event.data;
  let reply;
  try {
    reply = await chrome.runtime.sendMessage({ method, params, waitFor });
  } catch (error) {
    reply = { error: `the Stride Debug Bridge extension did not answer: ${error.message}` };
  }
  window.postMessage({ source: SOURCE, direction: 'reply', id, ...reply }, window.location.origin);
});
