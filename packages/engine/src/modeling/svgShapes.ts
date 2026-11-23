/**
 * 生成的 SVG（标签图集、价签、器具的漆面……）拆成一个个填充形状，给矢量贴图用（rendering/mesh/vectorAtlas.ts：近处按曲线逐像素
 * 算覆盖率，走多近都清楚）。只认我们的生成代码写的那部分 SVG：
 * - 元素：svg（根、嵌套的：x、y、width、height、viewBox，preserveAspectRatio 只按 none 算，嵌套的按自己的视口裁剪）、g、rect（可带
 *   rx、ry）、circle、ellipse、path（M L H V Q T C S A Z 和小写的相对命令）、polygon、polyline、line；defs 里的渐变只取各个色标的
 *   平均色（标签图集里没有渐变，冷柜门上的水雾那张不用矢量）；mask、filter、clipPath 不管。
 * - 属性：fill、fill-rule、fill-opacity、stroke、stroke-width、stroke-opacity、stroke-linecap（round、square）、opacity、transform
 *   （matrix、translate、scale、rotate、skewX、skewY），g 上的往下继承。颜色是 #rgb、#rrggbb、rgb()、几个常用的名字。
 * - 描边换成填充的轮廓：每一段一个矩形，拐点、圆头补一个圆（都按同一个绕向，非零规则下并在一起）。
 * 曲线一律换成二次贝塞尔（直线的控制点在中点，三次的按段数拆开近似，椭圆弧先换成三次），坐标是根 svg 的用户坐标（viewBox 的）。
 */

/** 一个填充形状：颜色（sRGB 的 0..1，a 是不透明度）、规则、裁剪（嵌套 svg 的视口，[x0, y0, x1, y1]）和二次曲线（每条 6 个数：起点、控制点、终点）。 */
export interface VectorShape {
  readonly color: readonly [number, number, number, number];
  readonly evenOdd: boolean;
  readonly clip: readonly [number, number, number, number] | undefined;
  readonly curves: readonly number[];
}

/** 解析出来的 SVG：根的 viewBox（[x, y, 宽, 高]）和按画的顺序排的形状。 */
export interface VectorImage {
  readonly viewBox: readonly [number, number, number, number];
  readonly shapes: readonly VectorShape[];
}

type Matrix = readonly [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

interface Style {
  readonly fill: string;
  readonly fillRule: string;
  readonly fillOpacity: number;
  readonly stroke: string;
  readonly strokeWidth: number;
  readonly strokeOpacity: number;
  readonly cap: string;
  readonly opacity: number;
}
const DEFAULT_STYLE: Style = { fill: '#000000', fillRule: 'nonzero', fillOpacity: 1, stroke: 'none', strokeWidth: 1, strokeOpacity: 1, cap: 'butt', opacity: 1 };

interface Element {
  readonly name: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly children: Element[];
}

/** SVG 文本拆成形状。不认识的元素跳过（连同子元素），格式不对时报错（where 是报错的前缀）。 */
export function svgShapes(svg: string, where = 'svg'): VectorImage {
  const root = parseXml(svg, where);
  if (root.name !== 'svg') throw new Error(`${where}: the root element is ${root.name}, not svg`);
  const box = viewBoxOf(root.attributes);
  const gradients = new Map<string, readonly [number, number, number, number]>();
  collectGradients(root, gradients);
  const shapes: VectorShape[] = [];
  walk(root.children, IDENTITY, DEFAULT_STYLE, undefined, { gradients, shapes, where });
  return { viewBox: box ?? [0, 0, number(root.attributes['width'], 0), number(root.attributes['height'], 0)], shapes };
}

interface Context {
  readonly gradients: ReadonlyMap<string, readonly [number, number, number, number]>;
  readonly shapes: VectorShape[];
  readonly where: string;
}

function walk(elements: readonly Element[], matrix: Matrix, inherited: Style, clip: VectorShape['clip'], context: Context): void {
  for (const element of elements) {
    const a = element.attributes;
    const style = styleOf(a, inherited);
    let m = a['transform'] ? multiply(matrix, parseTransform(a['transform'], context.where)) : matrix;
    switch (element.name) {
      case 'g':
        walk(element.children, m, style, clip, context);
        break;
      case 'svg': {
        // 嵌套的视口：先挪到 (x, y)，viewBox 拉伸到 width × height（preserveAspectRatio 当 none），按视口裁剪
        const x = number(a['x'], 0), y = number(a['y'], 0), width = number(a['width'], 0), height = number(a['height'], 0);
        const box = viewBoxOf(a);
        m = multiply(m, [1, 0, 0, 1, x, y]);
        const viewport = transformedBox(m, [0, 0, width, height]);
        if (box && box[2] > 0 && box[3] > 0) m = multiply(m, [width / box[2], 0, 0, height / box[3], -box[0] * width / box[2], -box[1] * height / box[3]]);
        walk(element.children, m, style, intersect(clip, viewport), context);
        break;
      }
      case 'rect': case 'circle': case 'ellipse': case 'path': case 'polygon': case 'polyline': case 'line': {
        const contours = outline(element.name, a, context.where);
        if (contours.length > 0) emit(contours, element.name !== 'line', m, style, clip, context);
        break;
      }
      default:
        // defs、渐变（已经收过）、mask、filter、clipPath、title……不画
        break;
    }
  }
}

/** 一个元素的填充和描边各出一个形状（描边在上面）。 */
function emit(contours: Contour[], fillable: boolean, m: Matrix, style: Style, clip: VectorShape['clip'], context: Context): void {
  const fill = fillable ? colorOf(style.fill, context) : undefined;
  if (fill && fill[3] > 0) {
    const alpha = fill[3] * style.fillOpacity * style.opacity;
    // 只围出一条线的（没写 fill 的描边路径默认填黑）面积是 0，不出形状
    const closed = contours.map((contour) => closeContour(contour.curves));
    const curves = closed.flatMap((contour) => transformCurves(contour, m));
    if (alpha > 0 && curves.length > 0 && Math.abs(signedArea(curves)) > 1e-9) context.shapes.push({ color: [fill[0], fill[1], fill[2], alpha], evenOdd: style.fillRule === 'evenodd', clip, curves });
  }
  const stroke = colorOf(style.stroke, context);
  if (stroke && stroke[3] > 0 && style.strokeWidth > 0) {
    const alpha = stroke[3] * style.strokeOpacity * style.opacity;
    // 描边在用户坐标里展开（线宽跟着变换一起缩放），再变换
    const curves = transformCurves(strokeOutline(contours, style.strokeWidth, style.cap), m);
    if (alpha > 0 && curves.length > 0) context.shapes.push({ color: [stroke[0], stroke[1], stroke[2], alpha], evenOdd: false, clip, curves });
  }
}

// ---- 轮廓：每个子路径是一串首尾相接的二次曲线 ----

interface Contour {
  readonly curves: number[];
  readonly closed: boolean;
}

/** 椭圆（圆）分几段二次曲线：8 段的误差在半径的 0.03% 以内。 */
const ELLIPSE_SEGMENTS = 8;

function outline(name: string, a: Readonly<Record<string, string>>, where: string): Contour[] {
  switch (name) {
    case 'rect': {
      const x = number(a['x'], 0), y = number(a['y'], 0), w = number(a['width'], 0), h = number(a['height'], 0);
      if (!(w > 0 && h > 0)) return [];
      let rx = number(a['rx'], NaN), ry = number(a['ry'], NaN);
      if (Number.isNaN(rx)) rx = Number.isNaN(ry) ? 0 : ry;
      if (Number.isNaN(ry)) ry = rx;
      rx = Math.min(Math.max(rx, 0), w / 2);
      ry = Math.min(Math.max(ry, 0), h / 2);
      if (rx === 0 || ry === 0) return [polygonContour([[x, y], [x + w, y], [x + w, y + h], [x, y + h]], true)];
      const path = new PathBuilder();
      path.move(x + rx, y);
      path.line(x + w - rx, y);
      path.arc(rx, ry, 0, false, true, x + w, y + ry);
      path.line(x + w, y + h - ry);
      path.arc(rx, ry, 0, false, true, x + w - rx, y + h);
      path.line(x + rx, y + h);
      path.arc(rx, ry, 0, false, true, x, y + h - ry);
      path.line(x, y + ry);
      path.arc(rx, ry, 0, false, true, x + rx, y);
      path.close();
      return path.contours;
    }
    case 'circle': {
      const r = number(a['r'], 0);
      return r > 0 ? [ellipseContour(number(a['cx'], 0), number(a['cy'], 0), r, r)] : [];
    }
    case 'ellipse': {
      const rx = number(a['rx'], 0), ry = number(a['ry'], 0);
      return rx > 0 && ry > 0 ? [ellipseContour(number(a['cx'], 0), number(a['cy'], 0), rx, ry)] : [];
    }
    case 'line':
      return [polygonContour([[number(a['x1'], 0), number(a['y1'], 0)], [number(a['x2'], 0), number(a['y2'], 0)]], false)];
    case 'polygon': case 'polyline': {
      const values = numbers(a['points'] ?? '');
      const points: [number, number][] = [];
      for (let i = 0; i + 1 < values.length; i += 2) points.push([values[i]!, values[i + 1]!]);
      return points.length >= 2 ? [polygonContour(points, name === 'polygon')] : [];
    }
    case 'path':
      return parsePath(a['d'] ?? '', where);
    default:
      return [];
  }
}

function polygonContour(points: readonly (readonly [number, number])[], closed: boolean): Contour {
  const curves: number[] = [];
  const count = closed ? points.length : points.length - 1;
  for (let i = 0; i < count; i++) {
    const [x0, y0] = points[i]!, [x1, y1] = points[(i + 1) % points.length]!;
    curves.push(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2, x1, y1);
  }
  return { curves, closed };
}

function ellipseContour(cx: number, cy: number, rx: number, ry: number): Contour {
  const curves: number[] = [];
  const step = (2 * Math.PI) / ELLIPSE_SEGMENTS, k = 1 / Math.cos(step / 2);
  for (let i = 0; i < ELLIPSE_SEGMENTS; i++) {
    const a0 = i * step, a1 = a0 + step, am = a0 + step / 2;
    curves.push(cx + rx * Math.cos(a0), cy + ry * Math.sin(a0), cx + rx * k * Math.cos(am), cy + ry * k * Math.sin(am), cx + rx * Math.cos(a1), cy + ry * Math.sin(a1));
  }
  return { curves, closed: true };
}

/** 一条路径攒成几个子路径（二次曲线）。 */
class PathBuilder {
  readonly contours: Contour[] = [];
  #curves: number[] = [];
  #start: [number, number] = [0, 0];
  x = 0;
  y = 0;

  move(x: number, y: number): void {
    this.#flush(false);
    this.#start = [x, y];
    this.x = x;
    this.y = y;
  }

  line(x: number, y: number): void {
    if (x === this.x && y === this.y) return;
    this.#curves.push(this.x, this.y, (this.x + x) / 2, (this.y + y) / 2, x, y);
    this.x = x;
    this.y = y;
  }

  quad(cx: number, cy: number, x: number, y: number): void {
    this.#curves.push(this.x, this.y, cx, cy, x, y);
    this.x = x;
    this.y = y;
  }

  /** 三次曲线：按长度拆成几段，每段用一条二次曲线近似（控制点取两条切线的交点的近似 (3c1 + 3c2 − p0 − p3) / 4）。 */
  cubic(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number): void {
    const x0 = this.x, y0 = this.y;
    const length = Math.hypot(c1x - x0, c1y - y0) + Math.hypot(c2x - c1x, c2y - c1y) + Math.hypot(x - c2x, y - c2y);
    const pieces = Math.min(16, Math.max(2, Math.ceil(length / 20)));
    const at = (t: number): [number, number] => {
      const u = 1 - t;
      return [u * u * u * x0 + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * x, u * u * u * y0 + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * y];
    };
    const tangent = (t: number): [number, number] => {
      const u = 1 - t;
      return [3 * u * u * (c1x - x0) + 6 * u * t * (c2x - c1x) + 3 * t * t * (x - c2x), 3 * u * u * (c1y - y0) + 6 * u * t * (c2y - c1y) + 3 * t * t * (y - c2y)];
    };
    for (let i = 0; i < pieces; i++) {
      const t0 = i / pieces, t1 = (i + 1) / pieces, h = (t1 - t0) / 2;
      const [px0, py0] = at(t0), [px1, py1] = at(t1);
      // 子段的三次控制点（按导数），再合成一个二次控制点
      const [d0x, d0y] = tangent(t0), [d1x, d1y] = tangent(t1);
      const q1x = px0 + (d0x * h * 2) / 3, q1y = py0 + (d0y * h * 2) / 3, q2x = px1 - (d1x * h * 2) / 3, q2y = py1 - (d1y * h * 2) / 3;
      this.#curves.push(px0, py0, (3 * (q1x + q2x) - px0 - px1) / 4, (3 * (q1y + q2y) - py0 - py1) / 4, px1, py1);
    }
    this.x = x;
    this.y = y;
  }

  /** 椭圆弧（SVG 的端点参数，换成中心参数后按 90° 一段的三次曲线）。 */
  arc(rx: number, ry: number, rotation: number, large: boolean, sweep: boolean, x: number, y: number): void {
    const x1 = this.x, y1 = this.y;
    if (x1 === x && y1 === y) return;
    rx = Math.abs(rx);
    ry = Math.abs(ry);
    if (rx === 0 || ry === 0) return this.line(x, y);
    const phi = (rotation * Math.PI) / 180, cos = Math.cos(phi), sin = Math.sin(phi);
    const dx = (x1 - x) / 2, dy = (y1 - y) / 2;
    const xp = cos * dx + sin * dy, yp = -sin * dx + cos * dy;
    const lambda = (xp * xp) / (rx * rx) + (yp * yp) / (ry * ry);
    if (lambda > 1) {
      rx *= Math.sqrt(lambda);
      ry *= Math.sqrt(lambda);
    }
    const sign = large === sweep ? -1 : 1;
    const numerator = rx * rx * ry * ry - rx * rx * yp * yp - ry * ry * xp * xp;
    const coefficient = sign * Math.sqrt(Math.max(0, numerator / (rx * rx * yp * yp + ry * ry * xp * xp)));
    const cxp = (coefficient * rx * yp) / ry, cyp = (-coefficient * ry * xp) / rx;
    const cx = cos * cxp - sin * cyp + (x1 + x) / 2, cy = sin * cxp + cos * cyp + (y1 + y) / 2;
    const angle = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    const theta = angle(1, 0, (xp - cxp) / rx, (yp - cyp) / ry);
    let delta = angle((xp - cxp) / rx, (yp - cyp) / ry, (-xp - cxp) / rx, (-yp - cyp) / ry);
    if (!sweep && delta > 0) delta -= 2 * Math.PI;
    if (sweep && delta < 0) delta += 2 * Math.PI;
    const pieces = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 2)));
    const step = delta / pieces, k = (4 / 3) * Math.tan(step / 4);
    const point = (t: number): [number, number] => {
      const px = rx * Math.cos(t), py = ry * Math.sin(t);
      return [cos * px - sin * py + cx, sin * px + cos * py + cy];
    };
    const derivative = (t: number): [number, number] => {
      const px = -rx * Math.sin(t), py = ry * Math.cos(t);
      return [cos * px - sin * py, sin * px + cos * py];
    };
    for (let i = 0; i < pieces; i++) {
      const t0 = theta + i * step, t1 = t0 + step;
      const [d0x, d0y] = derivative(t0), [d1x, d1y] = derivative(t1), [ex, ey] = i === pieces - 1 ? [x, y] : point(t1);
      this.cubic(this.x + k * d0x, this.y + k * d0y, ex - k * d1x, ey - k * d1y, ex, ey);
    }
  }

  close(): void {
    this.line(this.#start[0], this.#start[1]);
    this.#flush(true);
    this.x = this.#start[0];
    this.y = this.#start[1];
  }

  finish(): Contour[] {
    this.#flush(false);
    return this.contours;
  }

  #flush(closed: boolean): void {
    if (this.#curves.length > 0) this.contours.push({ curves: this.#curves, closed });
    this.#curves = [];
  }
}

function parsePath(d: string, where: string): Contour[] {
  const tokens = d.match(/[MmLlHhVvQqTtCcSsAaZz]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g) ?? [];
  const path = new PathBuilder();
  let i = 0, command = '';
  // 上一段的控制点（T、S 反射用）
  let lastQuad: [number, number] | undefined, lastCubic: [number, number] | undefined;
  const next = () => {
    const token = tokens[i++];
    if (token === undefined || /[A-Za-z]/.test(token)) throw new Error(`${where}: the path "${d.slice(0, 60)}" is cut short`);
    return Number(token);
  };
  while (i < tokens.length) {
    if (/[A-Za-z]/.test(tokens[i]!)) command = tokens[i++]!;
    else if (command === '') throw new Error(`${where}: the path "${d.slice(0, 60)}" does not start with a command`);
    const relative = command === command.toLowerCase(), ox = relative ? path.x : 0, oy = relative ? path.y : 0;
    const upper = command.toUpperCase();
    let quad: [number, number] | undefined, cubic: [number, number] | undefined;
    switch (upper) {
      case 'M':
        path.move(ox + next(), oy + next());
        // 后面跟的坐标对是 L
        command = relative ? 'l' : 'L';
        break;
      case 'L': path.line(ox + next(), oy + next()); break;
      case 'H': path.line(ox + next(), path.y); break;
      case 'V': path.line(path.x, oy + next()); break;
      case 'Q': {
        const cx = ox + next(), cy = oy + next();
        path.quad(cx, cy, ox + next(), oy + next());
        quad = [cx, cy];
        break;
      }
      case 'T': {
        const [cx, cy] = lastQuad ? [2 * path.x - lastQuad[0], 2 * path.y - lastQuad[1]] : [path.x, path.y];
        path.quad(cx, cy, ox + next(), oy + next());
        quad = [cx, cy];
        break;
      }
      case 'C': {
        const c1x = ox + next(), c1y = oy + next(), c2x = ox + next(), c2y = oy + next();
        path.cubic(c1x, c1y, c2x, c2y, ox + next(), oy + next());
        cubic = [c2x, c2y];
        break;
      }
      case 'S': {
        const [c1x, c1y] = lastCubic ? [2 * path.x - lastCubic[0], 2 * path.y - lastCubic[1]] : [path.x, path.y];
        const c2x = ox + next(), c2y = oy + next();
        path.cubic(c1x, c1y, c2x, c2y, ox + next(), oy + next());
        cubic = [c2x, c2y];
        break;
      }
      case 'A': {
        const rx = next(), ry = next(), rotation = next(), large = next() !== 0, sweep = next() !== 0;
        path.arc(rx, ry, rotation, large, sweep, ox + next(), oy + next());
        break;
      }
      case 'Z':
        path.close();
        break;
      default:
        throw new Error(`${where}: unknown path command ${command}`);
    }
    lastQuad = quad;
    lastCubic = cubic;
  }
  return path.finish();
}

// ---- 描边 ----

/** 描边换成填充的轮廓：曲线拆成折线，每段一个矩形，拐点（和 round 的两头）补一个圆；square 的两头往外伸半个线宽。 */
function strokeOutline(contours: readonly Contour[], width: number, cap: string): number[] {
  const half = width / 2, out: number[] = [];
  // 每个小轮廓各自转成同一个绕向，非零规则下并在一起
  const add = (piece: readonly number[]) => out.push(...oriented(piece));
  const disc = (x: number, y: number) => add(ellipseContour(x, y, half, half).curves);
  for (const contour of contours) {
    const points = flatten(contour.curves);
    if (contour.closed && points.length > 2) points.push(points[0]!);
    for (let i = 0; i + 1 < points.length; i++) {
      let [x0, y0] = points[i]!, [x1, y1] = points[i + 1]!;
      const length = Math.hypot(x1 - x0, y1 - y0);
      if (length === 0) continue;
      const ux = (x1 - x0) / length, uy = (y1 - y0) / length;
      if (cap === 'square' && !contour.closed) {
        if (i === 0) [x0, y0] = [x0 - ux * half, y0 - uy * half];
        if (i === points.length - 2) [x1, y1] = [x1 + ux * half, y1 + uy * half];
      }
      const nx = -uy * half, ny = ux * half;
      add(polygonContour([[x0 + nx, y0 + ny], [x1 + nx, y1 + ny], [x1 - nx, y1 - ny], [x0 - nx, y0 - ny]], true).curves);
    }
    const joints = contour.closed ? points.slice(0, -1) : points.slice(1, -1);
    for (const [x, y] of joints) disc(x, y);
    if (!contour.closed && cap === 'round' && points.length > 0) {
      disc(...points[0]!);
      disc(...points[points.length - 1]!);
    }
  }
  return out;
}

/** 二次曲线串拆成折线的点（按弯的程度分段）。 */
function flatten(curves: readonly number[]): [number, number][] {
  const points: [number, number][] = [];
  for (let c = 0; c < curves.length; c += 6) {
    const [x0, y0, cx, cy, x1, y1] = curves.slice(c, c + 6) as [number, number, number, number, number, number];
    if (c === 0) points.push([x0, y0]);
    const bend = Math.hypot(x0 - 2 * cx + x1, y0 - 2 * cy + y1);
    const pieces = bend < 1e-9 ? 1 : Math.min(16, Math.max(2, Math.ceil(Math.sqrt(bend))));
    for (let i = 1; i <= pieces; i++) {
      const t = i / pieces, u = 1 - t;
      points.push([u * u * x0 + 2 * u * t * cx + t * t * x1, u * u * y0 + 2 * u * t * cy + t * t * y1]);
    }
  }
  return points;
}

/** 填充时没闭合的子路径照 SVG 的规矩从终点连回起点。 */
function closeContour(curves: readonly number[]): readonly number[] {
  const n = curves.length;
  if (n === 0) return curves;
  const x0 = curves[0]!, y0 = curves[1]!, x1 = curves[n - 2]!, y1 = curves[n - 1]!;
  return x0 === x1 && y0 === y1 ? curves : [...curves, x1, y1, (x0 + x1) / 2, (y0 + y1) / 2, x0, y0];
}

/** 曲线围出的有向面积（按端点和控制点的多边形近似，只用来看是不是 0）。 */
function signedArea(curves: readonly number[]): number {
  let area = 0;
  for (let c = 0; c < curves.length; c += 6) {
    area += curves[c]! * curves[c + 3]! - curves[c + 2]! * curves[c + 1]!;
    area += curves[c + 2]! * curves[c + 5]! - curves[c + 4]! * curves[c + 3]!;
  }
  return area / 2;
}

/** 一个闭合的小轮廓按面积的符号转成同一个绕向（反了的倒过来走）。 */
function oriented(piece: readonly number[]): readonly number[] {
  let area = 0;
  for (let c = 0; c < piece.length; c += 6) area += piece[c]! * piece[c + 5]! - piece[c + 4]! * piece[c + 1]!;
  if (area >= 0) return piece;
  const out: number[] = [];
  for (let c = piece.length - 6; c >= 0; c -= 6) out.push(piece[c + 4]!, piece[c + 5]!, piece[c + 2]!, piece[c + 3]!, piece[c]!, piece[c + 1]!);
  return out;
}

// ---- 变换、样式、颜色 ----

function multiply(a: Matrix, b: Matrix): Matrix {
  return [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
}

function transformCurves(curves: readonly number[], m: Matrix): number[] {
  const out = new Array<number>(curves.length);
  for (let i = 0; i < curves.length; i += 2) {
    const x = curves[i]!, y = curves[i + 1]!;
    out[i] = m[0] * x + m[2] * y + m[4];
    out[i + 1] = m[1] * x + m[3] * y + m[5];
  }
  return out;
}

function transformedBox(m: Matrix, [x, y, w, h]: readonly number[]): [number, number, number, number] {
  const xs: number[] = [], ys: number[] = [];
  for (const [px, py] of [[x!, y!], [x! + w!, y!], [x!, y! + h!], [x! + w!, y! + h!]] as const) {
    xs.push(m[0] * px + m[2] * py + m[4]);
    ys.push(m[1] * px + m[3] * py + m[5]);
  }
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function intersect(a: VectorShape['clip'], b: readonly [number, number, number, number]): VectorShape['clip'] {
  return a ? [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])] : b;
}

function parseTransform(text: string, where: string): Matrix {
  let m = IDENTITY;
  for (const [, name, args] of text.matchAll(/([a-zA-Z]+)\s*\(([^)]*)\)/g)) {
    const v = numbers(args!);
    let t: Matrix;
    switch (name) {
      case 'matrix': t = [v[0] ?? 1, v[1] ?? 0, v[2] ?? 0, v[3] ?? 1, v[4] ?? 0, v[5] ?? 0]; break;
      case 'translate': t = [1, 0, 0, 1, v[0] ?? 0, v[1] ?? 0]; break;
      case 'scale': t = [v[0] ?? 1, 0, 0, v[1] ?? v[0] ?? 1, 0, 0]; break;
      case 'rotate': {
        const r = ((v[0] ?? 0) * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r), cx = v[1] ?? 0, cy = v[2] ?? 0;
        t = [c, s, -s, c, cx - c * cx + s * cy, cy - s * cx - c * cy];
        break;
      }
      case 'skewX': t = [1, 0, Math.tan(((v[0] ?? 0) * Math.PI) / 180), 1, 0, 0]; break;
      case 'skewY': t = [1, Math.tan(((v[0] ?? 0) * Math.PI) / 180), 0, 1, 0, 0]; break;
      default: throw new Error(`${where}: unknown transform ${name}`);
    }
    m = multiply(m, t);
  }
  return m;
}

function styleOf(a: Readonly<Record<string, string>>, inherited: Style): Style {
  return {
    fill: a['fill'] ?? inherited.fill,
    fillRule: a['fill-rule'] ?? inherited.fillRule,
    fillOpacity: number(a['fill-opacity'], inherited.fillOpacity),
    stroke: a['stroke'] ?? inherited.stroke,
    strokeWidth: number(a['stroke-width'], inherited.strokeWidth),
    strokeOpacity: number(a['stroke-opacity'], inherited.strokeOpacity),
    cap: a['stroke-linecap'] ?? inherited.cap,
    // opacity 不继承，往下乘（g 的 opacity 作用到里面所有的形状）
    opacity: inherited.opacity * number(a['opacity'], 1),
  };
}

const NAMED: Readonly<Record<string, string>> = { white: '#ffffff', black: '#000000', red: '#ff0000', green: '#008000', blue: '#0000ff', yellow: '#ffff00', gray: '#808080', grey: '#808080' };

function colorOf(value: string, context: Context): readonly [number, number, number, number] | undefined {
  const text = value.trim();
  if (text === 'none' || text === 'transparent') return undefined;
  const url = /^url\(#([^)]+)\)$/.exec(text);
  if (url) return context.gradients.get(url[1]!);
  return parseColor(NAMED[text] ?? text);
}

function parseColor(text: string): [number, number, number, number] | undefined {
  if (text.startsWith('#')) {
    const hex = text.length === 4 ? [...text.slice(1)].map((c) => c + c).join('') : text.slice(1, 7);
    const v = Number.parseInt(hex, 16);
    if (hex.length !== 6 || Number.isNaN(v)) return undefined;
    return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255, 1];
  }
  const rgb = /^rgba?\(([^)]*)\)$/.exec(text);
  if (rgb) {
    const v = rgb[1]!.split(/[\s,]+/).filter(Boolean).map((part) => (part.endsWith('%') ? (Number(part.slice(0, -1)) * 2.55) : Number(part)));
    return [(v[0] ?? 0) / 255, (v[1] ?? 0) / 255, (v[2] ?? 0) / 255, v[3] ?? 1];
  }
  return undefined;
}

/** 渐变取色标的平均色（带不透明度）。 */
function collectGradients(element: Element, out: Map<string, readonly [number, number, number, number]>): void {
  if ((element.name === 'linearGradient' || element.name === 'radialGradient') && element.attributes['id']) {
    const stops = element.children.filter((child) => child.name === 'stop').map((stop) => {
      const color = parseColor(stop.attributes['stop-color'] ?? '#000000') ?? [0, 0, 0, 1];
      return [color[0], color[1], color[2], color[3] * number(stop.attributes['stop-opacity'], 1)] as const;
    });
    if (stops.length > 0) out.set(element.attributes['id']!, [0, 1, 2, 3].map((k) => stops.reduce((sum, stop) => sum + stop[k]!, 0) / stops.length) as unknown as readonly [number, number, number, number]);
  }
  for (const child of element.children) collectGradients(child, out);
}

function viewBoxOf(a: Readonly<Record<string, string>>): [number, number, number, number] | undefined {
  const v = numbers(a['viewBox'] ?? '');
  return v.length === 4 ? [v[0]!, v[1]!, v[2]!, v[3]!] : undefined;
}

function number(text: string | undefined, fallback: number): number {
  if (text === undefined) return fallback;
  const value = Number.parseFloat(text);
  return Number.isFinite(value) ? value : fallback;
}

function numbers(text: string): number[] {
  return (text.match(/[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g) ?? []).map(Number);
}

// ---- 只够用的 XML 解析：元素、属性、自闭合，跳过注释、声明、文本 ----

function parseXml(text: string, where: string): Element {
  const root: Element = { name: '#root', attributes: {}, children: [] };
  const stack: Element[] = [root];
  const tag = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<(\/?)([A-Za-z][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
  for (const match of text.matchAll(tag)) {
    const [, closing, name, attributeText, selfClosing] = match;
    if (name === undefined) continue;
    if (closing) {
      if (stack.length <= 1 || stack[stack.length - 1]!.name !== name) throw new Error(`${where}: </${name}> does not match`);
      stack.pop();
      continue;
    }
    const attributes: Record<string, string> = {};
    for (const [, key, double, single] of attributeText!.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attributes[key!] = (double ?? single ?? '').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    const element: Element = { name: name!, attributes, children: [] };
    stack[stack.length - 1]!.children.push(element);
    if (!selfClosing) stack.push(element);
  }
  if (stack.length !== 1) throw new Error(`${where}: <${stack[stack.length - 1]!.name}> is not closed`);
  const first = root.children[0];
  if (!first) throw new Error(`${where}: no root element`);
  return first;
}
