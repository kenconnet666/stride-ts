/**
 * EditText 的影子输入框：激活的 EditText 后面放一个看不见的 DOM `<input>`（或多行时的 `<textarea>`），键盘输入、输入法、
 * 选中、复制粘贴、撤销都交给浏览器，EditText 每帧照它的值和选区显示。输入框摆在 EditText 在屏幕上的位置，输入法的候选窗就出现在
 * 字旁边；读屏软件也读得到它（aria-label 是元素的名字）。
 *
 * 和 Stride 不同：Stride 桌面版自己解释按键（左右、Home、End、Ctrl+C……），我们用浏览器的，行为和别的网页输入框一样。
 * Enter、Esc 结束编辑，同 Stride（Stride 桌面版的多行输入框也是 Enter 结束）；多行的可以 Shift+Enter 换行（多做的）。
 * Tab 结束编辑并把焦点交给下一个控件（Shift+Tab 上一个），顺序是影子 DOM 的（SemanticsLayer）。
 */
import type { EditText } from './controls/EditText';

export class TextInputBridge {
  readonly #canvas: HTMLCanvasElement;
  #element: HTMLInputElement | HTMLTextAreaElement | undefined;
  #edit: EditText | undefined;
  #composing = false;
  readonly #abort = new AbortController();

  constructor(canvas: HTMLCanvasElement) {
    this.#canvas = canvas;
    // 编辑时点画布不让输入框失去焦点（同 Stride 桌面版：点别处不结束编辑），点到别的元素由 UI 决定
    canvas.addEventListener('mousedown', (event) => {
      if (this.#edit) event.preventDefault();
    }, { signal: this.#abort.signal });
  }

  /** 正在编辑的 EditText。 */
  get active(): EditText | undefined {
    return this.#edit;
  }

  /** 开始编辑 edit：建（或换成）合适的输入框，填上文字和选区，拿到焦点。 */
  activate(edit: EditText): void {
    this.#edit = edit;
    const multiline = edit.maxLines > 1;
    if (!this.#element || (this.#element instanceof HTMLTextAreaElement) !== multiline) this.#create(multiline);
    const element = this.#element!;
    if (element instanceof HTMLInputElement) element.type = edit.inputType === 'password' ? 'password' : 'text';
    element.maxLength = Number.isFinite(edit.maxLength) && edit.maxLength < 524288 ? edit.maxLength : 524288;
    element.readOnly = edit.isReadOnly;
    element.value = edit.text;
    element.setAttribute('aria-label', edit.name ?? 'text');
    this.#position(edit);
    element.focus({ preventScroll: true });
    const [start, end] = toUtf16Range(edit.text, edit.selectionStart, edit.selectionStart + edit.selectionLength);
    element.setSelectionRange(start, end);
  }

  /** 结束编辑：输入框放弃焦点（如果还在编辑的是 edit）。 */
  deactivate(edit: EditText): void {
    if (this.#edit !== edit) return;
    this.#edit = undefined;
    this.#composing = false;
    this.#element?.blur();
  }

  /** @internal 每帧：输入框跟着 EditText 的位置，选区（用户按方向键、拖选）同步回 EditText。 */
  update(): void {
    const edit = this.#edit, element = this.#element;
    if (!edit || !element) return;
    this.#position(edit);
    if (this.#composing) return;
    const value = element.value;
    const start = toCodePointIndex(value, element.selectionStart ?? 0);
    const end = toCodePointIndex(value, element.selectionEnd ?? 0);
    const caretAtBeginning = element.selectionDirection === 'backward';
    edit.syncSelection(start, end - start, caretAtBeginning);
  }

  /** EditText 自己改了选区（点击、拖选）：告诉输入框。 */
  select(edit: EditText): void {
    if (this.#edit !== edit || !this.#element) return;
    const [start, end] = toUtf16Range(edit.text, edit.selectionStart, edit.selectionStart + edit.selectionLength);
    this.#element.setSelectionRange(start, end, edit.caretPosition === edit.selectionStart && edit.selectionLength > 0 ? 'backward' : 'forward');
  }

  /** EditText 的文字被代码改了：输入框跟着改。 */
  setText(edit: EditText): void {
    if (this.#edit === edit && this.#element && this.#element.value !== edit.text) this.#element.value = edit.text;
  }

  destroy(): void {
    this.#abort.abort();
    this.#element?.remove();
  }

  #create(multiline: boolean): void {
    this.#element?.remove();
    const element = document.createElement(multiline ? 'textarea' : 'input');
    // 看不见、不挡指针，但要在页面里（输入法和读屏软件需要）
    Object.assign(element.style, {
      position: 'fixed', opacity: '0', pointerEvents: 'none', border: '0', padding: '0', margin: '0', resize: 'none',
      background: 'transparent', color: 'transparent', caretColor: 'transparent', outline: 'none', overflow: 'hidden', zIndex: '0',
    });
    element.autocomplete = 'off';
    element.spellcheck = false;
    const signal = this.#abort.signal;
    element.addEventListener('input', () => this.#onInput(), { signal });
    element.addEventListener('compositionstart', () => {
      this.#composing = true;
    }, { signal });
    element.addEventListener('compositionupdate', (event) => this.#edit?.setComposition((event as CompositionEvent).data), { signal });
    element.addEventListener('compositionend', () => {
      this.#composing = false;
      this.#edit?.setComposition('');
      this.#onInput();
    }, { signal });
    element.addEventListener('keydown', (event) => {
      const { key, shiftKey } = event as KeyboardEvent;
      if (this.#composing) return;
      if (key === 'Escape' || (key === 'Enter' && !(multiline && shiftKey))) {
        event.preventDefault();
        if (this.#edit) this.#edit.isSelectionActive = false;
      } else if (key === 'Tab' && this.#edit) {
        // Tab：结束编辑，焦点交给界面上的下一个控件（影子 DOM 里的顺序）
        const edit = this.#edit;
        event.preventDefault();
        edit.isSelectionActive = false;
        edit.uiSystem?.semantics?.focusNext(edit, shiftKey);
      }
    }, { signal });
    // 浏览器窗口失去焦点之类：结束编辑（Stride 在游戏暂停时也结束）
    element.addEventListener('blur', () => {
      if (this.#edit) this.#edit.isSelectionActive = false;
    }, { signal });
    (this.#canvas.parentElement ?? document.body).appendChild(element);
    this.#element = element;
  }

  #onInput(): void {
    const edit = this.#edit, element = this.#element;
    if (!edit || !element || this.#composing) return;
    edit.setTextFromInput(element.value);
    if (element.value !== edit.text) element.value = edit.text;
  }

  /** 输入框摆到 EditText 的文字区域在屏幕上的位置。 */
  #position(edit: EditText): void {
    const element = this.#element!;
    const rect = this.#canvas.getBoundingClientRect();
    const ratio = edit.layoutingContext?.realVirtualResolutionRatio ?? [1, 1];
    const scaleX = rect.width / (this.#canvas.width || 1), scaleY = rect.height / (this.#canvas.height || 1);
    const [x, y, width, height] = edit.textRegionBounds();
    Object.assign(element.style, {
      left: `${rect.left + x * ratio[0] * scaleX}px`,
      top: `${rect.top + y * ratio[1] * scaleY}px`,
      width: `${Math.max(1, width * ratio[0] * scaleX)}px`,
      height: `${Math.max(1, height * ratio[1] * scaleY)}px`,
      fontSize: `${Math.max(1, edit.actualTextSize * ratio[1] * scaleY)}px`,
    });
  }
}

/** 码位下标的范围换成 UTF-16 的。 */
function toUtf16Range(text: string, start: number, end: number): [number, number] {
  const points = [...text];
  return [points.slice(0, start).join('').length, points.slice(0, end).join('').length];
}

/** UTF-16 下标换成码位下标。 */
function toCodePointIndex(text: string, index: number): number {
  return [...text.slice(0, index)].length;
}
