// GameMenu 的 MainScript：主菜单。欢迎弹窗里起名字；花金币、奖励升级飞船的三项属性（最多三颗星）和生命数；点当前的飞船
// 打开选飞船的弹窗（滚动的列表，锁着的不能选）；血条慢慢充满；Quit 退出。弹窗和飞船按钮从 UI 库按名字实例化。
import {
  Button, ButtonBase, EditText, Grid, ImageElement, ModalElement, prop, SpriteFromSheet, StackPanel, TextBlock, UIComponent, UniformGrid,
  type Panel, type SpriteFrame, type UIElement, type UIPage,
} from '@stride-ts/engine';
import { UISceneBase } from './UISceneBase';

const DEFAULT_NAME = 'John Doe';
const MAXIMUM_STAR = 3;
const SHIP_NAMES = ['red_ship', 'green_ship', 'blue_ship', 'blue_ship', 'yellow_ship', 'yellow_ship', 'cyan_ship'];

interface SpaceShip {
  readonly name: string;
  power: number;
  control: number;
  speed: number;
  readonly isLocked: boolean;
  powerImage?: ImageElement;
  controlImage?: ImageElement;
  speedImage?: ImageElement;
}

/** 元素的图片（页面里都是精灵表的帧）。 */
function frameOf(image: ImageElement): SpriteFromSheet {
  return image.source as SpriteFromSheet;
}

/** 按名字和类型找后代（Stride 的 FindVisualChildOfType），找不到时报错。 */
function child<T extends UIElement>(root: UIElement, type: abstract new (...args: never[]) => T, name: string): T {
  const found = root.find(type, name);
  if (!found) throw new Error(`GameMenu: no ${type.name} named '${name}'`);
  return found;
}

export class MainScript extends UISceneBase.props({
  mainSceneImages: prop.asset('spriteSheet').optional(),
  uiLibrary: prop.asset('uiLibrary').optional(),
}) {
  readonly ships: SpaceShip[] = [];
  #money = 0;
  #bonus = 0;
  #lifeStatus = 0;
  #powerStatus = 0;
  #controlStatus = 0;
  #speedStatus = 0;
  #activeShipIndex = 0;
  readonly #starFrames: number[] = [];
  readonly #borderStarFrames: number[] = [];

  #page!: UIPage;
  shipSelectPopup!: ModalElement;
  welcomePopup!: ModalElement;
  #gaugeBarWidth = 0;
  #lifebarGrid!: Grid;
  #lifebarGauge!: SpriteFrame;
  #bonusCounter!: TextBlock;
  #lifeCounter!: TextBlock;
  #moneyCounter!: TextBlock;
  #nameTextBlock!: TextBlock;
  #currentShipImage!: ImageElement;
  #powerStatusStar!: ImageElement;
  #controlStatusStar!: ImageElement;
  #speedStatusStar!: ImageElement;

  get bonus(): number { return this.#bonus; }
  set bonus(value: number) {
    this.#bonus = value;
    this.#bonusCounter.text = String(value).padStart(3, '0');
  }

  get money(): number { return this.#money; }
  set money(value: number) {
    this.#money = value;
    this.#moneyCounter.text = String(value).padStart(3, '0');
  }

  get lifeStatus(): number { return this.#lifeStatus; }
  set lifeStatus(value: number) {
    this.#lifeStatus = value;
    this.#lifeCounter.text = `x${value}`;
  }

  get powerStatus(): number { return this.#powerStatus; }
  set powerStatus(value: number) {
    if (value > MAXIMUM_STAR) return;
    this.#powerStatus = value;
    frameOf(this.#powerStatusStar).currentFrame = this.#starFrames[value]!;
    this.ships[this.#activeShipIndex]!.power = value;
  }

  get controlStatus(): number { return this.#controlStatus; }
  set controlStatus(value: number) {
    if (value > MAXIMUM_STAR) return;
    this.#controlStatus = value;
    frameOf(this.#controlStatusStar).currentFrame = this.#starFrames[value]!;
    this.ships[this.#activeShipIndex]!.control = value;
  }

  get speedStatus(): number { return this.#speedStatus; }
  set speedStatus(value: number) {
    if (value > MAXIMUM_STAR) return;
    this.#speedStatus = value;
    frameOf(this.#speedStatusStar).currentFrame = this.#starFrames[value]!;
    this.ships[this.#activeShipIndex]!.speed = value;
  }

  override start(): void {
    super.start();
    this.showWelcomePopup();
  }

  protected override loadScene(): void {
    const sheet = this.#sheet;
    for (let i = 0; i <= MAXIMUM_STAR; i++) {
      this.#starFrames.push(sheet.indexOf(`star${i}`));
      this.#borderStarFrames.push(sheet.indexOf(`bstar${i}`));
    }
    const random = () => Math.floor(Math.random() * (MAXIMUM_STAR + 1));
    SHIP_NAMES.forEach((name, i) => this.ships.push({ name, power: random(), control: random(), speed: random(), isLocked: i % 3 === 2 }));

    const page = this.entity.require(UIComponent).page;
    if (!page) throw new Error('GameMenu: the UI component has no page');
    this.#page = page;
    this.#initializeMainPage();
    this.#initializeShipSelectionPopup();
    this.#initializeWelcomePopup();

    const overlay = page.rootElement as UniformGrid;
    overlay.children.add(this.shipSelectPopup);
    overlay.children.add(this.welcomePopup);

    void this.#fillLifeBar().catch(() => undefined);
  }

  get #sheet() {
    const sheet = this.mainSceneImages;
    if (!sheet) throw new Error('GameMenu: MainScript has no MainSceneImages');
    return sheet;
  }

  get #library() {
    const library = this.uiLibrary;
    if (!library) throw new Error('GameMenu: MainScript has no UILibrary');
    return library;
  }

  /** 血条从 15% 慢慢充满：缩短精灵的区域，网格的两列跟着按比例分。 */
  async #fillLifeBar(): Promise<void> {
    let percentage = 0.15;
    while (percentage < 1) {
      await this.nextFrame();
      percentage = Math.min(1, percentage + this.game.updateTime.elapsed * 0.02);
      const width = percentage * this.#gaugeBarWidth;
      this.#lifebarGauge.region[2] = width;
      const columns = this.#lifebarGrid.columnDefinitions;
      columns.at(1)!.sizeValue = width / this.#gaugeBarWidth;
      columns.at(2)!.sizeValue = 1 - columns.at(1)!.sizeValue;
    }
  }

  #canPurchase(requireMoney: number, requireBonus: number): boolean {
    return this.money >= requireMoney && this.bonus >= requireBonus;
  }

  #createShipSelectionItem(ship: SpaceShip): Panel {
    const panel = this.#library.instantiateElement<Panel>('ShipButton');
    const button = child(panel, ButtonBase, 'shipButton');
    const shipImage = child(button, ImageElement, 'shipImage');
    ship.powerImage = child(button, ImageElement, 'powerImage');
    ship.controlImage = child(button, ImageElement, 'controlImage');
    ship.speedImage = child(button, ImageElement, 'speedImage');

    const shipFrame = this.#sheet.indexOf(ship.name);
    frameOf(shipImage).currentFrame = shipFrame;
    button.onClick(() => {
      this.#activeShipIndex = this.ships.findIndex((s) => s.name === ship.name);
      frameOf(this.#currentShipImage).currentFrame = shipFrame;
      this.powerStatus = ship.power;
      this.controlStatus = ship.control;
      this.speedStatus = ship.speed;
      this.shipSelectPopup.visibility = 'collapsed';
    });
    button.isEnabled = !ship.isLocked;
    if (ship.isLocked) child(panel, ImageElement, 'lockIcon').visibility = 'visible';
    return panel;
  }

  #initializeMainPage(): void {
    const root = this.#page.rootElement as UniformGrid;
    this.#bonusCounter = child(root, TextBlock, 'bonusCounter');
    this.#lifeCounter = child(root, TextBlock, 'lifeCounter');
    this.#moneyCounter = child(root, TextBlock, 'moneyCounter');
    this.bonus = 30;
    this.lifeStatus = 3;
    this.money = 30;

    const gauge = this.#sheet.find('life_bar');
    if (!gauge) throw new Error("GameMenu: MainSceneImages has no 'life_bar'");
    this.#lifebarGauge = gauge;
    this.#gaugeBarWidth = gauge.region[2];
    this.#lifebarGrid = child(root, Grid, 'lifebarGrid');

    this.#nameTextBlock = child(root, TextBlock, 'nameTextBlock');
    child(root, TextBlock, 'explanationText').text = 'Pictogram-based alphabets are easily supported.\n日本語も簡単に入れることが出来ます。';

    const statusPanel = child(root, UniformGrid, 'statusPanel');
    this.#powerStatusStar = child(statusPanel, ImageElement, 'powerStatusStar');
    this.#controlStatusStar = child(statusPanel, ImageElement, 'controlStatusStar');
    this.#speedStatusStar = child(statusPanel, ImageElement, 'speedStatusStar');
    const ship = this.ships[this.#activeShipIndex]!;
    this.powerStatus = ship.power;
    this.controlStatus = ship.control;
    this.speedStatus = ship.speed;

    const currentShipButton = child(root, Button, 'currentShipButton');
    currentShipButton.onClick(() => {
      this.#updateShipStatus();
      this.shipSelectPopup.visibility = 'visible';
    });
    this.#currentShipImage = child(currentShipButton, ImageElement, 'currentShipImage');

    const upgrades = child(root, UniformGrid, 'statusUpgradePanel');
    this.#setupStatusButton(child(upgrades, ButtonBase, 'powerStatusButton'), 2, 0, () => this.powerStatus, () => this.powerStatus++);
    this.#setupStatusButton(child(upgrades, ButtonBase, 'controlStatusButton'), 2, 0, () => this.controlStatus, () => this.controlStatus++);
    this.#setupStatusButton(child(upgrades, ButtonBase, 'speedStatusButton'), 2, 0, () => this.speedStatus, () => this.speedStatus++);
    this.#setupStatusButton(child(upgrades, ButtonBase, 'lifeStatusButton'), 1, 1, () => 0, () => this.lifeStatus++);

    // Stride 退出程序；浏览器里停下游戏
    child(root, Button, 'quitButton').onClick(() => this.game.exit());
  }

  #initializeShipSelectionPopup(): void {
    this.shipSelectPopup = this.#library.instantiateElement('ShipSelectPopup', ModalElement);
    this.shipSelectPopup.panelZIndex = 1;
    const stack = child(this.shipSelectPopup, StackPanel, 'contentStackPanel');
    for (const ship of this.ships) stack.children.add(this.#createShipSelectionItem(ship));
    this.#updateShipStatus();
    this.shipSelectPopup.visibility = 'collapsed';
  }

  #initializeWelcomePopup(): void {
    this.welcomePopup = this.#library.instantiateElement('WelcomePopup', ModalElement);
    this.welcomePopup.panelZIndex = 1;
    child(this.welcomePopup, TextBlock, 'welcomeText').text = 'Welcome to stride UI sample.\nPlease name your character';
    child(this.welcomePopup, Button, 'cancelButton').onClick(() => {
      this.#nameTextBlock.text = DEFAULT_NAME;
      this.welcomePopup.visibility = 'collapsed';
    });
    const nameEditText = child(this.welcomePopup, EditText, 'nameEditText');
    nameEditText.text = DEFAULT_NAME;
    child(this.welcomePopup, Button, 'validateButton').onClick(() => {
      this.#nameTextBlock.text = nameEditText.text.trim();
      this.welcomePopup.visibility = 'collapsed';
    });
  }

  #setupStatusButton(button: ButtonBase, moneyCost: number, bonusCost: number, get: () => number, increase: () => void): void {
    button.onClick(() => {
      if (!this.#canPurchase(moneyCost, bonusCost) || get() >= MAXIMUM_STAR) return;
      increase();
      this.bonus -= bonusCost;
      this.money -= moneyCost;
    });
  }

  showWelcomePopup(): void {
    this.welcomePopup.visibility = 'visible';
  }

  #updateShipStatus(): void {
    for (const ship of this.ships) {
      frameOf(ship.powerImage!).currentFrame = this.#borderStarFrames[ship.power]!;
      frameOf(ship.controlImage!).currentFrame = this.#borderStarFrames[ship.control]!;
      frameOf(ship.speedImage!).currentFrame = this.#borderStarFrames[ship.speed]!;
    }
  }
}
