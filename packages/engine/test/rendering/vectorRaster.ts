/**
 * 矢量贴图的 CPU 版画法（测试、排查用）：照着色器（rendering/mesh/vectorAtlas.ts 的 vectorColor、vectorShapeCoverage 和
 * rendering/text/slug.ts 的根判别、求交）逐像素算颜色和覆盖率，f32 的地方用 Math.fround，结果和 GPU 上的一致到舍入。
 * 用来离线把一张矢量贴图画成图，和精确的绕数比，找画错的地方。
 */
import { VECTOR_SHAPE_WORDS } from '../../src/rendering/mesh/vectorAtlas';

const f32 = Math.fround;

function rootCode(y1: number, y2: number, y3: number): number {
  const sign = (v: number) => (Object.is(v, -0) || v < 0 ? 1 : 0);
  const i1 = sign(y1), i2 = sign(y2) << 1, i3 = sign(y3) << 2;
  const shift = i1 | i2 | i3;
  return (0x2e74 >> shift) & 0x0101;
}

/** 曲线（点已经减去采样点）穿过 y = 0 的两个 x。 */
function solveHorizontal(p1: readonly [number, number], p2: readonly [number, number], p3: readonly [number, number]): [number, number] {
  const ax = f32(p1[0] - p2[0] * 2 + p3[0]), ay = f32(p1[1] - p2[1] * 2 + p3[1]);
  const bx = f32(p1[0] - p2[0]), by = f32(p1[1] - p2[1]);
  const d = f32(Math.sqrt(Math.max(f32(by * by - ay * p1[1]), 0)));
  // 同着色器的 slugRoots：每个根取不相消的写法
  const c = p1[1], linear = f32((c * 0.5) / by), curved = Math.abs(ay) >= 1 / 65536;
  const [t1, t2] = by >= 0
    ? [by + d !== 0 ? f32(c / f32(by + d)) : linear, curved ? f32(f32(by + d) / ay) : linear]
    : [curved ? f32(f32(by - d) / ay) : linear, f32(c / f32(by - d))];
  return [f32((ax * t1 - bx * 2) * t1 + p1[0]), f32((ax * t2 - bx * 2) * t2 + p1[0])];
}

/** 一个形状在 coord 处的覆盖率（同着色器的 vectorShapeCoverage）。 */
export function shapeCoverage(data: Uint32Array, shape: number, x: number, y: number, pixelsPerUnit: number): number {
  const f = new Float32Array(data.buffer, data.byteOffset, data.length);
  const o = data[6]! + shape * VECTOR_SHAPE_WORDS;
  const [sx, sy, ox, oy] = [f[o + 2]!, f[o + 3]!, f[o + 4]!, f[o + 5]!];
  const bandBase = data[8]! + data[o + 7]!;
  const hBands = data[o + 8]!, vBands = data[o + 9]!;
  const bx = Math.min(Math.max(Math.trunc(f32(x * sx + ox)), 0), vBands - 1), by = Math.min(Math.max(Math.trunc(f32(y * sy + oy)), 0), hBands - 1);
  const point = (i: number): [number, number] => [f[data[7]! + i * 2]!, f[data[7]! + i * 2 + 1]!];
  const pass = (band: number, horizontal: boolean) => {
    let cov = 0, wgt = 0;
    const count = data[bandBase + band * 2]!, list = bandBase + data[bandBase + band * 2 + 1]!;
    for (let k = 0; k < count; k++) {
      const p = data[list + k]!;
      // 横射线照原样；竖射线把 x、y 对调（同着色器的 slugSolveVertical 和用 x 的根判别）
      const swap = (q: [number, number]): [number, number] => (horizontal ? [f32(q[0] - x), f32(q[1] - y)] : [f32(q[1] - y), f32(q[0] - x)]);
      const p1 = swap(point(p)), p2 = swap(point(p + 1)), p3 = swap(point(p + 2));
      if (Math.max(p1[0], p2[0], p3[0]) * pixelsPerUnit < -0.5) break;
      const code = rootCode(p1[1], p2[1], p3[1]);
      if (code === 0) continue;
      const [r1, r2] = solveHorizontal(p1, p2, p3).map((r) => r * pixelsPerUnit) as [number, number];
      if (code & 1) {
        cov += Math.min(Math.max(r1 + 0.5, 0), 1);
        wgt = Math.max(wgt, Math.min(Math.max(1 - Math.abs(r1) * 2, 0), 1));
      }
      if (code > 1) {
        cov -= Math.min(Math.max(r2 + 0.5, 0), 1);
        wgt = Math.max(wgt, Math.min(Math.max(1 - Math.abs(r2) * 2, 0), 1));
      }
    }
    return [cov, wgt] as const;
  };
  let [xcov, xwgt] = pass(by, true);
  let [ycov, ywgt] = pass(hBands + bx, false);
  // 竖射线的结果按着色器的符号约定取反（着色器里竖带的穿越方向和横带相反）
  ycov = -ycov;
  if (data[o + 1]! & 1) {
    xcov = 1 - Math.abs(1 - (Math.abs(xcov) % 2));
    ycov = 1 - Math.abs(1 - (Math.abs(ycov) % 2));
  }
  return Math.min(Math.max(Math.max(Math.abs(xcov * xwgt + ycov * ywgt) / Math.max(xwgt + ywgt, 1 / 65536), Math.min(Math.abs(xcov), Math.abs(ycov))), 0), 1);
}

/** 精确的绕数（所有曲线，向 +X 数带符号的穿越次数）：和 shapeCoverage 比对用。 */
export function exactWinding(curves: readonly number[], x: number, y: number): number {
  let total = 0;
  for (let i = 0; i < curves.length; i += 6) {
    const [x0, y0, cx, cy, x1, y1] = [curves[i]!, curves[i + 1]!, curves[i + 2]!, curves[i + 3]!, curves[i + 4]!, curves[i + 5]!];
    const a = y0 - 2 * cy + y1, b = 2 * (cy - y0), c = y0 - y;
    const roots = Math.abs(a) < 1e-12 ? (Math.abs(b) > 1e-12 ? [-c / b] : []) : (() => {
      const d = b * b - 4 * a * c;
      return d < 0 ? [] : [(-b - Math.sqrt(d)) / (2 * a), (-b + Math.sqrt(d)) / (2 * a)];
    })();
    for (const t of roots) {
      if (t < 0 || t >= 1) continue;
      const u = 1 - t;
      if (u * u * x0 + 2 * u * t * cx + t * t * x1 <= x) continue;
      total += Math.sign(2 * a * t + b);
    }
  }
  return total;
}
