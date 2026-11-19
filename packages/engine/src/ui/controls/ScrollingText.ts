/**
 * 滚动的文字（Stride 的 ScrollingText）：一行字从右边进来、往左滚出去，像跑马灯。宽度按 desiredCharacterNumber 个字算，
 * 速度是每秒多少虚拟像素；repeatText 时滚完接着从头再来。appendText 往后接字，不打断正在滚的；直接改 text 则从头滚起。
 *
 * 和 Stride 不同：
 * - 滚出左边的字从要画的那串里去掉。Stride 里去字的那个循环条件写反了，实际从不去字，重复滚动时那串字越来越长、偏移越来越负。
 * - 不重复的文字全滚出去以后，appendText 接上的字从右边进来。Stride 把它们接在早已滚出去的那串后面，要等接上的字比空出来的
 *   那段还长才看得见。
 */
import type { Vec2 } from '../UIElement';
import { TextBlock } from './TextBlock';

export class ScrollingText extends TextBlock {
  #textToDisplay = '';
  #elementWidth = 0;
  #nextLetterIndex = 0;
  #textHasBeenAppended = false;
  #scrollingSpeed = 40;
  #desiredCharacterNumber = 10;
  #repeatText = true;
  #scrollingOffset = Infinity;
  #accumulatedWidth = 0;

  constructor() {
    super();
    // 字只画在元素的范围里
    this.clipToBounds = true;
    this.drawLayerNumber += 3;
  }

  /** 要画的那串字的左边离元素左边多远（虚拟像素）：从元素的宽度开始往下减，负的时候第一个字已经滚出去一部分。 */
  get scrollingOffset(): number { return this.#scrollingOffset; }
  /** 滚进来过的字一共有多宽。 */
  get accumulatedWidth(): number { return this.#accumulatedWidth; }

  /** 每秒滚多少虚拟像素（不小于 0）。 */
  get scrollingSpeed(): number { return this.#scrollingSpeed; }
  set scrollingSpeed(value: number) {
    if (!Number.isNaN(value)) this.#scrollingSpeed = Math.max(0, value);
  }

  /** 元素的宽度按多少个字（'A' 的宽）算。 */
  get desiredCharacterNumber(): number { return this.#desiredCharacterNumber; }
  set desiredCharacterNumber(value: number) {
    if (value === this.#desiredCharacterNumber) return;
    this.#desiredCharacterNumber = value;
    this.invalidateMeasure();
  }

  /** 滚完接着从头再来。 */
  get repeatText(): boolean { return this.#repeatText; }
  set repeatText(value: boolean) {
    if (value === this.#repeatText) return;
    this.#repeatText = value;
    this.#reset();
  }

  override get text(): string | null { return super.text; }
  override set text(value: string | null) {
    if (value === super.text) return;
    super.text = value;
    // 直接改文字：从头滚起；appendText 接上去的不打断
    if (!this.#textHasBeenAppended) this.#reset();
    this.#textHasBeenAppended = false;
  }

  /** 往后接字，正在滚的不受影响。 */
  appendText(text: string): void {
    this.#textHasBeenAppended = true;
    this.text = (this.text ?? '') + text;
  }

  clearText(): void {
    this.text = '';
  }

  override get textToDisplay(): string {
    return this.#textToDisplay;
  }

  /** 元素想要的大小：desiredCharacterNumber 个 'A' 那么宽。 */
  measureSize(): Vec2 {
    return this.font ? this.calculateTextSize('A'.repeat(this.#desiredCharacterNumber)) : [0, 0];
  }

  protected override onUpdate(elapsedSeconds: number): void {
    super.onUpdate(elapsedSeconds);
    if (this.isEnabled) this.#scroll(elapsedSeconds);
  }

  protected override measureOverride(): Vec2 {
    return this.measureSize();
  }

  protected override arrangeOverride(finalSize: Vec2): Vec2 {
    this.#elementWidth = finalSize[0];
    this.#scrollingOffset = Math.min(this.#elementWidth, this.#scrollingOffset);
    this.#scroll(0);
    return super.arrangeOverride(finalSize);
  }

  #reset(): void {
    this.#textToDisplay = '';
    this.#nextLetterIndex = 0;
    this.#scrollingOffset = this.isArrangeValid ? this.actualWidth : Infinity;
    this.#accumulatedWidth = 0;
  }

  /** 往左滚 elapsed 秒：右边不够了就从文字里接着取字，左边滚出去的字去掉。 */
  #scroll(elapsedSeconds: number): void {
    const text = [...(this.text ?? '')];
    if (text.length === 0 || !this.font || this.calculateTextSize(text.join(''))[0] <= Number.EPSILON) return;
    const width = (value: string) => this.calculateTextSize(value)[0];
    // 要画的那串的左边在元素左边以左多远
    let shift = elapsedSeconds * this.#scrollingSpeed - this.#scrollingOffset;
    const needed = shift + this.#elementWidth;
    let displayed = width(this.#textToDisplay);
    while (displayed < needed && this.#nextLetterIndex < text.length) {
      this.#textToDisplay += text[this.#nextLetterIndex++]!;
      const added = width(this.#textToDisplay) - displayed;
      this.#accumulatedWidth += added;
      if (this.#repeatText && this.#nextLetterIndex >= text.length) this.#nextLetterIndex = 0;
      displayed += added;
    }
    // 左边整个滚出去的字去掉（不重复时最后全滚出去，剩空串）
    let letters = [...this.#textToDisplay];
    while (letters.length > 0) {
      const rest = letters.slice(1).join('');
      const first = displayed - width(rest);
      if (first > shift) break;
      shift -= first;
      displayed -= first;
      letters = letters.slice(1);
    }
    this.#textToDisplay = letters.join('');
    // 字都滚出去、也没有可接的了：停在右边等着，之后 appendText 接上的字从右边进来
    this.#scrollingOffset = letters.length === 0 && this.#nextLetterIndex >= text.length ? this.#elementWidth : -shift;
  }
}
