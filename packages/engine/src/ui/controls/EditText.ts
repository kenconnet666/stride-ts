/**
 * 输入框（Stride 的 EditText）：布局和属性照 Stride；编辑（键盘、输入法、选中、复制粘贴）由 UI 输入接一个隐藏的
 * DOM 输入框做（step 4，见 docs/roadmap.md 的 GameMenu）。
 */
import type { SpriteFont } from '../../rendering/text/SpriteFont';
import type { TextAlignment } from '../../rendering/text/layout';
import { sizeWithThickness, type Color, type Vec2 } from '../UIElement';
import type { SpriteProvider } from '../sprites';
import { Control } from './ContentControl';
import { textSize } from './TextBlock';

/** 输入类型（Stride 的 InputTypeFlags）：password 显示成圆点。 */
export type EditTextInputType = 'none' | 'password';

const LIGHT: Color = [240 / 255, 240 / 255, 240 / 255, 1];

export class EditText extends Control {
  #text = '';
  #font: SpriteFont | null = null;
  #textSize = NaN;
  #minLines = 1;
  #maxLines = Number.MAX_SAFE_INTEGER;
  #maxLength = Number.MAX_SAFE_INTEGER;
  textColor: Color = LIGHT;
  textAlignment: TextAlignment = 'left';
  activeImage: SpriteProvider | null = null;
  inactiveImage: SpriteProvider | null = null;
  mouseOverImage: SpriteProvider | null = null;
  caretColor: Color = LIGHT;
  caretWidth = 1;
  /** 光标每秒闪几次。 */
  caretFrequency = 1;
  selectionColor: Color = [0x80 / 255, 0xb4 / 255, 0xd5 / 255, 1];
  imeSelectionColor: Color = [0x80 / 255, 0xff / 255, 0xf0 / 255, 1];
  isReadOnly = false;
  inputType: EditTextInputType = 'none';
  doNotSnapText = false;
  synchronousCharacterGeneration = false;
  /** 正在编辑（有焦点）。 */
  isSelectionActive = false;
  /** 指针在输入框上（UI 输入设）。 */
  isMouseOver = false;

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
    this.invalidateMeasure();
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

  /** 画出来的文字（密码显示成圆点）。 */
  get textToDisplay(): string {
    return this.inputType === 'password' ? '•'.repeat([...this.#text].length) : this.#text;
  }

  /** 现在该画的图：编辑中、悬停、平时。 */
  get backgroundImage(): SpriteProvider | null {
    return this.isSelectionActive ? this.activeImage : this.isMouseOver && this.mouseOverImage ? this.mouseOverImage : this.inactiveImage;
  }

  calculateTextSize(): Vec2 {
    return textSize(this, this.#font, this.textToDisplay, this.actualTextSize);
  }

  /** 想要的大小：文字的大小，高度在 minLines 到 maxLines 行之间，加上内边距。 */
  protected override measureOverride(): Vec2 {
    let desired: Vec2 = [0, 0];
    const font = this.#font;
    if (font) {
      let lineSpacing = font.totalLineSpacing(this.actualTextSize);
      if (font.kind === 'sdf') lineSpacing *= this.actualTextSize / font.size;
      const size = this.calculateTextSize();
      desired = [size[0], Math.min(Math.max(size[1], lineSpacing * this.#minLines), lineSpacing * this.#maxLines)];
    }
    return sizeWithThickness(desired, this.padding);
  }

  protected override arrangeOverride(finalSize: Vec2): Vec2 {
    return [Math.max(finalSize[0], this.desiredSize[0]), Math.max(finalSize[1], this.desiredSize[1])];
  }
}
