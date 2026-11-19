/**
 * 透明实例的先后（Stride 的透明阶段按每个物体从远到近排）：实例按批存在实例缓冲里（同一批的连在一起），所以分两步——
 * 先在每批自己的那段里按距离排好（sortBackToFront），画的时候再把各批的实例按距离归并成一段一段（backToFrontRuns）：
 * 同一批里连着的几个实例是缓冲里连着的一段，一次画完；不同批的实例可以交错。
 */
interface Point {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** 槽位 slot 的物体（世界矩阵的平移）到 eye 的距离的平方；world 是所有槽位的世界矩阵（每个 16 个数）。 */
function distanceSquared(world: ArrayLike<number>, slot: number, { x, y, z }: Point): number {
  return (world[slot * 16 + 12]! - x) ** 2 + (world[slot * 16 + 13]! - y) ** 2 + (world[slot * 16 + 14]! - z) ** 2;
}

/** 一批可见实例的槽位原地按到 eye 的距离从远到近排；距离一样的按槽位排（顺序不随帧变）。 */
export function sortBackToFront(slots: Uint32Array | Int32Array, world: ArrayLike<number>, eye: Point): void {
  if (slots.length < 2) return;
  slots.set(Array.from(slots).sort((p, q) => distanceSquared(world, q, eye) - distanceSquared(world, p, eye) || p - q));
}

/** 一批可见的实例：批的编号，和它们的槽位在 visibleSlots 里的那一段（已经用 sortBackToFront 排好）。 */
export interface VisibleBatch {
  readonly batch: number;
  readonly start: number;
  readonly count: number;
}

/**
 * 几批的实例一起从远到近，归并成一段一段；每段三个数：批、段在这批可见实例里的起点、个数。
 */
export function backToFrontRuns(batches: readonly VisibleBatch[], visibleSlots: ArrayLike<number>, world: ArrayLike<number>, eye: Point): number[] {
  // 每个实例：批、在批里的第几个、距离
  const instances: [batch: number, index: number, distance: number][] = [];
  for (const { batch, start, count } of batches) {
    for (let k = 0; k < count; k++) instances.push([batch, k, distanceSquared(world, visibleSlots[start + k]!, eye)]);
  }
  // 距离一样的按批、按批里的顺序（和批里排好的顺序一致）
  instances.sort((p, q) => q[2] - p[2] || p[0] - q[0] || p[1] - q[1]);
  const runs: number[] = [];
  for (const [batch, k] of instances) {
    const last = runs.length - 3;
    if (last >= 0 && runs[last] === batch && runs[last + 1]! + runs[last + 2]! === k) runs[last + 2]!++;
    else runs.push(batch, k, 1);
  }
  return runs;
}
