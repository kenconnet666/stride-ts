/**
 * 矢量贴图（标签图集按曲线逐像素算颜色，走多近都清楚；用户 2026-11-23 要的"标签直接按矢量画"）：合并的那批（货架、堆放）的颜色
 * 图集 SVG 拆成填充形状（modeling/svgShapes.ts），烘焙时建成这里的数据（`<路径>.vector`），网格着色器在近处（一个屏幕像素不到
 * 一个半图集像素）用它代替位图的颜色，远处照旧用位图（便宜、不闪）。
 *
 * 每个形状的覆盖率照 Slug（rendering/text/slug.ts：向右、向上各打一条射线，数穿过轮廓的次数，离边不到半个像素的按距离给部分
 * 覆盖），每个形状自己的横带、竖带（带里的曲线按最远的一端从大到小排，整条在像素后面就停）；整张图集切成格子，每格按从前往后
 * 列出盖到它的形状，像素从前往后叠颜色，盖满了就停。evenodd 的形状按穿越次数的奇偶算。
 *
 * 数据是一个 u32 数组（浮点按位存）：
 * - 头（HEADER 个字）：魔数、版本、图集的宽高（f32）、格子的列数和行数，形状表、点、带从哪个字开始，形状数，格子、格子里的列表从
 *   哪个字开始；
 * - 形状（SHAPE_WORDS 个字）：sRGB 的颜色（pack4x8unorm）、标志（第 0 位 evenodd）、带的变换（4 个 f32：坐标乘 xy 加 zw 得到竖带、
 *   横带的下标）、第一个点、带从哪开始（相对带的起点）、横带数、竖带数、边界（4 个 f32：形状的外框和裁剪的交，外面不算、边上按
 *   裁剪抗锯齿）；
 * - 点：每条二次曲线三个点（f32 的 x、y）；
 * - 带：每个形状先是横带、竖带各一对（条数、列表的偏移），后面是列表（曲线第一个点的下标）；
 * - 格子：每格一对（形状数、列表的偏移），列表是形状的下标（从前往后）。
 */
import type { VectorImage, VectorShape } from '../../modeling/svgShapes.ts';
import { SLUG_CURVE_WGSL } from '../text/slug.ts';

export const VECTOR_MAGIC = 0x31434556; // 'VEC1'
const HEADER = 16;
export const VECTOR_SHAPE_WORDS = 16;
/** 格子的边长（图集像素）。 */
const CELL = 32;
/** 每个形状最多几条横带、竖带。 */
const MAX_BANDS = 16;

/** 拆好的形状建成矢量贴图的数据。图集的像素坐标就是 viewBox 的坐标（合并的图集 viewBox 是 0 0 边长 边长）。 */
export function buildVectorAtlas(image: VectorImage): Uint32Array {
  const [, , width, height] = image.viewBox;
  const columns = Math.max(1, Math.ceil(width / CELL)), rows = Math.max(1, Math.ceil(height / CELL));
  const shapes = image.shapes.filter((shape) => shape.curves.length >= 6);
  const shapeWords = new Uint32Array(shapes.length * VECTOR_SHAPE_WORDS);
  const shapeFloats = new Float32Array(shapeWords.buffer);
  const points: number[] = [];
  const bands: number[] = [];
  const cells: number[][] = Array.from({ length: columns * rows }, () => []);
  shapes.forEach((shape, s) => {
    const bounds = boundsOf(shape);
    const o = s * VECTOR_SHAPE_WORDS;
    shapeWords[o] = packColor(shape.color);
    shapeWords[o + 1] = shape.evenOdd ? 1 : 0;
    const pointStart = points.length / 2;
    points.push(...shape.curves);
    const curveCount = shape.curves.length / 6;
    const [x0, y0, x1, y1] = curveBounds(shape.curves);
    const count = Math.min(MAX_BANDS, Math.max(1, Math.round(Math.sqrt(curveCount / 2))));
    const hBands = (y1 - y0) > 0 ? count : 1, vBands = (x1 - x0) > 0 ? count : 1;
    const sx = vBands / Math.max(x1 - x0, 1e-6), sy = hBands / Math.max(y1 - y0, 1e-6);
    shapeFloats.set([sx, sy, -x0 * sx, -y0 * sy], o + 2);
    shapeWords[o + 6] = pointStart;
    shapeWords[o + 7] = bands.length;
    shapeWords[o + 8] = hBands;
    shapeWords[o + 9] = vBands;
    shapeFloats.set(bounds, o + 10);
    // 带：先占好 (hBands + vBands) 对表头，列表接在后面
    const head = bands.length;
    for (let i = 0; i < 2 * (hBands + vBands); i++) bands.push(0);
    const curve = (c: number) => shape.curves.slice(c * 6, c * 6 + 6);
    const fill = (index: number, members: number[], key: (c: number) => number) => {
      members.sort((a, b) => key(b) - key(a));
      bands[head + index * 2] = members.length;
      bands[head + index * 2 + 1] = bands.length - head;
      for (const c of members) bands.push(pointStart + c * 3);
    };
    for (let b = 0; b < hBands; b++) {
      const lo = y0 + (b * (y1 - y0)) / hBands, hi = y0 + ((b + 1) * (y1 - y0)) / hBands;
      const members: number[] = [];
      for (let c = 0; c < curveCount; c++) {
        const p = curve(c), ylo = Math.min(p[1]!, p[3]!, p[5]!), yhi = Math.max(p[1]!, p[3]!, p[5]!);
        if (yhi >= lo && ylo <= hi && !(p[1] === p[3] && p[3] === p[5])) members.push(c);
      }
      fill(b, members, (c) => Math.max(...[0, 2, 4].map((k) => curve(c)[k]!)));
    }
    for (let b = 0; b < vBands; b++) {
      const lo = x0 + (b * (x1 - x0)) / vBands, hi = x0 + ((b + 1) * (x1 - x0)) / vBands;
      const members: number[] = [];
      for (let c = 0; c < curveCount; c++) {
        const p = curve(c), xlo = Math.min(p[0]!, p[2]!, p[4]!), xhi = Math.max(p[0]!, p[2]!, p[4]!);
        if (xhi >= lo && xlo <= hi && !(p[0] === p[2] && p[2] === p[4])) members.push(c);
      }
      fill(hBands + b, members, (c) => Math.max(...[1, 3, 5].map((k) => curve(c)[k]!)));
    }
    // 格子：外框（多一个像素，边上的抗锯齿）盖到的格
    const cx0 = Math.max(0, Math.floor((bounds[0] - 1) / CELL)), cy0 = Math.max(0, Math.floor((bounds[1] - 1) / CELL));
    const cx1 = Math.min(columns - 1, Math.floor((bounds[2] + 1) / CELL)), cy1 = Math.min(rows - 1, Math.floor((bounds[3] + 1) / CELL));
    for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) cells[cy * columns + cx]!.push(s);
  });
  // 格子里从前往后（后画的在前）
  const grid: number[] = [], lists: number[] = [];
  for (const cell of cells) {
    grid.push(cell.length, lists.length);
    for (let i = cell.length - 1; i >= 0; i--) lists.push(cell[i]!);
  }
  const shapesAt = HEADER, pointsAt = shapesAt + shapeWords.length, bandsAt = pointsAt + points.length, gridAt = bandsAt + bands.length, listsAt = gridAt + grid.length;
  const out = new Uint32Array(listsAt + lists.length);
  const outFloats = new Float32Array(out.buffer);
  out.set([VECTOR_MAGIC, 1], 0);
  outFloats.set([width, height], 2);
  // 4 列数、5 行数、6 形状表、7 点、8 带、9 形状数、10 格子、11 格子里的列表
  out.set([columns, rows, shapesAt, pointsAt, bandsAt, shapes.length, gridAt, listsAt], 4);
  out.set(shapeWords, shapesAt);
  outFloats.set(points, pointsAt);
  out.set(bands, bandsAt);
  out.set(grid, gridAt);
  out.set(lists, listsAt);
  return out;
}

/** 矢量贴图的数据（`.vector` 文件的字节）读回来；不是这个格式时报错。 */
export function readVectorAtlas(bytes: Uint8Array, where: string): Uint32Array {
  if (bytes.byteLength < HEADER * 4 || bytes.byteLength % 4 !== 0) throw new Error(`${where}: not a vector atlas (${bytes.byteLength} bytes)`);
  const words = new Uint32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  if (words[0] !== VECTOR_MAGIC) throw new Error(`${where}: not a vector atlas (bad magic)`);
  return words;
}

function curveBounds(curves: readonly number[]): [number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < curves.length; i += 2) {
    x0 = Math.min(x0, curves[i]!);
    x1 = Math.max(x1, curves[i]!);
    y0 = Math.min(y0, curves[i + 1]!);
    y1 = Math.max(y1, curves[i + 1]!);
  }
  return [x0, y0, x1, y1];
}

/** 形状的外框和裁剪的交。 */
function boundsOf(shape: VectorShape): [number, number, number, number] {
  const box = curveBounds(shape.curves);
  return shape.clip ? [Math.max(box[0], shape.clip[0]), Math.max(box[1], shape.clip[1]), Math.min(box[2], shape.clip[2]), Math.min(box[3], shape.clip[3])] : box;
}

function packColor([r, g, b, a]: readonly number[]): number {
  const byte = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255);
  return (byte(r!) | (byte(g!) << 8) | (byte(b!) << 16) | (byte(a!) << 24)) >>> 0;
}

/**
 * 着色器：vectorData（第 1 组的第 11 个绑定）是一张矢量贴图（没有时头是 0）。vectorColor 返回 uv（贴图坐标，0..1）处的颜色
 * （线性、预乘）和盖住的比例；perPixel 是 fwidth(图集像素坐标)，要在一致的控制流里算好传进来。用到 slug.ts 的根的判别和求交。
 */
export const VECTOR_ATLAS_WGSL = /* wgsl */ `
${SLUG_CURVE_WGSL}
@group(1) @binding(11) var<storage, read> vectorData: array<u32>;

fn vectorWord(i: u32) -> u32 { return vectorData[i]; }
fn vectorFloat(i: u32) -> f32 { return bitcast<f32>(vectorData[i]); }
fn vectorPoint(i: u32) -> vec2f {
  let at = vectorData[7u] + i * 2u;
  return vec2f(bitcast<f32>(vectorData[at]), bitcast<f32>(vectorData[at + 1u]));
}

fn vectorAtlasSize() -> vec2f {
  return vec2f(vectorFloat(2u), vectorFloat(3u));
}

// 一个形状在 coord（图集像素）处的覆盖率
fn vectorShapeCoverage(shape: u32, coord: vec2f, pixelsPerUnit: vec2f) -> f32 {
  let o = vectorData[6u] + shape * ${VECTOR_SHAPE_WORDS}u;
  let bandTransform = vec4f(vectorFloat(o + 2u), vectorFloat(o + 3u), vectorFloat(o + 4u), vectorFloat(o + 5u));
  let bandBase = vectorData[8u] + vectorWord(o + 7u);
  let hBands = vectorWord(o + 8u);
  let vBands = vectorWord(o + 9u);
  let bandIndex = clamp(vec2i(coord * bandTransform.xy + bandTransform.zw), vec2i(0), vec2i(i32(vBands) - 1, i32(hBands) - 1));

  var xcov = 0.0;
  var xwgt = 0.0;
  let hband = bandBase + u32(bandIndex.y) * 2u;
  let hcount = vectorData[hband];
  let hlist = bandBase + vectorData[hband + 1u];
  for (var i = 0u; i < hcount; i++) {
    let p = vectorData[hlist + i];
    let p12 = vec4f(vectorPoint(p) - coord, vectorPoint(p + 1u) - coord);
    let p3 = vectorPoint(p + 2u) - coord;
    if (max(max(p12.x, p12.z), p3.x) * pixelsPerUnit.x < -0.5) { break; }
    let code = slugRootCode(p12.y, p12.w, p3.y);
    if (code != 0u) {
      let r = slugSolveHorizontal(p12, p3) * pixelsPerUnit.x;
      if ((code & 1u) != 0u) {
        xcov += saturate(r.x + 0.5);
        xwgt = max(xwgt, saturate(1.0 - abs(r.x) * 2.0));
      }
      if (code > 1u) {
        xcov -= saturate(r.y + 0.5);
        xwgt = max(xwgt, saturate(1.0 - abs(r.y) * 2.0));
      }
    }
  }
  var ycov = 0.0;
  var ywgt = 0.0;
  let vband = bandBase + (hBands + u32(bandIndex.x)) * 2u;
  let vcount = vectorData[vband];
  let vlist = bandBase + vectorData[vband + 1u];
  for (var i = 0u; i < vcount; i++) {
    let p = vectorData[vlist + i];
    let p12 = vec4f(vectorPoint(p) - coord, vectorPoint(p + 1u) - coord);
    let p3 = vectorPoint(p + 2u) - coord;
    if (max(max(p12.y, p12.w), p3.y) * pixelsPerUnit.y < -0.5) { break; }
    let code = slugRootCode(p12.x, p12.z, p3.x);
    if (code != 0u) {
      let r = slugSolveVertical(p12, p3) * pixelsPerUnit.y;
      if ((code & 1u) != 0u) {
        ycov -= saturate(r.x + 0.5);
        ywgt = max(ywgt, saturate(1.0 - abs(r.x) * 2.0));
      }
      if (code > 1u) {
        ycov += saturate(r.y + 0.5);
        ywgt = max(ywgt, saturate(1.0 - abs(r.y) * 2.0));
      }
    }
  }
  // evenodd：穿越次数按奇偶（带小数的部分覆盖照样折回来）
  if ((vectorWord(o + 1u) & 1u) != 0u) {
    xcov = 1.0 - abs(1.0 - abs(xcov) % 2.0);
    ycov = 1.0 - abs(1.0 - abs(ycov) % 2.0);
  }
  return saturate(max(abs(xcov * xwgt + ycov * ywgt) / max(xwgt + ywgt, 1.0 / 65536.0), min(abs(xcov), abs(ycov))));
}

// uv 处的颜色（线性、预乘的 rgb，a 是盖住的比例）
fn vectorColor(uv: vec2f, perPixel: vec2f) -> vec4f {
  if (arrayLength(&vectorData) < ${HEADER}u || vectorData[0] != ${VECTOR_MAGIC}u) { return vec4f(0.0); }
  let size = vectorAtlasSize();
  let coord = uv * size;
  let pixelsPerUnit = 1.0 / max(perPixel, vec2f(1e-6));
  let columns = vectorData[4u];
  let rows = vectorData[5u];
  let cell = clamp(vec2i(coord / ${CELL}.0), vec2i(0), vec2i(i32(columns) - 1, i32(rows) - 1));
  let head = vectorData[10u] + (u32(cell.y) * columns + u32(cell.x)) * 2u;
  let count = vectorData[head];
  let list = vectorData[11u] + vectorData[head + 1u];
  var color = vec3f(0.0);
  var remaining = 1.0;
  for (var i = 0u; i < count; i++) {
    let shape = vectorData[list + i];
    let o = vectorData[6u] + shape * ${VECTOR_SHAPE_WORDS}u;
    let bounds = vec4f(vectorFloat(o + 10u), vectorFloat(o + 11u), vectorFloat(o + 12u), vectorFloat(o + 13u));
    // 外框（也是裁剪）：外面不算，边上按到边的距离抗锯齿
    let inside = min(min(coord.x - bounds.x, bounds.z - coord.x) * pixelsPerUnit.x, min(coord.y - bounds.y, bounds.w - coord.y) * pixelsPerUnit.y);
    if (inside < -0.5) { continue; }
    let rgba = unpack4x8unorm(vectorWord(o));
    let alpha = rgba.a * vectorShapeCoverage(shape, coord, pixelsPerUnit) * saturate(inside + 0.5);
    if (alpha <= 0.0) { continue; }
    // sRGB 的颜色换成线性
    let linear = select(pow((rgba.rgb + 0.055) / 1.055, vec3f(2.4)), rgba.rgb / 12.92, rgba.rgb <= vec3f(0.04045));
    color += remaining * alpha * linear;
    remaining *= 1.0 - alpha;
    if (remaining < 0.004) { break; }
  }
  return vec4f(color, 1.0 - remaining);
}
`;
