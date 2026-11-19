/**
 * 文字（Stride 的 TextBlock）：大小按字体量（字号乘 真实 / 虚拟 的比例去量，运行时字体再除回虚拟像素，同 Stride），
 * 可以按宽度自动换行（WrapText）。
 */
import { measureText, type TextAlignment } from '../../rendering/text/layout';
import type { SpriteFont } from '../../rendering/text/SpriteFont';
import { clamp, UIElement, type Color, type Vec2 } from '../UIElement';

export type { TextAlignment };

/** 用 font 量 text 的大小，虚拟像素（TextBlock、EditText 的 CalculateTextSize）。 */
export function textSize(element: UIElement, font: SpriteFont | null, text: string, actualTextSize: number): Vec2 {
  if (!font) return [0, 0];
  const ratio = element.layoutingContext?.realVirtualResolutionRatio ?? [1, 1];
  // 不要字的宽高比例不一样：两维都用纵向的比例
  const fontSize = ratio[1] * actualTextSize;
  const size = measureText(font, text, [fontSize, fontSize]);
  if (font.kind === 'dynamic') return [size[0] / ratio[0], size[1] / ratio[1]];
  if (font.kind === 'sdf') {
    const scale = actualTextSize / font.size;
    return [size[0] * scale, size[1] * scale];
  }
  return size;
}

export class TextBlock extends UIElement {
  #text: string | null = null;
  #font: SpriteFont | null = null;
  #textSize = NaN;
  #wrapText = false;
  #wrappedText = '';
  /** 上次量的时候字体下载完了几块：字形是按块下载的，下完新的块文字的大小会变，要重新量。 */
  #measuredBlocks = -1;
  /** 文字颜色（sRGB），默认 Stride 的 0xF0F0F0。 */
  textColor: Color = [240 / 255, 240 / 255, 240 / 255, 1];
  /** 描边（Stride 的 OutlineColor、OutlineThickness；还不画）。 */
  outlineColor: Color = [0, 0, 0, 1];
  outlineThickness = 0;
  textAlignment: TextAlignment = 'left';
  /** 不把文字对齐到真实像素。 */
  doNotSnapText = false;
  /** Stride 里让运行时字体同步生成字形；我们的字形是轮廓，不需要，留着兼容页面。 */
  synchronousCharacterGeneration = false;

  get text(): string | null { return this.#text; }
  set text(value: string | null) {
    if (value === this.#text) return;
    this.#text = value;
    this.invalidateMeasure();
  }

  get font(): SpriteFont | null { return this.#font; }
  set font(value: SpriteFont | null) {
    if (value === this.#font) return;
    this.#font = value;
    this.invalidateMeasure();
  }

  /** 字号，虚拟像素；NaN（没设）时用字体的字号。 */
  get textSize(): number { return this.#textSize; }
  set textSize(value: number) {
    const clamped = clamp(value, 0, Number.MAX_VALUE);
    if (Object.is(clamped, this.#textSize)) return;
    this.#textSize = clamped;
    this.invalidateMeasure();
  }

  get actualTextSize(): number {
    return !Number.isNaN(this.#textSize) ? this.#textSize : this.#font?.size ?? 0;
  }

  get wrapText(): boolean { return this.#wrapText; }
  set wrapText(value: boolean) {
    if (value === this.#wrapText) return;
    this.#wrapText = value;
    this.invalidateMeasure();
  }

  /** 画出来的文字（换行时插了换行符）。 */
  get textToDisplay(): string {
    return this.#wrapText ? this.#wrappedText : this.#text ?? '';
  }

  /** 文字的大小，虚拟像素。 */
  calculateTextSize(text = this.textToDisplay): Vec2 {
    return textSize(this, this.#font, text, this.actualTextSize);
  }

  protected override measureOverride(available: Vec2): Vec2 {
    this.#measuredBlocks = this.#font?.loadedBlocks ?? -1;
    if (this.#wrapText) this.#updateWrappedText(available[0]);
    return this.calculateTextSize();
  }

  protected override onUpdate(): void {
    const font = this.#font;
    if (!font) return;
    if (font.loadedBlocks !== this.#measuredBlocks) this.invalidateMeasure();
  }

  protected override arrangeOverride(finalSize: Vec2): Vec2 {
    if (this.#wrapText) this.#updateWrappedText(finalSize[0]);
    return finalSize;
  }

  /** 按宽度换行（Stride 的 UpdateWrappedText）：在最后一个空白处断开，一行里没有空白时按字断开。 */
  #updateWrappedText(availableWidth: number): void {
    const text = [...(this.#text ?? '')];
    if (text.length === 0) {
      this.#wrappedText = '';
      return;
    }
    let result = '';
    let line: string[] = [];
    let lineStart = 0;
    for (;;) {
      let width = 0;
      let next = 0;
      let lastSpace = -1;
      let character = text[0]!;
      let newLine = false;
      for (;;) {
        width = this.calculateTextSize(line.join(''))[0];
        if (width > availableWidth || lineStart + next >= text.length) break;
        character = text[lineStart + next]!;
        if (character === '\n') {
          lineStart += next + 1;
          newLine = true;
          break;
        }
        line.push(character);
        if (/\s/u.test(character)) lastSpace = next;
        next++;
      }
      if (!newLine) {
        if (width <= availableWidth) {
          result += line.join('');
          break;
        }
        if (line.length <= 1 || width <= 0) {
          line = [character];
          lineStart += next;
        } else if (lastSpace < 0) {
          line.pop();
          lineStart += next - 1;
        } else {
          if (next > lastSpace) line.splice(lastSpace, next - lastSpace);
          lineStart += lastSpace + 1;
        }
      }
      result += line.join('') + '\n';
      line = [];
    }
    this.#wrappedText = result;
  }
}
