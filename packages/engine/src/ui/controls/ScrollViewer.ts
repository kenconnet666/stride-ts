/**
 * 滚动视图（Stride 的 ScrollViewer）：内容比自己大时可以滚动，裁到自己的矩形里，滚动时显示滚动条、停下后慢慢淡出。
 * 内容能自己滚动（ScrollInfo，比如 StackPanel 沿堆叠方向）时交给内容，否则自己按偏移移动内容。
 * 拖动和惯性由 UI 输入（step 4）喂给 lastFrameTranslation 和速度。没有做 Stride 的 SnapToAnchors（样例没有用到）。
 */
import type { TouchEventArgs } from '../events';
import { multiply, sizeWithoutThickness, sizeWithThickness, translation, UIElement, type Color, type Vec2 } from '../UIElement';
import { ContentControl } from './ContentControl';

export type Orientation = 'horizontal' | 'vertical';
export type ScrollingMode = 'none' | 'horizontal' | 'vertical' | 'horizontalVertical';

/** 能自己滚动的内容（Stride 的 IScrollInfo）。 */
export interface ScrollInfo {
  scrollOwner: ScrollViewer | null;
  canScroll(direction: 0 | 1): boolean;
  readonly extent: readonly [number, number];
  readonly offset: readonly [number, number];
  readonly viewport: readonly [number, number];
  /** 0 到 1。 */
  readonly scrollBarPositions: readonly [number, number];
  scrollToBeginning(direction: 0 | 1): void;
  scrollToEnd(direction: 0 | 1): void;
  scrollOf(offsets: readonly [number, number]): void;
}

const TOLERANCE = 1e-6;
/** 滚动条每秒淡出的比例。 */
const SCROLL_BAR_HIDING_SPEED = 1;

function directions(mode: ScrollingMode): readonly (0 | 1)[] {
  return mode === 'horizontal' ? [0] : mode === 'vertical' ? [1] : mode === 'horizontalVertical' ? [0, 1] : [];
}

function isScrollInfo(element: UIElement | null): element is UIElement & ScrollInfo {
  return element !== null && 'scrollOf' in element && 'canScroll' in element;
}

/** 滚动条（Stride 的 ScrollBar）：一个有颜色的矩形，ScrollViewer 摆放它。 */
export class ScrollBar extends UIElement {
  barColor: Color = [0, 0, 0, 0];
}

export class ScrollViewer extends ContentControl {
  /** 滚动条的颜色（sRGB）。 */
  scrollBarColor: Color = [0.1, 0.1, 0.1, 1];
  scrollBarThickness = 6;
  /** 拖动多远（虚拟像素）才开始滚动。 */
  scrollStartThreshold = 10;
  #deceleration = 1500;
  #scrollMode: ScrollingMode = 'horizontal';
  #touchScrollingEnabled = true;
  /** 内容的偏移（自己滚动的那几维），≤ 0。 */
  #scrollOffsets: Vec2 = [0, 0];
  /** 现在的滚动速度，虚拟像素每秒。 */
  currentScrollingSpeed: Vec2 = [0, 0];
  /** 这一帧要滚的距离（拖动时由输入设）。 */
  lastFrameTranslation: Vec2 = [0, 0];
  /** 用户正在拖着滚动。 */
  isUserScrollingViewer = false;
  #userManuallyScrolled = false;
  #isTouchedDown = false;
  #accumulatedTranslation: Vec2 = [0, 0];
  #viewport: Vec2 = [0, 0];
  #requests: { value: Vec2; relative: boolean }[] = [];
  readonly scrollBars: readonly [ScrollBar, ScrollBar] = [new ScrollBar(), new ScrollBar()];

  constructor() {
    super();
    for (const bar of this.scrollBars) {
      bar.measure([0, 0]);
      UIElement.setVisualParent(bar, this);
    }
    this.canBeHitByUser = this.#touchScrollingEnabled;
    this.clipToBounds = true;
  }

  get viewport(): readonly [number, number] { return this.#viewport; }
  /** 滚到的位置（偏移取反）。 */
  get scrollPosition(): readonly [number, number] { return [0 - this.#scrollOffsets[0], 0 - this.#scrollOffsets[1]]; }

  get deceleration(): number { return this.#deceleration; }
  set deceleration(value: number) { if (!Number.isNaN(value)) this.#deceleration = value; }

  get scrollMode(): ScrollingMode { return this.#scrollMode; }
  set scrollMode(value: ScrollingMode) {
    if (value === this.#scrollMode) return;
    this.#scrollMode = value;
    this.#scrollOffsets = [0, 0];
    const content = this.#scrollInfo;
    content?.scrollToBeginning(0);
    content?.scrollToBeginning(1);
    this.invalidateMeasure();
  }

  get touchScrollingEnabled(): boolean { return this.#touchScrollingEnabled; }
  set touchScrollingEnabled(value: boolean) {
    this.#touchScrollingEnabled = value;
    this.canBeHitByUser = value;
  }

  override get content(): UIElement | null { return super.content; }
  override set content(value: UIElement | null) {
    if (value === super.content) return;
    const old = this.#scrollInfo;
    if (old) old.scrollOwner = null;
    super.content = value;
    this.hideScrollBars();
    this.stopCurrentScrolling();
    this.#scrollOffsets = [0, 0];
    const info = this.#scrollInfo;
    if (info) info.scrollOwner = this;
    // 滚动条画在内容上面
    this.visualChildrenList.sort((a, b) => Number(a instanceof ScrollBar) - Number(b instanceof ScrollBar));
  }

  get #scrollInfo(): (UIElement & ScrollInfo) | null {
    const content = super.content;
    return isScrollInfo(content) ? content : null;
  }

  canScroll(direction: 0 | 1): boolean {
    return directions(this.#scrollMode).includes(direction);
  }

  stopCurrentScrolling(): void {
    this.currentScrollingSpeed = [0, 0];
  }

  hideScrollBars(): void {
    for (const d of directions(this.#scrollMode)) this.scrollBars[d].barColor = [0, 0, 0, 0];
  }

  /** 滚到开头或结尾。 */
  scrollToBeginning(direction: 0 | 1, stopScrolling = true): void {
    this.#scrollToExtremity(direction, stopScrolling, true);
  }

  scrollToEnd(direction: 0 | 1, stopScrolling = true): void {
    this.#scrollToExtremity(direction, stopScrolling, false);
  }

  #scrollToExtremity(direction: 0 | 1, stopScrolling: boolean, beginning: boolean): void {
    if (stopScrolling) {
      this.hideScrollBars();
      this.stopCurrentScrolling();
    }
    this.#userManuallyScrolled = true;
    if (!this.canScroll(direction)) return;
    const info = this.#scrollInfo;
    if (info?.canScroll(direction)) {
      if (beginning) info.scrollToBeginning(direction);
      else info.scrollToEnd(direction);
      return;
    }
    const step: Vec2 = [0, 0];
    step[direction] = beginning ? -Infinity : Infinity;
    this.scrollOf(step, stopScrolling);
  }

  /** 滚到绝对位置。 */
  scrollTo(position: readonly [number, number], stopScrolling = true): void {
    if (stopScrolling) {
      this.hideScrollBars();
      this.stopCurrentScrolling();
    }
    this.#userManuallyScrolled = true;
    if (!this.visualContent) return;
    const info = this.#scrollInfo;
    if (info) {
      const corrected: Vec2 = [0, 0];
      for (const d of directions(this.#scrollMode)) corrected[d] = position[d];
      info.scrollToBeginning(0);
      info.scrollToBeginning(1);
      info.scrollOf(corrected);
    }
    if (this.isArrangeValid) {
      this.#updateScrollOffsets([-position[0], -position[1]]);
      this.#updateContentArrangeMatrix();
    } else {
      this.invalidateArrange();
      this.#requests = [{ value: [position[0], position[1]], relative: false }];
    }
  }

  /** 滚动一段距离（虚拟像素，正的是往后、往下）。 */
  scrollOf(step: readonly [number, number], stopScrolling = true): void {
    this.#userManuallyScrolled = true;
    this.#scrollBy(step, stopScrolling);
  }

  #scrollBy(step: readonly [number, number], stopScrolling: boolean): void {
    if (stopScrolling) {
      this.hideScrollBars();
      this.stopCurrentScrolling();
    }
    if (!this.visualContent) return;
    const corrected: Vec2 = [0, 0];
    for (const d of directions(this.#scrollMode)) corrected[d] = step[d];
    this.#scrollInfo?.scrollOf(corrected);
    if (this.isArrangeValid) {
      this.#updateScrollOffsets([this.#scrollOffsets[0] - step[0], this.#scrollOffsets[1] - step[1]]);
      this.#updateContentArrangeMatrix();
    } else {
      this.invalidateArrange();
      this.#requests.push({ value: [step[0], step[1]], relative: true });
    }
  }

  /** 偏移限制在 [视口 - 内容, 0] 里；到头时速度归零。 */
  #updateScrollOffsets(desired: Vec2): void {
    const content = this.visualContent!;
    const contentSize = sizeWithoutThickness(sizeWithoutThickness(content.renderSize, this.margin), this.padding);
    for (const d of directions(this.#scrollMode)) {
      if (this.#scrollInfo?.canScroll(d)) {
        this.#scrollOffsets[d] = 0;
        continue;
      }
      this.#scrollOffsets[d] = desired[d];
      const minimum = this.#viewport[d] - contentSize[d];
      if (this.#scrollOffsets[d] < minimum) {
        this.#scrollOffsets[d] = minimum;
        this.currentScrollingSpeed[d] = 0;
      }
      if (this.#scrollOffsets[d] > 0) {
        this.#scrollOffsets[d] = 0;
        this.currentScrollingSpeed[d] = 0;
      }
    }
  }

  override get isEnabled(): boolean { return super.isEnabled; }
  override set isEnabled(value: boolean) {
    if (!value) this.hideScrollBars();
    super.isEnabled = value;
  }

  protected override measureOverride(available: Vec2): Vec2 {
    let childDesired: Vec2 = [0, 0];
    const content = this.visualContent;
    if (content) {
      const childAvailable = sizeWithoutThickness(available, this.padding);
      for (const d of directions(this.#scrollMode)) {
        if (!this.#scrollInfo?.canScroll(d)) childAvailable[d] = Infinity;
      }
      content.measure(childAvailable);
      childDesired = content.desiredSizeWithMargins;
    }
    return sizeWithThickness(childDesired, this.padding);
  }

  protected override arrangeOverride(finalSize: Vec2): Vec2 {
    this.#viewport = [finalSize[0], finalSize[1]];
    const content = this.visualContent;
    if (content) {
      const childSize = sizeWithoutThickness(finalSize, this.padding);
      for (const d of directions(this.#scrollMode)) {
        if (!this.#scrollInfo?.canScroll(d)) childSize[d] = Math.max(content.desiredSizeWithMargins[d], childSize[d]);
      }
      content.arrange(childSize, this.isCollapsed);
      this.#updateScrollBarsSize();
      if (this.#requests.length > 0) {
        for (const request of this.#requests) {
          this.#updateScrollOffsets(request.relative
            ? [this.#scrollOffsets[0] - request.value[0], this.#scrollOffsets[1] - request.value[1]]
            : [-request.value[0], -request.value[1]]);
        }
      } else {
        this.#updateScrollOffsets(this.#scrollOffsets);
      }
      this.#updateContentArrangeMatrix();
    }
    this.#requests = [];
    return finalSize;
  }

  #updateScrollBarsSize(): void {
    for (const bar of this.scrollBars) bar.arrange([0, 0], false);
    const content = this.visualContent!;
    const info = this.#scrollInfo;
    for (const d of directions(this.#scrollMode)) {
      const contentLength = info ? info.extent[d] : content.renderSize[d] + content.margin[d] + content.margin[d + 2]!;
      const length = Math.min(1, this.#viewport[d] / contentLength) * this.#viewport[d];
      const size: Vec2 = [0, 0];
      for (const e of [0, 1] as const) size[e] = e === d ? length : Math.min(this.scrollBarThickness, this.#viewport[e]);
      this.scrollBars[d].arrange(size, this.isCollapsed);
    }
  }

  #updateContentArrangeMatrix(): void {
    const offsets: Vec2 = [this.#scrollOffsets[0], this.#scrollOffsets[1]];
    const info = this.#scrollInfo;
    for (const d of [0, 1] as const) if (info?.canScroll(d)) offsets[d] = info.offset[d];
    this.visualContent!.arrangeMatrix = translation(offsets[0] + this.padding[0] - this.#viewport[0] / 2, offsets[1] + this.padding[1] - this.#viewport[1] / 2);
  }

  /** @internal 内容自己滚动后调用（StackPanel）：到头时停下，更新滚动条和内容的位置。 */
  invalidateScrollInfo(): void {
    const info = this.#scrollInfo;
    if (!info) return;
    for (const d of [0, 1] as const) {
      const position = info.scrollBarPositions[d];
      if (position < TOLERANCE || position > 1 - TOLERANCE) this.currentScrollingSpeed[d] = 0;
    }
    this.#updateScrollBarsSize();
    this.#updateContentArrangeMatrix();
  }

  /** 惯性滚动、减速、滚动条淡出。 */
  protected override onUpdate(elapsedSeconds: number): void {
    if (!this.isEnabled || elapsedSeconds < TOLERANCE) return;
    if (this.isUserScrollingViewer || this.#userManuallyScrolled) {
      this.#userManuallyScrolled = false;
      if (this.isUserScrollingViewer) this.currentScrollingSpeed = [this.lastFrameTranslation[0] / elapsedSeconds, this.lastFrameTranslation[1] / elapsedSeconds];
    } else {
      this.lastFrameTranslation = [elapsedSeconds * this.currentScrollingSpeed[0], elapsedSeconds * this.currentScrollingSpeed[1]];
    }
    for (const d of directions(this.#scrollMode)) {
      const speed = this.currentScrollingSpeed[d];
      this.currentScrollingSpeed[d] = Math.sign(speed) * Math.max(0, Math.abs(speed) - elapsedSeconds * this.#deceleration);
    }
    if (this.lastFrameTranslation[0] !== 0 || this.lastFrameTranslation[1] !== 0) this.#scrollBy(this.lastFrameTranslation, false);
    for (const d of [0, 1] as const) {
      const bar = this.scrollBars[d];
      const fade = Math.abs(this.currentScrollingSpeed[d]) < TOLERANCE && (!this.#touchScrollingEnabled || !this.isUserScrollingViewer);
      // Stride 按字节减：每秒减掉滚动条颜色的 SCROLL_BAR_HIDING_SPEED 倍
      bar.barColor = fade
        ? bar.barColor.map((channel, i) => Math.max(0, channel - this.scrollBarColor[i]! * SCROLL_BAR_HIDING_SPEED * elapsedSeconds)) as unknown as Color
        : this.scrollBarColor;
    }
    this.lastFrameTranslation = [0, 0];
  }

  // ---- 拖动（Stride 的 OnPreviewTouch*）：拖过 scrollStartThreshold 才开始滚，滚动时吞掉指针事件，里面的按钮不会被点到 ----
  protected override onPreviewTouchDown(args: TouchEventArgs): void {
    super.onPreviewTouchDown(args);
    this.stopCurrentScrolling();
    this.#accumulatedTranslation = [0, 0];
    this.#isTouchedDown = true;
  }

  protected override onPreviewTouchUp(args: TouchEventArgs): void {
    super.onPreviewTouchUp(args);
    if (this.isUserScrollingViewer) {
      args.handled = true;
      leaveTouchedChildren(this, args);
    }
    this.isUserScrollingViewer = false;
    this.#isTouchedDown = false;
  }

  protected override onTouchEnter(args: TouchEventArgs): void {
    super.onTouchEnter(args);
    this.stopCurrentScrolling();
    this.#accumulatedTranslation = [0, 0];
  }

  protected override onTouchLeave(args: TouchEventArgs): void {
    super.onTouchLeave(args);
    this.isUserScrollingViewer = false;
    this.#isTouchedDown = false;
  }

  protected override onPreviewTouchMove(args: TouchEventArgs): void {
    super.onPreviewTouchMove(args);
    if (this.#scrollMode === 'none' || !this.#touchScrollingEnabled || !this.#isTouchedDown) return;
    for (const d of directions(this.#scrollMode)) this.lastFrameTranslation[d] -= args.worldTranslation[d];
    this.#accumulatedTranslation = [this.#accumulatedTranslation[0] + this.lastFrameTranslation[0], this.#accumulatedTranslation[1] + this.lastFrameTranslation[1]];
    if (!this.isUserScrollingViewer && Math.hypot(...this.#accumulatedTranslation) > this.scrollStartThreshold) {
      this.isUserScrollingViewer = true;
      this.lastFrameTranslation = [...this.#accumulatedTranslation];
    }
    if (this.isUserScrollingViewer) args.handled = true;
  }

  /** 滚动条摆在右边、下边，位置按滚动的比例。 */
  protected override updateChildrenWorldMatrix(): void {
    const content = this.visualContent;
    if (!content) return;
    content.updateWorldMatrix(multiply(content.arrangeMatrix, this.worldMatrix));
    const info = this.#scrollInfo;
    for (const d of directions(this.#scrollMode)) {
      const bar = this.scrollBars[d];
      const position: Vec2 = [this.renderSize[0] / 2 - bar.renderSize[0], this.renderSize[1] / 2 - bar.renderSize[1]];
      const range = content.desiredSizeWithMargins[d] - this.#viewport[d];
      let ratio = 0;
      if (info?.canScroll(d)) ratio = -info.scrollBarPositions[d];
      else if (range > TOLERANCE) ratio = this.#scrollOffsets[d] / range;
      position[d] = -(this.renderSize[d] / 2 + ratio * (this.renderSize[d] - bar.renderSize[d]));
      // 滚动条的世界矩阵：这个元素的世界矩阵平移到滚动条左上角（滚动条自己再加上半个大小到中心）
      bar.updateWorldMatrix(multiply(translation(position[0], position[1]), this.worldMatrix));
    }
  }
}

/** 开始拖动滚动后，里面被按着的元素都收到移出（按钮不再算按下）。 */
function leaveTouchedChildren(parent: UIElement, args: TouchEventArgs): void {
  for (const child of parent.visualChildren) {
    if (!child.isTouched) continue;
    const copy = Object.assign(Object.create(Object.getPrototypeOf(args) as object) as TouchEventArgs, args, { handled: false, source: undefined });
    child.raiseTouchLeave(copy);
    leaveTouchedChildren(child, args);
  }
}
