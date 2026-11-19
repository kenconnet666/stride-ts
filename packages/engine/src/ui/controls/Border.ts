/**
 * 边框（Stride 的 Border）：内容控件，四周画一圈 borderColor 的边（宽度是 borderThickness），背景色照常画在整个元素上。
 * 和 Stride 不同：只有两维，没有前后两面的边。
 */
import { sizeWithoutThickness, sizeWithThickness, translation, type Color, type Thickness, type Vec2 } from '../UIElement';
import { ContentControl } from './ContentControl';

const BLACK: Color = [0, 0, 0, 1];
const NO_THICKNESS: Thickness = [0, 0, 0, 0];

export class Border extends ContentControl {
  /** 边的颜色（sRGB）。 */
  borderColor: Color = BLACK;
  #borderThickness: Thickness = NO_THICKNESS;

  /** 边的宽度：左、上、右、下。 */
  get borderThickness(): Thickness { return this.#borderThickness; }
  set borderThickness(value: Thickness) {
    this.#borderThickness = value;
    this.invalidateMeasure();
  }

  protected override measureOverride(available: Vec2): Vec2 {
    return sizeWithThickness(super.measureOverride(sizeWithoutThickness(available, this.#borderThickness)), this.#borderThickness);
  }

  protected override arrangeOverride(finalSize: Vec2): Vec2 {
    const content = this.visualContent;
    if (content) {
      const [bl, bt] = this.#borderThickness, [pl, pt] = this.padding;
      content.arrange(sizeWithoutThickness(sizeWithoutThickness(finalSize, this.#borderThickness), this.padding), this.isCollapsed);
      content.arrangeMatrix = translation(pl + bl - finalSize[0] / 2, pt + bt - finalSize[1] / 2);
    }
    return finalSize;
  }
}
