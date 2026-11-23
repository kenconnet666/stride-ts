/**
 * 页面外壳的加载骨架：游戏页面打开到第一帧画出来之前（下载脚本、加载原生模块、加载内容、编管线）的占位画面——深色底、标题、
 * 进度条、一行阶段说明。HTML 和样式在这里（LOADING_SCREEN_HTML），由 devkit 的 strideLoading 插件在构建和开发时注入每个应用的
 * 页面（不用每个应用各抄一份）；引擎在启动的各个阶段调 reportLoading 更新，第一帧画出来时淡出并摘掉。
 *
 * 页面上没有这个元素（编辑器里嵌着的游戏页面、没注入的应用）时全部是空操作。注入的内联脚本保证它不会永远留着：
 * 嵌在 iframe 里（编辑器的视口）直接摘掉，60 秒还没走完也淡出（比如页面根本没跑引擎）。
 */

/** 启动的阶段：进度条走到哪、说明写什么（说明在样式里按 data-phase 写，页面不用带字符串）。 */
export const LOADING_PHASES = {
  /** 页面和脚本有了，引擎在加载原生模块（wasm）。 */
  native: 0.15,
  /** 原生模块好了，在加载内容（场景、模型、材质）和预热管线。 */
  content: 0.45,
  /** 内容好了，等第一帧画出来。 */
  scene: 0.9,
} as const;

export type LoadingPhase = keyof typeof LOADING_PHASES;

/** 元素的 id。 */
export const LOADING_ID = 'stride-loading';

/** 淡出多久（毫秒），也是摘掉元素前等的时间。 */
export const LOADING_FADE_MS = 350;

/** 更新加载骨架到这个阶段；没有这个元素时什么也不做。 */
export function reportLoading(phase: LoadingPhase): void {
  const element = typeof document === 'undefined' ? null : document.getElementById(LOADING_ID);
  if (!element) return;
  element.dataset['phase'] = phase;
  element.style.setProperty('--progress', String(LOADING_PHASES[phase]));
}

/** 第一帧画出来了：进度条走满、淡出、摘掉。 */
export function finishLoading(): void {
  const element = typeof document === 'undefined' ? null : document.getElementById(LOADING_ID);
  if (!element || element.dataset['phase'] === 'done') return;
  element.dataset['phase'] = 'done';
  element.style.setProperty('--progress', '1');
  setTimeout(() => element.remove(), LOADING_FADE_MS + 50);
}

/** 启动失败：停在这里，红字写原因（不淡出，不然错误一闪就没了）。 */
export function failLoading(message: string): void {
  const element = typeof document === 'undefined' ? null : document.getElementById(LOADING_ID);
  if (!element) return;
  element.dataset['phase'] = 'failed';
  const text = element.querySelector('.stride-loading-error');
  if (text) text.textContent = message;
}
