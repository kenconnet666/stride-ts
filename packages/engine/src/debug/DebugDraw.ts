/**
 * 调试用的线（`game.debugDraw`）：脚本、工具每帧调用 `line`、`box`、`sphere` 这些画线框，默认只画这一帧（下一次 update 开始时
 * 清掉），给了 duration 的留那么多秒。画在场景、后处理和 UI 之后，粗细按 CSS 像素给、换成整数个设备像素，不随距离变；
 * 默认和场景比深度（被挡住的看不见），`depthTest: false` 的画在最上面。编辑器的网格、Gizmo、选中框，物理形状的显示都用它。
 *
 *   override update(): void {
 *     this.game.debugDraw.box(this.entity.require(Transform).world, [0.5, 1, 0.5], [1, 0.8, 0, 1]);
 *     this.game.debugDraw.line(from, to, [1, 0, 0, 1], { width: 2, depthTest: false });
 *   }
 *
 * 颜色按 sRGB 写（同 UI 的颜色），存的时候换成线性。这里只管攒线（可以单测），画在 DebugDrawRenderer。
 */
import { srgbToLinear, type Vec3Like } from '../mathematics/vectors';

/** 一个点：{ x, y, z } 或者 [x, y, z]。 */
export type DebugPoint = Vec3Like | readonly [number, number, number];
export type DebugColor = readonly [number, number, number, number];

export interface DebugDrawOptions {
  /** 线宽，CSS 像素（默认 1）；画的时候换成整数个设备像素。 */
  readonly width?: number;
  /** 和场景比深度（默认 true）；false 时画在最上面。 */
  readonly depthTest?: boolean;
  /** 留多少秒（默认 0：只画这一帧）。 */
  readonly duration?: number;
}

/** 每条线在缓冲里占的 float 数：起点 xyz、线宽，终点 xyz、空，颜色 rgba（线性）。 */
export const DEBUG_LINE_FLOATS = 12;

const WHITE: DebugColor = [1, 1, 1, 1];
type Triple = readonly [number, number, number];

function triple(point: DebugPoint): Triple {
  return 'x' in point ? [point.x, point.y, point.z] : point;
}

/** 和 axis 垂直的两个单位向量（u、v、axis 右手系）。 */
function basis([x, y, z]: Triple): [Triple, Triple] {
  // 拿离 axis 最远的坐标轴去叉乘
  const other: Triple = Math.abs(y) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  let ux = other[1] * z - other[2] * y, uy = other[2] * x - other[0] * z, uz = other[0] * y - other[1] * x;
  const length = Math.hypot(ux, uy, uz) || 1;
  ux /= length; uy /= length; uz /= length;
  return [[ux, uy, uz], [y * uz - z * uy, z * ux - x * uz, x * uy - y * ux]];
}

function normalize([x, y, z]: Triple, fallback: Triple = [0, 1, 0]): Triple {
  const length = Math.hypot(x, y, z);
  return length > 1e-12 ? [x / length, y / length, z / length] : fallback;
}

/** 一组线：数据连着放，另外记每条线到什么时候为止。 */
class LineBuffer {
  data = new Float32Array(DEBUG_LINE_FLOATS * 256);
  expires = new Float64Array(256);
  count = 0;

  push(a: Triple, b: Triple, color: DebugColor, width: number, expires: number): void {
    if (this.count === this.expires.length) {
      const data = new Float32Array(this.data.length * 2);
      data.set(this.data);
      this.data = data;
      const expires = new Float64Array(this.expires.length * 2);
      expires.set(this.expires);
      this.expires = expires;
    }
    const o = this.count * DEBUG_LINE_FLOATS, data = this.data;
    data[o] = a[0]; data[o + 1] = a[1]; data[o + 2] = a[2]; data[o + 3] = width;
    data[o + 4] = b[0]; data[o + 5] = b[1]; data[o + 6] = b[2]; data[o + 7] = 0;
    data[o + 8] = srgbToLinear(color[0]); data[o + 9] = srgbToLinear(color[1]); data[o + 10] = srgbToLinear(color[2]); data[o + 11] = color[3];
    this.expires[this.count++] = expires;
  }

  /** 去掉到期的（expires 不大于 now），留下的往前挪；返回有没有去掉。 */
  expire(now: number): boolean {
    let kept = 0;
    for (let i = 0; i < this.count; i++) {
      if (this.expires[i]! <= now) continue;
      if (kept !== i) {
        this.data.copyWithin(kept * DEBUG_LINE_FLOATS, i * DEBUG_LINE_FLOATS, (i + 1) * DEBUG_LINE_FLOATS);
        this.expires[kept] = this.expires[i]!;
      }
      kept++;
    }
    const removed = kept !== this.count;
    this.count = kept;
    return removed;
  }
}

export class DebugDraw {
  /** 画不画；不画的时候照样攒线。 */
  visible = true;
  /** 默认的线宽，CSS 像素。 */
  width = 1;
  /** 和场景比深度的线、画在最上面的线。 */
  readonly #tested = new LineBuffer();
  readonly #overlay = new LineBuffer();
  #now = 0;
  #version = 0;

  /** 线变过就加一（渲染器靠它决定要不要重新上传）。 */
  get version(): number { return this.#version; }
  /** 一共有多少条线。 */
  get count(): number { return this.#tested.count + this.#overlay.count; }
  /** @internal 和场景比深度的线：数据（每条 DEBUG_LINE_FLOATS 个 float）和条数。 */
  get tested(): { readonly data: Float32Array; readonly count: number } { return this.#tested; }
  /** @internal 画在最上面的线。 */
  get overlay(): { readonly data: Float32Array; readonly count: number } { return this.#overlay; }

  /** @internal 每次 update 开始时：total 是游戏时间（秒），到期的线去掉（没给 duration 的就是上一帧的）。 */
  beginFrame(total: number): void {
    this.#now = total;
    const removed = this.#tested.expire(total);
    if (this.#overlay.expire(total) || removed) this.#version++;
  }

  /** 去掉所有的线（包括还没到期的）。 */
  clear(): void {
    if (this.count === 0) return;
    this.#tested.count = this.#overlay.count = 0;
    this.#version++;
  }

  line(from: DebugPoint, to: DebugPoint, color: DebugColor = WHITE, options?: DebugDrawOptions): void {
    this.#line(triple(from), triple(to), color, options);
  }

  /** 一串点连成的折线；closed 时最后一个点连回第一个。 */
  polyline(points: readonly DebugPoint[], color: DebugColor = WHITE, options?: DebugDrawOptions & { readonly closed?: boolean }): void {
    const last = options?.closed ? points.length : points.length - 1;
    for (let i = 0; i < last; i++) this.#line(triple(points[i]!), triple(points[(i + 1) % points.length]!), color, options);
  }

  /** 两个角给出的轴对齐的盒子（包围盒）。 */
  bounds(min: DebugPoint, max: DebugPoint, color: DebugColor = WHITE, options?: DebugDrawOptions): void {
    const [x0, y0, z0] = triple(min), [x1, y1, z1] = triple(max);
    this.#boxCorners([
      [x0, y0, z0], [x1, y0, z0], [x0, y1, z0], [x1, y1, z0], [x0, y0, z1], [x1, y0, z1], [x0, y1, z1], [x1, y1, z1],
    ], color, options);
  }

  /** 世界矩阵 world（列主序的 16 个数）下、半边长 halfExtents 的盒子：12 条棱。 */
  box(world: ArrayLike<number>, halfExtents: DebugPoint = [0.5, 0.5, 0.5], color: DebugColor = WHITE, options?: DebugDrawOptions): void {
    const [hx, hy, hz] = triple(halfExtents);
    const corners: Triple[] = [];
    for (let i = 0; i < 8; i++) corners.push(transform(world, i & 1 ? hx : -hx, i & 2 ? hy : -hy, i & 4 ? hz : -hz));
    this.#boxCorners(corners, color, options);
  }

  /** 圆：圆心、所在平面的法线、半径。 */
  circle(center: DebugPoint, normal: DebugPoint, radius: number, color: DebugColor = WHITE, options?: DebugDrawOptions & { readonly segments?: number }): void {
    const [u, v] = basis(normalize(triple(normal)));
    this.#arc(triple(center), u, v, radius, 0, Math.PI * 2, options?.segments ?? 32, color, options);
  }

  /** 球：三个互相垂直的大圆。 */
  sphere(center: DebugPoint, radius: number, color: DebugColor = WHITE, options?: DebugDrawOptions & { readonly segments?: number }): void {
    const c = triple(center), segments = options?.segments ?? 32;
    this.#arc(c, [1, 0, 0], [0, 1, 0], radius, 0, Math.PI * 2, segments, color, options);
    this.#arc(c, [0, 1, 0], [0, 0, 1], radius, 0, Math.PI * 2, segments, color, options);
    this.#arc(c, [0, 0, 1], [1, 0, 0], radius, 0, Math.PI * 2, segments, color, options);
  }

  /** 胶囊：两个端点（两头半球的球心）和半径。 */
  capsule(from: DebugPoint, to: DebugPoint, radius: number, color: DebugColor = WHITE, options?: DebugDrawOptions & { readonly segments?: number }): void {
    const a = triple(from), b = triple(to), segments = options?.segments ?? 32;
    const axis = normalize([b[0] - a[0], b[1] - a[1], b[2] - a[2]]);
    const [u, v] = basis(axis);
    const back: Triple = [-axis[0], -axis[1], -axis[2]];
    for (const side of [u, v]) {
      // 侧面的两条母线，两头各半个圆
      for (const sign of [1, -1]) this.#line(offset(a, side, radius * sign), offset(b, side, radius * sign), color, options);
      this.#arc(b, side, axis, radius, 0, Math.PI, segments / 2, color, options);
      this.#arc(a, side, back, radius, 0, Math.PI, segments / 2, color, options);
    }
    this.#arc(a, u, v, radius, 0, Math.PI * 2, segments, color, options);
    this.#arc(b, u, v, radius, 0, Math.PI * 2, segments, color, options);
  }

  /** 圆柱：两个底面的圆心和半径。topRadius 给 0 就是圆锥。 */
  cylinder(from: DebugPoint, to: DebugPoint, radius: number, color: DebugColor = WHITE, options?: DebugDrawOptions & { readonly segments?: number; readonly topRadius?: number }): void {
    const a = triple(from), b = triple(to), segments = options?.segments ?? 32, top = options?.topRadius ?? radius;
    const [u, v] = basis(normalize([b[0] - a[0], b[1] - a[1], b[2] - a[2]]));
    this.#arc(a, u, v, radius, 0, Math.PI * 2, segments, color, options);
    if (top > 0) this.#arc(b, u, v, top, 0, Math.PI * 2, segments, color, options);
    for (const side of [u, v]) for (const sign of [1, -1]) this.#line(offset(a, side, radius * sign), offset(b, side, top * sign), color, options);
  }

  /** 箭头：从 from 到 to 的线，头上四条短线；headLength 默认是全长的五分之一。 */
  arrow(from: DebugPoint, to: DebugPoint, color: DebugColor = WHITE, options?: DebugDrawOptions & { readonly headLength?: number }): void {
    const a = triple(from), b = triple(to);
    const length = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    this.#line(a, b, color, options);
    if (length < 1e-9) return;
    const axis = normalize([b[0] - a[0], b[1] - a[1], b[2] - a[2]]);
    const head = options?.headLength ?? length / 5;
    const [u, v] = basis(axis);
    const base = offset(b, axis, -head);
    for (const side of [u, v]) for (const sign of [1, -1]) this.#line(b, offset(base, side, head * 0.4 * sign), color, options);
  }

  /** 坐标轴：world 的原点出发的三条线，X 红、Y 绿、Z 蓝，长 size（按 world 的轴的方向，不随它的缩放）。 */
  axes(world: ArrayLike<number>, size = 1, options?: DebugDrawOptions): void {
    const origin: Triple = [world[12]!, world[13]!, world[14]!];
    const colors: DebugColor[] = [[1, 0.2, 0.2, 1], [0.3, 0.9, 0.3, 1], [0.3, 0.5, 1, 1]];
    for (let i = 0; i < 3; i++) this.#line(origin, offset(origin, normalize([world[i * 4]!, world[i * 4 + 1]!, world[i * 4 + 2]!], [0, 0, 0]), size), colors[i]!, options);
  }

  /** 视锥：给视图投影矩阵的逆（列主序），画出裁剪空间那个盒子在世界里的样子（深度 0 到 1）。 */
  frustum(inverseViewProjection: ArrayLike<number>, color: DebugColor = WHITE, options?: DebugDrawOptions): void {
    const corners: Triple[] = [];
    for (let i = 0; i < 8; i++) corners.push(project(inverseViewProjection, i & 1 ? 1 : -1, i & 2 ? 1 : -1, i & 4 ? 1 : 0));
    this.#boxCorners(corners, color, options);
  }

  /**
   * 网格：以 center 为中心、在 axisU 和 axisV 张成的平面上（默认是水平的 XZ 平面），每隔 step 一条线，两个方向各铺 halfCount 格。
   * 过中心的两条线用 axisColor（默认比别的线亮）。
   */
  grid(
    center: DebugPoint = [0, 0, 0], step = 1, halfCount = 10, color: DebugColor = [0.5, 0.5, 0.5, 0.6],
    options?: DebugDrawOptions & { readonly axisU?: DebugPoint; readonly axisV?: DebugPoint; readonly axisColor?: DebugColor },
  ): void {
    const c = triple(center), u = triple(options?.axisU ?? [1, 0, 0]), v = triple(options?.axisV ?? [0, 0, 1]);
    const extent = step * halfCount, axisColor = options?.axisColor ?? [0.8, 0.8, 0.8, 0.9];
    for (let i = -halfCount; i <= halfCount; i++) {
      const lineColor = i === 0 ? axisColor : color;
      this.#line(offset(offset(c, u, i * step), v, -extent), offset(offset(c, u, i * step), v, extent), lineColor, options);
      this.#line(offset(offset(c, v, i * step), u, -extent), offset(offset(c, v, i * step), u, extent), lineColor, options);
    }
  }

  #line(a: Triple, b: Triple, color: DebugColor, options: DebugDrawOptions | undefined): void {
    const buffer = options?.depthTest === false ? this.#overlay : this.#tested;
    // 没给 duration：到下一次 beginFrame 为止（那时的时间一定不小于现在）
    buffer.push(a, b, color, options?.width ?? this.width, options?.duration ? this.#now + options.duration : this.#now);
    this.#version++;
  }

  /** 八个角（下标的第 0、1、2 位是 x、y、z 取哪一头）连成 12 条棱。 */
  #boxCorners(corners: readonly Triple[], color: DebugColor, options: DebugDrawOptions | undefined): void {
    for (let i = 0; i < 8; i++) {
      for (const bit of [1, 2, 4]) if ((i & bit) === 0) this.#line(corners[i]!, corners[i | bit]!, color, options);
    }
  }

  /** 圆弧：center + radius · (u cos t + v sin t)，t 从 start 到 end，分成 segments 段。 */
  #arc(center: Triple, u: Triple, v: Triple, radius: number, start: number, end: number, segments: number, color: DebugColor, options: DebugDrawOptions | undefined): void {
    const count = Math.max(2, Math.round(segments));
    let previous: Triple | undefined;
    for (let i = 0; i <= count; i++) {
      const t = start + ((end - start) * i) / count, cos = Math.cos(t) * radius, sin = Math.sin(t) * radius;
      const point: Triple = [center[0] + u[0] * cos + v[0] * sin, center[1] + u[1] * cos + v[1] * sin, center[2] + u[2] * cos + v[2] * sin];
      if (previous) this.#line(previous, point, color, options);
      previous = point;
    }
  }
}

function offset(point: Triple, direction: Triple, distance: number): Triple {
  return [point[0] + direction[0] * distance, point[1] + direction[1] * distance, point[2] + direction[2] * distance];
}

/** 列主序的 4x4 矩阵乘点 (x, y, z, 1)，不做透视除法（仿射变换）。 */
function transform(m: ArrayLike<number>, x: number, y: number, z: number): Triple {
  return [m[0]! * x + m[4]! * y + m[8]! * z + m[12]!, m[1]! * x + m[5]! * y + m[9]! * z + m[13]!, m[2]! * x + m[6]! * y + m[10]! * z + m[14]!];
}

/** 同上，做透视除法。 */
function project(m: ArrayLike<number>, x: number, y: number, z: number): Triple {
  const w = m[3]! * x + m[7]! * y + m[11]! * z + m[15]!;
  const [px, py, pz] = transform(m, x, y, z);
  return [px / w, py / w, pz / w];
}
