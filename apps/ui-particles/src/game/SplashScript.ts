// UIParticles 的 SplashScript：用代码建全屏的 UI——背景图，Grid 里的标题、"重新开始"和"恭喜"两个按钮、底部的导火索；点按钮在
// 按钮上放命中特效的预制体（2 秒后移除）。两种状态：新游戏时导火索慢慢烧短，火（粒子系统 Fire）跟着烧到的位置走，烧完或点
// "恭喜"进入结束；结束时火停掉，大的彩纸（ConfettiBig）移到画面里放。正交相机的大小按窗口高度调，UI 的 600 像素是一个世界单位。
import {
  Button, Camera, ContentDecorator, Grid, ImageElement, ParticleSystemComponent, prop, SpriteFromSheet, StripDefinition, TextBlock, Transform,
  UIComponent, UIPage, UniformGrid, Canvas, type Entity, type SpriteFont, type SpriteFrame, type SpriteSheet, type UIElement,
} from '@stride-ts/engine';
import { UISceneBase } from './UISceneBase';

type GameState = 'none' | 'newGame' | 'endGame';

const VIRTUAL_WIDTH = 600;
const VIRTUAL_HEIGHT = 600;
const WHITE = [1, 1, 1, 1] as const;

export class SplashScript extends UISceneBase.props({
  westernFont: prop.asset('font').optional(),
  splashScreenImages: prop.asset('spriteSheet').optional(),
  buttonsImages: prop.asset('spriteSheet').optional(),
  prefab: prop.asset('prefab').optional(),
}) {
  #gaugeBarWidth = 0;
  #lifeBarGrid!: Grid;
  #lifeBarGauge!: SpriteFrame;
  #currentState: GameState = 'newGame';
  #desiredState: GameState = 'newGame';
  /** 导火索还剩多少（0 到 1）；比对截图时从外面定住。 */
  fusePercentage = 1;

  protected override loadScene(): void {
    const font = this.#required(this.westernFont, 'WesternFont');
    const images = this.#required(this.splashScreenImages, 'SplashScreenImages');

    const title = new ContentDecorator();
    title.backgroundImage = SpriteFromSheet.create(images, 'stride_sample_text_bg');
    title.content = textBlock(font, 'Stride UI Particles', 60);
    title.padding = [35, 15, 35, 25];
    title.horizontalAlignment = 'center';
    title.panelZIndex = 1;

    const confetti = imageButton(images, 'button_long', textBlock(font, 'Click here to start the game over', 24));
    confetti.gridRow = 1;
    confetti.onClick(() => {
      this.fusePercentage = 1;
      this.#desiredState = 'newGame';
      this.#spawnParticles(confetti);
    });

    const stars = imageButton(images, 'button_short', textBlock(font, 'Congratulations', 24));
    stars.gridRow = 4;
    stars.onClick(() => {
      this.#desiredState = 'endGame';
      this.#spawnParticles(stars);
    });

    const bottomBar = this.#createBottomBar();
    bottomBar.panelZIndex = 1;
    bottomBar.gridRow = 6;

    const grid = new Grid();
    grid.maximumWidth = VIRTUAL_WIDTH;
    grid.maximumHeight = VIRTUAL_HEIGHT;
    grid.verticalAlignment = 'center';
    grid.horizontalAlignment = 'center';
    for (let row = 0; row < 5; row++) grid.rowDefinitions.add(new StripDefinition('auto'));
    grid.rowDefinitions.add(new StripDefinition('fixed', 100));
    grid.rowDefinitions.add(new StripDefinition('fixed', 50));
    grid.columnDefinitions.add(new StripDefinition());
    for (const child of [title, confetti, stars, bottomBar]) grid.children.add(child);

    const background = new ImageElement();
    background.source = SpriteFromSheet.create(images, 'background_uiimage');
    background.stretchType = 'fill';
    background.panelZIndex = -1;

    const root = new UniformGrid();
    root.children.add(background);
    root.children.add(grid);
    this.entity.require(UIComponent).page = new UIPage('Splash', root);
  }

  protected override updateScene(): void {
    const camera = this.#named('UIParticlesCamera');
    if (!camera) return;
    // 一个世界单位是 600 个 UI 像素（同 Stride；宽高比按画面算，不用设）
    camera.require(Camera).orthographicSize = this.game.graphicsDevice.canvas.height / VIRTUAL_HEIGHT;
    if (this.#currentState === 'newGame') this.#newGameState();
    else if (this.#currentState === 'endGame') this.#endGameState();
    this.#desiredState = 'none';
  }

  /** UI 的位置（虚拟像素，相对 UI 中心，y 向下）换到正交相机前的世界坐标（Stride 的 ToOrthographicCamera）。 */
  #toOrthographicCamera([x, y]: readonly [number, number]): [number, number, number] {
    return [x / VIRTUAL_WIDTH, -y / VIRTUAL_HEIGHT, 0];
  }

  /** 元素中心相对 UI 中心的位置（Stride 的 WorldMatrix.TranslationVector）。 */
  #centered(element: UIElement): [number, number] {
    const { resolution } = this.entity.require(UIComponent);
    const [x, y] = element.worldPosition;
    return [x - resolution.x / 2, y - resolution.y / 2];
  }

  /** 在按钮左边放命中特效：实例化预制体，重置粒子，2 秒后移除。 */
  #spawnParticles(button: Button): void {
    const prefab = this.prefab;
    if (!prefab) return;
    const [x, y] = this.#centered(button);
    const position = this.#toOrthographicCamera([x + 45 - button.renderSize[0] / 2, y - 5]);
    const spawned = prefab.instantiate(this.game.entities);
    for (const entity of spawned) {
      entity.get(ParticleSystemComponent)?.particleSystem.resetSimulation();
      place(entity, position);
    }
    this.addTask(async () => {
      for (let remaining = 2; remaining > 0; remaining -= this.game.updateTime.elapsed) await this.nextFrame();
      for (const entity of spawned) entity.destroy();
    });
  }

  #enterNewGame(): void {
    this.#currentState = 'newGame';
    this.fusePercentage = 1;
    const fire = this.#named('Fire');
    if (fire) {
      place(fire, [0, 0.65, 0]);
      fire.require(ParticleSystemComponent).particleSystem.play();
    }
    const confetti = this.#named('ConfettiBig');
    if (confetti) {
      place(confetti, [10, 0, 0]);
      confetti.require(ParticleSystemComponent).particleSystem.stop();
    }
    this.#drawFuse();
  }

  /** 导火索按剩下的比例缩短（精灵的区域和网格的两列），火放在烧到的地方。 */
  #drawFuse(): void {
    this.fusePercentage = Math.min(1, this.fusePercentage - this.game.updateTime.elapsed * 0.04);
    const width = Math.max(1, this.fusePercentage * this.#gaugeBarWidth);
    this.#lifeBarGauge.region[2] = width;
    const columns = this.#lifeBarGrid.columnDefinitions;
    columns.at(1)!.sizeValue = width / this.#gaugeBarWidth;
    columns.at(2)!.sizeValue = 1 - columns.at(1)!.sizeValue;

    const fire = this.#named('Fire');
    if (!fire) return;
    const grid = this.#lifeBarGrid;
    const [x, y] = this.#centered(grid);
    const fireX = x - (grid.renderSize[0] / 2 - columns.at(0)!.actualSize - columns.at(1)!.actualSize + 5);
    place(fire, this.#toOrthographicCamera([fireX, y - 10]));
  }

  /** 进入结束：火停掉，大彩纸移到画面里放（点"恭喜"时；比对截图时也从外面调用）。 */
  enterEndGame(): void {
    this.#currentState = 'endGame';
    this.fusePercentage = 0;
    this.#drawFuse();
    const fire = this.#named('Fire');
    if (fire) {
      place(fire, [10, 0, 0]);
      fire.require(ParticleSystemComponent).particleSystem.stop();
    }
    const confetti = this.#named('ConfettiBig');
    if (confetti) {
      place(confetti, [0, 0.5, 0]);
      confetti.require(ParticleSystemComponent).particleSystem.play();
    }
  }

  #newGameState(): void {
    this.fusePercentage = Math.min(1, this.fusePercentage - this.game.updateTime.elapsed * 0.03);
    this.#drawFuse();
    if (this.#desiredState === 'endGame' || this.fusePercentage <= 0) this.enterEndGame();
  }

  #endGameState(): void {
    if (this.#desiredState === 'newGame') this.#enterNewGame();
  }

  /** 底部的导火索：Grid 的第二列是绳子的图，第二、三列按剩下的比例分。 */
  #createBottomBar(): UIElement {
    const buttons = this.#required(this.buttonsImages, 'ButtonsImages');
    const rope = SpriteFromSheet.create(buttons, 'rope_small');
    this.#lifeBarGauge = rope.getSprite()!;
    this.#gaugeBarWidth = this.#lifeBarGauge.region[2];
    const gauge = new ImageElement();
    gauge.name = 'LifeBarBackground';
    gauge.source = rope;
    gauge.stretchType = 'fill';
    gauge.gridColumn = 1;

    const grid = (this.#lifeBarGrid = new Grid());
    grid.children.add(gauge);
    grid.columnDefinitions.add(new StripDefinition('fixed', 8));
    grid.columnDefinitions.add(new StripDefinition('star', 0));
    grid.columnDefinitions.add(new StripDefinition('star', 100));
    grid.columnDefinitions.add(new StripDefinition('fixed', 8));
    grid.rowDefinitions.add(new StripDefinition());
    grid.canvasRelativePosition = [0, 0.185];
    grid.canvasRelativeSize = [1, 1];
    grid.panelZIndex = -1;

    const layer = new Canvas();
    layer.verticalAlignment = 'top';
    layer.maximumHeight = 10;
    layer.children.add(grid);
    return layer;
  }

  #named(name: string): Entity | undefined {
    return [...(this.game.rootScene?.entities.values() ?? [])].find((entity) => entity.name === name);
  }

  #required<T>(value: T | undefined, name: string): T {
    if (value === undefined) throw new Error(`UIParticles: SplashScript has no ${name}`);
    return value;
  }
}

/** 把实体放到 position（本地位置）。 */
function place(entity: Entity, [x, y, z]: readonly number[]): void {
  Object.assign(entity.require(Transform).position, { x, y, z });
}

function textBlock(font: SpriteFont, text: string, size: number): TextBlock {
  const block = new TextBlock();
  block.font = font;
  block.text = text;
  block.textSize = size;
  block.textColor = WHITE;
  return block;
}

/** 三种状态都用同一张图的按钮，靠右，内容是文字。 */
function imageButton(sheet: SpriteSheet, sprite: string, content: UIElement): Button {
  const image = SpriteFromSheet.create(sheet, sprite);
  const button = new Button();
  button.notPressedImage = image;
  button.pressedImage = image;
  button.mouseOverImage = image;
  button.content = content;
  button.horizontalAlignment = 'right';
  button.padding = [90, 22, 25, 35];
  button.panelZIndex = 1;
  return button;
}
