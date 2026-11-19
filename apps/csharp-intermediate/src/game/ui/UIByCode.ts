// CSharpIntermediate 的 UIByCode：用代码建一个 UI 页面（右下角的面板里一个按钮、一行字），点按钮把现在的时间写到字上。
// 和 Stride 不同：字体是异步加载的（Content.Load 是同步的），加载好了才建页面。
import { Button, StackPanel, StartupScript, TextBlock, UIComponent, UIPage, type SpriteFont } from '@stride-ts/engine';

const FONT = 'CSharpIntermediate/UI/OpenSans-font';
// Stride 的 Color.DarkKhaki、Black、Yellow、OrangeRed（sRGB）
const DARK_KHAKI = [189 / 255, 183 / 255, 107 / 255, 1] as const;
const BLACK = [0, 0, 0, 1] as const;
const YELLOW = [1, 1, 0, 1] as const;
const ORANGE_RED = [1, 69 / 255, 0, 1] as const;

/** C# 的 DateTime.ToShortTimeString()（不变区域：HH:mm）。 */
const shortTime = (date: Date) => `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;

export class UIByCode extends StartupScript {
  override start(): void {
    void this.game.content.loadFont(FONT).then((font) => {
      // 加载完之前教程已经换走了
      if (this.attached) this.#build(font);
    });
  }

  #build(font: SpriteFont): void {
    const textBlock = Object.assign(new TextBlock(), {
      name: 'TextBlockByCode', text: '...', font, textColor: YELLOW, backgroundColor: ORANGE_RED, horizontalAlignment: 'center' as const,
    });
    const button = Object.assign(new Button(), {
      name: 'ButtonByCode',
      horizontalAlignment: 'center' as const,
      backgroundColor: DARK_KHAKI,
      content: Object.assign(new TextBlock(), { text: 'Show me the time!', font, textSize: 16, textColor: BLACK, verticalAlignment: 'center' as const }),
    });
    button.onClick(() => (textBlock.text = `Date: ${shortTime(new Date())}`));

    const root = Object.assign(new StackPanel(), {
      height: 200,
      width: 400,
      margin: [0, 0, 10, 10] as const,
      verticalAlignment: 'bottom' as const,
      horizontalAlignment: 'right' as const,
      // Stride 的 new Color(0, 1, 0, 0.1f)
      backgroundColor: [0, 1, 0, 0.1] as const,
    });
    root.children.add(button);
    root.children.add(textBlock);
    const page = new UIPage('UIByCode', root);
    // Stride 的 Entity.GetOrCreate<UIComponent>()
    const ui = this.entity.get(UIComponent);
    if (ui) ui.page = page;
    else this.entity.add(UIComponent.with({ page }));
  }
}
