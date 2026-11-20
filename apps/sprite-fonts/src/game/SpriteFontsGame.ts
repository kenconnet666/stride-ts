// SpriteFonts：没有场景，按游戏设置启动——合成器的根是 FontRenderer（只用 SpriteBatch 画字），属性里的字体和背景图随游戏设置
// 导入、加载。第九屏的富文本是 UI（RichTextScreen.ts），链接换屏。
import { Game } from '@stride-ts/engine';
import { FontRenderer } from './FontRenderer';
import { createRichTextScreen, RICH_TEXT } from './RichTextScreen';

export const GAME_SETTINGS = 'SpriteFonts/Shared/GameSettings';

export class SpriteFontsGame extends Game {
  protected override async loadContent(): Promise<void> {
    await this.loadGameSettings(GAME_SETTINGS, { renderers: { [FontRenderer.typeName]: (props) => FontRenderer.create(props) } });
    const renderer = this.rootRenderer as FontRenderer;
    const { dynamicFont, boldFont, italicFont } = renderer.assets;
    const fonts = { regular: dynamicFont, bold: boldFont, italic: italicFont };
    await Promise.all(Object.values(fonts).map((font) => font.ensure(RICH_TEXT)));
    renderer.richText = createRichTextScreen(this, fonts, (href) => renderer.step(href === 'prev' ? -1 : 1)).root;
  }
}
