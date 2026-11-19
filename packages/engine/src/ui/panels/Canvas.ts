/**
 * Canvas（Stride 的 Canvas）：子元素按附加属性钉在某个位置（绝对的虚拟像素，或按 Canvas 大小的比例），大小可以按 Canvas
 * 的比例给；Canvas 自己不要求空间（想要的大小是 0）。
 */
import { sizeWithThickness, translation, type UIElement, type Vec2 } from '../UIElement';
import { Panel } from './Panel';

export class Canvas extends Panel {
  protected override measureOverride(available: Vec2): Vec2 {
    for (const child of this.visualChildrenList) {
      const relativeSize = child.canvasRelativeSize;
      const childAvailable: Vec2 = [Infinity, Infinity];
      for (const d of [0, 1] as const) {
        if (Number.isNaN(relativeSize[d])) continue;
        // 0 x 无穷大会是 NaN
        childAvailable[d] = relativeSize[d] > 0 ? relativeSize[d] * available[d] : 0;
      }
      child.measure(sizeWithThickness(childAvailable, child.margin));
    }
    return [0, 0];
  }

  protected override arrangeOverride(finalSize: Vec2): Vec2 {
    for (const child of this.visualChildrenList) {
      child.arrange(child.desiredSizeWithMargins, this.isCollapsed);
      const pin = pinPosition(child, finalSize);
      const origin = child.canvasPinOrigin;
      child.arrangeMatrix = translation(pin[0] - origin[0] * child.renderSize[0] - finalSize[0] / 2, pin[1] - origin[1] * child.renderSize[1] - finalSize[1] / 2);
    }
    return finalSize;
  }
}

/** 子元素钉住的位置：绝对位置是 NaN（或者不用绝对位置而相对位置有值）的那一维用相对位置。 */
function pinPosition(child: UIElement, parentSize: Vec2): Vec2 {
  const relative = child.canvasRelativePosition;
  const position: Vec2 = [child.canvasAbsolutePosition[0], child.canvasAbsolutePosition[1]];
  for (const d of [0, 1] as const) {
    if (Number.isNaN(position[d]) || (!child.canvasUseAbsolutePosition && !Number.isNaN(relative[d]))) {
      position[d] = relative[d] === 0 ? 0 : relative[d] * parentSize[d];
    }
  }
  return position;
}
