/**
 * 网格面板的基类（Stride 的 GridBase）和等分网格（UniformGrid）：子元素用附加属性 gridRow、gridColumn（和跨度）放进格子。
 */
import { translation, type UIElement, type Vec2 } from '../UIElement';
import { Panel } from './Panel';

export abstract class GridBase extends Panel {
  #columnGap = 0;
  #rowGap = 0;

  /** 列之间的空隙，虚拟像素。 */
  get columnGap(): number { return this.#columnGap; }
  set columnGap(value: number) {
    if (value === this.#columnGap) return;
    this.#columnGap = Math.max(0, value);
    this.invalidateMeasure();
  }

  get rowGap(): number { return this.#rowGap; }
  set rowGap(value: number) {
    if (value === this.#rowGap) return;
    this.#rowGap = Math.max(0, value);
    this.invalidateMeasure();
  }

  protected gap(dimension: 0 | 1): number {
    return dimension === 0 ? this.#columnGap : this.#rowGap;
  }

  /** count 个格子之间的空隙之和。 */
  protected totalGap(dimension: 0 | 1, count: number): number {
    return count <= 1 ? 0 : this.gap(dimension) * (count - 1);
  }

  /** 子元素的格子位置：列、行。 */
  protected elementPosition(element: UIElement): Vec2 {
    return [element.gridColumn, element.gridRow];
  }

  /** 子元素跨几列、几行。 */
  protected elementSpan(element: UIElement): Vec2 {
    return [element.gridColumnSpan, element.gridRowSpan];
  }
}

export class UniformGrid extends GridBase {
  #rows = 1;
  #columns = 1;
  #cellSize: Vec2 = [0, 0];

  get rows(): number { return this.#rows; }
  set rows(value: number) { this.#rows = Math.max(1, Math.trunc(value)); this.invalidateMeasure(); }
  get columns(): number { return this.#columns; }
  set columns(value: number) { this.#columns = Math.max(1, Math.trunc(value)); this.invalidateMeasure(); }

  #spannedSize(cell: Vec2, span: Vec2): Vec2 {
    return [0, 1].map((d) => {
      const s = Math.max(span[d]!, 1);
      return cell[d]! * s + this.gap(d as 0 | 1) * (s - 1);
    }) as Vec2;
  }

  protected override measureOverride(available: Vec2): Vec2 {
    const counts: Vec2 = [this.#columns, this.#rows];
    const gaps: Vec2 = [this.totalGap(0, counts[0]), this.totalGap(1, counts[1])];
    const cell: Vec2 = [(available[0] - gaps[0]) / counts[0], (available[1] - gaps[1]) / counts[1]];
    const needed: Vec2 = [0, 0];
    for (const child of this.visualChildrenList) {
      const span = this.elementSpan(child);
      child.measure(this.#spannedSize(cell, span));
      needed[0] = Math.max(needed[0], child.desiredSizeWithMargins[0] / span[0]);
      needed[1] = Math.max(needed[1], child.desiredSizeWithMargins[1] / span[1]);
    }
    return [counts[0] * needed[0] + gaps[0], counts[1] * needed[1] + gaps[1]];
  }

  protected override arrangeOverride(finalSize: Vec2): Vec2 {
    const counts: Vec2 = [this.#columns, this.#rows];
    this.#cellSize = [(finalSize[0] - this.totalGap(0, counts[0])) / counts[0], (finalSize[1] - this.totalGap(1, counts[1])) / counts[1]];
    for (const child of this.visualChildrenList) {
      const position = this.elementPosition(child);
      const offset: Vec2 = [position[0] * (this.#cellSize[0] + this.gap(0)), position[1] * (this.#cellSize[1] + this.gap(1))];
      child.arrangeMatrix = translation(offset[0] - finalSize[0] / 2, offset[1] - finalSize[1] / 2);
      child.arrange(this.#spannedSize(this.#cellSize, this.elementSpan(child)), this.isCollapsed);
    }
    return finalSize;
  }
}
