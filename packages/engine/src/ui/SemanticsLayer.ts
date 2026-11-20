/**
 * 影子 DOM：画布上面盖一层透明的 DOM，全屏 UI 的每段文字、每个控件在里面有一个位置和大小跟画面一致的节点（见 semantics.ts）。
 * 画面还是我们自己画，这一层只是让浏览器"看得到"画布里的界面：
 * - 读屏软件读得到文字和控件（按钮、复选框、滑条、输入框、对话框），能操作它们；Tab 键能走到控件上，Enter、空格触发按钮，方向键调滑条，
 *   焦点框由浏览器画在控件的位置上。
 * - 浏览器的查找（Ctrl+F）、全选复制、翻译插件找得到界面上的文字；TextBlock.isSelectable 的文字可以用鼠标拖着选。
 *   选区的底色由我们的渲染器照自己的排版画（selectionOf），浏览器自己的选区底色关掉。
 *
 * 做法参考 Flutter Web 的 semantics 树和 PDF.js 的文字层：节点是透明的（颜色透明，不是 opacity 0，这样焦点框还看得见），
 * 默认不接指针事件，鼠标照常落到画布上；文字一行一个 span，按我们量出来的宽度横向拉伸（页面上没有游戏的字体，浏览器用
 * 自己的字体排，宽度对不上）。
 *
 * 没变就不动：每隔 updateInterval 把语义树和上一次的比（semanticsKey），只有变了的节点才写 DOM。
 */
import { ButtonBase } from './controls/Button';
import { EditText } from './controls/EditText';
import { RichTextBlock } from './controls/RichTextBlock';
import { Slider } from './controls/Slider';
import type { TextBlock } from './controls/TextBlock';
import { collectSemantics, semanticsKey, type SemanticsLine, type SemanticsNode } from './semantics';
import type { UIElement, Vec2 } from './UIElement';

/** 一棵全屏的 UI 和它的虚拟分辨率。 */
export interface SemanticsPage {
  readonly root: UIElement;
  readonly virtualResolution: Vec2;
}

interface Mirror {
  readonly dom: HTMLElement;
  key: string;
  node: SemanticsNode;
}

const STYLE_ID = 'stride-semantics-style';
const STYLE = `
.stride-semantics, .stride-semantics * { margin: 0; padding: 0; border: 0; background: transparent; color: transparent; box-sizing: border-box; }
.stride-semantics { position: fixed; overflow: hidden; pointer-events: none; z-index: 1; font-family: sans-serif; }
.stride-semantics > div { position: absolute; left: 0; top: 0; transform-origin: 0 0; }
.stride-semantics .node { position: absolute; left: 0; top: 0; transform-origin: 0 0; pointer-events: none; font: inherit; overflow: visible; }
.stride-semantics .node span { position: absolute; white-space: pre; transform-origin: 0 0; user-select: text; }
.stride-semantics .node span span { position: static; }
.stride-semantics .node [role=link]:focus-visible { outline: 2px solid Highlight; outline: 2px auto -webkit-focus-ring-color; outline-offset: 1px; }
.stride-semantics .node.selectable span { pointer-events: auto; cursor: text; }
.stride-semantics ::selection { background: transparent; color: transparent; }
.stride-semantics .node:focus-visible { outline: 2px solid Highlight; outline: 2px auto -webkit-focus-ring-color; outline-offset: 2px; }
`;

export class SemanticsLayer {
  /** 关掉以后影子 DOM 清空，不再同步。 */
  enabled = true;
  /**
   * 最多多久同步一次，秒。读屏、查找不需要逐帧跟上；每次同步要把整棵 UI 走一遍（元素的属性大多是普通字段，没有"变了"的信号），
   * 所以不逐帧做。UI 的分层缓存做了以后改成只在脏的时候同步。
   */
  updateInterval = 0.1;
  #lastUpdate = -Infinity;
  readonly #canvas: HTMLCanvasElement;
  #container: HTMLElement | undefined;
  readonly #pages = new Map<UIElement, { dom: HTMLElement; scale: string }>();
  readonly #mirrors = new Map<UIElement, Mirror>();
  #rect = '';
  /** 选区落在哪些文字上：元素 → 选中的范围（textToDisplay 里的码位，[起, 止)）。 */
  #selection = new Map<UIElement, readonly [number, number]>();
  readonly #abort = new AbortController();
  #measure: CanvasRenderingContext2D | null | undefined;

  constructor(canvas: HTMLCanvasElement) {
    this.#canvas = canvas;
    document.addEventListener('selectionchange', () => this.#readSelection(), { signal: this.#abort.signal });
  }

  /** 页面上的选区盖住 text 的哪一段（textToDisplay 里的码位，[起, 止)）；没选中时是 undefined。渲染器照它画选区的底色。 */
  selectionOf(text: TextBlock): readonly [number, number] | undefined {
    return this.#selection.get(text);
  }

  /** @internal 每帧画完全屏 UI 以后：照这一帧的 UI 树同步影子 DOM。 */
  update(pages: readonly SemanticsPage[]): void {
    if (!this.enabled || pages.length === 0) {
      if (this.#container) this.#clear();
      return;
    }
    const now = performance.now() / 1000;
    if (now - this.#lastUpdate < this.updateInterval) return;
    this.#lastUpdate = now;
    const container = (this.#container ??= this.#create());
    const rect = this.#canvas.getBoundingClientRect();
    const rectKey = `${rect.left},${rect.top},${rect.width},${rect.height}`;
    if (rectKey !== this.#rect) {
      this.#rect = rectKey;
      Object.assign(container.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
    }
    const seen = new Set<UIElement>();
    const roots = new Set<UIElement>();
    for (const { root, virtualResolution } of pages) {
      roots.add(root);
      let page = this.#pages.get(root);
      if (!page) {
        page = { dom: document.createElement('div'), scale: '' };
        container.appendChild(page.dom);
        this.#pages.set(root, page);
      }
      const scale = `scale(${rect.width / virtualResolution[0]}, ${rect.height / virtualResolution[1]})`;
      if (scale !== page.scale) page.dom.style.transform = page.scale = scale;
      let previous: HTMLElement | null = null;
      for (const node of collectSemantics(root)) {
        seen.add(node.element);
        const key = semanticsKey(node);
        let mirror = this.#mirrors.get(node.element);
        if (mirror && mirror.node.role !== node.role) {
          mirror.dom.remove();
          mirror = undefined;
        }
        if (!mirror) {
          mirror = { dom: this.#createNode(node), key: '', node };
          this.#mirrors.set(node.element, mirror);
        }
        // DOM 里的顺序就是阅读和 Tab 的顺序
        const expected: ChildNode | null = previous ? previous.nextSibling : page.dom.firstChild;
        if (mirror.dom !== expected) page.dom.insertBefore(mirror.dom, expected);
        previous = mirror.dom;
        mirror.node = node;
        if (key !== mirror.key) {
          mirror.key = key;
          this.#apply(mirror.dom, node);
        }
      }
    }
    for (const [element, mirror] of this.#mirrors) {
      if (seen.has(element)) continue;
      mirror.dom.remove();
      this.#mirrors.delete(element);
      this.#selection.delete(element);
    }
    for (const [root, page] of this.#pages) {
      if (roots.has(root)) continue;
      page.dom.remove();
      this.#pages.delete(root);
    }
  }

  /**
   * 键盘焦点从 element 的节点挪到下一个（backwards 时上一个）能拿焦点的节点；没有时返回 false。正在编辑的输入框按 Tab 用它
   * （真的输入框不在这一层里，浏览器自己的 Tab 顺序接不上）。
   */
  focusNext(element: UIElement, backwards = false): boolean {
    const from = this.#mirrors.get(element)?.dom;
    if (!from || !this.#container) return false;
    const wanted = backwards ? Node.DOCUMENT_POSITION_PRECEDING : Node.DOCUMENT_POSITION_FOLLOWING;
    const candidates = [...this.#container.querySelectorAll<HTMLElement>('button.node, .node[tabindex="0"]')]
      .filter((dom) => !dom.inert && !(dom as HTMLButtonElement).disabled && (from.compareDocumentPosition(dom) & wanted) !== 0);
    const target = backwards ? candidates.at(-1) : candidates[0];
    target?.focus();
    return target !== undefined;
  }

  destroy(): void {
    this.#abort.abort();
    this.#clear();
  }

  #clear(): void {
    this.#container?.remove();
    this.#container = undefined;
    this.#pages.clear();
    this.#mirrors.clear();
    this.#selection.clear();
    this.#rect = '';
    this.#lastUpdate = -Infinity;
  }

  #create(): HTMLElement {
    if (!document.getElementById(STYLE_ID)) {
      const style = Object.assign(document.createElement('style'), { id: STYLE_ID, textContent: STYLE });
      document.head.appendChild(style);
    }
    const container = document.createElement('div');
    container.className = 'stride-semantics';
    (this.#canvas.parentElement ?? document.body).appendChild(container);
    return container;
  }

  #createNode(node: SemanticsNode): HTMLElement {
    const { role, element } = node;
    // 按钮用真的 <button>：Enter、空格触发 click，能拿焦点，都是浏览器自带的
    const dom: HTMLElement = document.createElement(role === 'button' || role === 'checkbox' ? 'button' : 'div');
    dom.className = 'node';
    if (role !== 'text' && role !== 'button') dom.setAttribute('role', role);
    if (role === 'dialog') dom.setAttribute('aria-modal', 'true');
    if (role === 'slider') dom.tabIndex = 0;
    const signal = this.#abort.signal;
    if (element instanceof ButtonBase && role !== 'dialog') {
      // 读屏软件的"点击"、键盘的 Enter 和空格都是 click 事件（鼠标的点击落在画布上，不到这里）
      dom.addEventListener('click', () => element.performClick(), { signal });
      dom.addEventListener('keydown', (event) => {
        // 游戏那边不该同时收到这次按键（空格是跳）
        if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
      }, { signal });
    }
    if (element instanceof RichTextBlock) {
      // 富文本里的链接（setSegments 建的 role=link 的段）：读屏软件的点击、Enter 发 LinkClicked
      const linkOf = (event: Event) => (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-link]')?.dataset['link'];
      dom.addEventListener('click', (event) => {
        const link = linkOf(event);
        if (link !== undefined) element.activateLink(Number(link));
      }, { signal });
      dom.addEventListener('keydown', (event) => {
        const link = linkOf(event);
        if (link === undefined || event.key !== 'Enter') return;
        element.activateLink(Number(link));
        event.stopPropagation();
      }, { signal });
    }
    if (element instanceof EditText) {
      // 走到输入框上（Tab、读屏软件的点击）就开始编辑：真的输入框（TextInputBridge）接手焦点，这个节点下次同步时拿掉
      const activate = () => {
        if (!element.isSelectionActive) element.isSelectionActive = true;
      };
      dom.addEventListener('focus', activate, { signal });
      dom.addEventListener('click', activate, { signal });
    }
    if (element instanceof Slider) {
      dom.addEventListener('keydown', (event) => {
        const { key } = event;
        if (key === 'ArrowRight' || key === 'ArrowUp') element.increase();
        else if (key === 'ArrowLeft' || key === 'ArrowDown') element.decrease();
        else if (key === 'Home') element.value = element.minimum;
        else if (key === 'End') element.value = element.maximum;
        else return;
        event.preventDefault();
        event.stopPropagation();
      }, { signal });
    }
    return dom;
  }

  /** 节点的内容写到 DOM 上（只在内容变了时调用）。 */
  #apply(dom: HTMLElement, node: SemanticsNode): void {
    const { role, label, matrix, size, disabled, hidden, blocked, checked, range, text, value, readOnly } = node;
    Object.assign(dom.style, { width: `${size[0]}px`, height: `${size[1]}px`, transform: `matrix(${matrix.join(',')})` });
    setAttribute(dom, 'aria-hidden', hidden ? 'true' : undefined);
    dom.inert = blocked;
    if (role === 'textbox') dom.tabIndex = hidden ? -1 : 0;
    if (value !== undefined && dom.textContent !== value) dom.textContent = value;
    setAttribute(dom, 'aria-readonly', readOnly ? 'true' : undefined);
    setAttribute(dom, 'aria-disabled', disabled && role !== 'text' && role !== 'marquee' ? 'true' : undefined);
    if (dom instanceof HTMLButtonElement) dom.disabled = disabled;
    if (role !== 'text' && role !== 'marquee') setAttribute(dom, 'aria-label', label || undefined);
    setAttribute(dom, 'aria-checked', checked);
    if (range) {
      dom.setAttribute('aria-valuemin', String(range.min));
      dom.setAttribute('aria-valuemax', String(range.max));
      dom.setAttribute('aria-valuenow', String(range.value));
    }
    if (!text) return;
    dom.classList.toggle('selectable', text.selectable);
    while (dom.childElementCount > text.lines.length) dom.lastElementChild!.remove();
    while (dom.childElementCount < text.lines.length) dom.appendChild(document.createElement('span'));
    text.lines.forEach((line, i) => {
      const span = dom.children[i] as HTMLElement;
      // 行尾带上换行，复制出来的文字分行
      const newline = i < text.lines.length - 1 ? '\n' : '';
      if (line.segments) setSegments(span, line.segments, newline);
      else if (span.textContent !== line.text + newline) span.textContent = line.text + newline;
      const natural = this.#naturalWidth(line.text, text.fontSize);
      const height = line.height ?? text.lineHeight;
      Object.assign(span.style, {
        left: `${line.x}px`, top: `${line.y}px`, fontSize: `${text.fontSize}px`, lineHeight: `${height}px`, height: `${height}px`,
        transform: natural > 0 && line.width > 0 ? `scaleX(${line.width / natural})` : '',
      });
    });
  }

  /** 浏览器用自己的字体排这行字有多宽（CSS 像素，字号 fontSize）。 */
  #naturalWidth(text: string, fontSize: number): number {
    if (this.#measure === undefined) this.#measure = document.createElement('canvas').getContext('2d');
    const context = this.#measure;
    if (!context) return 0;
    context.font = `${fontSize}px sans-serif`;
    return context.measureText(text).width;
  }

  /** 页面的选区变了：算出它盖住了哪些文字节点的哪一段。 */
  #readSelection(): void {
    const selection = document.getSelection();
    const result = new Map<UIElement, readonly [number, number]>();
    const container = this.#container;
    if (container && selection && !selection.isCollapsed) {
      for (let r = 0; r < selection.rangeCount; r++) {
        const range = selection.getRangeAt(r);
        if (!range.intersectsNode(container)) continue;
        for (const [element, mirror] of this.#mirrors) {
          const lines = mirror.node.text?.lines;
          if (!lines || !range.intersectsNode(mirror.dom)) continue;
          let start = Infinity, end = -Infinity;
          lines.forEach((line, i) => {
            const textNode = mirror.dom.children[i]?.firstChild;
            if (!textNode || !range.intersectsNode(textNode)) return;
            // 选区的头、尾落在这一行里时取它的位置，否则这一行整个在选区里
            const from = range.startContainer === textNode ? range.startOffset : 0;
            const to = range.endContainer === textNode ? range.endOffset : line.text.length;
            // UTF-16 的下标换成码位（行尾补的换行不算）
            start = Math.min(start, line.start + [...line.text.slice(0, from)].length);
            end = Math.max(end, line.start + [...line.text.slice(0, to)].length);
          });
          if (end > start) result.set(element, [start, end]);
        }
      }
    }
    this.#selection = result;
  }
}

/** 富文本的一行：每段一个 span，链接的段是能 Tab 到的 role=link（data-link 是第几个链接）。内容没变时不动 DOM。 */
function setSegments(span: HTMLElement, segments: NonNullable<SemanticsLine['segments']>, newline: string): void {
  const key = JSON.stringify([segments, newline]);
  if (span.dataset['segments'] === key) return;
  span.dataset['segments'] = key;
  span.replaceChildren(...segments.map((segment, i) => {
    const part = document.createElement('span');
    part.textContent = segment.text + (i === segments.length - 1 ? newline : '');
    if (segment.link !== undefined) {
      part.setAttribute('role', 'link');
      part.tabIndex = 0;
      part.dataset['link'] = String(segment.link);
    }
    return part;
  }));
}

function setAttribute(dom: HTMLElement, name: string, value: string | undefined): void {
  if (value === undefined) dom.removeAttribute(name);
  else if (dom.getAttribute(name) !== value) dom.setAttribute(name, value);
}
