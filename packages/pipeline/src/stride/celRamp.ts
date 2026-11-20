/**
 * 卡通着色的渐变贴图化简成节点（引擎的 CelRamp：[位置, r, g, b]，节点间线性插值）。
 *
 * Stride 按 (clamp(x, 0, 1), 0.5) 线性采样渐变贴图，所以中间那一行的每个纹素中心 (j + 0.5) / 宽 是一个点、点之间是直线：这本身
 * 就是一条折线。按 Douglas-Peucker 从两端开始，每次补上离当前折线最远的那个点，直到误差小于 tolerance 或者节点用完；硬台阶两边
 * 的纹素都会被留下，节点间的线性插值就是 Stride 线性采样的结果。
 */
import type { CelRamp } from '@stride-ts/engine/content-format';

type Stop = readonly [number, number, number, number];

/** 渐变贴图中间那一行的颜色（线性，每个纹素 3 个数）化简成最多 maxStops 个节点。 */
export function simplifyRamp(row: ArrayLike<number>, width: number, maxStops: number, tolerance = 0.002): CelRamp {
  const points: Stop[] = Array.from({ length: width }, (_, j) => [(j + 0.5) / width, row[j * 3]!, row[j * 3 + 1]!, row[j * 3 + 2]!]);
  if (points.length <= 2) return points;
  const kept = [0, points.length - 1];
  while (kept.length < maxStops) {
    let worst = -1, worstError = tolerance;
    for (let k = 0; k + 1 < kept.length; k++) {
      const a = points[kept[k]!]!, b = points[kept[k + 1]!]!;
      for (let j = kept[k]! + 1; j < kept[k + 1]!; j++) {
        const error = distance(points[j]!, a, b);
        if (error > worstError) [worst, worstError] = [j, error];
      }
    }
    if (worst < 0) break;
    kept.push(worst);
    kept.sort((x, y) => x - y);
  }
  return kept.map((j) => points[j]!);
}

/** p 和 a、b 两点连线在 p 的位置上的颜色差（各通道里最大的）。 */
function distance(p: Stop, a: Stop, b: Stop): number {
  const t = (p[0] - a[0]) / (b[0] - a[0]);
  return Math.max(...[1, 2, 3].map((c) => Math.abs(p[c]! - (a[c]! + (b[c]! - a[c]!) * t))));
}
