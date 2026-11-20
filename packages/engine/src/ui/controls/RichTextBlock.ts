/**
 * 富文本（Stride 没有）：text 是 Markdown 源文（写法见 rendering/text/markdown.ts），一段文字里可以有粗体、斜体、行内代码、
 * 链接、标题、列表，颜色、字号、下划线用 `[文字]{color=#f80 size=120% .underline}`。字号、颜色、对齐、换行、描边这些照
 * TextBlock；粗体、斜体、代码优先用给的同族字体（boldFont 这些），没给时由 font 合成。
 *
 * 链接：指针在链接上按下、在同一个链接上松开时发 LinkClicked（冒泡，`onLinkClick((href) => …)`）；只有链接点得到，文字的
 * 其余部分不挡游戏和后面元素的输入。影子 DOM 里链接是可以 Tab 到、按 Enter 的节点（见 SemanticsLayer）。
 *
 * 和 TextBlock 不同：不能用鼠标拖着选中（isSelectable 不起作用；全选、查找、读屏照常）。
 */
import { parseMarkdown, plainText, type RichDocument, type RichStyle } from '../../rendering/text/markdown';
import { layoutRichText, lineOffset, type RichTextLayout } from '../../rendering/text/richLayout';
import type { SpriteFont } from '../../rendering/text/SpriteFont';
import { RoutedEvent, RoutedEventArgs, type TouchEventArgs } from '../events';
import type { Color, Vec2 } from '../UIElement';
import { TextBlock } from './TextBlock';

/** 点了哪个链接。 */
export class LinkEventArgs extends RoutedEventArgs {
  /** 链接的地址（Markdown 里 `(…)` 写的）。 */
  href = '';
  /** 第几个链接（按出现的顺序）。 */
  index = -1;
}

export class RichTextBlock extends TextBlock {
  /** 点了链接（冒泡）：`text.addHandler(RichTextBlock.linkClickedEvent, (sender, args) => args.href)`。 */
  static readonly linkClickedEvent = new RoutedEvent<LinkEventArgs>('LinkClicked', 'bubble');
  /** 链接的颜色（sRGB）。 */
  linkColor: Color = [0.4, 0.7, 1, 1];
  /** 行内代码的颜色和底色（sRGB，同 UI 的其他颜色是预乘 alpha 的）。 */
  codeColor: Color = [1, 0.8, 0.55, 1];
  codeBackgroundColor: Color = [0.12, 0.12, 0.12, 0.12];
  #boldFont: SpriteFont | null = null;
  #italicFont: SpriteFont | null = null;
  #boldItalicFont: SpriteFont | null = null;
  #codeFont: SpriteFont | null = null;
  #parsed: { source: string; document: RichDocument } | undefined;
  #layout: RichTextLayout | undefined;
  /** 上次排版的换行宽度和依据（见 #key；字形下完新的块要重排）。 */
  #wrapWidth: number | undefined;
  #layoutKey = '';
  #pressedLink = -1;

  /** 粗体、斜体、粗斜体、代码用的字体；null 时用 font（粗体、斜体合成）。 */
  get boldFont(): SpriteFont | null { return this.#boldFont; }
  set boldFont(value: SpriteFont | null) { this.#setFont(() => (this.#boldFont = value), this.#boldFont, value); }
  get italicFont(): SpriteFont | null { return this.#italicFont; }
  set italicFont(value: SpriteFont | null) { this.#setFont(() => (this.#italicFont = value), this.#italicFont, value); }
  get boldItalicFont(): SpriteFont | null { return this.#boldItalicFont; }
  set boldItalicFont(value: SpriteFont | null) { this.#setFont(() => (this.#boldItalicFont = value), this.#boldItalicFont, value); }
  get codeFont(): SpriteFont | null { return this.#codeFont; }
  set codeFont(value: SpriteFont | null) { this.#setFont(() => (this.#codeFont = value), this.#codeFont, value); }

  /** 解析好的文档（text 变了才重新解析）。 */
  get document(): RichDocument {
    const source = this.text ?? '';
    if (this.#parsed?.source !== source) this.#parsed = { source, document: parseMarkdown(source) };
    return this.#parsed.document;
  }

  /** 上次布局排好的样子；还没布局、没有字体时是 undefined。 */
  get richLayout(): RichTextLayout | undefined {
    return this.#layout;
  }

  /** 去掉标记的纯文字（读屏、复制用）。 */
  override get textToDisplay(): string {
    return plainText(this.document);
  }

  /** 登记点链接的处理函数（addHandler(RichTextBlock.linkClickedEvent, ...) 的简写）。 */
  onLinkClick(handler: (href: string, sender: RichTextBlock) => void): void {
    this.addHandler(RichTextBlock.linkClickedEvent, (sender, args) => handler(args.href, sender as RichTextBlock));
  }

  /** 用代码点第 index 个链接（影子 DOM 的点击、Enter 也走这里）：发 LinkClicked。停用的不发。 */
  activateLink(index: number): void {
    const link = this.document.links[index];
    if (!link || !this.isHierarchyEnabled) return;
    const args = new LinkEventArgs(RichTextBlock.linkClickedEvent);
    args.href = link.href;
    args.index = index;
    this.raiseEvent(args);
  }

  /**
   * 一段文字画什么颜色（sRGB，预乘 alpha）：写了的颜色，否则链接、代码、普通文字各自的颜色。Markdown 里写的颜色是
   * 不预乘的（同 CSS），这里乘上。
   */
  colorOf(style: RichStyle): Color {
    const written = style.color;
    if (written) return [written[0] * written[3], written[1] * written[3], written[2] * written[3], written[3]];
    return style.link !== undefined ? this.linkColor : style.code ? this.codeColor : this.textColor;
  }

  /** 虚拟坐标里的点落在第几个链接上；不在链接上时是 -1。 */
  linkAt(point: readonly [number, number]): number {
    const layout = this.#layout;
    const local = this.#toLocal(point);
    if (!layout || !local) return -1;
    const [x, y] = local;
    for (const area of layout.linkAreas) {
      const left = area.x + lineOffset(layout.lines[area.line]!, this.textAlignment, this.renderSize[0]);
      if (x >= left && x <= left + area.width && y >= area.y && y <= area.y + area.height) return area.link;
    }
    return -1;
  }

  /** 只有链接点得到。 */
  override intersects(point: readonly [number, number]): boolean {
    return this.linkAt(point) >= 0;
  }

  protected override measureOverride(available: Vec2): Vec2 {
    return this.#relayout(this.wrapText ? available[0] : undefined);
  }

  protected override arrangeOverride(finalSize: Vec2): Vec2 {
    if (this.wrapText) this.#relayout(finalSize[0]);
    return finalSize;
  }

  protected override onUpdate(_elapsedSeconds: number): void {
    // 字形按块下载，下完新的块（或者开关字距）要重新排
    if (this.#layout && this.#layoutKey !== this.#key(this.#wrapWidth)) this.invalidateMeasure();
  }

  protected override onTouchDown(args: TouchEventArgs): void {
    super.onTouchDown(args);
    this.#pressedLink = this.linkAt(args.worldPosition);
  }

  protected override onTouchUp(args: TouchEventArgs): void {
    super.onTouchUp(args);
    const link = this.linkAt(args.worldPosition);
    if (link >= 0 && link === this.#pressedLink) this.activateLink(link);
    this.#pressedLink = -1;
  }

  protected override onTouchLeave(args: TouchEventArgs): void {
    super.onTouchLeave(args);
    this.#pressedLink = -1;
  }

  /** 按 wrapWidth（虚拟像素；undefined 是不按宽度换行）排版，返回大小。 */
  #relayout(wrapWidth: number | undefined): Vec2 {
    const font = this.font;
    if (!font) {
      this.#layout = undefined;
      this.canBeHitByUser = false;
      return [0, 0];
    }
    const key = this.#key(wrapWidth);
    if (!this.#layout || key !== this.#layoutKey) {
      const ratio = this.layoutingContext?.realVirtualResolutionRatio ?? [1, 1];
      this.#layout = layoutRichText(this.document, { regular: font, bold: this.#boldFont, italic: this.#italicFont, boldItalic: this.#boldItalicFont, code: this.#codeFont }, {
        fontSize: this.actualTextSize, pixelRatio: ratio[1], wrapWidth,
      });
      this.#layoutKey = key;
      this.#wrapWidth = wrapWidth;
      this.canBeHitByUser = this.#layout.linkAreas.length > 0;
    }
    return [this.#layout.size[0], this.#layout.size[1]];
  }

  /** 排版结果取决于的东西：换行宽度、源文、字号、像素比、各字体的排版版本。 */
  #key(wrapWidth: number | undefined): string {
    const ratio = this.layoutingContext?.realVirtualResolutionRatio ?? [1, 1];
    const versions = [this.font, this.#boldFont, this.#italicFont, this.#boldItalicFont, this.#codeFont].map((font) => font?.layoutVersion ?? '-').join(',');
    return `${wrapWidth ?? ''}|${this.actualTextSize}|${ratio[1]}|${versions}|${this.text ?? ''}`;
  }

  #setFont(assign: () => void, previous: SpriteFont | null, value: SpriteFont | null): void {
    if (previous === value) return;
    assign();
    this.invalidateMeasure();
  }

  /** 虚拟坐标换到元素的局部坐标（左上角是原点）。 */
  #toLocal(point: readonly [number, number]): [number, number] | undefined {
    const [a, b, c, d, e, f] = this.worldMatrix;
    const determinant = a * d - b * c;
    if (determinant === 0) return undefined;
    const x = point[0] - e, y = point[1] - f;
    return [(d * x - c * y) / determinant + this.renderSize[0] / 2, (a * y - b * x) / determinant + this.renderSize[1] / 2];
  }
}
