// UIElementLink 的 SplashScript：在代码里建页面——中间一个来回移动的长按钮（名字是 "ElementName"，FollowingEntity 的
// UIElementLink 跟着它），四个角各一个方块按钮；点长按钮换下一个场景。按钮的位置按画面的像素（UISceneBase 把虚拟分辨率设成
// 画面大小）。
import { Button, Canvas, prop, SpriteFromSheet, UIPage, UIComponent, type SpriteSheet } from '@stride-ts/engine';
import { UISceneBase } from './UISceneBase';

/** 精灵表里名字是 name 的帧当按钮的三种图，按钮的大小是帧的像素大小。 */
function spriteButton(sheet: SpriteSheet, name: string): Button {
  const index = sheet.indexOf(name);
  if (index < 0) throw new Error(`UIElementLink: sprite sheet '${sheet.name}' has no sprite '${name}'`);
  const image = new SpriteFromSheet(sheet, index);
  const button = new Button();
  button.pressedImage = image;
  button.notPressedImage = image;
  button.mouseOverImage = image;
  const [, , width, height] = sheet.sprites[index]!.region;
  button.width = width;
  button.height = height;
  return button;
}

export class SplashScript extends UISceneBase.props({
  splashScreenImages: prop.asset('spriteSheet').optional(),
  nextScene: prop.asset('scene').optional(),
}) {
  followedButton!: Button;
  #center: [number, number] = [0, 0];

  #loadNextScene(): void {
    const next = this.nextScene;
    if (!next) return;
    void this.game.setRootScene(next.path);
    this.cancel();
  }

  protected override loadScene(): void {
    const sheet = this.splashScreenImages;
    if (!sheet) throw new Error('UIElementLink: SplashScript has no SplashScreenImages');
    const { width, height } = this.game.graphicsDevice.canvas;
    this.#center = [width / 2, height / 2];

    // 跟着走的按钮：FollowingEntity 的 UIElementLink 按这个名字找
    this.followedButton = spriteButton(sheet, 'button_long');
    this.followedButton.name = 'ElementName';
    this.followedButton.onClick(() => this.#loadNextScene());

    const root = new Canvas();
    root.children.add(this.followedButton);
    const corners: [number, number][] = [[0, 0], [1, 0], [0, 1], [1, 1]];
    for (const [x, y] of corners) {
      const corner = spriteButton(sheet, 'button_box');
      corner.canvasAbsolutePosition = [x * (width - corner.width), y * (height - corner.height)];
      root.children.add(corner);
    }
    root.maximumWidth = width;
    root.maximumHeight = height;
    this.entity.require(UIComponent).page = new UIPage('Splash', root);
  }

  protected override updateScene(): void {
    const distance = Math.sin(this.game.updateTime.total * 0.2) * this.#center[0] * 0.75;
    this.followedButton.canvasAbsolutePosition = [this.#center[0] + distance, this.#center[1]];
  }
}
