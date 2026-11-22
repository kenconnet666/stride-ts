/**
 * 飘带和拖尾（Stride 的 ShapeBuilderRibbon、ShapeBuilderTrail 和它们的 Ribbonizer）：按画的顺序（一般是 ByOrder，从新到旧）把粒子
 * 连成一条带子，相邻两个粒子之间一个四边形；生成顺序（Order 字段）的组变了就断开另起一条。
 * - Ribbon：宽度是粒子的大小，方向在屏幕里垂直于带子（按投影到屏幕上的走向算）；
 * - Trail：宽度和方向是粒子的 Direction 乘大小（没有 Direction 时朝上），EdgePolicy 是 Center 时粒子在带子中间，Edge 时在边上。
 * Smoothing 不是 None 时每两个粒子之间再插 Segments - 1 个点（Fast 是 Catmull-Rom，Best 是圆弧），每个粒子占 Segments 个四边形。
 * UV：U 横跨带子，V 沿着带子（AsIs 每段 0 到 1，Stretched 整条 0 到 TexCoordsFactor，DistanceBased 按走过的距离乘
 * TexCoordsFactor），再按 UVRotate 翻转、旋转，最后按材质的 UV 帧（翻页、滚动）变换。颜色按粒子，一个粒子的几个四边形同色。
 */
import type { ParticleModuleFile } from '../content/formats/format';
import { rotate, type Vec3 } from './math';
import { value } from './modules';
import type { ParticleEmitter } from './ParticleEmitter';
import type { CameraAxes, VertexWriter } from './shapes';

const ZERO_TOLERANCE = 1e-6;
/** 生成顺序里组的位置（Stride 的 SpawnOrderConst.GroupBitOffset）。 */
const GROUP_BIT_OFFSET = 16;

export const RIBBONS = new Set(['shapeBuilderRibbon', 'shapeBuilderTrail']);

type Smoothing = 'none' | 'fast' | 'best';
type TexCoordPolicy = 'asIs' | 'stretched' | 'distanceBased';

/** 飘带、拖尾的设置。 */
export class RibbonSettings {
  readonly trail: boolean;
  readonly smoothing: Smoothing;
  /** 每个粒子占几个四边形（没有平滑时 1）。 */
  readonly sections: number;
  readonly texCoordPolicy: TexCoordPolicy;
  readonly texCoordsFactor: number;
  /** Trail 的 EdgePolicy 是 Center（Ribbon 总在中间）。 */
  readonly centered: boolean;
  /** UVRotate 换算成的三个开关（同 Stride 的 ApplyChanges）。 */
  readonly flipU: boolean;
  readonly flipV: boolean;
  readonly swapUV: boolean;

  constructor(file: ParticleModuleFile) {
    this.trail = file.$type === 'shapeBuilderTrail';
    this.smoothing = value(file, 'smoothingPolicy', 'none') as Smoothing;
    this.sections = this.smoothing === 'none' ? 1 : Math.max(1, Math.trunc(value(file, 'segments', 1)));
    this.texCoordPolicy = value(file, 'textureCoordinatePolicy', 'asIs') as TexCoordPolicy;
    this.texCoordsFactor = value(file, 'texCoordsFactor', 1);
    this.centered = !this.trail || value<string>(file, 'edgePolicy', 'edge') === 'center';
    const rotate = (file['uvRotate'] as ParticleModuleFile | null | undefined) ?? {};
    const clockwise = value<string>(rotate, 'uvClockwise', 'degree0');
    this.flipU = value(rotate, 'flipX', false) !== (clockwise === 'degree180' || clockwise === 'degree90');
    this.flipV = value(rotate, 'flipY', false) !== (clockwise === 'degree180' || clockwise === 'degree270');
    this.swapUV = clockwise === 'degree90' || clockwise === 'degree270';
  }
}

/** 按 order 的顺序把发射器的粒子连成带子写进 out，每个粒子写 sections 个四边形。 */
export function buildRibbons(emitter: ParticleEmitter, ribbon: RibbonSettings, camera: CameraAxes, order: readonly number[], out: VertexWriter): void {
  const pool = emitter.pool;
  const position = pool.field('position')!, size = pool.field('size'), direction = pool.field('direction');
  const spawnOrder = pool.integers('order');
  const local = emitter.simulationSpace === 'local';
  const space = emitter.drawTransform;
  const sections = ribbon.sections;
  const writer = new RibbonWriter(ribbon, camera, order.length * sections, out);
  const { points, extra, group } = writer;
  let previousGroup = 0;
  const p: Vec3 = [0, 0, 0], d: Vec3 = [0, 0, 0];
  for (const i of order) {
    if (spawnOrder) {
      const current = spawnOrder[i]! >>> GROUP_BIT_OFFSET;
      if (current !== previousGroup) writer.flush();
      previousGroup = current;
    }
    const slot = group.length * sections;
    group.push(i);
    p[0] = position[i * 3]!; p[1] = position[i * 3 + 1]!; p[2] = position[i * 3 + 2]!;
    let particleSize = size ? size[i]! : 1;
    if (ribbon.trail) {
      if (direction) {
        d[0] = direction[i * 3]! * particleSize; d[1] = direction[i * 3 + 1]! * particleSize; d[2] = direction[i * 3 + 2]! * particleSize;
      } else {
        d[0] = 0; d[1] = particleSize; d[2] = 0;
      }
    }
    if (local) {
      rotate(space.worldRotation, p);
      for (let k = 0; k < 3; k++) p[k] = p[k]! * space.worldScale[0] + space.worldPosition[k]!;
      particleSize *= space.worldScale[0];
      if (ribbon.trail) {
        rotate(space.worldRotation, d);
        for (let k = 0; k < 3; k++) d[k]! *= space.worldScale[0];
      }
    }
    points.set(p, slot * 3);
    if (ribbon.trail) extra.set(d, slot * 3);
    else extra[slot] = particleSize;
  }
  writer.flush();
}

/** 把一个发射器的带子一条条写出去：group 是正在攒的这一条的粒子，它们的点从 points 的开头起。 */
class RibbonWriter {
  readonly points: Float64Array;
  readonly extra: Float64Array;
  readonly group: number[] = [];
  readonly ribbon: RibbonSettings;
  readonly camera: CameraAxes;
  readonly out: VertexWriter;
  /** 点投影到屏幕上的 (x, y)（Ribbon 用）。 */
  readonly #screen: Float64Array;
  readonly #width: Vec3 = [0, 0, 0];

  constructor(ribbon: RibbonSettings, camera: CameraAxes, capacity: number, out: VertexWriter) {
    this.ribbon = ribbon;
    this.camera = camera;
    this.out = out;
    this.points = new Float64Array(capacity * 3);
    this.extra = new Float64Array(capacity * (ribbon.trail ? 3 : 1));
    this.#screen = new Float64Array(ribbon.trail ? 0 : capacity * 2);
  }

  /** 写出攒好的这一条，开始下一条。 */
  flush(): void {
    if (this.group.length > 0) this.#ribbonize();
    this.group.length = 0;
  }

  #ribbonize(): void {
    const { ribbon, points, extra } = this;
    const sections = ribbon.sections, last = this.group.length * sections;
    // 只有一个粒子：每个四边形缩成一点（Stride 写的是零位置的四边形）
    if (last <= sections) {
      this.#particle(0);
      for (let q = 0; q < last * 4; q++) this.#vertex(points[0]!, points[1]!, points[2]!, 0, 0);
      return;
    }
    if (sections > 1) {
      if (ribbon.smoothing === 'best') expandCircular(points, extra, ribbon.trail ? 3 : 1, sections, last);
      else expandCatmullRom(points, extra, ribbon.trail ? 3 : 1, sections, last);
    }
    if (!ribbon.trail) this.#project(last);

    const width = this.#width;
    let axisX = 0, axisY = 0;
    if (!ribbon.trail) [axisX, axisY] = this.#along(0, 1);
    this.#widthAt(0, axisX, axisY);
    let w0 = width[0], w1 = width[1], w2 = width[2];
    let ox = points[0]!, oy = points[1]!, oz = points[2]!;
    let vOld = 0;
    // 居中时左右各伸出半宽，在边上时只往一边伸出整个宽度
    const side = ribbon.centered ? 1 : 0;
    const asIs = ribbon.texCoordPolicy === 'asIs', stretched = ribbon.texCoordPolicy === 'stretched';
    for (let k = 0; k < last; k++) {
      if (k % sections === 0) this.#particle(k / sections);
      const cx = points[k * 3]!, cy = points[k * 3 + 1]!, cz = points[k * 3 + 2]!;
      if (!ribbon.trail) {
        // 宽度方向：前后两段在屏幕上的走向的平均
        const [nx, ny] = k + 1 < last ? this.#along(k, k + 1) : this.#along(last - 2, last - 1);
        const [mx, my] = normalize2(axisX + nx, axisY + ny);
        axisX = nx; axisY = ny;
        this.#widthAt(k, mx, my);
      } else {
        this.#widthAt(k, 0, 0);
      }
      const n0 = width[0], n1 = width[1], n2 = width[2];
      const vNew = stretched
        ? ((k + 1) / last) * ribbon.texCoordsFactor
        : Math.sqrt((cx - ox) ** 2 + (cy - oy) ** 2 + (cz - oz) ** 2) * ribbon.texCoordsFactor + vOld;
      // 上边在前一个点，下边在这个点
      this.#vertex(ox - w0 * side, oy - w1 * side, oz - w2 * side, 0, asIs ? 0 : vOld);
      this.#vertex(ox + w0, oy + w1, oz + w2, 1, asIs ? 0 : vOld);
      this.#vertex(cx + n0, cy + n1, cz + n2, 1, asIs ? 1 : vNew);
      this.#vertex(cx - n0 * side, cy - n1 * side, cz - n2 * side, 0, asIs ? 1 : vNew);
      vOld = vNew;
      w0 = n0; w1 = n1; w2 = n2;
      ox = cx; oy = cy; oz = cz;
    }
  }

  /** 选第 k 个粒子（颜色和 UV 帧）。 */
  #particle(k: number): void {
    this.out.particle(this.group[k]!);
  }

  /** 写一个顶点，UV 先按 UVRotate 翻转、旋转。 */
  #vertex(x: number, y: number, z: number, u: number, w: number): void {
    const ribbon = this.ribbon;
    const fu = ribbon.flipU ? 1 - u : u, fv = ribbon.flipV ? 1 - w : w;
    if (ribbon.swapUV) this.out.vertex(x, y, z, fv, fu);
    else this.out.vertex(x, y, z, fu, fv);
  }

  /** 前 count 个点投影到裁剪空间再除以 w 的 (x, y)；viewProjection 按列存。 */
  #project(count: number): void {
    const m = this.camera.viewProjection, points = this.points, screen = this.#screen;
    for (let k = 0; k < count; k++) {
      const x = points[k * 3]!, y = points[k * 3 + 1]!, z = points[k * 3 + 2]!;
      const w = m[3]! * x + m[7]! * y + m[11]! * z + m[15]!;
      screen[k * 2] = (m[0]! * x + m[4]! * y + m[8]! * z + m[12]!) / w;
      screen[k * 2 + 1] = (m[1]! * x + m[5]! * y + m[9]! * z + m[13]!) / w;
    }
  }

  /** 点 k 到 next 在屏幕上的走向，指回 k（归一化，同 Stride）。 */
  #along(k: number, next: number): [number, number] {
    const screen = this.#screen;
    return normalize2(screen[k * 2]! - screen[next * 2]!, screen[k * 2 + 1]! - screen[next * 2 + 1]!);
  }

  /** 点 k 的宽度向量写进 #width：Trail 是存好的宽度，Ribbon 是屏幕上的方向 (ax, ay) 乘半个大小、转 90 度换回世界。 */
  #widthAt(k: number, ax: number, ay: number): void {
    const out = this.#width, extra = this.extra;
    if (this.ribbon.trail) {
      out[0] = extra[k * 3]!; out[1] = extra[k * 3 + 1]!; out[2] = extra[k * 3 + 2]!;
      return;
    }
    const { right, up } = this.camera;
    const half = extra[k]! * 0.5, x = ax * half, y = ay * half;
    out[0] = y * right[0] - x * up[0]; out[1] = y * right[1] - x * up[1]; out[2] = y * right[2] - x * up[2];
  }
}

/** 插值的点按 Catmull-Rom（Stride 的 ExpandVertices_CatmullRom），extra 线性插值，最后一段向 0 过渡。 */
export function expandCatmullRom(points: Float64Array, extra: Float64Array, width: number, sections: number, last: number): void {
  const step = 1 / sections;
  const p0 = new Float64Array(3), p1 = points.slice(0, 3), p2 = points.slice(sections * 3, sections * 3 + 3), p3 = new Float64Array(3);
  for (let c = 0; c < 3; c++) p0[c] = p1[c]! * 2 - p2[c]!;
  const e1 = extra.slice(0, width), e2 = extra.slice(sections * width, sections * width + width);
  for (let index = 0; index < last; index += sections) {
    const next = index + sections * 2;
    const hasNext = next < last;
    p3.set(hasNext ? points.subarray(next * 3, next * 3 + 3) : p2);
    for (let j = 1; j < sections; j++) {
      const t = j * step, t2 = t * t, t3 = t2 * t;
      for (let c = 0; c < 3; c++) {
        const a = p0[c]!, b = p1[c]!, d = p2[c]!, e = p3[c]!;
        points[(index + j) * 3 + c] = 0.5 * (2 * b + (d - a) * t + (2 * a - 5 * b + 4 * d - e) * t2 + (3 * b - a - 3 * d + e) * t3);
      }
      for (let c = 0; c < width; c++) extra[(index + j) * width + c] = e1[c]! + (e2[c]! - e1[c]!) * t;
    }
    p0.set(p1); p1.set(p2); p2.set(p3);
    e1.set(e2);
    if (hasNext) e2.set(extra.subarray(next * width, next * width + width));
    else e2.fill(0);
  }
}

/** 插值的点按两个外接圆弧之间插值（Stride 的 ExpandVertices_Circular）。 */
export function expandCircular(points: Float64Array, extra: Float64Array, width: number, sections: number, last: number): void {
  const step = 1 / sections;
  const p0 = new Float64Array(3), p1 = points.slice(0, 3), p2 = points.slice(sections * 3, sections * 3 + 3), p3 = new Float64Array(3);
  for (let c = 0; c < 3; c++) p0[c] = p1[c]! * 2 - p2[c]!;
  const o1 = circumcenter(new Float64Array(3), p0, p1, p2), o2 = new Float64Array(3);
  let r1 = distance(o1, p1);
  const e1 = extra.slice(0, width), e2 = extra.slice(sections * width, sections * width + width), e3 = new Float64Array(width);
  for (let index = 0; index < last; index += sections) {
    const next = index + sections * 2;
    const hasNext = next < last;
    p3.set(hasNext ? points.subarray(next * 3, next * 3 + 3) : p2);
    if (hasNext) e3.set(extra.subarray(next * width, next * width + width));
    else e3.fill(0);
    let r2: number;
    if (hasNext) {
      circumcenter(o2, p1, p2, p3);
      r2 = distance(o2, p2);
    } else {
      o2.set(o1);
      r2 = r1;
    }
    for (let j = 1; j < sections; j++) {
      const t = j * step;
      // 直线上的点分别投到两段圆弧上，再按 t 混合
      const qx = p1[0]! + (p2[0]! - p1[0]!) * t, qy = p1[1]! + (p2[1]! - p1[1]!) * t, qz = p1[2]! + (p2[2]! - p1[2]!) * t;
      const s1 = r1 / length(qx - o1[0]!, qy - o1[1]!, qz - o1[2]!), s2 = r2 / length(qx - o2[0]!, qy - o2[1]!, qz - o2[2]!);
      const at = (index + j) * 3;
      points[at] = arcLerp(qx, o1[0]!, o2[0]!, s1, s2, t);
      points[at + 1] = arcLerp(qy, o1[1]!, o2[1]!, s1, s2, t);
      points[at + 2] = arcLerp(qz, o1[2]!, o2[2]!, s1, s2, t);
      for (let c = 0; c < width; c++) extra[(index + j) * width + c] = e1[c]! + (e2[c]! - e1[c]!) * t;
    }
    p1.set(p2); p2.set(p3);
    e1.set(e2); e2.set(e3);
    o1.set(o2); r1 = r2;
  }
}

/** lerp(o1 + (q - o1) · s1, o2 + (q - o2) · s2, t)：s 是半径除以 q 到圆心的距离（距离为 0 时方向是 0，同 Stride 的 Normalize）。 */
function arcLerp(q: number, o1: number, o2: number, s1: number, s2: number, t: number): number {
  const a = o1 + (q - o1) * (Number.isFinite(s1) ? s1 : 0), b = o2 + (q - o2) * (Number.isFinite(s2) ? s2 : 0);
  return a + (b - a) * t;
}

/** 外接圆的圆心写进 out（Stride 的 ShapeBuilder.Circumcenter）；三点共线时是 c。 */
export function circumcenter(out: Float64Array, a: ArrayLike<number>, b: ArrayLike<number>, c: ArrayLike<number>): Float64Array {
  const ux = a[0]! - c[0]!, uy = a[1]! - c[1]!, uz = a[2]! - c[2]!;
  const wx = b[0]! - c[0]!, wy = b[1]! - c[1]!, wz = b[2]! - c[2]!;
  const cx = uy * wz - uz * wy, cy = uz * wx - ux * wz, cz = ux * wy - uy * wx;
  const cross = cx * cx + cy * cy + cz * cz;
  out[0] = c[0]!; out[1] = c[1]!; out[2] = c[2]!;
  if (cross < ZERO_TOLERANCE) return out;
  const uu = ux * ux + uy * uy + uz * uz, ww = wx * wx + wy * wy + wz * wz;
  // (|u|² w - |w|² u) × (u × w) / (2 |u × w|²)
  const vx = wx * uu - ux * ww, vy = wy * uu - uy * ww, vz = wz * uu - uz * ww;
  out[0]! += (vy * cz - vz * cy) / (2 * cross);
  out[1]! += (vz * cx - vx * cz) / (2 * cross);
  out[2]! += (vx * cy - vy * cx) / (2 * cross);
  return out;
}

const length = (x: number, y: number, z: number) => Math.sqrt(x * x + y * y + z * z);
const distance = (a: ArrayLike<number>, b: ArrayLike<number>) => length(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);

/** 归一化（长度为 0 时原样，同 Stride 的 Normalize）。 */
function normalize2(x: number, y: number): [number, number] {
  const length = Math.hypot(x, y);
  return length > ZERO_TOLERANCE ? [x / length, y / length] : [x, y];
}
