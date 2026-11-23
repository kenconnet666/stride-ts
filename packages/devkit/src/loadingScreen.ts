/**
 * 页面外壳的加载骨架的 HTML 和样式（引擎那边的 reportLoading 更新它，见 engine/loadingScreen.ts）：strideLoading 插件把它注入每个
 * 应用的页面，构建和开发服务器上都有。纯 CSS 的占位：脚本和原生模块还在下载的时候就能显示，进度条在引擎报告之前是来回扫的光条。
 */
import type { Plugin } from 'vite';

const STYLE = `
#stride-loading { position: fixed; inset: 0; z-index: 2147483000; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px;
  background: #0b0d12; color: #c9ced9; font: 13px/1.4 system-ui, sans-serif; transition: opacity 350ms ease; --progress: 0; }
#stride-loading[data-phase="done"] { opacity: 0; pointer-events: none; }
#stride-loading .stride-loading-title { font-size: 20px; font-weight: 600; letter-spacing: 0.02em; color: #e7eaf2; }
#stride-loading .stride-loading-bar { width: min(320px, 60vw); height: 3px; border-radius: 2px; background: #232733; overflow: hidden; position: relative; }
#stride-loading .stride-loading-bar::before { content: ""; position: absolute; inset: 0 auto 0 0; width: calc(var(--progress) * 100%); background: #6f9cff; transition: width 300ms ease; }
/* 引擎还没报告（脚本在下载）：一条来回扫的光 */
#stride-loading:not([data-phase])  .stride-loading-bar::after { content: ""; position: absolute; top: 0; bottom: 0; width: 30%; background: linear-gradient(90deg, transparent, #6f9cff, transparent); animation: stride-loading-sweep 1.1s ease-in-out infinite; }
@keyframes stride-loading-sweep { from { left: -30%; } to { left: 100%; } }
#stride-loading .stride-loading-label::after { content: "Loading"; }
#stride-loading[data-phase="native"] .stride-loading-label::after { content: "Starting the engine"; }
#stride-loading[data-phase="content"] .stride-loading-label::after { content: "Loading content"; }
#stride-loading[data-phase="scene"] .stride-loading-label::after { content: "Preparing the first frame"; }
#stride-loading[data-phase="failed"] .stride-loading-bar { display: none; }
#stride-loading[data-phase="failed"] .stride-loading-label::after { content: "Failed to start"; color: #ff8585; }
#stride-loading .stride-loading-error { max-width: min(640px, 80vw); color: #ff8585; font: 12px/1.4 ui-monospace, monospace; white-space: pre-wrap; text-align: center; }
@media (prefers-reduced-motion: reduce) { #stride-loading, #stride-loading .stride-loading-bar::before { transition: none; } #stride-loading .stride-loading-bar::after { animation: none; } }
`;

/**
 * 内联脚本：标题取页面的 title；嵌在 iframe 里（编辑器的视口，编辑器自己有骨架屏）直接摘掉；60 秒还没走完就淡出
 * （页面没跑引擎的话不会永远盖着）。
 */
const SCRIPT = `(function () {
  var element = document.getElementById('stride-loading');
  if (!element) return;
  if (window.top !== window) { element.remove(); return; }
  element.querySelector('.stride-loading-title').textContent = document.title;
  setTimeout(function () { if (element.dataset.phase !== 'failed') { element.dataset.phase = 'done'; setTimeout(function () { element.remove(); }, 400); } }, 60000);
})();`;

const BODY = `<div id="stride-loading" role="status" aria-live="polite"><div class="stride-loading-title"></div><div class="stride-loading-bar"></div><div class="stride-loading-label"></div><div class="stride-loading-error"></div></div><script>${SCRIPT}</script>`;

/** 把加载骨架放进页面：样式在 head 里，元素和脚本紧跟在 body 的开头（比应用自己的任何内容都早）。 */
export function injectLoadingScreen(html: string): string {
  if (html.includes('id="stride-loading"')) return html;
  return html
    .replace('</head>', `<style>${STYLE}</style></head>`)
    .replace(/<body[^>]*>/, (open) => `${open}${BODY}`);
}

export function strideLoading(): Plugin {
  return {
    name: 'stride-loading',
    transformIndexHtml: { order: 'pre', handler: injectLoadingScreen },
  };
}
