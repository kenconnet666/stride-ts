/**
 * 开关按钮（Stride 的 ToggleButton）：点一下换一个状态——选中、没选中，开了 isThreeState 时中间多一个"不确定"。每个状态一张图
 * （可以另给指针悬停时的图），状态变了发 Checked、Unchecked、Indeterminate 事件（冒泡）。
 *
 *   const sound = Object.assign(new ToggleButton(), { checkedImage: on, uncheckedImage: off });
 *   sound.addHandler(ToggleButton.checkedEvent, () => (game.audio.masterVolume = 1));
 *   sound.addHandler(ToggleButton.uncheckedEvent, () => (game.audio.masterVolume = 0));
 */
import type { SpriteFrame } from '../../rendering/SpriteSheet';
import { RoutedEvent, RoutedEventArgs } from '../events';
import type { SpriteProvider } from '../sprites';
import type { Color, Thickness } from '../UIElement';
import { ButtonBase } from './Button';

/** Stride 的 ToggleState。 */
export type ToggleState = 'checked' | 'unChecked' | 'indeterminate';

const WHITE: Color = [1, 1, 1, 1];
const TOGGLE_PADDING: Thickness = [10, 5, 10, 7];

export class ToggleButton extends ButtonBase {
  static readonly checkedEvent = new RoutedEvent<RoutedEventArgs>('Checked', 'bubble');
  static readonly indeterminateEvent = new RoutedEvent<RoutedEventArgs>('Indeterminate', 'bubble');
  static readonly uncheckedEvent = new RoutedEvent<RoutedEventArgs>('Unchecked', 'bubble');

  checkedImage: SpriteProvider | null = null;
  uncheckedImage: SpriteProvider | null = null;
  indeterminateImage: SpriteProvider | null = null;
  /** 指针悬停时换的图；没给就用上面对应状态的。 */
  checkedMouseOverImage: SpriteProvider | null = null;
  uncheckedMouseOverImage: SpriteProvider | null = null;
  indeterminateMouseOverImage: SpriteProvider | null = null;
  /** 乘在图上的颜色（sRGB）。 */
  color: Color = WHITE;
  #isThreeState = false;
  #state: ToggleState = 'unChecked';

  constructor() {
    super();
    this.drawLayerNumber += 1;
    this.padding = TOGGLE_PADDING;
  }

  /** 有没有"不确定"这个状态（点的时候 选中 → 不确定 → 没选中）；关掉时正好在不确定的换到下一个状态。 */
  get isThreeState(): boolean { return this.#isThreeState; }
  set isThreeState(value: boolean) {
    if (!value && this.#state === 'indeterminate') this.goToNextState();
    this.#isThreeState = value;
  }

  /** 现在的状态；设成 indeterminate 会顺带打开 isThreeState。变了就发对应的事件。 */
  get state(): ToggleState { return this.#state; }
  set state(value: ToggleState) {
    if (value === this.#state) return;
    this.#state = value;
    if (value === 'indeterminate') this.#isThreeState = true;
    const event = value === 'checked' ? ToggleButton.checkedEvent : value === 'indeterminate' ? ToggleButton.indeterminateEvent : ToggleButton.uncheckedEvent;
    this.raiseEvent(new RoutedEventArgs(event));
  }

  /** 现在该画的图：按状态取，指针悬停而且给了悬停图时用悬停的。 */
  get toggleButtonImage(): SpriteFrame | undefined {
    const over = this.mouseOverState === 'element';
    const [image, overImage] = this.#state === 'checked' ? [this.checkedImage, this.checkedMouseOverImage]
      : this.#state === 'indeterminate' ? [this.indeterminateImage, this.indeterminateMouseOverImage]
      : [this.uncheckedImage, this.uncheckedMouseOverImage];
    return ((over && overImage) || image)?.getSprite();
  }

  protected goToNextState(): void {
    this.state = this.#state === 'checked' ? (this.#isThreeState ? 'indeterminate' : 'unChecked') : this.#state === 'indeterminate' ? 'unChecked' : 'checked';
  }

  protected override handleClick(args: RoutedEventArgs): void {
    super.handleClick(args);
    this.goToNextState();
  }
}
