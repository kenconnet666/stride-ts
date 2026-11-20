// 第九屏（Stride 的 SpriteFonts 没有）：UI 里的富文本（RichTextBlock，源文是 Markdown）。粗体、斜体用这个样例自带的粗体、
// 斜体字体，粗斜体由粗体合成；颜色、字号、下划线是方括号属性。链接"上一屏""下一屏"是 LinkClicked 事件。
import { Grid, RichTextBlock, UIComponent, UIPage, type Game, type SpriteFont } from '@stride-ts/engine';

export const RICH_TEXT = `### Inline styles
Mix **bold**, *italic*, ***bold italic***, ~~strikethrough~~ and \`inline code\` in one line.

Colors, sizes and underlines are bracketed spans: [orange]{color=#ff8800}, [big]{size=150%}, [small]{size=70%}, [underlined]{.underline}.

- Lines wrap at the box width and align like a TextBlock
- Links raise routed events: [previous screen](prev) · [next screen](next)
  - Nested items are indented one level more`;

export interface RichTextFonts {
  readonly regular: SpriteFont;
  readonly bold: SpriteFont;
  readonly italic: SpriteFont;
}

/** 建一个全屏 UI（1920x1080，同 FontRenderer 的虚拟分辨率），中间一块宽 1400 的富文本；返回根元素和文字。 */
export function createRichTextScreen(game: Game, fonts: RichTextFonts, onLink: (href: string) => void): { root: Grid; text: RichTextBlock } {
  const text = Object.assign(new RichTextBlock(), {
    text: RICH_TEXT, font: fonts.regular, boldFont: fonts.bold, italicFont: fonts.italic, textSize: 46, wrapText: true, width: 1400,
    horizontalAlignment: 'center' as const, verticalAlignment: 'top' as const, margin: [0, 400, 0, 0] as const, name: 'RichText',
  });
  text.onLinkClick(onLink);
  const root = new Grid();
  root.children.add(text);
  const entity = game.entities.create({ name: 'RichText' });
  entity.add(UIComponent.with({ page: new UIPage('RichText', root), resolution: [1920, 1080, 1000], resolutionStretch: 'fixedWidthFixedHeight' }));
  return { root, text };
}
