/**
 * `stride page`：像人一样看、操作页面（编辑器的界面、游戏页面的 DOM）——照 Claude in Chrome 的那套能力，经 DevTools 协议做，
 * 主 Chrome（调试桥扩展）和 stride open 的 Chrome（直连）一样用：
 *
 * - tree：无障碍树，每个元素带编号（e123，是 DevTools 的 backendNodeId），连同里面的 iframe（编辑器的视口）；--interactive 只要能操作的。
 * - find：按文字找元素，报编号。text：页面的文字。
 * - click、hover、drag、scroll、type、key：真实的鼠标、键盘事件（浏览器当成用户操作：isTrusted 是真，能锁指针、能触发只认用户手势的 API）。
 *   位置写编号（先滚进视口，点它的中心）或者 CSS 像素坐标 x,y（和 shot 截出来的图的像素一致）。
 * - shot：截整个视口（CSS 像素，坐标就是 click 用的坐标）或者一个元素。
 */
import type { DevtoolsSession } from './client.ts';

interface AxNode {
  nodeId: string;
  ignored?: boolean;
  role?: { value?: string };
  name?: { value?: string };
  value?: { value?: unknown };
  properties?: { name: string; value: { value?: unknown } }[];
  childIds?: string[];
  backendDOMNodeId?: number;
  parentId?: string;
}

/** 能操作的角色（tree --interactive 只列这些，和它们的祖先里有名字的标题、区域，方便看出在哪）。 */
const INTERACTIVE = new Set(['button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'listbox', 'option', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'slider', 'spinbutton', 'switch', 'treeitem', 'gridcell', 'columnheader', 'iframe']);
/** 只是包一层、自己没有意义的角色：树里跳过它们，孩子往上提一层。 */
const NOISE = new Set(['generic', 'none', 'presentation', 'LineBreak', 'InlineTextBox', 'StaticText']);

/** 页面（连同各个 iframe）的无障碍树，按行：缩进、角色、名字、值、编号。 */
export async function pageTree(cdp: DevtoolsSession, { interactive = false, max = 400 }: { interactive?: boolean; max?: number } = {}): Promise<string> {
  const { frameTree } = (await cdp.send('Page.getFrameTree')) as { frameTree: FrameTree };
  const lines: string[] = [];
  for (const frame of flattenFrames(frameTree)) {
    const { nodes } = (await cdp.send('Accessibility.getFullAXTree', { frameId: frame.id })) as { nodes: AxNode[] };
    if (frame.depth > 0) lines.push(`${'  '.repeat(frame.depth - 1)}[frame ${frame.url}]`);
    const byId = new Map(nodes.map((node) => [node.nodeId, node]));
    const root = nodes.find((node) => !node.parentId);
    if (!root) continue;
    const visit = (node: AxNode, depth: number) => {
      if (lines.length >= max) return;
      const role = node.role?.value ?? '';
      const name = String(node.name?.value ?? '').trim();
      const skip = node.ignored || NOISE.has(role) || (interactive && !INTERACTIVE.has(role) && !(name && ['heading', 'dialog', 'region', 'toolbar', 'tablist', 'menu', 'tree'].includes(role)));
      if (!skip) lines.push(`${'  '.repeat(depth + frame.depth)}${describe(node)}`);
      for (const id of node.childIds ?? []) {
        const child = byId.get(id);
        if (child) visit(child, skip ? depth : depth + 1);
      }
    };
    visit(root, 0);
  }
  if (lines.length >= max) lines.push(`… (more than ${max} lines; use --interactive or --max)`);
  return lines.join('\n');
}

/** 名字或值里有 text 的元素（不分大小写），按行报。 */
export async function pageFind(cdp: DevtoolsSession, text: string): Promise<string> {
  const needle = text.toLowerCase();
  const tree = await pageTree(cdp, { max: 100_000 });
  return tree.split('\n').filter((line) => line.toLowerCase().includes(needle)).map((line) => line.trim()).slice(0, 50).join('\n');
}

function describe(node: AxNode): string {
  const parts = [node.role?.value ?? '?'];
  const name = String(node.name?.value ?? '').trim();
  if (name) parts.push(JSON.stringify(name.length > 80 ? `${name.slice(0, 77)}…` : name));
  const value = node.value?.value;
  if (value !== undefined && value !== '') parts.push(`= ${JSON.stringify(value)}`);
  for (const property of node.properties ?? []) {
    if (['checked', 'selected', 'expanded', 'disabled', 'pressed', 'focused'].includes(property.name) && property.value.value) parts.push(property.name);
  }
  if (node.backendDOMNodeId !== undefined) parts.push(`[e${node.backendDOMNodeId}]`);
  return parts.join(' ');
}

interface FrameTree {
  frame: { id: string; url: string };
  childFrames?: FrameTree[];
}

function flattenFrames(tree: FrameTree, depth = 0): { id: string; url: string; depth: number }[] {
  return [{ id: tree.frame.id, url: tree.frame.url, depth }, ...(tree.childFrames ?? []).flatMap((child) => flattenFrames(child, depth + 1))];
}

/** 页面的文字（document.body.innerText，太长截断）。 */
export async function pageText(cdp: DevtoolsSession, max = 20_000): Promise<string> {
  const { result } = (await cdp.send('Runtime.evaluate', { expression: 'document.body.innerText', returnByValue: true })) as { result: { value: string } };
  return result.value.length > max ? `${result.value.slice(0, max)}\n… (${result.value.length} characters)` : result.value;
}

/** 元素的盒子（四个角）；编号失效（页面刷新、元素被重新渲染）时报清楚。 */
async function boxOf(cdp: DevtoolsSession, backendNodeId: number): Promise<{ content: number[]; border: number[] }> {
  await cdp.send('DOM.scrollIntoViewIfNeeded', { backendNodeId }).catch(() => undefined);
  try {
    return ((await cdp.send('DOM.getBoxModel', { backendNodeId })) as { model: { content: number[]; border: number[] } }).model;
  } catch (error) {
    if (/no node found/i.test(String(error))) throw new Error(`element e${backendNodeId} no longer exists (the page reloaded or re-rendered it); run page tree or page find again`);
    throw error;
  }
}

/** 位置：元素编号（e123）滚进视口后取中心，或者 CSS 像素的 "x,y"。 */
export async function resolvePoint(cdp: DevtoolsSession, target: string): Promise<[number, number]> {
  const ref = /^e(\d+)$/.exec(target);
  if (!ref) {
    // "x,y" 或 "x y"（PowerShell 把 1700,800 当成数组，传进来是空格分开的）
    const xy = target.trim().split(/[\s,]+/).map(Number);
    if (xy.length !== 2 || xy.some((v) => !Number.isFinite(v))) throw new Error(`'${target}' is neither an element ref (e123, from page tree) nor x,y CSS pixels`);
    return xy as [number, number];
  }
  const q = (await boxOf(cdp, Number(ref[1]))).content;
  return [(q[0]! + q[2]! + q[4]! + q[6]!) / 4, (q[1]! + q[3]! + q[5]! + q[7]!) / 4];
}

const MODIFIER_BITS: Record<string, number> = { alt: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, shift: 8 };

function modifierBits(modifiers: string | undefined): number {
  let bits = 0;
  for (const name of (modifiers ?? '').split('+').map((m) => m.trim().toLowerCase()).filter(Boolean)) {
    const bit = MODIFIER_BITS[name];
    if (bit === undefined) throw new Error(`unknown modifier '${name}' (alt, ctrl, meta, shift)`);
    bits |= bit;
  }
  return bits;
}

export interface ClickOptions {
  readonly button?: 'left' | 'right' | 'middle';
  /** 1 单击、2 双击、3 三击。 */
  readonly count?: number;
  /** 'ctrl+shift' 这样的修饰键。 */
  readonly modifiers?: string;
}

export async function pageClick(cdp: DevtoolsSession, target: string, { button = 'left', count = 1, modifiers }: ClickOptions = {}): Promise<{ x: number; y: number }> {
  const [x, y] = await resolvePoint(cdp, target);
  const bits = modifierBits(modifiers);
  await showCursor(cdp, x, y, 'move', [modifiers, button !== 'left' ? button : '', count > 1 ? `×${count}` : ''].filter(Boolean).join(' '));
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, modifiers: bits });
  await showCursor(cdp, x, y, 'click', '');
  for (let i = 1; i <= count; i++) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: i, modifiers: bits });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: i, modifiers: bits });
  }
  return { x, y };
}

export async function pageHover(cdp: DevtoolsSession, target: string): Promise<{ x: number; y: number }> {
  const [x, y] = await resolvePoint(cdp, target);
  await showCursor(cdp, x, y, 'move');
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  return { x, y };
}

/** 按住拖过去：中间分 steps 步移动（拖放、滑块、视口里拖操纵器都要中间的移动事件）。 */
export async function pageDrag(cdp: DevtoolsSession, from: string, to: string, { steps = 12, button = 'left', modifiers }: { steps?: number; button?: 'left' | 'right' | 'middle'; modifiers?: string } = {}): Promise<{ from: [number, number]; to: [number, number] }> {
  const a = await resolvePoint(cdp, from), b = await resolvePoint(cdp, to);
  const bits = modifierBits(modifiers);
  const buttons = { left: 1, right: 2, middle: 4 }[button];
  await showCursor(cdp, a[0], a[1], 'move', modifiers ?? '');
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: a[0], y: a[1], modifiers: bits });
  await showCursor(cdp, a[0], a[1], 'down');
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: a[0], y: a[1], button, clickCount: 1, modifiers: bits });
  for (let i = 1; i <= steps; i++) {
    const t = i / steps, x = a[0] + (b[0] - a[0]) * t, y = a[1] + (b[1] - a[1]) * t;
    await showCursor(cdp, x, y, 'up');
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button, buttons, modifiers: bits });
  }
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b[0], y: b[1], button, clickCount: 1, modifiers: bits });
  return { from: a, to: b };
}

/** 滚轮：在 target 上滚 dy（往下为正）、dx 个 CSS 像素。 */
export async function pageScroll(cdp: DevtoolsSession, target: string, dy: number, dx = 0): Promise<{ x: number; y: number }> {
  const [x, y] = await resolvePoint(cdp, target);
  await showCursor(cdp, x, y, 'move', dy > 0 ? '↓ scroll' : dy < 0 ? '↑ scroll' : '↔ scroll');
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: dx, deltaY: dy });
  return { x, y };
}

/** 打字：插入文字到当前的焦点（同输入法上屏，一次一段，快）。要逐键的按键事件用 key。 */
export async function pageType(cdp: DevtoolsSession, text: string): Promise<void> {
  const [x, y] = await cursorPosition(cdp);
  await showCursor(cdp, x, y, 'label', `⌨ ${text.length > 24 ? `${text.slice(0, 23)}…` : text}`);
  await cdp.send('Input.insertText', { text });
}

/** 键名 → DOM 的 key、code 和 Windows 虚拟键码（Chrome 要它才会触发默认行为，比如 Enter 提交、Tab 移焦点）。 */
const KEYS: Record<string, [key: string, code: string, vk: number]> = {
  enter: ['Enter', 'Enter', 13], tab: ['Tab', 'Tab', 9], escape: ['Escape', 'Escape', 27], esc: ['Escape', 'Escape', 27],
  backspace: ['Backspace', 'Backspace', 8], delete: ['Delete', 'Delete', 46], space: [' ', 'Space', 32],
  arrowup: ['ArrowUp', 'ArrowUp', 38], up: ['ArrowUp', 'ArrowUp', 38], arrowdown: ['ArrowDown', 'ArrowDown', 40], down: ['ArrowDown', 'ArrowDown', 40],
  arrowleft: ['ArrowLeft', 'ArrowLeft', 37], left: ['ArrowLeft', 'ArrowLeft', 37], arrowright: ['ArrowRight', 'ArrowRight', 39], right: ['ArrowRight', 'ArrowRight', 39],
  home: ['Home', 'Home', 36], end: ['End', 'End', 35], pageup: ['PageUp', 'PageUp', 33], pagedown: ['PageDown', 'PageDown', 34],
  shift: ['Shift', 'ShiftLeft', 16], ctrl: ['Control', 'ControlLeft', 17], control: ['Control', 'ControlLeft', 17], alt: ['Alt', 'AltLeft', 18], meta: ['Meta', 'MetaLeft', 91],
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`f${i + 1}`, [`F${i + 1}`, `F${i + 1}`, 112 + i]])),
};

function keyOf(name: string): [string, string, number] {
  const known = KEYS[name.toLowerCase()];
  if (known) return known;
  if (/^[a-z]$/i.test(name)) return [name.toLowerCase(), `Key${name.toUpperCase()}`, name.toUpperCase().charCodeAt(0)];
  if (/^[0-9]$/.test(name)) return [name, `Digit${name}`, name.charCodeAt(0)];
  throw new Error(`unknown key '${name}'`);
}

/** 按键组合（'ctrl+s'、'Enter'、'shift+Tab'），几组按顺序按；repeat 次。 */
export async function pageKey(cdp: DevtoolsSession, combos: readonly string[], repeat = 1): Promise<void> {
  const [x, y] = await cursorPosition(cdp);
  await showCursor(cdp, x, y, 'label', `⌨ ${combos.join(' ')}${repeat > 1 ? ` ×${repeat}` : ''}`);
  for (let r = 0; r < repeat; r++) {
    for (const combo of combos) {
      const names = combo.split('+');
      const main = keyOf(names.pop()!);
      const modifiers = modifierBits(names.join('+'));
      const [key, code, vk] = main;
      const text = key.length === 1 && !(modifiers & (2 | 4)) ? (modifiers & 8 ? key.toUpperCase() : key) : undefined;
      await cdp.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key, code, windowsVirtualKeyCode: vk, modifiers, ...(text ? { text } : {}) });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, modifiers });
    }
  }
}

/** 截图：整个视口，或者一个元素（ref）。按 CSS 像素截，图上的坐标就是 click 用的坐标。返回 PNG。 */
export async function pageShot(cdp: DevtoolsSession, ref?: string): Promise<Buffer> {
  // 截图默认按设备像素（高分屏、系统缩放时比 CSS 像素大）：缩回 CSS 像素，图上的坐标就是 click 用的坐标
  const { result } = (await cdp.send('Runtime.evaluate', { expression: 'devicePixelRatio', returnByValue: true })) as { result: { value: number } };
  const scale = 1 / (result.value || 1);
  let clip: { x: number; y: number; width: number; height: number; scale: number };
  if (ref) {
    const match = /^e(\d+)$/.exec(ref);
    if (!match) throw new Error(`'${ref}' is not an element ref (e123)`);
    const model = await boxOf(cdp, Number(match[1]));
    const xs = [model.border[0]!, model.border[2]!, model.border[4]!, model.border[6]!], ys = [model.border[1]!, model.border[3]!, model.border[5]!, model.border[7]!];
    clip = { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys), scale };
  } else {
    const { cssLayoutViewport } = (await cdp.send('Page.getLayoutMetrics')) as { cssLayoutViewport: { clientWidth: number; clientHeight: number } };
    clip = { x: 0, y: 0, width: cssLayoutViewport.clientWidth, height: cssLayoutViewport.clientHeight, scale };
  }
  const { data } = (await cdp.send('Page.captureScreenshot', { format: 'png', clip })) as { data: string };
  return Buffer.from(data, 'base64');
}

/** 在顶层页面（编辑器的界面，不是视口里的游戏 iframe）里求一个表达式的值；能 await。查界面的布局、状态用。 */
export async function pageEval(cdp: DevtoolsSession, expression: string): Promise<unknown> {
  const { result, exceptionDetails } = (await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, replMode: true })) as {
    result: { value?: unknown; description?: string };
    exceptionDetails?: { exception?: { description?: string }; text: string };
  };
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
  return result.value ?? result.description;
}

/**
 * 页面上 agent 自己的鼠标指针（同 Claude in Chrome 那样让人看得见在操作哪里）：注入到页面最上层、不挡点击。指针平滑地移到目标处，
 * 点击有一圈波纹，按键、滚轮在指针旁边显示按了什么，闲置 4 秒淡出。整个函数原样注入页面，不能用外面的变量。
 */
function drawCursor(x: number, y: number, kind: 'move' | 'click' | 'down' | 'up' | 'label', label: string): Promise<void> {
  const w = window as unknown as { __strideCursor?: { el: HTMLElement; tag: HTMLElement; x: number; y: number; timer: number } };
  let c = w.__strideCursor;
  if (!c || !c.el.isConnected) {
    const el = document.createElement('div');
    el.setAttribute('data-stride-cursor', '');
    el.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;transition:transform 140ms ease-out,opacity 300ms;will-change:transform;';
    el.innerHTML = '<svg width="22" height="22" viewBox="0 0 22 22" style="display:block;filter:drop-shadow(0 1px 2px rgba(0,0,0,.6))"><path d="M2 1 L2 17 L6.5 13 L9.5 20 L12.5 18.6 L9.6 12 L15.5 12 Z" fill="#ff7a1a" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg>';
    const tag = document.createElement('div');
    tag.style.cssText = 'position:absolute;left:18px;top:18px;padding:2px 6px;border-radius:4px;background:#ff7a1a;color:#fff;font:12px/1.4 system-ui,sans-serif;white-space:nowrap;opacity:0;transition:opacity 200ms;';
    el.appendChild(tag);
    document.documentElement.appendChild(el);
    c = w.__strideCursor = { el, tag, x: innerWidth / 2, y: innerHeight / 2, timer: 0 };
    el.style.transform = `translate(${c.x}px, ${c.y}px)`;
  }
  const cursor = c;
  cursor.el.style.opacity = '1';
  cursor.el.style.transform = `translate(${x}px, ${y}px)`;
  cursor.x = x;
  cursor.y = y;
  if (label) {
    cursor.tag.textContent = label;
    cursor.tag.style.opacity = '1';
  }
  if (kind === 'click' || kind === 'down') {
    const ring = document.createElement('div');
    ring.style.cssText = `position:fixed;left:${x - 14}px;top:${y - 14}px;width:28px;height:28px;border-radius:50%;border:2px solid #ff7a1a;z-index:2147483646;pointer-events:none;transition:transform 400ms ease-out,opacity 400ms;`;
    document.documentElement.appendChild(ring);
    requestAnimationFrame(() => {
      ring.style.transform = 'scale(1.8)';
      ring.style.opacity = '0';
    });
    setTimeout(() => ring.remove(), 450);
  }
  clearTimeout(cursor.timer);
  cursor.timer = setTimeout(() => {
    cursor.el.style.opacity = '0';
    cursor.tag.style.opacity = '0';
  }, 4000) as unknown as number;
  // 等指针移过去（transition 140 毫秒）再发真实的事件，人看得清
  return new Promise((resolve) => setTimeout(resolve, kind === 'move' || kind === 'click' ? 160 : 0));
}

/** 画模拟指针（--no-cursor 时不画）；画不出来（页面在跳转）不影响操作。 */
export async function showCursor(cdp: DevtoolsSession, x: number, y: number, kind: 'move' | 'click' | 'down' | 'up' | 'label', label = ''): Promise<void> {
  if (!cursorEnabled) return;
  await cdp.send('Runtime.evaluate', { expression: `(${drawCursor.toString()})(${x}, ${y}, ${JSON.stringify(kind)}, ${JSON.stringify(label)})`, awaitPromise: true }).catch(() => undefined);
}

let cursorEnabled = true;
/** 关掉模拟指针（截图比对、测帧时间时不要它）。 */
export function setCursorEnabled(enabled: boolean): void {
  cursorEnabled = enabled;
}

/** 指针现在在哪（键盘操作时把按键标在那里）。 */
async function cursorPosition(cdp: DevtoolsSession): Promise<[number, number]> {
  const { result } = (await cdp.send('Runtime.evaluate', { expression: 'window.__strideCursor ? [__strideCursor.x, __strideCursor.y] : [innerWidth / 2, innerHeight / 2]', returnByValue: true })) as { result: { value: [number, number] } };
  return result.value;
}
