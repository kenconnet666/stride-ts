// SpaceEscape 的 UIScript：三个页面——主菜单（标志和"Touch to Start"）、游戏中（左上角的距离）、结束（Menu 和 Retry）。按钮的
// 点击由 GameScript 接上。界面第一次用到时才建：场景里 GameScript 排在 UI 前面，它的 start 先跑，要拿这里的按钮。
import {
  Button, Canvas, ContentDecorator, ImageElement, ModalElement, prop, SpriteFromSheet, StartupScript, TextBlock, UIComponent, UIPage,
  type SpriteFont, type SpriteProvider, type UIElement,
} from '@stride-ts/engine';

const BLACK = [0, 0, 0, 1] as const;
// Stride 的 Color.Gold（sRGB 的 255, 215, 0）
const GOLD = [1, 215 / 255, 0, 1] as const;
const CENTER = [0.5, 0.5] as const;

interface Pages {
  readonly mainMenu: ModalElement;
  readonly game: Canvas;
  readonly gameOver: ModalElement;
  readonly distance: TextBlock;
  readonly startButton: Button;
  readonly menuButton: Button;
  readonly retryButton: Button;
}

export class UIScript extends StartupScript.props({
  font: prop.asset('font').optional(),
  uiImages: prop.asset('spriteSheet').optional(),
}) {
  #pages: Pages | undefined;

  get startButton(): Button {
    return this.#built.startButton;
  }

  get menuButton(): Button {
    return this.#built.menuButton;
  }

  get retryButton(): Button {
    return this.#built.retryButton;
  }

  override start(): void {
    void this.#built;
  }

  startMainMenuMode(): void {
    this.#show(this.#built.mainMenu);
  }

  startPlayMode(): void {
    this.#show(this.#built.game);
  }

  startGameOverMode(): void {
    this.#show(this.#built.gameOver);
  }

  /** Stride 的 "Distance : {0,6}"：距离右对齐占六位。 */
  setDistance(distance: number): void {
    this.#built.distance.text = `Distance : ${String(distance).padStart(6)}`;
  }

  #show(root: UIElement): void {
    this.entity.require(UIComponent).page = new UIPage('SpaceEscape', root);
  }

  get #built(): Pages {
    return (this.#pages ??= this.#build());
  }

  #build(): Pages {
    const font = this.font, images = this.uiImages;
    if (!font || !images) throw new Error('SpaceEscape: UIScript needs Font and UIImages');
    const buttonImage = SpriteFromSheet.create(images, 'button');

    const logo = new ImageElement();
    logo.source = SpriteFromSheet.create(images, 'sd_logo');
    logo.canvasPinOrigin = CENTER;
    logo.canvasRelativeSize = [0.8, 0.5];
    logo.canvasRelativePosition = [0.5, 0.3];
    const startButton = textButton(font, 'Touch to Start', buttonImage, [80, 27, 25, 35], 250);
    startButton.canvasRelativePosition = [0.5, 0.8];

    const distance = new TextBlock();
    distance.font = font;
    distance.textColor = GOLD;
    distance.verticalAlignment = 'center';
    distance.canvasPinOrigin = CENTER;
    distance.canvasRelativePosition = [0.2, 0.05];
    const scoreBoard = new ContentDecorator();
    scoreBoard.backgroundImage = SpriteFromSheet.create(images, 'distance_bg');
    scoreBoard.content = distance;
    scoreBoard.padding = [60, 31, 25, 35];
    // 最小宽度让距离变化时计分板不跟着变宽
    scoreBoard.minimumWidth = 290;
    const game = new Canvas();
    game.children.add(scoreBoard);

    const menuButton = textButton(font, 'Menu', buttonImage, [77, 29, 25, 35], 190);
    menuButton.canvasRelativePosition = [0.7, 0.7];
    const retryButton = textButton(font, 'Retry', buttonImage, [74, 29, 25, 35], 190);
    retryButton.canvasRelativePosition = [0.3, 0.7];
    const gameOver = modal(menuButton, retryButton);
    gameOver.minimumWidth = 200;

    return { mainMenu: modal(logo, startButton), game, gameOver, distance, startButton, menuButton, retryButton };
  }
}

/** 三种状态都用同一张图、内容是居中黑字的按钮，中心对准 Canvas 上的位置。 */
function textButton(font: SpriteFont, text: string, image: SpriteProvider, padding: [number, number, number, number], minimumWidth: number): Button {
  const label = new TextBlock();
  label.font = font;
  label.text = text;
  label.textColor = BLACK;
  label.horizontalAlignment = 'center';
  label.verticalAlignment = 'center';
  const button = new Button();
  button.content = label;
  button.notPressedImage = image;
  button.pressedImage = image;
  button.mouseOverImage = image;
  button.padding = padding;
  button.minimumWidth = minimumWidth;
  button.canvasPinOrigin = CENTER;
  return button;
}

/** 铺满的模态层，里面一个 Canvas 放这些元素（模态层挡住下面的点击）。 */
function modal(...children: UIElement[]): ModalElement {
  const canvas = new Canvas();
  for (const child of children) canvas.children.add(child);
  const root = new ModalElement();
  root.horizontalAlignment = 'stretch';
  root.verticalAlignment = 'stretch';
  root.content = canvas;
  return root;
}

