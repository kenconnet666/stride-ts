/**
 * 输入框（Stride 的 EditText）：布局、属性、选区和光标照 Stride。点一下开始编辑（isSelectionActive，拿到键盘焦点），
 * 编辑交给影子输入框（TextInputBridge：浏览器的输入框负责键盘、输入法、选中、复制粘贴），这里按它的值和选区显示；
 * 在框里点、拖可以放光标、选文字。
 *
 * 下标都按码位算（一个 emoji 是一个字），同 [...text]。
 */
import { layoutText, type TextAlignment } from '../../rendering/text/layout';
import type { SpriteFont } from '../../rendering/text/SpriteFont';
import { RoutedEvent, RoutedEventArgs, type TouchEventArgs } from '../events';
import { sizeWithThickness, type Color, type Vec2 } from '../UIElement';
import type { SpriteProvider } from '../sprites';
import { Control } from './ContentControl';
import { textSize } from './TextBlock';

/** 输入类型（Stride 的 InputTypeFlags）：password 显示成圆点。 */
export type EditTextInputType = 'none' | 'password';

const LIGHT: Color = [240 / 255, 240 / 255, 240 / 255, 1];

/** 文字里每个下标（0 到字数）的位置：相对文字区域左上角的虚拟坐标，y 是那一行的行顶。 */
export interface TextBoundaries {
  readonly x: readonly number[];
  readonly y: readonly number[];
  readonly lineHeight: number;
}

export class EditText extends Control {
  /** 文字改了（冒泡，Stride 的 TextChanged）。 */
  static readonly textChangedEvent = new RoutedEvent<RoutedEventArgs>('TextChanged', 'bubble');

  #text = '';
  #font: SpriteFont | null = null;
  #textSize = NaN;
  #minLines = 1;
  #maxLines = Number.MAX_SAFE_INTEGER;
  #maxLength = Number.MAX_SAFE_INTEGER;
  #isSelectionActive = false;
  #selectionStart = 0;
  #selectionLength = 0;
  #caretAtBeginning = false;
  #composition = '';
  #caretTime = 0;
  #isTouchedDown = false;
  #anchor = 0;
  textColor: Color = LIGHT;
  textAlignment: TextAlignment = 'left';
  activeImage: SpriteProvider | null = null;
  inactiveImage: SpriteProvider | null = null;
  mouseOverImage: SpriteProvider | null = null;
  caretColor: Color = LIGHT;
  caretWidth = 1;
  /** 光标每秒闪几次（0 是不闪）。 */
  caretFrequency = 1;
  selectionColor: Color = [0x80 / 255, 0xb4 / 255, 0xd5 / 255, 1];
  imeSelectionColor: Color = [0x80 / 255, 0xff / 255, 0xf0 / 255, 1];
  isReadOnly = false;
  inputType: EditTextInputType = 'none';
  doNotSnapText = false;
  synchronousCharacterGeneration = false;
  /** 上次量的时候字体的排版版本（同 TextBlock）。 */
  #measuredVersion = -1;

  constructor() {
    super();
    this.canBeHitByUser = true;
    this.padding = [8, 4, 8, 8];
    // 图片、选中、文字、光标
    this.drawLayerNumber += 4;
  }

  get text(): string { return this.#text; }
  set text(value: string) {
    const text = [...(value ?? '')].slice(0, this.#maxLength).join('');
    if (text === this.#text) return;
    this.#text = text;
    const length = [...text].length;
    this.#selectionStart = Math.min(this.#selectionStart, length);
    this.#selectionLength = Math.min(this.#selectionLength, length - this.#selectionStart);
    this.uiSystem?.textInput?.setText(this);
    this.invalidateMeasure();
    this.raiseEvent(new RoutedEventArgs(EditText.textChangedEvent));
  }

  get font(): SpriteFont | null { return this.#font; }
  set font(value: SpriteFont | null) { this.#font = value; this.invalidateMeasure(); }
  get textSize(): number { return this.#textSize; }
  set textSize(value: number) { this.#textSize = Math.max(0, value); this.invalidateMeasure(); }
  get actualTextSize(): number { return !Number.isNaN(this.#textSize) ? this.#textSize : this.#font?.size ?? 0; }
  get minLines(): number { return this.#minLines; }
  set minLines(value: number) { this.#minLines = Math.max(1, value); this.invalidateMeasure(); }
  get maxLines(): number { return this.#maxLines; }
  set maxLines(value: number) { this.#maxLines = Math.max(1, value); this.invalidateMeasure(); }
  /** 最多几个字（码位）；改小时截掉多的。 */
  get maxLength(): number { return this.#maxLength; }
  set maxLength(value: number) {
    this.#maxLength = Math.max(0, value);
    this.text = this.#text;
  }

  // ---- 编辑 ----
  /** 正在编辑（有键盘焦点，Stride 的 IsSelectionActive）。只读的不能编辑；同时只有一个输入框在编辑。 */
  get isSelectionActive(): boolean { return this.#isSelectionActive; }
  set isSelectionActive(value: boolean) {
    if (value === this.#isSelectionActive || (value && this.isReadOnly)) return;
    const system = this.uiSystem;
    if (!system) return;
    this.#isSelectionActive = value;
    if (value) {
      const previous = system.focusedElement;
      if (previous instanceof EditText && previous !== this) previous.isSelectionActive = false;
      system.focusedElement = this;
      system.textInput?.activate(this);
      this.resetCaretBlinking();
    } else {
      if (system.focusedElement === this) system.focusedElement = null;
      system.textInput?.deactivate(this);
      this.#composition = '';
    }
  }

  override get isEnabled(): boolean { return super.isEnabled; }
  override set isEnabled(value: boolean) {
    if (!value && this.#isSelectionActive) this.isSelectionActive = false;
    super.isEnabled = value;
  }

  get selectionStart(): number { return this.#selectionStart; }
  get selectionLength(): number { return this.#selectionLength; }
  get selectedText(): string { return [...this.#text].slice(this.#selectionStart, this.#selectionStart + this.#selectionLength).join(''); }
  /** 光标在选区的哪一头。 */
  get caretPosition(): number { return this.#caretAtBeginning ? this.#selectionStart : this.#selectionStart + this.#selectionLength; }
  set caretPosition(value: number) { this.select(value, 0); }
  /** 输入法正在拼的字（还没确认）。 */
  get composition(): string { return this.#composition; }

  /** 选中从 start 起 length 个字（Stride 的 Select）；caretAtBeginning 时光标在开头。 */
  select(start: number, length: number, caretAtBeginning = false): void {
    this.#setSelection(start, length, caretAtBeginning);
    this.uiSystem?.textInput?.select(this);
  }

  selectAll(caretAtBeginning = false): void {
    this.select(0, [...this.#text].length, caretAtBeginning);
  }

  clear(): void {
    this.text = '';
  }

  appendText(text: string): void {
    this.text = this.#text + text;
  }

  /** 光标重新从亮开始闪（Stride 的 ResetCaretBlinking）。 */
  resetCaretBlinking(): void {
    this.#caretTime = 0;
  }

  /** 光标现在看得见（编辑中、闪烁到亮的一半）。 */
  get isCaretVisible(): boolean {
    if (!this.#isSelectionActive) return false;
    return this.caretFrequency <= 0 || (this.#caretTime * this.caretFrequency) % 1 < 0.5;
  }

  /** @internal 影子输入框的值变了。 */
  setTextFromInput(value: string): void {
    this.text = value;
    this.resetCaretBlinking();
  }

  /** @internal 影子输入框的选区（按键移动、拖选、全选）。 */
  syncSelection(start: number, length: number, caretAtBeginning: boolean): void {
    if (start === this.#selectionStart && length === this.#selectionLength && caretAtBeginning === this.#caretAtBeginning) return;
    this.#setSelection(start, length, caretAtBeginning);
    this.resetCaretBlinking();
  }

  /** @internal 输入法拼字中（空字符串是拼完或取消）。 */
  setComposition(text: string): void {
    this.#composition = text;
    this.invalidateMeasure();
  }

  #setSelection(start: number, length: number, caretAtBeginning: boolean): void {
    const total = [...this.#text].length;
    const s = Math.max(0, Math.min(start, total));
    this.#selectionStart = s;
    this.#selectionLength = Math.max(0, Math.min(length, total - s));
    this.#caretAtBeginning = caretAtBeginning;
  }

  /** 画出来的文字：拼字中时拼的字插在选区的位置；密码显示成圆点。 */
  get textToDisplay(): string {
    let points = [...this.#text];
    if (this.#composition) points = [...points.slice(0, this.#selectionStart), ...this.#composition, ...points.slice(this.#selectionStart + this.#selectionLength)];
    return this.inputType === 'password' ? '•'.repeat(points.length) : points.join('');
  }

  /** 现在该画的图：编辑中、悬停、平时。 */
  get backgroundImage(): SpriteProvider | null {
    return this.#isSelectionActive ? this.activeImage : this.mouseOverState === 'element' && this.mouseOverImage ? this.mouseOverImage : this.inactiveImage;
  }

  // ---- 指针 ----
  protected override onTouchDown(args: TouchEventArgs): void {
    super.onTouchDown(args);
    this.isSelectionActive = !this.isReadOnly;
    this.#isTouchedDown = true;
    this.#anchor = this.#indexAt(args.worldPosition);
    this.select(this.#anchor, 0);
    this.resetCaretBlinking();
  }

  protected override onTouchMove(args: TouchEventArgs): void {
    super.onTouchMove(args);
    if (!this.#isTouchedDown) return;
    const index = this.#indexAt(args.worldPosition);
    this.select(Math.min(index, this.#anchor), Math.abs(index - this.#anchor), index < this.#anchor);
  }

  protected override onTouchUp(args: TouchEventArgs): void {
    super.onTouchUp(args);
    this.#isTouchedDown = false;
  }

  protected override onTouchLeave(args: TouchEventArgs): void {
    super.onTouchLeave(args);
    this.#isTouchedDown = false;
  }

  // ---- 文字的位置 ----
  /** 文字区域（元素减去内边距）在虚拟坐标里的左上角和大小。 */
  textRegionBounds(): [number, number, number, number] {
    const [left, top, right, bottom] = this.padding;
    const [w, h] = this.renderSize;
    const [cx, cy] = this.worldPosition;
    return [cx - w / 2 + left, cy - h / 2 + top, Math.max(0, w - left - right), Math.max(0, h - top - bottom)];
  }

  /** 每个下标（光标能停的位置）的坐标，按画的时候一样的排版（真实像素的字号、在区域宽度里对齐）。 */
  textBoundaries(): TextBoundaries | undefined {
    const font = this.#font;
    if (!font) return undefined;
    const context = this.layoutingContext;
    const ratio = font.isStatic || this.doNotSnapText || !context ? [1, 1] : context.realVirtualResolutionRatio;
    const size = ratio[1]! * this.actualTextSize;
    const text = [...this.textToDisplay];
    const regionWidth = this.textRegionBounds()[2];
    const glyphs = layoutText(font, text.join(''), [size, size], this.textAlignment, regionWidth * ratio[0]!);
    const lineHeight = font.totalLineSpacing(size);
    const xs: number[] = new Array<number>(text.length + 1).fill(NaN);
    const ys: number[] = new Array<number>(text.length + 1).fill(NaN);
    for (const glyph of glyphs) {
      xs[glyph.index] = glyph.x;
      ys[glyph.index] = glyph.y;
      xs[glyph.index + 1] = glyph.nextX;
      ys[glyph.index + 1] = glyph.y;
    }
    // 没有字形的位置（换行、空文字）：接着前一个位置；换行后从下一行开头
    let lineStart = alignedLineStart(this.textAlignment, regionWidth * ratio[0]!);
    for (let i = 0; i <= text.length; i++) {
      if (Number.isNaN(xs[i]!)) {
        const newline = i > 0 && text[i - 1] === '\n';
        xs[i] = newline || i === 0 ? lineStart : xs[i - 1]!;
        ys[i] = i === 0 ? 0 : ys[i - 1]! + (newline ? lineHeight : 0);
      }
      if (i > 0 && text[i - 1] === '\n') lineStart = xs[i]!;
    }
    return { x: xs.map((x) => x / ratio[0]!), y: ys.map((y) => y / ratio[1]!), lineHeight: lineHeight / ratio[1]! };
  }

  /** 虚拟坐标里的点离哪个下标最近（先找行，再找行里最近的位置）。 */
  #indexAt(point: readonly [number, number]): number {
    const boundaries = this.textBoundaries();
    if (!boundaries) return 0;
    const [left, top] = this.textRegionBounds();
    const x = point[0] - left, y = point[1] - top;
    const line = Math.max(0, Math.floor(y / boundaries.lineHeight)) * boundaries.lineHeight;
    let best = 0, bestDistance = Infinity;
    boundaries.x.forEach((bx, i) => {
      const lineDistance = Math.abs(boundaries.y[i]! - line);
      const distance = lineDistance * 1e6 + Math.abs(bx - x);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = i;
      }
    });
    return best;
  }

  // ---- 布局 ----
  calculateTextSize(): Vec2 {
    return textSize(this, this.#font, this.textToDisplay, this.actualTextSize);
  }

  /** 想要的大小：文字的大小，高度在 minLines 到 maxLines 行之间，加上内边距。 */
  protected override measureOverride(): Vec2 {
    let desired: Vec2 = [0, 0];
    const font = this.#font;
    this.#measuredVersion = font?.layoutVersion ?? -1;
    if (font) {
      let lineSpacing = font.totalLineSpacing(this.actualTextSize);
      if (font.kind === 'sdf') lineSpacing *= this.actualTextSize / font.size;
      const size = this.calculateTextSize();
      desired = [size[0], Math.min(Math.max(size[1], lineSpacing * this.#minLines), lineSpacing * this.#maxLines)];
    }
    return sizeWithThickness(desired, this.padding);
  }

  protected override onUpdate(elapsedSeconds: number): void {
    this.#caretTime += elapsedSeconds;
    const font = this.#font;
    if (font && font.layoutVersion !== this.#measuredVersion) this.invalidateMeasure();
  }

  protected override arrangeOverride(finalSize: Vec2): Vec2 {
    return [Math.max(finalSize[0], this.desiredSize[0]), Math.max(finalSize[1], this.desiredSize[1])];
  }
}

/** 一行在区域里的起点（空行用：左对齐是 0，居中在中间，右对齐在右边）。 */
function alignedLineStart(alignment: TextAlignment, width: number): number {
  return alignment === 'left' ? 0 : alignment === 'center' ? Math.round(width / 2) : width;
}
