/**
 * 字形轮廓整理成矢量文字渲染器（Slug 算法，Eric Lengyel 2017，见 engine 的 rendering/text）要的数据：
 * - 点：同一条轮廓上相连的二次曲线共用端点，一条曲线是三个相邻的点（p1、控制点、p3），下一条从 p3 开始；
 * - 横带和竖带：字形的包围盒按高度切成若干横带、按宽度切成若干竖带，每条带列出和它相交的曲线，横带里按曲线的
 *   最大 x 从大到小排（着色器从右往左扫，过了像素就停），竖带按最大 y 从大到小排。水平的直线不进横带、竖直的直线不进
 *   竖带（和平行的射线没有交点）。带之间重叠 1/1024 em，免得曲线正好落在边界上时漏掉。
 * 坐标都是 em（字体单位除以 unitsPerEm），y 向上。偏移都相对这个字形，字形可以按块拼进更大的缓冲。
 */

/** 一个字形的 Slug 数据。 */
export interface SlugGlyph {
  /** 点（x、y 交替）。 */
  readonly points: Float32Array;
  /**
   * 带：先是 hBands 个横带的头、再是 vBands 个竖带的头，每个头两个字（曲线数、曲线表相对这个数组开头的位置），
   * 后面是曲线表（曲线第一个点在 points 里的下标，按点算，不是按 float 算）。
   */
  readonly bands: Uint32Array;
  readonly hBands: number;
  readonly vBands: number;
  /** em 坐标到带下标：横带下标 = floor(y · scale[1] + offset[1])，竖带下标 = floor(x · scale[0] + offset[0])。 */
  readonly bandScale: readonly [number, number];
  readonly bandOffset: readonly [number, number];
}

const MAX_BANDS = 16;
const BAND_OVERLAP = 1 / 1024;

/**
 * curves：二次曲线（x1 y1 x2 y2 x3 y3，em），bounds：x0 y0 x1 y1（em）。没有曲线时（空格）返回空的数据。
 */
export function slugGlyph(curves: Float32Array, bounds: readonly [number, number, number, number]): SlugGlyph {
  const count = curves.length / 6;
  if (count === 0) return { points: new Float32Array(0), bands: new Uint32Array(0), hBands: 0, vBands: 0, bandScale: [0, 0], bandOffset: [0, 0] };
  const { points, starts } = packPoints(curves);
  const [x0, y0, x1, y1] = bounds;
  const coordinate = (curve: number, axis: 0 | 1) => [curves[curve * 6 + axis]!, curves[curve * 6 + 2 + axis]!, curves[curve * 6 + 4 + axis]!];
  // 横带：按 y 切，排除水平的直线，按最大 x 排；竖带反过来
  const horizontal = bandsAlong(count, coordinate, 1, 0, y0, y1);
  const vertical = bandsAlong(count, coordinate, 0, 1, x0, x1);
  const bands = [...horizontal.lists, ...vertical.lists];
  const header = bands.length * 2;
  const words: number[] = new Array<number>(header).fill(0);
  bands.forEach((list, i) => {
    words[i * 2] = list.length;
    words[i * 2 + 1] = words.length;
    for (const curve of list) words.push(starts[curve]!);
  });
  return {
    points,
    bands: Uint32Array.from(words),
    hBands: horizontal.lists.length,
    vBands: vertical.lists.length,
    bandScale: [vertical.scale, horizontal.scale],
    bandOffset: [-x0 * vertical.scale, -y0 * horizontal.scale],
  };
}

/** 相连的曲线共用端点：一条曲线的 p1 等于上一条的 p3 时不再重复存。starts 是每条曲线的 p1 在 points 里的下标。 */
function packPoints(curves: Float32Array): { points: Float32Array; starts: Uint32Array } {
  const count = curves.length / 6;
  const points: number[] = [];
  const starts = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    const c = curves.subarray(i * 6, i * 6 + 6);
    const n = points.length;
    const continues = n >= 2 && points[n - 2] === c[0] && points[n - 1] === c[1];
    if (!continues) points.push(c[0]!, c[1]!);
    starts[i] = points.length / 2 - 1;
    points.push(c[2]!, c[3]!, c[4]!, c[5]!);
  }
  return { points: Float32Array.from(points), starts };
}

/**
 * 沿 axis（1：横带按 y 切；0：竖带按 x 切）把曲线分到带里；带的条数取 1..MAX_BANDS 里使"最多的一条带里的曲线数"
 * 不超过最好情况加一的最少条数（条数越多数据越大，最多的那条带决定着色器的最坏耗时）。
 */
function bandsAlong(count: number, coordinate: (curve: number, axis: 0 | 1) => number[], axis: 0 | 1, sortAxis: 0 | 1, start: number, end: number): { lists: number[][]; scale: number } {
  const extent = Math.max(end - start, 1e-6);
  // 和带平行的直线不参与
  const eligible = Array.from({ length: count }, (_, i) => i).filter((curve) => {
    const c = coordinate(curve, axis);
    return !(c[0] === c[1] && c[1] === c[2]);
  });
  const sortKey = (curve: number) => Math.max(...coordinate(curve, sortAxis));
  const split = (n: number): number[][] => {
    const height = extent / n;
    return Array.from({ length: n }, (_, b) => {
      const lo = start + b * height - BAND_OVERLAP;
      const hi = start + (b + 1) * height + BAND_OVERLAP;
      return eligible.filter((curve) => {
        const c = coordinate(curve, axis);
        return Math.max(...c) >= lo && Math.min(...c) <= hi;
      }).sort((a, b2) => sortKey(b2) - sortKey(a));
    });
  };
  const largest = (lists: number[][]) => Math.max(0, ...lists.map((list) => list.length));
  const best = largest(split(MAX_BANDS));
  let n = 1;
  let lists = split(1);
  while (n < MAX_BANDS && largest(lists) > best + 1) lists = split(++n);
  return { lists, scale: n / extent };
}
