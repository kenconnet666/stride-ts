// JumpyJet 的 UIScript：三个页面——主菜单（标志和"Touch to Start"）、游戏中（左上角的分数）、结束（Menu 和 Retry）；
// 点按钮广播开始、重置事件并换页面，过一组管子加一分，结束时分数清零、换到结束页面。
import {
  Button, Canvas, ContentDecorator, ImageElement, ModalElement, prop, SpriteFromSheet, SyncScript, TextBlock, UIComponent, UIPage,
  type SpriteFont, type SpriteProvider, type SpriteSheet, type UIElement,
} from '@stride-ts/engine';
import { GameOverEventKey, GameResetEventKey, GameStartedEventKey, PipePassedEventKey } from './GameGlobals';

const BLACK = [0, 0, 0, 1] as const;
const CENTER = [0.5, 0.5] as const;

export class UIScript extends SyncScript.props({
  font: prop.asset('font').optional(),
  uiImages: prop.asset('spriteSheet').optional(),
}) {
  #gameOver = this.receive(GameOverEventKey);
  #pipePassed = this.receive(PipePassedEventKey);
  #mainMenuRoot!: ModalElement;
  #gameRoot!: Canvas;
  #gameOverRoot!: ModalElement;
  #scoreTextBlock!: TextBlock;
  #currentScore = 0;

  override start(): void {
    const font = this.font, images = this.uiImages;
    if (!font || !images) throw new Error('JumpyJet: UIScript needs Font and UIImages');
    const buttonImage = SpriteFromSheet.create(images, 'button');
    this.#createMainMenuUI(font, images, buttonImage);
    this.#createGameUI(font, images);
    this.#createGameOverUI(font, buttonImage);
    this.startMainMenuMode();
    this.disposables.use(this.game.debug.command('start-game', 'start playing (the "Touch to Start" button)', () => this.#startGame()));
  }

  override update(): void {
    if (this.#pipePassed.tryConsume()) this.#currentScore++;
    if (this.#gameOver.tryConsume()) {
      this.#currentScore = 0;
      this.#show(this.#gameOverRoot);
    }
    // Stride 的 "Score : {0,2}"：分数右对齐占两位
    this.#scoreTextBlock.text = `Score : ${String(this.#currentScore).padStart(2)}`;
  }

  startMainMenuMode(): void {
    this.#show(this.#mainMenuRoot);
  }

  startGameMode(): void {
    this.#show(this.#gameRoot);
  }

  #startGame(): void {
    GameStartedEventKey.broadcast();
    this.startGameMode();
  }

  #show(root: UIElement): void {
    this.entity.require(UIComponent).page = new UIPage('JumpyJet', root);
  }

  #createMainMenuUI(font: SpriteFont, images: SpriteSheet, buttonImage: SpriteProvider): void {
    const logo = new ImageElement();
    logo.source = SpriteFromSheet.create(images, 'sd_logo');
    logo.canvasPinOrigin = CENTER;
    logo.canvasRelativeSize = [0.75, 0.5];
    logo.canvasRelativePosition = [0.5, 0.3];

    const startButton = textButton(font, 'Touch to Start', buttonImage, [77, 30, 25, 30], 250);
    startButton.canvasRelativePosition = [0.5, 0.7];
    startButton.onClick(() => this.#startGame());

    this.#mainMenuRoot = modal(logo, startButton);
  }

  #createGameUI(font: SpriteFont, images: SpriteSheet): void {
    const score = (this.#scoreTextBlock = new TextBlock());
    score.font = font;
    score.textColor = BLACK;
    score.verticalAlignment = 'center';
    score.canvasPinOrigin = CENTER;
    score.canvasRelativePosition = [0.2, 0.05];

    const scoreBoard = new ContentDecorator();
    scoreBoard.backgroundImage = SpriteFromSheet.create(images, 'score_bg');
    scoreBoard.content = score;
    scoreBoard.padding = [60, 31, 25, 35];
    // 最小宽度让分数变化时计分板不跟着变宽
    scoreBoard.minimumWidth = 190;

    this.#gameRoot = new Canvas();
    this.#gameRoot.children.add(scoreBoard);
  }

  #createGameOverUI(font: SpriteFont, buttonImage: SpriteProvider): void {
    const menuButton = textButton(font, 'Menu', buttonImage, [77, 30, 25, 30], 190);
    menuButton.canvasRelativePosition = [0.7, 0.7];
    menuButton.onClick(() => {
      GameResetEventKey.broadcast();
      this.startMainMenuMode();
    });

    const retryButton = textButton(font, 'Retry', buttonImage, [74, 30, 25, 30], 190);
    retryButton.canvasRelativePosition = [0.3, 0.7];
    retryButton.onClick(() => {
      GameResetEventKey.broadcast();
      GameStartedEventKey.broadcast();
      this.startGameMode();
    });

    this.#gameOverRoot = modal(menuButton, retryButton);
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
