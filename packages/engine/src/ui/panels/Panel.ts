/**
 * 面板（Stride 的 Panel）：有一组子元素，按 ZIndex 排画的顺序（小的先画），子类决定怎么排（Grid、StackPanel、Canvas……）。
 */
import { UIElement } from '../UIElement';
import type { ScrollViewer } from '../controls/ScrollViewer';

/** 面板的子元素（Stride 的 UIElementCollection）：增删时设好父元素、重排画的顺序、让面板重新布局。 */
export class UIElementCollection implements Iterable<UIElement> {
  readonly #items: UIElement[] = [];
  readonly #onAdded: (element: UIElement, index: number) => void;
  readonly #onRemoved: (element: UIElement, index: number) => void;

  constructor(onAdded: (element: UIElement, index: number) => void, onRemoved: (element: UIElement, index: number) => void) {
    this.#onAdded = onAdded;
    this.#onRemoved = onRemoved;
  }

  get length(): number {
    return this.#items.length;
  }

  at(index: number): UIElement | undefined {
    return this.#items.at(index);
  }

  indexOf(element: UIElement): number {
    return this.#items.indexOf(element);
  }

  includes(element: UIElement): boolean {
    return this.#items.includes(element);
  }

  add(element: UIElement): void {
    this.insert(this.#items.length, element);
  }

  insert(index: number, element: UIElement): void {
    this.#items.splice(index, 0, element);
    this.#onAdded(element, index);
  }

  /** 移除一个子元素；不在里面时返回 false。 */
  remove(element: UIElement): boolean {
    const index = this.#items.indexOf(element);
    if (index < 0) return false;
    this.removeAt(index);
    return true;
  }

  removeAt(index: number): void {
    const [element] = this.#items.splice(index, 1);
    if (element) this.#onRemoved(element, index);
  }

  clear(): void {
    while (this.#items.length > 0) this.removeAt(this.#items.length - 1);
  }

  [Symbol.iterator](): Iterator<UIElement> {
    return this.#items[Symbol.iterator]();
  }
}

export abstract class Panel extends UIElement {
  readonly children = new UIElementCollection((element, index) => this.onLogicalChildAdded(element, index), (element, index) => this.onLogicalChildRemoved(element, index));
  /** 包着这个面板的 ScrollViewer（面板自己能滚动时由它设）。 */
  scrollOwner: ScrollViewer | null = null;

  protected onLogicalChildAdded(element: UIElement, _index: number): void {
    UIElement.setParent(element, this);
    UIElement.setVisualParent(element, this);
    this.sortVisualChildren();
    this.invalidateMeasure();
  }

  protected onLogicalChildRemoved(element: UIElement, _index: number): void {
    UIElement.setParent(element, null);
    UIElement.setVisualParent(element, null);
    this.invalidateMeasure();
  }

  override onChildZIndexChanged(): void {
    this.sortVisualChildren();
  }

  /** 按 ZIndex 排画的顺序；相同的保持加入的顺序。 */
  protected sortVisualChildren(): void {
    this.visualChildrenList.sort((a, b) => a.panelZIndex - b.panelZIndex);
  }
}
