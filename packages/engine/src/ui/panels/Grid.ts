/**
 * 网格（Stride 的 Grid）：行和列各有定义（StripDefinition）：固定大小、按内容（auto）、按比例分剩下的空间（star，"1*"、"2*"），
 * 每种都可以有最小、最大值。子元素用 gridRow、gridColumn（和跨度）放进格子。算法照 Stride（见 Grid.cs 的注释）：
 * 1. 先用估计的空间量 auto 行列里的元素；2. 定 auto 行列的大小（跨几条的元素尽量把增加的空间推到最后一条）；
 * 3. 定 1 星的大小（被最小、最大值卡住的星号行列逐步排除）；4. 用格子的准确大小再量一遍所有元素；5. 算网格想要的大小。
 */
import { clamp, translation, type UIElement, type Vec2 } from '../UIElement';
import { GridBase } from './UniformGrid';

export type StripType = 'fixed' | 'auto' | 'star';

/** 一行或一列（Stride 的 StripDefinition）。改了会让网格重新布局。 */
export class StripDefinition {
  #type: StripType;
  #sizeValue: number;
  #minimumSize = 0;
  #maximumSize = Infinity;
  /** 布局算出来的大小。 */
  actualSize = 0;
  /** @internal 所在的网格（改定义时让它重新布局）。 */
  owner: Grid | null = null;

  constructor(type: StripType = 'star', sizeValue = 1) {
    this.#type = type;
    this.#sizeValue = clamp(sizeValue, 0, Number.MAX_VALUE);
  }

  get type(): StripType { return this.#type; }
  set type(value: StripType) {
    if (value === this.#type) return;
    this.#type = value;
    this.#changed();
  }

  /** 固定的大小（fixed），或星号的份数（star）；auto 不用。 */
  get sizeValue(): number { return this.#sizeValue; }
  set sizeValue(value: number) {
    if (Number.isNaN(value)) return;
    this.#sizeValue = clamp(value, 0, Number.MAX_VALUE);
    this.#changed();
  }

  get minimumSize(): number { return this.#minimumSize; }
  set minimumSize(value: number) {
    if (Number.isNaN(value)) return;
    this.#minimumSize = clamp(value, 0, Number.MAX_VALUE);
    this.#maximumSize = clamp(this.#maximumSize, this.#minimumSize, Infinity);
    this.#changed();
  }

  get maximumSize(): number { return this.#maximumSize; }
  set maximumSize(value: number) {
    if (Number.isNaN(value)) return;
    this.#maximumSize = clamp(value, this.#minimumSize, Infinity);
    this.#changed();
  }

  clampSize(size: number): number {
    return clamp(size, this.#minimumSize, this.#maximumSize);
  }

  /** @internal 星号行列的最小值 / 份数。 */
  relativeMinimum(): number {
    return this.#sizeValue < 1e-6 ? 0 : this.#minimumSize / this.#sizeValue;
  }

  /** @internal 星号行列的最大值 / 份数。 */
  relativeMaximum(): number {
    return this.#sizeValue < 1e-6 ? 0 : this.#maximumSize / this.#sizeValue;
  }

  #changed(): void {
    this.owner?.invalidateMeasure();
  }
}

/** 行或列的定义列表：增删时让网格重新布局。 */
export class StripDefinitionCollection implements Iterable<StripDefinition> {
  readonly #items: StripDefinition[] = [];
  readonly #owner: Grid;

  constructor(owner: Grid) {
    this.#owner = owner;
  }

  get length(): number { return this.#items.length; }
  at(index: number): StripDefinition | undefined { return this.#items[index]; }

  add(definition: StripDefinition): void {
    definition.owner = this.#owner;
    this.#items.push(definition);
    this.#owner.invalidateMeasure();
  }

  remove(definition: StripDefinition): boolean {
    const index = this.#items.indexOf(definition);
    if (index < 0) return false;
    this.#items.splice(index, 1);
    definition.owner = null;
    this.#owner.invalidateMeasure();
    return true;
  }

  clear(): void {
    for (const definition of [...this.#items]) this.remove(definition);
  }

  [Symbol.iterator](): Iterator<StripDefinition> {
    return this.#items[Symbol.iterator]();
  }

  /** @internal */
  get items(): readonly StripDefinition[] {
    return this.#items;
  }
}

/** 一个方向（列或行）的布局缓存。 */
interface Dimension {
  strips: readonly StripDefinition[];
  /** 每个子元素占的行列。 */
  elementStrips: Map<UIElement, StripDefinition[]>;
  /** 每条（非星号）行列里完全不占星号行列的元素。 */
  noStarElements: UIElement[][];
  /** 占了星号行列的元素 → 它占的行列。 */
  partialStarElements: Map<UIElement, StripDefinition[]>;
  starStrips: StripDefinition[];
  /** 每条的起点（多一个终点）。 */
  positions: number[];
}

export class Grid extends GridBase {
  readonly rowDefinitions = new StripDefinitionCollection(this);
  readonly columnDefinitions = new StripDefinitionCollection(this);
  /** 没写行列定义时用的一条默认的（1 星），按方向留着。 */
  readonly #defaults = [[new StripDefinition()], [new StripDefinition()]] as const;
  readonly #dimensions: [Dimension, Dimension] = [emptyDimension(), emptyDimension()];
  readonly #autoElements = new Set<UIElement>();

  /** 实际用的列定义（没写时是一条默认的）。 */
  get actualColumnDefinitions(): readonly StripDefinition[] { return this.#dimensions[0].strips; }
  get actualRowDefinitions(): readonly StripDefinition[] { return this.#dimensions[1].strips; }

  protected override measureOverride(available: Vec2): Vec2 {
    this.#updateStrips();
    this.#rebuildMeasureCache();

    // 估计 auto 元素能用的空间：可用空间减去固定行列、其余行列的最小值和空隙
    for (const dim of this.#dimensions) initializeActualSizes(dim.strips);
    const autoAvailable: Vec2 = [available[0], available[1]];
    for (const d of [0, 1] as const) {
      autoAvailable[d] -= this.totalGap(d, this.#dimensions[d].strips.length);
      for (const strip of this.#dimensions[d].strips) autoAvailable[d] -= strip.type === 'fixed' ? strip.actualSize : strip.minimumSize;
    }
    for (const child of this.#autoElements) {
      const childAvailable: Vec2 = [0, 0];
      for (const d of [0, 1] as const) {
        let withMinimum = autoAvailable[d];
        let size = 0;
        const strips = this.#dimensions[d].elementStrips.get(child)!;
        for (const strip of strips) {
          withMinimum += strip.type === 'fixed' ? strip.actualSize : strip.minimumSize;
          if (strip.type === 'fixed') size += strip.clampSize(strip.sizeValue);
          else size = Math.min(withMinimum, size + strip.maximumSize);
        }
        if (strips.length > 1) size += this.gap(d) * (strips.length - 1);
        childAvailable[d] = size;
      }
      child.measure(childAvailable);
    }

    // auto 行列的大小：尽量小，跨几条的元素缺的空间放到它占的最后一条 auto 上
    for (const d of [0, 1] as const) {
      const dim = this.#dimensions[d];
      initializeActualSizes(dim.strips);
      dim.strips.forEach((current, index) => {
        if (current.type !== 'auto') return;
        for (const element of dim.noStarElements[index]!) {
          const strips = dim.elementStrips.get(element)!;
          let currentIndex = 0;
          let space = 0;
          strips.forEach((strip, i) => {
            space += strip.actualSize;
            if (strip === current) currentIndex = i;
          });
          if (strips.length > 1) space += this.gap(d) * (strips.length - 1);
          let needed = Math.max(0, element.desiredSizeWithMargins[d] - space);
          if (needed <= 0) continue;
          for (let i = currentIndex + 1; i < strips.length && needed > 0; i++) {
            const strip = strips[i]!;
            if (strip.type === 'auto') needed = Math.max(0, needed - (strip.maximumSize - strip.actualSize));
          }
          current.actualSize = current.clampSize(current.actualSize + needed);
        }
      });
    }

    this.#starSizes(available);

    // 用格子的准确大小再量一遍
    for (const child of this.visualChildrenList) {
      child.measure([this.#stripsSize(child, 0), this.#stripsSize(child, 1)]);
    }

    // 网格想要的大小：1 星要多大才能放下所有占星号行列的元素
    const needed: Vec2 = [0, 0];
    for (const d of [0, 1] as const) {
      const dim = this.#dimensions[d];
      let oneStar = 0;
      for (const [element, strips] of dim.partialStarElements) oneStar = Math.max(oneStar, this.#oneStarNeeded(element, strips, d));
      for (const strip of dim.starStrips) strip.actualSize = strip.clampSize(oneStar * strip.sizeValue);
      needed[d] = sumActual(dim.strips) + this.totalGap(d, dim.strips.length);
    }
    return needed;
  }

  /** 放下这个元素时 1 星至少要多大（从相对最小值最小的星号行列开始逐步加大，到最大值的不再加）。 */
  #oneStarNeeded(element: UIElement, strips: readonly StripDefinition[], d: 0 | 1): number {
    const minSorted: StripDefinition[] = [];
    let space = 0;
    for (const strip of strips) {
      if (strip.type === 'star') {
        strip.actualSize = strip.minimumSize;
        minSorted.push(strip);
      }
      space += strip.actualSize;
    }
    if (strips.length > 1) space += this.gap(d) * (strips.length - 1);
    let missing = Math.max(0, element.desiredSizeWithMargins[d] - space);
    minSorted.sort((a, b) => a.relativeMinimum() - b.relativeMinimum());

    const maxSorted: StripDefinition[] = [];
    let oneStar = 0;
    for (let minIndex = 0; minIndex < minSorted.length && missing > 0; minIndex++) {
      const minStrip = minSorted[minIndex]!;
      maxSorted.push(minStrip);
      maxSorted.sort((a, b) => a.relativeMaximum() - b.relativeMaximum());
      const nextRelativeMin = minIndex === minSorted.length - 1 ? Infinity : minSorted[minIndex + 1]!.relativeMinimum();
      let step = Math.min(missing / sumValues(maxSorted), nextRelativeMin - minStrip.relativeMinimum());
      while (step > 0 && maxSorted.length > 0) {
        const maxStrip = maxSorted[0]!;
        const maxIncrease = maxStrip.sizeValue * step;
        const relativeIncrease = Math.min(step, (maxStrip.maximumSize - maxStrip.actualSize) / maxStrip.sizeValue);
        step -= relativeIncrease;
        const reachedMax = maxStrip.actualSize + maxIncrease >= maxStrip.maximumSize;
        for (const strip of maxSorted) {
          const increase = relativeIncrease * strip.sizeValue;
          missing -= increase;
          strip.actualSize += increase;
        }
        if (reachedMax) {
          const remaining = step * sumValues(maxSorted);
          maxSorted.splice(maxSorted.indexOf(maxStrip), 1);
          step = remaining / sumValues(maxSorted);
        }
        oneStar = Math.max(oneStar, maxStrip.actualSize / maxStrip.sizeValue);
      }
    }
    return oneStar;
  }

  protected override arrangeOverride(finalSize: Vec2): Vec2 {
    this.#starSizes(finalSize);
    for (const d of [0, 1] as const) {
      const dim = this.#dimensions[d];
      dim.positions = [];
      let start = 0;
      dim.strips.forEach((strip, index) => {
        dim.positions.push(start);
        start += strip.actualSize;
        if (index < dim.strips.length - 1) start += this.gap(d);
      });
      dim.positions.push(start);
    }
    const gridSize: Vec2 = [
      Math.max(this.#dimensions[0].positions.at(-1)!, finalSize[0]),
      Math.max(this.#dimensions[1].positions.at(-1)!, finalSize[1]),
    ];
    for (const child of this.visualChildrenList) {
      const position = this.elementPosition(child);
      child.arrangeMatrix = translation(this.#dimensions[0].positions[position[0]]! - gridSize[0] / 2, this.#dimensions[1].positions[position[1]]! - gridSize[1] / 2);
      child.arrange([this.#stripsSize(child, 0), this.#stripsSize(child, 1)], this.isCollapsed);
    }
    return gridSize;
  }

  /** 星号行列的大小：剩下的空间按份数分，被最小、最大值卡住的定下来、从剩下的里扣掉，直到没有被卡住的。 */
  #starSizes(finalSize: Vec2): void {
    for (const d of [0, 1] as const) {
      const dim = this.#dimensions[d];
      let stars = [...dim.starStrips];
      let remaining = Math.max(0, finalSize[d] - sumNonStar(dim.strips) - this.totalGap(d, dim.strips.length));
      let values = sumValues(stars);
      let oneStar = remaining / values;
      let maxBounded: StripDefinition[];
      let minBounded: StripDefinition[];
      do {
        maxBounded = [];
        minBounded = [];
        for (const strip of stars) {
          strip.actualSize = strip.sizeValue * oneStar;
          if (strip.actualSize < strip.minimumSize) {
            strip.actualSize = strip.minimumSize;
            minBounded.push(strip);
          } else if (strip.actualSize > strip.maximumSize) {
            strip.actualSize = strip.maximumSize;
            maxBounded.push(strip);
          }
        }
        const trimmed = sumActual(stars) < remaining ? maxBounded : minBounded;
        remaining -= sumActual(trimmed);
        values -= sumValues(trimmed);
        oneStar = remaining / values;
        stars = stars.filter((strip) => !trimmed.includes(strip));
      } while ((maxBounded.length > 0 || minBounded.length > 0) && stars.length > 0);
    }
  }

  /** 子元素占的行列的大小加上中间的空隙。 */
  #stripsSize(child: UIElement, d: 0 | 1): number {
    const strips = this.#dimensions[d].elementStrips.get(child)!;
    return sumActual(strips) + (strips.length > 1 ? this.gap(d) * (strips.length - 1) : 0);
  }

  /** 实际用的行列：没写定义时用一条默认的；超出网格的元素记警告（Stride 也只警告）。 */
  #updateStrips(): void {
    const user = [this.columnDefinitions.items, this.rowDefinitions.items] as const;
    for (const d of [0, 1] as const) this.#dimensions[d].strips = user[d].length > 0 ? user[d] : this.#defaults[d];
    for (const child of this.visualChildrenList) {
      const end = [child.gridColumn + child.gridColumnSpan, child.gridRow + child.gridRowSpan];
      for (const d of [0, 1] as const) {
        if (this.#dimensions[d].strips.length < end[d]!) console.warn(`Element '${child.name ?? child.constructor.name}' is outside of the grid '${this.name}' definition for [${d === 0 ? 'Column' : 'Row'}].`);
      }
    }
  }

  #rebuildMeasureCache(): void {
    this.#autoElements.clear();
    for (const dim of this.#dimensions) {
      dim.elementStrips.clear();
      dim.partialStarElements.clear();
      dim.noStarElements = dim.strips.map(() => []);
      dim.starStrips = dim.strips.filter((strip) => strip.type === 'star');
    }
    for (const child of this.visualChildrenList) {
      const position = this.elementPosition(child);
      const span = this.elementSpan(child);
      for (const d of [0, 1] as const) {
        const dim = this.#dimensions[d];
        const strips = dim.strips.slice(position[d], position[d] + span[d]);
        dim.elementStrips.set(child, strips);
        if (strips.some((strip) => strip.type === 'auto')) this.#autoElements.add(child);
        if (strips.some((strip) => strip.type === 'star')) dim.partialStarElements.set(child, strips);
        else for (let i = position[d]; i < position[d] + span[d]; i++) dim.noStarElements[i]!.push(child);
      }
    }
  }

  /** 位置超出网格的放到最后一条（同 Stride）。 */
  protected override elementPosition(element: UIElement): Vec2 {
    const [column, row] = super.elementPosition(element);
    return [Math.min(column, this.#dimensions[0].strips.length - 1), Math.min(row, this.#dimensions[1].strips.length - 1)];
  }

  /** 跨度不超出网格。 */
  protected override elementSpan(element: UIElement): Vec2 {
    const position = this.elementPosition(element);
    const span = super.elementSpan(element);
    return [
      Math.min(position[0] + span[0], this.#dimensions[0].strips.length) - position[0],
      Math.min(position[1] + span[1], this.#dimensions[1].strips.length) - position[1],
    ];
  }
}

function emptyDimension(): Dimension {
  return { strips: [], elementStrips: new Map(), noStarElements: [], partialStarElements: new Map(), starStrips: [], positions: [] };
}

function initializeActualSizes(strips: readonly StripDefinition[]): void {
  for (const strip of strips) strip.actualSize = strip.clampSize(strip.type === 'fixed' ? strip.sizeValue : 0);
}

function sumActual(strips: readonly StripDefinition[]): number {
  let sum = 0;
  for (const strip of strips) sum += strip.actualSize;
  return sum;
}

function sumNonStar(strips: readonly StripDefinition[]): number {
  let sum = 0;
  for (const strip of strips) if (strip.type !== 'star') sum += strip.actualSize;
  return sum;
}

function sumValues(strips: readonly StripDefinition[]): number {
  let sum = 0;
  for (const strip of strips) sum += strip.sizeValue;
  return sum;
}
