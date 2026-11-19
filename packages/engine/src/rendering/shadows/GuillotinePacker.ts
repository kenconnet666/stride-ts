/**
 * 在一张图集里分配矩形（Stride 的 GuillotinePacker）：记着一组空闲的矩形，每次挑能放下、剩余面积最小的那块，放在它的左上角，
 * 剩下的部分切成下面、右边两块。阴影图集每帧清空重排。
 */
export interface PackedRectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

export class GuillotinePacker {
  readonly width: number;
  readonly height: number;
  #free: PackedRectangle[] = [];

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.clear();
  }

  /** 全部腾空。 */
  clear(): void {
    this.#free = [{ x: 0, y: 0, width: this.width, height: this.height }];
  }

  /** 分配 count 块同样大小的矩形；放不下这么多块时一块也不占，返回 undefined（Stride 的 TryInsert）。 */
  insert(width: number, height: number, count = 1): PackedRectangle[] | undefined {
    const free = this.#free.map((rectangle) => ({ ...rectangle })), placed: PackedRectangle[] = [];
    for (let i = 0; i < count; i++) {
      const rectangle = insertInto(free, width, height);
      if (!rectangle) return undefined;
      placed.push(rectangle);
    }
    this.#free = free;
    return placed;
  }
}

function insertInto(free: PackedRectangle[], width: number, height: number): PackedRectangle | undefined {
  let best = -1, bestScore = Infinity;
  for (let i = 0; i < free.length; i++) {
    const candidate = free[i]!;
    if (width > candidate.width || height > candidate.height) continue;
    const score = candidate.width * candidate.height - width * height;
    if (score < bestScore) {
      best = i;
      bestScore = score;
      // 正好一样大：不用再找
      if (score === 0) break;
    }
  }
  if (best < 0) return undefined;
  const from = free[best]!, w = from.width - width, h = from.height - height;
  // 沿哪边切：让剩下的两块里大的那块尽量大
  const splitHorizontal = width * h > w * height;
  const bottom = { x: from.x, y: from.y + height, width: splitHorizontal ? from.width : width, height: h };
  const right = { x: from.x + width, y: from.y, width: w, height: splitHorizontal ? height : from.height };
  free[best] = free.at(-1)!;
  free.pop();
  if (bottom.width > 0 && bottom.height > 0) free.push(bottom);
  if (right.width > 0 && right.height > 0) free.push(right);
  return { x: from.x, y: from.y, width, height };
}
