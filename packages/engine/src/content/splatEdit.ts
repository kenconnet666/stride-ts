/**
 * 扫描场景的编辑的纯函数部分（`.splatedit.json`，格式见 content/formats/splatEditFormat.ts）：从 .splat 读回原样的泼溅（叶子节点的
 * 那些，合并出来的粗级不要，生成时重建），按裁剪框、刷掉的球、删飞点挑出留下的。编辑器后端烘焙（pipeline 的
 * bakers/splatEditModel.ts）、测试都用。
 */
import type { SplatEditBox, SplatEditFile } from './formats/splatEditFormat.ts';
import { whiteBalanceMatrix } from '../rendering/postfx/tonemap/whiteBalance.ts';
import { decodeSplats, shCoefficients, shWords, SPLAT_WORDS, type SplatSource } from './splatFile.ts';

// 几段扫描的合并、对齐也从这个入口（@stride-ts/engine/splat-edit）出去
export * from './splatAlign.ts';
export * from './splatProxy.ts';

/** 删飞点的默认：格子边长（米）、周围最少几个、最低的不透明度。 */
const FLOATER_CELL = 0.25;
const FLOATER_NEIGHBORS = 4;
const FLOATER_OPACITY = 0;

/** 读回 .splat 里原样的泼溅（细节层次的叶子；版本 1、2 的文件是全部）：位置、缩放、旋转、颜色、球谐都解成浮点。 */
export function decodeSplatSource(buffer: ArrayBuffer, where = 'splats'): SplatSource {
  const decoded = decodeSplats(buffer, where);
  const ranges = decoded.nodes.filter((node) => node.childCount === 0).map((node) => [node.first, node.count] as const);
  const count = ranges.reduce((sum, [, n]) => sum + n, 0);
  const words = decoded.words, floats = new Float32Array(words.buffer, words.byteOffset, words.length);
  const positions = new Float32Array(count * 3), scales = new Float32Array(count * 3), rotations = new Float32Array(count * 4), colors = new Float32Array(count * 4);
  const bands = decoded.shBands, per = shCoefficients(bands) * 3, shPer = shWords(bands);
  const sh = bands > 0 ? new Float32Array(count * per) : undefined;
  const shBytes = new Uint8Array(decoded.sh.buffer, decoded.sh.byteOffset, decoded.sh.byteLength);
  let out = 0;
  for (const [first, n] of ranges) {
    for (let i = first; i < first + n; i++, out++) {
      const o = i * SPLAT_WORDS;
      positions.set([floats[o]!, floats[o + 1]!, floats[o + 2]!], out * 3);
      scales.set([fromHalf(words[o + 3]! & 0xffff), fromHalf(words[o + 3]! >>> 16), fromHalf(words[o + 4]! & 0xffff)], out * 3);
      const r = words[o + 5]!, c = words[o + 6]!;
      rotations.set([snorm8(r & 0xff), snorm8((r >>> 8) & 0xff), snorm8((r >>> 16) & 0xff), snorm8(r >>> 24)], out * 4);
      colors.set([(c & 0xff) / 255, ((c >>> 8) & 0xff) / 255, ((c >>> 16) & 0xff) / 255, (c >>> 24) / 255], out * 4);
      if (sh) for (let k = 0; k < per; k++) sh[out * per + k] = (shBytes[i * shPer * 4 + k]! / 255 - 0.5) * 2 * decoded.shRange;
    }
  }
  return { count, positions, scales, rotations, colors, ...(sh ? { shBands: bands, sh } : {}) };
}

/** 这次编辑每一步去掉了几个（编辑器、MCP 报给人看）。 */
export interface SplatEditStats {
  readonly kept: number;
  readonly cropped: number;
  readonly erased: number;
  readonly floaters: number;
}

/** 按编辑挑出留下的泼溅（顺序不变）。 */
export function applySplatEdit(source: SplatSource, edit: SplatEditFile): { readonly source: SplatSource; readonly stats: SplatEditStats } {
  const { count, positions, colors } = source;
  const keep = new Uint8Array(count).fill(1);
  let cropped = 0, erased = 0, floaters = 0;
  const at = (i: number) => [positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!] as const;
  const keepBoxes = edit.keep ?? [], removeBoxes = edit.remove ?? [], spheres = edit.erase ?? [];
  for (let i = 0; i < count; i++) {
    const p = at(i);
    if ((keepBoxes.length > 0 && !keepBoxes.some((box) => insideBox(box, p))) || removeBoxes.some((box) => insideBox(box, p))) {
      keep[i] = 0;
      cropped++;
    } else if (spheres.some((sphere) => (p[0] - sphere.center[0]) ** 2 + (p[1] - sphere.center[1]) ** 2 + (p[2] - sphere.center[2]) ** 2 <= sphere.radius ** 2)) {
      keep[i] = 0;
      erased++;
    }
  }
  if (edit.floaters) {
    const cell = Math.max(1e-4, edit.floaters.cell ?? FLOATER_CELL), neighbors = edit.floaters.neighbors ?? FLOATER_NEIGHBORS, minOpacity = edit.floaters.minOpacity ?? FLOATER_OPACITY;
    // 留下的泼溅按格子数一遍，再看每个泼溅自己和周围 26 格的总数
    const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
    const cells = new Map<string, number>();
    const cellOf = (i: number) => [Math.floor(positions[i * 3]! / cell), Math.floor(positions[i * 3 + 1]! / cell), Math.floor(positions[i * 3 + 2]! / cell)] as const;
    for (let i = 0; i < count; i++) {
      if (!keep[i]) continue;
      const [x, y, z] = cellOf(i), k = key(x, y, z);
      cells.set(k, (cells.get(k) ?? 0) + 1);
    }
    const around = new Map<string, number>();
    for (let i = 0; i < count; i++) {
      if (!keep[i]) continue;
      if (colors[i * 4 + 3]! < minOpacity) {
        keep[i] = 0;
        floaters++;
        continue;
      }
      const [x, y, z] = cellOf(i), k = key(x, y, z);
      let total = around.get(k);
      if (total === undefined) {
        total = 0;
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) total += cells.get(key(x + dx, y + dy, z + dz)) ?? 0;
        around.set(k, total);
      }
      // 数的时候算上了自己
      if (total - 1 < neighbors) {
        keep[i] = 0;
        floaters++;
      }
    }
  }
  const picked = pickSplats(source, keep);
  return { source: edit.color ? applySplatColor(picked, splatColorMatrix(edit.color)) : picked, stats: { kept: count - cropped - erased - floaters, cropped, erased, floaters } };
}

/**
 * 调色的矩阵（线性 sRGB 里的 3×3，行主序）：曝光 2^exposure 乘饱和度（绕 Rec.709 的亮度插值）乘白平衡（rendering/postfx/tonemap
 * 的 whiteBalanceMatrix：temperature 的光当成白）。
 */
export function splatColorMatrix(color: NonNullable<SplatEditFile['color']>): number[] {
  const gain = 2 ** (color.exposure ?? 0), s = color.saturation ?? 1;
  const luma = [0.2126, 0.7152, 0.0722];
  const saturation = [0, 1, 2].flatMap((i) => [0, 1, 2].map((j) => (1 - s) * luma[j]! + (i === j ? s : 0)));
  // whiteBalanceMatrix 是列主序：换成行主序
  const wb = whiteBalanceMatrix(color.temperature ?? 6500, color.tint ?? 0);
  const white = [0, 1, 2].flatMap((i) => [0, 1, 2].map((j) => wb[j * 3 + i]!));
  return [0, 1, 2].flatMap((i) => [0, 1, 2].map((j) => gain * [0, 1, 2].reduce((sum, k) => sum + saturation[i * 3 + k]! * white[k * 3 + j]!, 0)));
}

/**
 * 按调色的矩阵 m（线性 sRGB，行主序）改颜色：0 阶的颜色（显示空间的 sRGB）解码、乘 m、再编码（夹在 0..1）；高阶球谐是加在
 * 显示空间颜色上的小偏移，按在这个泼溅的颜色处线性化的变换改（编码的导数 · m · 解码的导数），亮处、暗处跟着一起变。
 */
export function applySplatColor(source: SplatSource, m: readonly number[]): SplatSource {
  const colors = new Float32Array(source.colors), n = shCoefficients(source.shBands ?? 0), sh = source.sh ? new Float32Array(source.sh) : undefined;
  for (let i = 0; i < source.count; i++) {
    const encoded = [colors[i * 4]!, colors[i * 4 + 1]!, colors[i * 4 + 2]!], linear = encoded.map(decodeSrgb);
    const mapped = [0, 1, 2].map((r) => m[r * 3]! * linear[0]! + m[r * 3 + 1]! * linear[1]! + m[r * 3 + 2]! * linear[2]!);
    for (let c = 0; c < 3; c++) colors[i * 4 + c] = encodeSrgb(Math.min(1, Math.max(0, mapped[c]!)));
    if (sh && n > 0) {
      const jacobian = [0, 1, 2].map((r) => [0, 1, 2].map((c) => encodeSlope(Math.max(0, mapped[r]!)) * m[r * 3 + c]! * decodeSlope(encoded[c]!)));
      const base = i * n * 3;
      for (let k = 0; k < n; k++) {
        const v = [sh[base + k]!, sh[base + n + k]!, sh[base + 2 * n + k]!];
        for (let r = 0; r < 3; r++) sh[base + r * n + k] = jacobian[r]![0]! * v[0]! + jacobian[r]![1]! * v[1]! + jacobian[r]![2]! * v[2]!;
      }
    }
  }
  return { ...source, colors, ...(sh ? { sh } : {}) };
}

/**
 * 编辑器里调色的预览：画面上的泼溅已经按 baked 调过了，预览要的是从它到 next 的那一下——next 的矩阵乘 baked 的逆。两个一样
 * 时是 undefined（不用调）。
 */
export function splatColorPreview(next: SplatEditFile['color'], baked: SplatEditFile['color']): number[] | undefined {
  if (JSON.stringify(next ?? {}) === JSON.stringify(baked ?? {})) return undefined;
  const to = splatColorMatrix(next ?? {}), from = invert3(splatColorMatrix(baked ?? {}));
  return [0, 1, 2].flatMap((i) => [0, 1, 2].map((j) => to[i * 3]! * from[j]! + to[i * 3 + 1]! * from[3 + j]! + to[i * 3 + 2]! * from[6 + j]!));
}

/** 3×3（行主序）的逆；奇异的（饱和度 0）当成恒等。 */
function invert3(m: readonly number[]): number[] {
  const [a, b, c, d, e, f, g, h, i] = m as [number, number, number, number, number, number, number, number, number];
  const A = e * i - f * h, B = f * g - d * i, C = d * h - e * g, det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-9) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  return [A / det, (c * h - b * i) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, (c * d - a * f) / det, C / det, (b * g - a * h) / det, (a * e - b * d) / det];
}

const decodeSrgb = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const encodeSrgb = (l: number) => (l <= 0.0031308 ? l * 12.92 : 1.055 * l ** (1 / 2.4) - 0.055);
/** 解码、编码的导数（编码在 0 附近按线性段的斜率，免得除零）。 */
const decodeSlope = (c: number) => (c <= 0.04045 ? 1 / 12.92 : (2.4 / 1.055) * ((c + 0.055) / 1.055) ** 1.4);
const encodeSlope = (l: number) => (l <= 0.0031308 ? 12.92 : (1.055 / 2.4) * l ** (1 / 2.4 - 1));

/**
 * 编辑的裁剪框、删掉的框、刷掉的球和调色编成 GPU 上的遮罩（rendering/splats/SplatRenderer.ts 的 masked、project，编辑器里马上
 * 预览）：第一项是三种的个数和有没有调色，接着 3 行调色的矩阵（线性 sRGB，color 给了才用），再是每个框 3 行——泼溅坐标换到
 * 框里 ±0.5 的单位坐标（第 k 行是框的第 k 根轴除以那条边长，w 是平移）——每个球一项（球心、半径）。删飞点要数邻居，不在遮罩里。
 */
export function splatEditMask(edit: Pick<SplatEditFile, 'keep' | 'remove' | 'erase'>, color?: readonly number[]): Float32Array {
  const keep = edit.keep ?? [], remove = edit.remove ?? [], erase = edit.erase ?? [];
  const data = new Float32Array(16 + (keep.length + remove.length) * 12 + erase.length * 4);
  data.set([keep.length, remove.length, erase.length, color ? 1 : 0]);
  if (color) for (let r = 0; r < 3; r++) data.set([color[r * 3]!, color[r * 3 + 1]!, color[r * 3 + 2]!, 0], 4 + r * 4);
  let at = 16;
  for (const box of [...keep, ...remove]) {
    const q = box.rotation ?? [0, 0, 0, 1];
    for (let k = 0; k < 3; k++) {
      const axis = rotate(q, [k === 0 ? 1 : 0, k === 1 ? 1 : 0, k === 2 ? 1 : 0]).map((v) => v / box.size[k]!);
      data.set([axis[0]!, axis[1]!, axis[2]!, -(axis[0]! * box.center[0] + axis[1]! * box.center[1] + axis[2]! * box.center[2])], at);
      at += 4;
    }
  }
  for (const sphere of erase) {
    data.set([...sphere.center, sphere.radius], at);
    at += 4;
  }
  return data;
}

/** 四元数（xyzw）转一个向量。 */
function rotate([qx, qy, qz, qw]: readonly number[], [x, y, z]: readonly number[]): [number, number, number] {
  const tx = 2 * (qy! * z! - qz! * y!), ty = 2 * (qz! * x! - qx! * z!), tz = 2 * (qx! * y! - qy! * x!);
  return [x! + qw! * tx + qy! * tz - qz! * ty, y! + qw! * ty + qz! * tx - qx! * tz, z! + qw! * tz + qx! * ty - qy! * tx];
}

/** 点在盒子里（含边界）：转进盒子自己的坐标比半边长。 */
export function insideBox(box: SplatEditBox, point: readonly number[]): boolean {
  let [x, y, z] = [point[0]! - box.center[0], point[1]! - box.center[1], point[2]! - box.center[2]];
  // 用旋转的共轭把点转回去
  if (box.rotation) [x, y, z] = rotate([-box.rotation[0], -box.rotation[1], -box.rotation[2], box.rotation[3]], [x, y, z]);
  return Math.abs(x) <= box.size[0] / 2 && Math.abs(y) <= box.size[1] / 2 && Math.abs(z) <= box.size[2] / 2;
}

/** 挑出 keep 为 1 的那些（各个数组一起挑）。 */
function pickSplats(source: SplatSource, keep: Uint8Array): SplatSource {
  const indices: number[] = [];
  for (let i = 0; i < source.count; i++) if (keep[i]) indices.push(i);
  const pick = (array: Float32Array, stride: number) => {
    const out = new Float32Array(indices.length * stride);
    indices.forEach((i, n) => out.set(array.subarray(i * stride, (i + 1) * stride), n * stride));
    return out;
  };
  const per = shCoefficients(source.shBands ?? 0) * 3;
  return {
    count: indices.length, positions: pick(source.positions, 3), scales: pick(source.scales, 3), rotations: pick(source.rotations, 4), colors: pick(source.colors, 4),
    ...(source.sh && per > 0 ? { shBands: source.shBands!, sh: pick(source.sh, per) } : {}),
  };
}

const snorm8 = (byte: number) => ((byte << 24) >> 24) / 127;

/** f16 的位 → f32（同 splatFile.ts 的 toHalf 的反过来）。 */
function fromHalf(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1, exponent = (bits >>> 10) & 0x1f, mantissa = bits & 0x3ff;
  if (exponent === 0) return sign * mantissa * 2 ** -24;
  if (exponent === 31) return mantissa ? Number.NaN : sign * Infinity;
  return sign * (1 + mantissa / 1024) * 2 ** (exponent - 15);
}
