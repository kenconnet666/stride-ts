/**
 * 堆叠面板（Stride 的 StackPanel）：子元素按方向一个接一个排。放在 ScrollViewer 里时它自己负责沿堆叠方向滚动
 * （IScrollInfo）：滚动位置以"第几个子元素"为单位（2.5 是第三个子元素滚过一半）。
 * 还没做 Stride 的 ItemVirtualizationEnabled（只排看得见的子元素），样例没有用到。
 */
import { translation, type UIElement, type Vec2 } from '../UIElement';
import type { Orientation, ScrollInfo } from '../controls/ScrollViewer';
import { Panel } from './Panel';

const TOLERANCE = 1e-6;

export class StackPanel extends Panel implements ScrollInfo {
  #orientation: Orientation = 'vertical';
  #gap = 0;
  #scrollPosition = 0;
  #offset: Vec2 = [0, 0];
  #extent: Vec2 = [0, 0];
  #viewport: Vec2 = [0, 0];
  /** 每个子元素的起点（多一个终点），沿堆叠方向。 */
  #bounds: number[] = [];
  /** 能滚到的最后一个子元素。 */
  #maxScrollingIndex = 0;
  /** 布局失效时先记下的滚动请求，下次排列时做。 */
  #requests: (() => void)[] = [];

  get orientation(): Orientation { return this.#orientation; }
  set orientation(value: Orientation) {
    if (value === this.#orientation) return;
    this.#orientation = value;
    this.invalidateMeasure();
  }

  /** 子元素之间的空隙，虚拟像素。 */
  get gap(): number { return this.#gap; }
  set gap(value: number) {
    if (value === this.#gap) return;
    this.#gap = Math.max(0, value);
    this.invalidateMeasure();
  }

  get scrollPosition(): number { return this.#scrollPosition; }
  get extent(): readonly [number, number] { return this.#extent; }
  get offset(): readonly [number, number] { return this.#offset; }
  get viewport(): readonly [number, number] { return this.#viewport; }

  get #axis(): 0 | 1 {
    return this.#orientation === 'horizontal' ? 0 : 1;
  }

  protected override onLogicalChildAdded(element: UIElement, index: number): void {
    super.onLogicalChildAdded(element, index);
    if (index < Math.floor(this.#scrollPosition)) this.#scrollPosition++;
  }

  protected override onLogicalChildRemoved(element: UIElement, index: number): void {
    super.onLogicalChildRemoved(element, index);
    if (index < Math.floor(this.#scrollPosition)) this.#scrollPosition--;
  }

  protected override measureOverride(available: Vec2): Vec2 {
    this.#viewport = [available[0], available[1]];
    const axis = this.#axis, other = (1 - axis) as 0 | 1;
    const childAvailable: Vec2 = [available[0], available[1]];
    childAvailable[axis] = Infinity;
    const scrollMode = this.scrollOwner?.scrollMode;
    if (scrollMode === 'horizontal' || scrollMode === 'horizontalVertical') childAvailable[0] = Infinity;
    if (scrollMode === 'vertical' || scrollMode === 'horizontalVertical') childAvailable[1] = Infinity;

    const children = [...this.children];
    for (const child of children) child.measure(childAvailable);
    const desired: Vec2 = [0, 0];
    children.forEach((child, index) => {
      const gap = index < children.length - 1 && !children[index + 1]!.isCollapsed ? this.#gap : 0;
      desired[axis] += child.desiredSizeWithMargins[axis] + gap;
      desired[other] = Math.max(desired[other], child.desiredSizeWithMargins[other]);
    });
    return desired;
  }

  protected override arrangeOverride(finalSize: Vec2): Vec2 {
    this.#viewport = [finalSize[0], finalSize[1]];
    const axis = this.#axis;
    this.#arrangeChildren();
    this.#maxScrollingIndex = this.#bounds.length - 2;
    while (this.#maxScrollingIndex > 0 && this.#bounds[this.#maxScrollingIndex]! > this.#bounds.at(-1)! - this.#viewport[axis]) this.#maxScrollingIndex--;
    this.#extent = [finalSize[0], finalSize[1]];
    this.#extent[axis] = this.#bounds.at(-1)!;
    if (this.#requests.length > 0) for (const request of this.#requests) request();
    else this.#adjustOffsets(this.#scrollPosition);
    this.#requests = [];
    return finalSize;
  }

  #arrangeChildren(): void {
    const axis = this.#axis, other = (1 - axis) as 0 | 1;
    this.#bounds = [0];
    let first = true;
    for (const child of this.children) {
      if (child.visibility !== 'collapsed') {
        if (first) first = false;
        else this.#bounds[this.#bounds.length - 1]! += this.#gap;
      }
      const start = this.#bounds.at(-1)!;
      // 原点在面板的左上角
      const origin: Vec2 = [-this.#viewport[0] / 2, -this.#viewport[1] / 2];
      origin[axis] += start;
      child.arrangeMatrix = translation(origin[0], origin[1]);
      const size: Vec2 = [child.desiredSizeWithMargins[0], child.desiredSizeWithMargins[1]];
      size[other] = this.#viewport[other];
      child.arrange(size, this.isCollapsed);
      const margin = child.margin;
      const next = start + child.renderSize[axis] + margin[axis] + margin[axis + 2]!;
      this.#bounds.push(child.isCollapsed ? start : next);
    }
  }

  // ---- 滚动（ScrollInfo）----
  canScroll(direction: 0 | 1): boolean {
    return direction === this.#axis;
  }

  /** 滚动条的位置，0 到 1。 */
  get scrollBarPositions(): readonly [number, number] {
    const ratio: Vec2 = [0, 0];
    const axis = this.#axis;
    if (this.children.length === 0) return ratio;
    const range = this.#extent[axis] - this.#viewport[axis];
    if (range <= TOLERANCE) return ratio;
    const index = Math.floor(this.#scrollPosition);
    const remainder = this.#scrollPosition - index;
    if (this.#bounds.length > index + 1) {
      const previous = this.#bounds[index]!, next = this.#bounds[index + 1]!;
      ratio[axis] = Math.min(1, (previous + remainder * (next - previous)) / range);
    }
    return ratio;
  }

  /** 滚到第 index 个子元素（可以带小数）。 */
  scrollToElement(index: number): void {
    if (this.isArrangeValid) this.#adjustOffsets(index);
    else {
      this.invalidateArrange();
      this.#requests = [() => this.#adjustOffsets(index)];
    }
  }

  scrollToBeginning(direction: 0 | 1): void {
    if (direction === this.#axis) this.scrollToElement(0);
  }

  scrollToEnd(direction: 0 | 1): void {
    if (direction === this.#axis) this.scrollToElement(Number.MAX_SAFE_INTEGER);
  }

  /** 沿堆叠方向滚动 offsets 里那一维的距离（虚拟像素）。 */
  scrollOf(offsets: readonly [number, number]): void {
    const offset = offsets[this.#axis];
    if (Math.abs(offset) < TOLERANCE) return;
    if (!this.isArrangeValid) {
      this.invalidateArrange();
      this.#requests.push(() => this.#scrollBy(offset));
      return;
    }
    this.#scrollBy(offset);
  }

  #scrollBy(offset: number): void {
    const axis = this.#axis;
    const distance = Math.abs(offset);
    let index = Math.floor(this.#scrollPosition);
    const currentSize = this.#childSize(index, axis);
    const inChild = (this.#scrollPosition - index) * currentSize;
    const forward = offset > 0;
    let accumulated = forward ? -inChild : inChild - currentSize;
    let size = currentSize;
    while (accumulated + size < distance && (forward ? index < this.children.length - 1 : index > 0)) {
      index += Math.sign(offset);
      accumulated += size;
      size = this.#childSize(index, axis);
    }
    const remainder = distance - accumulated;
    const partial = forward ? remainder : size - remainder;
    this.#adjustOffsets(index + partial / size);
  }

  #adjustOffsets(desiredScrollPosition: number): void {
    this.#offset = [0, 0];
    const axis = this.#axis;
    if (this.#bounds.length < 2) {
      this.#scrollPosition = 0;
    } else {
      const lower = this.#bounds[this.#maxScrollingIndex]!;
      const upper = this.#bounds[this.#maxScrollingIndex + 1]!;
      let maxScrollPosition = this.#maxScrollingIndex;
      if (upper - lower > TOLERANCE) maxScrollPosition += Math.min(1 - TOLERANCE, (this.#extent[axis] - this.#viewport[axis] - lower) / (upper - lower));
      this.#scrollPosition = Math.max(0, Math.min(maxScrollPosition, desiredScrollPosition));
      this.#offset[axis] = -this.#bounds[Math.floor(this.#scrollPosition)]!;
    }
    const index = Math.floor(this.#scrollPosition);
    this.#offset[axis] -= (this.#scrollPosition - index) * this.#childSize(index, axis);
    this.scrollOwner?.invalidateScrollInfo();
  }

  /** 第 index 个子元素沿 dimension 的大小（含外边距和后面的空隙）。 */
  #childSize(index: number, dimension: 0 | 1): number {
    const children = [...this.children];
    const child = children[index];
    if (!child) return 0;
    const gap = index < children.length - 1 && !children[index + 1]!.isCollapsed ? this.#gap : 0;
    if (child.isCollapsed) return gap;
    return child.renderSize[dimension] + child.margin[dimension] + child.margin[dimension + 2]! + gap;
  }
}
