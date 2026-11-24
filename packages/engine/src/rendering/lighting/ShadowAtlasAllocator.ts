/**
 * 阴影图集里的块（2 的幂的正方形）的分配和释放：四叉的伙伴分配。阴影图跨帧留在图集里（缓存，docs/realtime.md），所以要能单独
 * 释放、相邻的空块合回大块；块的位置一旦分了就不动，直到释放。
 *
 * 每种边长一张空块表；要 size 的块时先看同样大小的空块，没有就从大一级的空块里切四块（拿走一块，三块进表），一直往上找到整张图集。
 * 释放时同一个父块的四块都空了就合回父块，再往上试。
 */
export interface PackedRectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

export class ShadowAtlasAllocator {
  /** 图集的边长（2 的幂）。 */
  readonly size: number;
  /** 边长 → 这么大的空块（按 y · size + x 记）。 */
  readonly #free = new Map<number, Set<number>>();

  constructor(size: number) {
    if (!(size > 0) || (size & (size - 1)) !== 0) throw new Error(`shadow atlas size ${size} is not a power of two`);
    this.size = size;
    this.clear();
  }

  /** 全部腾空。 */
  clear(): void {
    this.#free.clear();
    this.#freeSet(this.size).add(0);
  }

  /** 分一块 size 见方的（size 是 2 的幂，不超过图集）；放不下时 undefined。 */
  allocate(size: number): PackedRectangle | undefined {
    const key = this.#take(size);
    return key === undefined ? undefined : { x: key % this.size, y: Math.floor(key / this.size), width: size, height: size };
  }

  /** 还回一块（allocate 给的，原样）。 */
  release(rectangle: Readonly<PackedRectangle>): void {
    let size = rectangle.width, x = rectangle.x, y = rectangle.y;
    for (;;) {
      if (size >= this.size) {
        this.#freeSet(size).add(0);
        return;
      }
      // 同一个父块的另外三块都空着：合起来，再往上试
      const parent = size * 2, px = x - (x % parent), py = y - (y % parent);
      const siblings = [px, px + size].flatMap((sx) => [py, py + size].map((sy) => sy * this.size + sx)).filter((key) => key !== y * this.size + x);
      const free = this.#freeSet(size);
      if (!siblings.every((key) => free.has(key))) {
        free.add(y * this.size + x);
        return;
      }
      for (const key of siblings) free.delete(key);
      size = parent;
      x = px;
      y = py;
    }
  }

  #take(size: number): number | undefined {
    if (size > this.size) return undefined;
    const free = this.#freeSet(size);
    const first = free.values().next();
    if (!first.done) {
      free.delete(first.value);
      return first.value;
    }
    // 从大一级的空块里切四块：左上的拿走，其余三块进表
    const parent = this.#take(size * 2);
    if (parent === undefined) return undefined;
    const x = parent % this.size, y = Math.floor(parent / this.size);
    free.add(y * this.size + x + size);
    free.add((y + size) * this.size + x);
    free.add((y + size) * this.size + x + size);
    return parent;
  }

  #freeSet(size: number): Set<number> {
    let set = this.#free.get(size);
    if (!set) this.#free.set(size, (set = new Set()));
    return set;
  }
}
