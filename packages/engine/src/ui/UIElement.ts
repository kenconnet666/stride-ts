/**
 * UI 元素的基类（Stride 的 UIElement）：布局属性、两遍布局（Measure 算想要的大小，Arrange 定最终的大小和位置）、
 * 世界矩阵、按树的顺序画。规则照 Stride 的源码移植，只是两维（见 docs/decisions.md）：没有深度方向的尺寸和对齐。
 *
 * 坐标是 UI 的虚拟分辨率，(0, 0) 在左上角，y 向下。每个元素的世界矩阵把"以元素中心为原点"的坐标换到虚拟坐标
 * （Stride 的 WorldMatrix 也以元素中心为原点，只是整个 UI 的原点在虚拟分辨率的中心）。
 *
 * 和 Stride 一样，尺寸属性里 NaN 表示没设（按内容或对齐决定），最大值默认是无穷大。
 *
 * 指针事件（events.ts 的路由事件）：按下、移动、松开先走隧道的 Preview 版本再走冒泡的；元素自己的反应写在 onTouchDown 这些
 * 方法里（Stride 的类处理函数），只在元素和它的父元素都启用时调用。
 */
import type { UISystem } from './UISystem';
import { addHandler, raiseEvent, registerClassHandler, removeHandler, RoutedEvent, type RoutedEventArgs, type RoutedEventHandler, type TouchEventArgs } from './events';
export type Vec2 = [number, number];
/** 左、上、右、下。 */
export type Thickness = readonly [left: number, top: number, right: number, bottom: number];
/** sRGB 的 r、g、b、a（0 到 1），同 Stride 的 Color。 */
export type Color = readonly [number, number, number, number];
export type HorizontalAlignment = 'left' | 'center' | 'right' | 'stretch';
export type VerticalAlignment = 'top' | 'center' | 'bottom' | 'stretch';
export type Visibility = 'visible' | 'hidden' | 'collapsed';
/** 二维仿射矩阵 [a, b, c, d, e, f]：x' = a·x + c·y + e，y' = b·x + d·y + f（同 canvas 的 setTransform）。 */
export type Matrix2D = readonly [number, number, number, number, number, number];

export const IDENTITY: Matrix2D = [1, 0, 0, 1, 0, 0];
/** 指针在不在元素上（Stride 的 MouseOverState）：在元素本身上、在某个子元素上、不在。 */
export type MouseOverState = 'none' | 'element' | 'child';
export const TRANSPARENT: Color = [0, 0, 0, 0];
const NO_THICKNESS: Thickness = [0, 0, 0, 0];

/** 先做 first 再做 second。 */
export function multiply(first: Matrix2D, second: Matrix2D): Matrix2D {
  const [a1, b1, c1, d1, e1, f1] = first, [a2, b2, c2, d2, e2, f2] = second;
  return [a2 * a1 + c2 * b1, b2 * a1 + d2 * b1, a2 * c1 + c2 * d1, b2 * c1 + d2 * d1, a2 * e1 + c2 * f1 + e2, b2 * e1 + d2 * f1 + f2];
}

export function translation(x: number, y: number): Matrix2D {
  return [1, 0, 0, 1, x, y];
}

/** 布局时 UI 所在的画面（Stride 的 LayoutingContext）：文字按真实像素的字号量。 */
export interface LayoutingContext {
  readonly virtualResolution: readonly [number, number];
  readonly realResolution: readonly [number, number];
  /** 真实像素 / 虚拟像素。 */
  readonly realVirtualResolutionRatio: readonly [number, number];
}

/** MathUtil.Clamp：NaN 原样返回。 */
export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export function sizeWithoutThickness(size: readonly [number, number], t: Thickness): Vec2 {
  return [Math.max(0, size[0] - t[0] - t[2]), Math.max(0, size[1] - t[1] - t[3])];
}

export function sizeWithThickness(size: readonly [number, number], t: Thickness): Vec2 {
  return [Math.max(0, size[0] + t[0] + t[2]), Math.max(0, size[1] + t[1] + t[3])];
}

export abstract class UIElement {
  name: string | null = null;
  /** 背景色，画在元素的矩形上。 */
  backgroundColor: Color = TRANSPARENT;
  /** 把子元素裁到自己的矩形里。 */
  clipToBounds = false;
  /** 这个元素自己画几层（Stride 的 DrawLayerNumber，决定前后）：背景 1 层，按钮的图、装饰的图各加 1 层。 */
  drawLayerNumber = 1;
  /** 指针能不能点到它。 */
  canBeHitByUser = false;

  #width = NaN;
  #height = NaN;
  #minimumWidth = 0;
  #minimumHeight = 0;
  #maximumWidth = Infinity;
  #maximumHeight = Infinity;
  #defaultWidth = 0;
  #defaultHeight = 0;
  #margin: Thickness = NO_THICKNESS;
  #horizontalAlignment: HorizontalAlignment = 'stretch';
  #verticalAlignment: VerticalAlignment = 'stretch';
  #visibility: Visibility = 'visible';
  #opacity = 1;
  #isEnabled = true;
  #localMatrix: Matrix2D = IDENTITY;

  // 附加属性（Stride 里由面板注册的 DependencyProperty：GridBase 的行列、Panel 的 ZIndex、Canvas 的位置）
  #gridRow = 0;
  #gridColumn = 0;
  #gridRowSpan = 1;
  #gridColumnSpan = 1;
  #panelZIndex = 0;
  #canvasUseAbsolutePosition = true;
  #canvasAbsolutePosition: Vec2 = [0, 0];
  #canvasRelativePosition: Vec2 = [0, 0];
  #canvasRelativeSize: Vec2 = [NaN, NaN];
  #canvasPinOrigin: Vec2 = [0, 0];

  /** 逻辑上的父元素（面板的 Children、内容控件的 Content）。 */
  parent: UIElement | null = null;
  /** 画和布局时的父元素（通常和 parent 一样；ScrollViewer 的滚动条只有视觉父元素）。 */
  visualParent: UIElement | null = null;
  /** 按画的顺序（面板按 ZIndex 排过）。 */
  protected readonly visualChildrenList: UIElement[] = [];

  desiredSize: Vec2 = [0, 0];
  desiredSizeWithMargins: Vec2 = [0, 0];
  renderSize: Vec2 = [0, 0];
  /** 元素左上角相对给它的空间左上角的偏移（含外边距和对齐）。 */
  renderOffsets: Vec2 = [0, 0];
  /** 以元素中心为原点的坐标 → 虚拟坐标。 */
  worldMatrix: Matrix2D = IDENTITY;
  /** 父元素给它的位置：相对父元素中心（面板、内容控件排列时设）。 */
  arrangeMatrix: Matrix2D = IDENTITY;
  /** 乘上了所有父元素的不透明度。 */
  renderOpacity = 1;
  /** 画的先后（Stride 的 DepthBias）：越大越靠前。 */
  depthBias = 0;
  maxChildrenDepthBias = 0;
  #isHierarchyEnabled = true;

  /** 有指针按在它（或它的子元素）上。 */
  isTouched = false;
  #mouseOverState: MouseOverState = 'none';

  isMeasureValid = false;
  isArrangeValid = false;
  #forceNextMeasure = true;
  #forceNextArrange = true;
  #previousMeasureSize: Vec2 = [-1, -1];
  #previousArrangeSize: Vec2 = [-1, -1];
  #previousParentCollapsed = false;
  #layoutingContext: LayoutingContext | null = null;
  #uiSystem: UISystem | null = null;

  get visualChildren(): readonly UIElement[] {
    return this.visualChildrenList;
  }

  get width(): number { return this.#width; }
  set width(value: number) { this.#width = clamp(value, 0, Number.MAX_VALUE); this.invalidateMeasure(); }
  get height(): number { return this.#height; }
  set height(value: number) { this.#height = clamp(value, 0, Number.MAX_VALUE); this.invalidateMeasure(); }
  get minimumWidth(): number { return this.#minimumWidth; }
  set minimumWidth(value: number) { if (!Number.isNaN(value)) { this.#minimumWidth = clamp(value, 0, Number.MAX_VALUE); this.invalidateMeasure(); } }
  get minimumHeight(): number { return this.#minimumHeight; }
  set minimumHeight(value: number) { if (!Number.isNaN(value)) { this.#minimumHeight = clamp(value, 0, Number.MAX_VALUE); this.invalidateMeasure(); } }
  get maximumWidth(): number { return this.#maximumWidth; }
  set maximumWidth(value: number) { if (!Number.isNaN(value)) { this.#maximumWidth = clamp(value, 0, Infinity); this.invalidateMeasure(); } }
  get maximumHeight(): number { return this.#maximumHeight; }
  set maximumHeight(value: number) { if (!Number.isNaN(value)) { this.#maximumHeight = clamp(value, 0, Infinity); this.invalidateMeasure(); } }
  /** 宽高没设、内容也没给出时用的大小。 */
  get defaultWidth(): number { return this.#defaultWidth; }
  set defaultWidth(value: number) { if (!Number.isNaN(value)) { this.#defaultWidth = clamp(value, 0, Number.MAX_VALUE); this.invalidateMeasure(); } }
  get defaultHeight(): number { return this.#defaultHeight; }
  set defaultHeight(value: number) { if (!Number.isNaN(value)) { this.#defaultHeight = clamp(value, 0, Number.MAX_VALUE); this.invalidateMeasure(); } }
  get margin(): Thickness { return this.#margin; }
  set margin(value: Thickness) { this.#margin = value; this.invalidateMeasure(); }
  get horizontalAlignment(): HorizontalAlignment { return this.#horizontalAlignment; }
  set horizontalAlignment(value: HorizontalAlignment) { this.#horizontalAlignment = value; this.invalidateArrange(); }
  get verticalAlignment(): VerticalAlignment { return this.#verticalAlignment; }
  set verticalAlignment(value: VerticalAlignment) { this.#verticalAlignment = value; this.invalidateArrange(); }
  get visibility(): Visibility { return this.#visibility; }
  set visibility(value: Visibility) {
    if (value === this.#visibility) return;
    this.#visibility = value;
    this.invalidateMeasure();
  }
  get opacity(): number { return this.#opacity; }
  set opacity(value: number) { if (!Number.isNaN(value)) this.#opacity = clamp(value, 0, 1); }
  get isEnabled(): boolean { return this.#isEnabled; }
  set isEnabled(value: boolean) { this.#isEnabled = value; }
  /** 自己和所有父元素都启用。 */
  get isHierarchyEnabled(): boolean { return this.#isHierarchyEnabled; }
  get isVisible(): boolean { return this.#visibility === 'visible'; }
  get isCollapsed(): boolean { return this.#visibility === 'collapsed'; }
  /** 布局之后的局部变换（旋转、缩放），以元素中心为原点。 */
  get localMatrix(): Matrix2D { return this.#localMatrix; }
  set localMatrix(value: Matrix2D) { this.#localMatrix = value; }
  get actualWidth(): number { return this.renderSize[0]; }
  get actualHeight(): number { return this.renderSize[1]; }

  // ---- 附加属性 ----
  /** 在 Grid、UniformGrid 里的行（Stride 的 GridBase.RowPropertyKey，扩展方法 SetGridRow）。 */
  get gridRow(): number { return this.#gridRow; }
  set gridRow(value: number) { this.#gridRow = Math.max(0, Math.trunc(value)); this.#invalidateParentMeasure(); }
  get gridColumn(): number { return this.#gridColumn; }
  set gridColumn(value: number) { this.#gridColumn = Math.max(0, Math.trunc(value)); this.#invalidateParentMeasure(); }
  get gridRowSpan(): number { return this.#gridRowSpan; }
  set gridRowSpan(value: number) { this.#gridRowSpan = Math.max(1, Math.trunc(value)); this.#invalidateParentMeasure(); }
  get gridColumnSpan(): number { return this.#gridColumnSpan; }
  set gridColumnSpan(value: number) { this.#gridColumnSpan = Math.max(1, Math.trunc(value)); this.#invalidateParentMeasure(); }
  /** 在面板里画的先后（Stride 的 Panel.ZIndexPropertyKey）：大的后画、在上面。 */
  get panelZIndex(): number { return this.#panelZIndex; }
  set panelZIndex(value: number) {
    this.#panelZIndex = Math.trunc(value);
    this.visualParent?.onChildZIndexChanged();
  }
  /** 在 Canvas 里用绝对位置（true）还是相对位置。 */
  get canvasUseAbsolutePosition(): boolean { return this.#canvasUseAbsolutePosition; }
  set canvasUseAbsolutePosition(value: boolean) { this.#canvasUseAbsolutePosition = value; this.#invalidateParentMeasure(); }
  /** Canvas 里钉住的位置，虚拟像素；某一维是 NaN 时用相对位置。 */
  get canvasAbsolutePosition(): readonly [number, number] { return this.#canvasAbsolutePosition; }
  set canvasAbsolutePosition(value: readonly [number, number]) { this.#canvasAbsolutePosition = [value[0], value[1]]; this.#invalidateParentMeasure(); }
  /** Canvas 里钉住的位置，按 Canvas 的大小的比例。 */
  get canvasRelativePosition(): readonly [number, number] { return this.#canvasRelativePosition; }
  set canvasRelativePosition(value: readonly [number, number]) { this.#canvasRelativePosition = [value[0], value[1]]; this.#invalidateParentMeasure(); }
  /** Canvas 里的大小，按 Canvas 的大小的比例；NaN 是不限。 */
  get canvasRelativeSize(): readonly [number, number] { return this.#canvasRelativeSize; }
  set canvasRelativeSize(value: readonly [number, number]) { this.#canvasRelativeSize = [Math.abs(value[0]), Math.abs(value[1])]; this.#invalidateParentMeasure(); }
  /** 元素上哪一点钉在那个位置，按元素大小的比例（0 到 1）。 */
  get canvasPinOrigin(): readonly [number, number] { return this.#canvasPinOrigin; }
  set canvasPinOrigin(value: readonly [number, number]) { this.#canvasPinOrigin = [clamp(value[0], 0, 1), clamp(value[1], 0, 1)]; this.#invalidateParentMeasure(); }

  #invalidateParentMeasure(): void {
    this.parent?.invalidateMeasure();
  }

  /** @internal 子元素的 ZIndex 变了（面板重新排画的顺序）。 */
  onChildZIndexChanged(): void {}

  // ---- 层级 ----
  /** 按名字找自己或后代（深度优先，同 Stride 的 FindName）。 */
  findName(name: string): UIElement | null {
    if (this.name === name) return this;
    for (const child of this.visualChildrenList) {
      const found = child.findName(name);
      if (found) return found;
    }
    return null;
  }

  /** 按名字和类型找自己或后代（Stride 的 FindVisualChildOfType）。 */
  find<T extends UIElement>(type: abstract new (...args: never[]) => T, name?: string): T | null {
    if (this instanceof type && (name === undefined || this.name === name)) return this;
    for (const child of this.visualChildrenList) {
      const found = child.find(type, name);
      if (found) return found;
    }
    return null;
  }

  protected static setParent(child: UIElement, parent: UIElement | null): void {
    if (parent && child.parent) throw new Error(`UI element '${child.name ?? child.constructor.name}' already has a parent`);
    child.parent = parent;
  }

  /** 设视觉父元素：从原来的父元素的视觉子元素里移走，加到新的后面（面板之后按 ZIndex 重排）。 */
  protected static setVisualParent(child: UIElement, parent: UIElement | null): void {
    const old = child.visualParent;
    if (old) old.visualChildrenList.splice(old.visualChildrenList.indexOf(child), 1);
    child.visualParent = parent;
    if (!parent) return;
    parent.visualChildrenList.push(child);
    if (parent.#layoutingContext) child.layoutingContext = parent.#layoutingContext;
  }

  /** 显示这棵树的 UI 系统（Stride 的 UIElementServices）：根元素上设，子元素沿父元素找。 */
  get uiSystem(): UISystem | null {
    return this.#uiSystem ?? this.visualParent?.uiSystem ?? null;
  }

  /** @internal UISystem 画根元素时设。 */
  set uiSystem(value: UISystem | null) {
    this.#uiSystem = value;
  }

  // ---- 布局 ----
  get layoutingContext(): LayoutingContext | null {
    return this.#layoutingContext;
  }

  set layoutingContext(value: LayoutingContext | null) {
    if (!value) return;
    const old = this.#layoutingContext;
    if (old && sameContext(old, value)) return;
    this.#forceMeasure();
    this.#layoutingContext = value;
    for (const child of this.visualChildrenList) child.layoutingContext = value;
  }

  /** 让下次布局重新量这个元素（向上传给父元素；子元素标记为要重新检查）。 */
  invalidateMeasure(): void {
    this.#forceMeasure();
    this.#propagateMeasureInvalidation();
  }

  invalidateArrange(): void {
    this.#forceArrange();
    this.#propagateArrangeInvalidation();
  }

  #propagateMeasureInvalidation(): void {
    for (const child of this.visualChildrenList) {
      if (!child.isMeasureValid) continue;
      child.isMeasureValid = false;
      child.isArrangeValid = false;
      child.#propagateMeasureInvalidation();
    }
  }

  #propagateArrangeInvalidation(): void {
    for (const child of this.visualChildrenList) {
      if (!child.isArrangeValid) continue;
      child.isArrangeValid = false;
      child.#propagateArrangeInvalidation();
    }
  }

  #forceMeasure(): void {
    if (this.#forceNextMeasure && this.#forceNextArrange) return;
    this.#forceNextMeasure = true;
    this.#forceNextArrange = true;
    this.isMeasureValid = false;
    this.isArrangeValid = false;
    if (this.visualParent) this.visualParent.#forceMeasure();
  }

  #forceArrange(): void {
    if (this.#forceNextArrange) return;
    this.isArrangeValid = false;
    this.#forceNextArrange = true;
    if (this.visualParent) this.visualParent.#forceArrange();
  }

  #validateChildrenMeasure(): void {
    for (const child of this.visualChildrenList) {
      if (child.isMeasureValid) continue;
      child.isMeasureValid = true;
      child.#validateChildrenMeasure();
    }
  }

  #validateChildrenArrange(): void {
    for (const child of this.visualChildrenList) {
      if (child.isArrangeValid) continue;
      child.isArrangeValid = true;
      child.#validateChildrenArrange();
    }
  }

  /** 第一遍：给出可用的空间（含外边距），算出 desiredSize。 */
  measure(availableSizeWithMargins: readonly [number, number]): void {
    if (!this.#forceNextMeasure && sameSize(availableSizeWithMargins, this.#previousMeasureSize)) {
      this.isMeasureValid = true;
      this.#validateChildrenMeasure();
      return;
    }
    this.#forceNextMeasure = false;
    this.isMeasureValid = true;
    this.isArrangeValid = false;
    this.#previousMeasureSize = [availableSizeWithMargins[0], availableSizeWithMargins[1]];

    if (this.isCollapsed) {
      this.desiredSize = [0, 0];
      this.desiredSizeWithMargins = [0, 0];
      return;
    }

    const size: Vec2 = [this.#width, this.#height];
    const available = sizeWithoutThickness(availableSizeWithMargins, this.#margin);
    const childrenAvailable: Vec2 = [
      Math.max(this.#minimumWidth, Math.min(this.#maximumWidth, Number.isNaN(size[0]) ? available[0] : size[0])),
      Math.max(this.#minimumHeight, Math.min(this.#maximumHeight, Number.isNaN(size[1]) ? available[1] : size[1])),
    ];
    const childrenDesired = this.measureOverride(childrenAvailable);
    for (const d of [0, 1] as const) {
      if (Number.isNaN(size[d])) size[d] = childrenDesired[d];
    }
    if (Number.isNaN(size[0])) size[0] = this.#defaultWidth;
    if (Number.isNaN(size[1])) size[1] = this.#defaultHeight;
    const desired = this.#infinityToParentRenderSize(size);
    desired[0] = Math.max(this.#minimumWidth, Math.min(this.#maximumWidth, desired[0]));
    desired[1] = Math.max(this.#minimumHeight, Math.min(this.#maximumHeight, desired[1]));
    this.desiredSize = desired;
    this.desiredSizeWithMargins = sizeWithThickness(desired, this.#margin);
  }

  /** 无穷大的尺寸换成父元素（再往上）的大小。 */
  #infinityToParentRenderSize(size: Vec2): Vec2 {
    let parent = this.parent;
    while ((!Number.isFinite(size[0]) || !Number.isFinite(size[1])) && parent) {
      for (const d of [0, 1] as const) if (!Number.isFinite(size[d])) size[d] = parent.renderSize[d];
      parent = parent.parent;
    }
    return size;
  }

  /** 子类算内容想要的大小（不含外边距）。 */
  protected measureOverride(_availableSizeWithoutMargins: Vec2): Vec2 {
    return [0, 0];
  }

  /** 第二遍：给出最终的空间（含外边距），定 renderSize 和 renderOffsets。 */
  arrange(finalSizeWithMargins: readonly [number, number], isParentCollapsed: boolean): void {
    if (!this.#forceNextArrange && sameSize(finalSizeWithMargins, this.#previousArrangeSize) && isParentCollapsed === this.#previousParentCollapsed) {
      this.isArrangeValid = true;
      this.#validateChildrenArrange();
      return;
    }
    this.#forceNextArrange = false;
    this.isArrangeValid = true;
    this.#previousParentCollapsed = isParentCollapsed;
    this.#previousArrangeSize = [finalSizeWithMargins[0], finalSizeWithMargins[1]];

    if (this.isCollapsed || isParentCollapsed) {
      this.collapseOverride();
      return;
    }

    const size: Vec2 = [this.#width, this.#height];
    const finalSize = sizeWithoutThickness(finalSizeWithMargins, this.#margin);
    if (Number.isNaN(size[0]) && this.#horizontalAlignment === 'stretch') size[0] = finalSize[0];
    if (Number.isNaN(size[1]) && this.#verticalAlignment === 'stretch') size[1] = finalSize[1];
    if (Number.isNaN(size[0])) size[0] = Math.min(this.desiredSize[0], finalSize[0]);
    if (Number.isNaN(size[1])) size[1] = Math.min(this.desiredSize[1], finalSize[1]);
    size[0] = Math.max(this.#minimumWidth, Math.min(this.#maximumWidth, size[0]));
    size[1] = Math.max(this.#minimumHeight, Math.min(this.#maximumHeight, size[1]));

    const arranged = this.arrangeOverride(size);
    this.renderOffsets = this.adjustmentOffsets(this.#margin, finalSizeWithMargins, arranged);
    this.renderSize = arranged;
  }

  /** 子类排列内容，返回实际用的大小（不含外边距）。 */
  protected arrangeOverride(finalSizeWithoutMargins: Vec2): Vec2 {
    return finalSizeWithoutMargins;
  }

  /** 折叠（Collapsed）时：大小都是 0，子元素跟着折叠。 */
  protected collapseOverride(): void {
    this.desiredSize = [0, 0];
    this.desiredSizeWithMargins = [0, 0];
    this.renderSize = [0, 0];
    this.renderOffsets = [0, 0];
    for (const child of this.visualChildrenList) {
      child.invalidateMeasure();
      child.collapseOverride();
    }
  }

  /** 按对齐方式把 usedSize 放进 providedSpace（Stride 的 CalculateAdjustmentOffsets）。 */
  protected adjustmentOffsets(thickness: Thickness, providedSpace: readonly [number, number], usedSize: readonly [number, number]): Vec2 {
    const used = sizeWithThickness(usedSize, thickness);
    const offsets: Vec2 = [thickness[0], thickness[1]];
    const h = this.#horizontalAlignment, v = this.#verticalAlignment;
    if (h === 'center' || h === 'stretch') offsets[0] += (providedSpace[0] - used[0]) / 2;
    else if (h === 'right') offsets[0] += providedSpace[0] - used[0];
    if (v === 'center' || v === 'stretch') offsets[1] += (providedSpace[1] - used[1]) / 2;
    else if (v === 'bottom') offsets[1] += providedSpace[1] - used[1];
    return offsets;
  }

  /** 鼠标在它上面（UI 输入每帧更新）。 */
  get mouseOverState(): MouseOverState { return this.#mouseOverState; }
  set mouseOverState(value: MouseOverState) {
    if (value === this.#mouseOverState) return;
    this.#mouseOverState = value;
    this.onMouseOverStateChanged();
  }

  /** mouseOverState 变了以后（按钮换悬停的图）。 */
  protected onMouseOverStateChanged(): void {}

  // ---- 事件 ----
  static readonly previewTouchDownEvent = new RoutedEvent<TouchEventArgs>('PreviewTouchDown', 'tunnel');
  static readonly previewTouchMoveEvent = new RoutedEvent<TouchEventArgs>('PreviewTouchMove', 'tunnel');
  static readonly previewTouchUpEvent = new RoutedEvent<TouchEventArgs>('PreviewTouchUp', 'tunnel');
  static readonly touchDownEvent = new RoutedEvent<TouchEventArgs>('TouchDown', 'bubble');
  static readonly touchEnterEvent = new RoutedEvent<TouchEventArgs>('TouchEnter', 'direct');
  static readonly touchLeaveEvent = new RoutedEvent<TouchEventArgs>('TouchLeave', 'direct');
  static readonly touchMoveEvent = new RoutedEvent<TouchEventArgs>('TouchMove', 'bubble');
  static readonly touchUpEvent = new RoutedEvent<TouchEventArgs>('TouchUp', 'bubble');

  /** 登记处理函数（Stride 的 AddHandler）；handledEventsToo 时处理过的事件也收到。 */
  addHandler<A extends RoutedEventArgs>(event: RoutedEvent<A>, handler: RoutedEventHandler<A>, handledEventsToo = false): void {
    addHandler(this, event, handler, handledEventsToo);
  }

  removeHandler<A extends RoutedEventArgs>(event: RoutedEvent<A>, handler: RoutedEventHandler<A>): void {
    removeHandler(this, event, handler);
  }

  /** 从这个元素发出事件（Stride 的 RaiseEvent）。 */
  raiseEvent(args: RoutedEventArgs): void {
    raiseEvent(this, args);
  }

  /** @internal UI 输入：按下（先 PreviewTouchDown 再 TouchDown）。 */
  raiseTouchDown(args: TouchEventArgs): void {
    this.#raise(args, UIElement.previewTouchDownEvent, UIElement.touchDownEvent);
  }

  /** @internal */
  raiseTouchMove(args: TouchEventArgs): void {
    this.#raise(args, UIElement.previewTouchMoveEvent, UIElement.touchMoveEvent);
  }

  /** @internal */
  raiseTouchUp(args: TouchEventArgs): void {
    this.#raise(args, UIElement.previewTouchUpEvent, UIElement.touchUpEvent);
  }

  /** @internal */
  raiseTouchEnter(args: TouchEventArgs): void {
    this.#raise(args, UIElement.touchEnterEvent);
  }

  /** @internal */
  raiseTouchLeave(args: TouchEventArgs): void {
    this.#raise(args, UIElement.touchLeaveEvent);
  }

  #raise(args: TouchEventArgs, ...events: RoutedEvent<TouchEventArgs>[]): void {
    for (const event of events) {
      args.routedEvent = event;
      raiseEvent(this, args);
    }
  }

  protected onPreviewTouchDown(_args: TouchEventArgs): void {
    this.isTouched = true;
  }

  protected onPreviewTouchMove(_args: TouchEventArgs): void {}

  protected onPreviewTouchUp(_args: TouchEventArgs): void {
    this.isTouched = false;
  }

  protected onTouchDown(_args: TouchEventArgs): void {}

  protected onTouchMove(_args: TouchEventArgs): void {}

  protected onTouchUp(_args: TouchEventArgs): void {}

  protected onTouchEnter(_args: TouchEventArgs): void {
    this.isTouched = true;
  }

  protected onTouchLeave(_args: TouchEventArgs): void {
    this.isTouched = false;
  }

  /** 虚拟坐标里的点在不在元素的矩形里（Stride 的 Intersects；ModalElement 改成整个 UI）。 */
  intersects(point: readonly [number, number]): boolean {
    const [a, b, c, d, e, f] = this.worldMatrix;
    const determinant = a * d - b * c;
    if (determinant === 0) return false;
    const x = point[0] - e, y = point[1] - f;
    const localX = (d * x - c * y) / determinant, localY = (a * y - b * x) / determinant;
    return Math.abs(localX) <= this.renderSize[0] / 2 && Math.abs(localY) <= this.renderSize[1] / 2;
  }

  /** 世界矩阵的原点（元素中心）在虚拟坐标里的位置。 */
  get worldPosition(): readonly [number, number] {
    return [this.worldMatrix[4], this.worldMatrix[5]];
  }

  // ---- 每帧 ----
  /** @internal 每帧在布局之前（Stride 的 Update）：子类做按时间的变化（滚动的惯性、光标闪烁、图片换了重新量）。 */
  update(elapsedSeconds: number): void {
    this.onUpdate(elapsedSeconds);
    for (const child of this.visualChildrenList) child.update(elapsedSeconds);
  }

  protected onUpdate(_elapsedSeconds: number): void {}

  /** @internal 布局之后算世界矩阵：parentWorld 是父元素给的位置（含 arrangeMatrix）。 */
  updateWorldMatrix(parentWorld: Matrix2D): void {
    const local = this.#localMatrix;
    // 局部矩阵加上布局的偏移，把原点放到元素中心
    const placed: Matrix2D = [local[0], local[1], local[2], local[3],
      local[4] + this.renderOffsets[0] + this.renderSize[0] / 2, local[5] + this.renderOffsets[1] + this.renderSize[1] / 2];
    this.worldMatrix = multiply(placed, parentWorld);
    this.updateChildrenWorldMatrix();
  }

  /** 子元素的世界矩阵：子元素的 arrangeMatrix 相对这个元素的中心。 */
  protected updateChildrenWorldMatrix(): void {
    for (const child of this.visualChildrenList) child.updateWorldMatrix(multiply(child.arrangeMatrix, this.worldMatrix));
  }

  /** @internal 不透明度、启用状态、画的先后往下传（Stride 的 UpdateElementState）。 */
  updateElementState(elementBias: number): void {
    const parent = this.visualParent;
    this.renderOpacity = (parent?.renderOpacity ?? 1) * this.#opacity;
    this.#isHierarchyEnabled = (parent ? parent.#isHierarchyEnabled : true) && this.#isEnabled;
    this.depthBias = elementBias;
    let bias = elementBias + this.drawLayerNumber;
    for (const child of this.visualChildrenList) {
      child.updateElementState(bias);
      bias = child.maxChildrenDepthBias + (child.clipToBounds ? child.drawLayerNumber : 0);
    }
    this.maxChildrenDepthBias = bias;
  }
}

function sameSize(a: readonly [number, number], b: readonly [number, number]): boolean {
  return Object.is(a[0], b[0]) && Object.is(a[1], b[1]);
}

function sameContext(a: LayoutingContext, b: LayoutingContext): boolean {
  return a.realResolution[0] === b.realResolution[0] && a.realResolution[1] === b.realResolution[1]
    && a.virtualResolution[0] === b.virtualResolution[0] && a.virtualResolution[1] === b.virtualResolution[1];
}

// 元素自己的反应（Stride 的类处理函数）：只在元素和它的父元素都启用时调用
type TouchHandlers = { [K in 'onPreviewTouchDown' | 'onPreviewTouchMove' | 'onPreviewTouchUp' | 'onTouchDown' | 'onTouchMove' | 'onTouchUp' | 'onTouchEnter' | 'onTouchLeave']: (args: TouchEventArgs) => void };
const CLASS_HANDLERS: readonly [RoutedEvent<TouchEventArgs>, keyof TouchHandlers][] = [
  [UIElement.previewTouchDownEvent, 'onPreviewTouchDown'],
  [UIElement.previewTouchMoveEvent, 'onPreviewTouchMove'],
  [UIElement.previewTouchUpEvent, 'onPreviewTouchUp'],
  [UIElement.touchDownEvent, 'onTouchDown'],
  [UIElement.touchMoveEvent, 'onTouchMove'],
  [UIElement.touchUpEvent, 'onTouchUp'],
  [UIElement.touchEnterEvent, 'onTouchEnter'],
  [UIElement.touchLeaveEvent, 'onTouchLeave'],
];
for (const [event, method] of CLASS_HANDLERS) {
  registerClassHandler(UIElement, event, (element, args) => {
    if (element.isHierarchyEnabled) (element as unknown as TouchHandlers)[method](args);
  });
}
