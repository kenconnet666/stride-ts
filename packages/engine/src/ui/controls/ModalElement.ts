/**
 * 模态元素（Stride 的 ModalElement）：弹窗。画的时候先用 overlayColor 盖住整个 UI，模态时挡住后面所有元素的指针
 * （step 4），点到弹窗外面发 OutsideClick。默认居中。
 */
import type { Color } from '../UIElement';
import { ButtonBase } from './Button';

export class ModalElement extends ButtonBase {
  /** 盖住整个 UI 的颜色（sRGB），默认 60% 的黑。 */
  overlayColor: Color = [0, 0, 0, 0.6];
  isModal = true;

  constructor() {
    super();
    this.drawLayerNumber += 1;
    this.verticalAlignment = 'center';
    this.horizontalAlignment = 'center';
  }
}
