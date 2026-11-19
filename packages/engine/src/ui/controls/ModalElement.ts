/**
 * 模态元素（Stride 的 ModalElement）：弹窗。画的时候先用 overlayColor 盖住整个 UI，模态时整个 UI 都算点在它上面（挡住后面
 * 所有元素的指针），点到弹窗外面发 OutsideClick。默认居中。
 *
 * 和 Stride 不同：Stride 判断"外面"时拿相对弹窗中心的位置和 [0, 大小] 比，点在弹窗左半边、上半边也算外面；我们按弹窗的矩形判断。
 */
import { RoutedEvent, RoutedEventArgs, type TouchEventArgs } from '../events';
import type { Color } from '../UIElement';
import { ButtonBase } from './Button';

export class ModalElement extends ButtonBase {
  /** 盖住整个 UI 的颜色（sRGB），默认 60% 的黑。 */
  overlayColor: Color = [0, 0, 0, 0.6];
  isModal = true;
  /** 点在弹窗外面（冒泡）。 */
  static readonly outsideClickEvent = new RoutedEvent<RoutedEventArgs>('OutsideClick', 'bubble');

  constructor() {
    super();
    this.drawLayerNumber += 1;
    this.verticalAlignment = 'center';
    this.horizontalAlignment = 'center';
  }

  override intersects(point: readonly [number, number]): boolean {
    return this.isModal || super.intersects(point);
  }

  protected override onTouchUp(args: TouchEventArgs): void {
    super.onTouchUp(args);
    if (!this.isModal || args.source !== this) return;
    if (!super.intersects(args.worldPosition)) this.raiseEvent(new RoutedEventArgs(ModalElement.outsideClickEvent));
  }
}
