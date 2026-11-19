/**
 * 按钮（Stride 的 ButtonBase、Button）：按下、没按、指针悬停时各一张图（常是九宫格的框），默认大小跟着内容走
 * （sizeToContent）；关掉时大小按图片算。指针按下变成按下状态，在按钮上松开时发 Click（clickMode 是 press 时按下就发），
 * 指针移出去就不算按下了。
 */
import type { SpriteFrame } from '../../rendering/SpriteSheet';
import { registerClassHandler, RoutedEvent, RoutedEventArgs, type TouchEventArgs } from '../events';
import type { Color, Thickness, Vec2 } from '../UIElement';
import type { SpriteProvider } from '../sprites';
import { ContentControl } from './ContentControl';
import { imageSize, type StretchDirection, type StretchType } from './ImageElement';

/** 什么时候算点击：松开时（默认），还是按下时。 */
export type ClickMode = 'release' | 'press';

const WHITE: Color = [1, 1, 1, 1];
const BUTTON_PADDING: Thickness = [10, 5, 10, 7];

export abstract class ButtonBase extends ContentControl {
  /** 点击（Stride 的 Click，冒泡）：`button.addHandler(ButtonBase.clickEvent, () => ...)`。 */
  static readonly clickEvent = new RoutedEvent<RoutedEventArgs>('Click', 'bubble');
  clickMode: ClickMode = 'release';
  #isPressed = false;

  constructor() {
    super();
    this.canBeHitByUser = true;
  }

  get isPressed(): boolean { return this.#isPressed; }
  protected set isPressed(value: boolean) { this.#isPressed = value; }

  /** 登记点击的处理函数（addHandler(ButtonBase.clickEvent, ...) 的简写）。 */
  onClick(handler: (sender: ButtonBase) => void): void {
    this.addHandler(ButtonBase.clickEvent, (sender) => handler(sender as ButtonBase));
  }

  protected override onTouchDown(args: TouchEventArgs): void {
    super.onTouchDown(args);
    this.isPressed = true;
    if (this.clickMode === 'press') this.raiseEvent(new RoutedEventArgs(ButtonBase.clickEvent));
  }

  protected override onTouchUp(args: TouchEventArgs): void {
    super.onTouchUp(args);
    if (this.isPressed && this.clickMode === 'release') this.raiseEvent(new RoutedEventArgs(ButtonBase.clickEvent));
    this.isPressed = false;
  }

  protected override onTouchLeave(args: TouchEventArgs): void {
    super.onTouchLeave(args);
    this.isPressed = false;
  }

  /** 点击时按钮自己的反应（Stride 的 OnClick，比如 ToggleButton 换状态）。 */
  protected handleClick(_args: RoutedEventArgs): void {}
}

registerClassHandler(ButtonBase, ButtonBase.clickEvent, (element, args) => (element as unknown as { handleClick(args: RoutedEventArgs): void }).handleClick(args));

export class Button extends ButtonBase {
  #pressedImage: SpriteProvider | null = null;
  #notPressedImage: SpriteProvider | null = null;
  #mouseOverImage: SpriteProvider | null = null;
  #imageStretchType: StretchType = 'uniform';
  #imageStretchDirection: StretchDirection = 'both';
  #sizeToContent = true;
  /** 乘在按钮图片上的颜色（sRGB）。 */
  color: Color = WHITE;

  constructor() {
    super();
    this.drawLayerNumber += 1;
    this.padding = BUTTON_PADDING;
  }

  override get isPressed(): boolean { return super.isPressed; }
  protected override set isPressed(value: boolean) {
    if (value === super.isPressed) return;
    super.isPressed = value;
    this.invalidateMeasure();
  }

  get pressedImage(): SpriteProvider | null { return this.#pressedImage; }
  set pressedImage(value: SpriteProvider | null) { this.#pressedImage = value; this.#imageChanged(); }
  get notPressedImage(): SpriteProvider | null { return this.#notPressedImage; }
  set notPressedImage(value: SpriteProvider | null) { this.#notPressedImage = value; this.#imageChanged(); }
  get mouseOverImage(): SpriteProvider | null { return this.#mouseOverImage; }
  set mouseOverImage(value: SpriteProvider | null) { this.#mouseOverImage = value; this.#imageChanged(); }
  get imageStretchType(): StretchType { return this.#imageStretchType; }
  set imageStretchType(value: StretchType) { this.#imageStretchType = value; this.invalidateMeasure(); }
  get imageStretchDirection(): StretchDirection { return this.#imageStretchDirection; }
  set imageStretchDirection(value: StretchDirection) { this.#imageStretchDirection = value; this.invalidateMeasure(); }
  /** 大小跟着内容走（true），还是按按钮的图片算。 */
  get sizeToContent(): boolean { return this.#sizeToContent; }
  set sizeToContent(value: boolean) {
    if (value === this.#sizeToContent) return;
    this.#sizeToContent = value;
    this.invalidateMeasure();
  }

  /** 现在该画的图：按下、悬停（有悬停图时）、没按。 */
  get buttonImage(): SpriteFrame | undefined {
    const provider = this.isPressed ? this.#pressedImage : this.mouseOverState === 'element' && this.#mouseOverImage ? this.#mouseOverImage : this.#notPressedImage;
    return provider?.getSprite();
  }

  protected override measureOverride(available: Vec2): Vec2 {
    return this.#sizeToContent ? super.measureOverride(available) : imageSize(this.buttonImage, available, this.#imageStretchType, this.#imageStretchDirection, true);
  }

  protected override arrangeOverride(finalSize: Vec2): Vec2 {
    return this.#sizeToContent ? super.arrangeOverride(finalSize) : imageSize(this.buttonImage, finalSize, this.#imageStretchType, this.#imageStretchDirection, false);
  }

  protected override onMouseOverStateChanged(): void {
    this.#imageChanged();
  }

  #imageChanged(): void {
    if (!this.#sizeToContent) this.invalidateMeasure();
  }
}
