/**
 * 控件（Stride 的 Control：有内边距）和内容控件（ContentControl：装一个子元素）；ContentDecorator 在内容后面画一张背景图
 * （常是九宫格的框）。
 */
import { sizeWithoutThickness, sizeWithThickness, translation, UIElement, type Thickness, type Vec2 } from '../UIElement';
import type { SpriteProvider } from '../sprites';

const NO_PADDING: Thickness = [0, 0, 0, 0];

export abstract class Control extends UIElement {
  #padding: Thickness = NO_PADDING;

  /** 内容和边框之间的距离：左、上、右、下。 */
  get padding(): Thickness { return this.#padding; }
  set padding(value: Thickness) {
    this.#padding = value;
    this.invalidateMeasure();
  }
}

export abstract class ContentControl extends Control {
  #content: UIElement | null = null;
  #visualContent: UIElement | null = null;

  get content(): UIElement | null { return this.#content; }
  set content(value: UIElement | null) {
    if (value === this.#content) return;
    if (this.#content) UIElement.setParent(this.#content, null);
    this.#content = value;
    this.visualContent = value;
    if (value) UIElement.setParent(value, this);
    this.invalidateMeasure();
  }

  /** 画的内容（通常就是 content）。 */
  get visualContent(): UIElement | null { return this.#visualContent; }
  protected set visualContent(value: UIElement | null) {
    if (this.#visualContent) UIElement.setVisualParent(this.#visualContent, null);
    this.#visualContent = value;
    if (value) UIElement.setVisualParent(value, this);
    this.invalidateMeasure();
  }

  protected override measureOverride(available: Vec2): Vec2 {
    let childDesired: Vec2 = [0, 0];
    const content = this.#visualContent;
    if (content) {
      content.measure(sizeWithoutThickness(available, this.padding));
      childDesired = content.desiredSizeWithMargins;
    }
    return sizeWithThickness(childDesired, this.padding);
  }

  protected override arrangeOverride(finalSize: Vec2): Vec2 {
    const content = this.#visualContent;
    if (content) {
      content.arrange(sizeWithoutThickness(finalSize, this.padding), this.isCollapsed);
      content.arrangeMatrix = translation(this.padding[0] - finalSize[0] / 2, this.padding[1] - finalSize[1] / 2);
    }
    return finalSize;
  }
}

export class ContentDecorator extends ContentControl {
  backgroundImage: SpriteProvider | null = null;

  constructor() {
    super();
    // 装饰的图多画一层
    this.drawLayerNumber += 1;
  }
}
