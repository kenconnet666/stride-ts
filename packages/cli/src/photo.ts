/**
 * 照片比对（路线图 R1，`stride shot --photo`）：引擎的截图和一张参考照片（同样的机位、按截图的大小铺满裁好）比"像不像"，不是
 * 逐像素比（照片和渲染的像素对不上）。量的是人眼最先看出来的几样：
 * - 曝光：亮度（线性的相对亮度）的中位数差几档（log₂），亮处、暗处（第 5、95 百分位）各差几档，反差（log 亮度的标准差）；
 * - 颜色：白平衡（平均的 R/G、B/G）、饱和度；
 * - 细节：亮度的梯度平均有多大（一样的分辨率下比）——渲染"太干净、太简单"在这一项上最明显，比值小于 1 是渲染的细节少；
 * - 按 4 × 4 的格子各比曝光和细节，看出差在哪一块；
 * - 结构：缩小后亮度的 SSIM（机位对齐了才有意义）。
 * 另出一张拼图：照片 | 渲染 | 一半一半叠在一起（对机位用）。
 */
import type { Image } from './png.ts';

/** 一张图的统计。 */
export interface PhotoStats {
  /** 线性相对亮度的第 5、50、95 百分位。 */
  readonly luminance: { readonly p5: number; readonly p50: number; readonly p95: number };
  /** log₂ 亮度的标准差（档）。 */
  readonly contrast: number;
  /** 平均的线性 R/G、B/G。 */
  readonly whiteBalance: { readonly redGreen: number; readonly blueGreen: number };
  /** 平均饱和度（HSV 的 S，0..1）。 */
  readonly saturation: number;
  /** 亮度（sRGB 编码的 0..1）的梯度平均大小。 */
  readonly detail: number;
}

/** 一个格子的比较：曝光差几档（渲染减照片），细节的比值（渲染 / 照片）。 */
export interface CellComparison {
  readonly row: number;
  readonly column: number;
  readonly stops: number;
  readonly detailRatio: number;
}

export interface PhotoComparison {
  readonly photo: PhotoStats;
  readonly render: PhotoStats;
  /** 渲染减照片：中位数、亮处、暗处的亮度差几档。 */
  readonly exposureStops: { readonly median: number; readonly highlights: number; readonly shadows: number };
  /** 渲染 / 照片的细节。 */
  readonly detailRatio: number;
  /** 缩小到四分之一后亮度的平均 SSIM（−1..1，1 是一样）。 */
  readonly ssim: number;
  readonly grid: readonly CellComparison[];
  /** 一句一句的结论（差得明显的才写）。 */
  readonly notes: readonly string[];
}

const GRID = 4;

function toLinear(value: number): number {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
const LINEAR = Float64Array.from({ length: 256 }, (_, i) => toLinear(i));

/** 线性相对亮度（Rec. 709）和 sRGB 编码的亮度（梯度、SSIM 用）。 */
function luminances(image: Image, x0 = 0, y0 = 0, x1 = image.width, y1 = image.height): { linear: Float64Array; encoded: Float64Array; width: number; height: number } {
  const width = x1 - x0, height = y1 - y0;
  const linear = new Float64Array(width * height), encoded = new Float64Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = ((y0 + y) * image.width + x0 + x) * 4;
      const l = 0.2126 * LINEAR[image.data[i]!]! + 0.7152 * LINEAR[image.data[i + 1]!]! + 0.0722 * LINEAR[image.data[i + 2]!]!;
      linear[y * width + x] = l;
      encoded[y * width + x] = (0.2126 * image.data[i]! + 0.7152 * image.data[i + 1]! + 0.0722 * image.data[i + 2]!) / 255;
    }
  }
  return { linear, encoded, width, height };
}

function percentile(sorted: Float64Array, p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))]!;
}

/** 亮度梯度（中心差分）的平均大小。 */
function detailOf(encoded: Float64Array, width: number, height: number): number {
  let sum = 0, count = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const gx = encoded[y * width + x + 1]! - encoded[y * width + x - 1]!;
      const gy = encoded[(y + 1) * width + x]! - encoded[(y - 1) * width + x]!;
      sum += Math.hypot(gx, gy);
      count++;
    }
  }
  return count > 0 ? sum / count : 0;
}

/** 一张图（或一块）的统计。 */
export function photoStats(image: Image): PhotoStats {
  const { linear, encoded, width, height } = luminances(image);
  const sorted = Float64Array.from(linear).sort();
  let logSum = 0, logSquares = 0, r = 0, g = 0, b = 0, saturation = 0;
  for (let i = 0; i < linear.length; i++) {
    const log = Math.log2(Math.max(linear[i]!, 1e-4));
    logSum += log;
    logSquares += log * log;
    const p = i * 4, red = image.data[p]!, green = image.data[p + 1]!, blue = image.data[p + 2]!;
    r += LINEAR[red]!;
    g += LINEAR[green]!;
    b += LINEAR[blue]!;
    const max = Math.max(red, green, blue), min = Math.min(red, green, blue);
    saturation += max > 0 ? (max - min) / max : 0;
  }
  const n = Math.max(linear.length, 1), mean = logSum / n;
  return {
    luminance: { p5: percentile(sorted, 0.05), p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95) },
    contrast: Math.sqrt(Math.max(logSquares / n - mean * mean, 0)),
    whiteBalance: { redGreen: r / Math.max(g, 1e-9), blueGreen: b / Math.max(g, 1e-9) },
    saturation: saturation / n,
    detail: detailOf(encoded, width, height),
  };
}

/** 缩小 factor 倍（按块平均）的 sRGB 亮度。 */
function downscaled(image: Image, factor: number): { values: Float64Array; width: number; height: number } {
  const width = Math.floor(image.width / factor), height = Math.floor(image.height / factor);
  const { encoded } = luminances(image);
  const values = new Float64Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let dy = 0; dy < factor; dy++) for (let dx = 0; dx < factor; dx++) sum += encoded[(y * factor + dy) * image.width + x * factor + dx]!;
      values[y * width + x] = sum / (factor * factor);
    }
  }
  return { values, width, height };
}

/** 平均 SSIM：8 × 8 的窗口、步长 4（Wang 2004 的常数，值域 0..1）。 */
export function ssim(a: Float64Array, b: Float64Array, width: number, height: number): number {
  const c1 = 0.01 ** 2, c2 = 0.03 ** 2;
  let total = 0, windows = 0;
  for (let y = 0; y + 8 <= height; y += 4) {
    for (let x = 0; x + 8 <= width; x += 4) {
      let ma = 0, mb = 0;
      for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) {
        ma += a[(y + j) * width + x + i]!;
        mb += b[(y + j) * width + x + i]!;
      }
      ma /= 64;
      mb /= 64;
      let va = 0, vb = 0, cov = 0;
      for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) {
        const da = a[(y + j) * width + x + i]! - ma, db = b[(y + j) * width + x + i]! - mb;
        va += da * da;
        vb += db * db;
        cov += da * db;
      }
      va /= 63;
      vb /= 63;
      cov /= 63;
      total += ((2 * ma * mb + c1) * (2 * cov + c2)) / ((ma * ma + mb * mb + c1) * (va + vb + c2));
      windows++;
    }
  }
  return windows > 0 ? total / windows : 1;
}

function crop(image: Image, x0: number, y0: number, x1: number, y1: number): Image {
  const width = x1 - x0, height = y1 - y0;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) data.set(image.data.subarray(((y0 + y) * image.width + x0) * 4, ((y0 + y) * image.width + x1) * 4), y * width * 4);
  return { width, height, data };
}

const stops = (render: number, photo: number) => Math.log2(Math.max(render, 1e-5) / Math.max(photo, 1e-5));
const round = (value: number, digits = 2) => Number(value.toFixed(digits));

/** 比较一张参考照片和一张渲染（一样大：照片已经按渲染的大小铺满裁好）。 */
export function comparePhoto(photo: Image, render: Image): PhotoComparison {
  if (photo.width !== render.width || photo.height !== render.height) throw new Error(`comparePhoto: the photo is ${photo.width}x${photo.height}, the render ${render.width}x${render.height}`);
  const p = photoStats(photo), r = photoStats(render);
  const grid: CellComparison[] = [];
  for (let row = 0; row < GRID; row++) {
    for (let column = 0; column < GRID; column++) {
      const x0 = Math.floor((column * photo.width) / GRID), x1 = Math.floor(((column + 1) * photo.width) / GRID);
      const y0 = Math.floor((row * photo.height) / GRID), y1 = Math.floor(((row + 1) * photo.height) / GRID);
      const pc = photoStats(crop(photo, x0, y0, x1, y1)), rc = photoStats(crop(render, x0, y0, x1, y1));
      grid.push({ row, column, stops: round(stops(rc.luminance.p50, pc.luminance.p50)), detailRatio: round(rc.detail / Math.max(pc.detail, 1e-6)) });
    }
  }
  const a = downscaled(photo, 4), b = downscaled(render, 4);
  const exposureStops = { median: round(stops(r.luminance.p50, p.luminance.p50)), highlights: round(stops(r.luminance.p95, p.luminance.p95)), shadows: round(stops(r.luminance.p5, p.luminance.p5)) };
  const detailRatio = round(r.detail / Math.max(p.detail, 1e-6));
  const notes: string[] = [];
  if (Math.abs(exposureStops.median) > 0.33) notes.push(`the render is ${Math.abs(exposureStops.median)} stops ${exposureStops.median > 0 ? 'brighter' : 'darker'} overall`);
  if (Math.abs(exposureStops.shadows) > 0.5) notes.push(`shadows are ${Math.abs(exposureStops.shadows)} stops ${exposureStops.shadows > 0 ? 'brighter' : 'darker'} (indirect light, ambient occlusion)`);
  if (Math.abs(exposureStops.highlights) > 0.5) notes.push(`highlights are ${Math.abs(exposureStops.highlights)} stops ${exposureStops.highlights > 0 ? 'brighter' : 'darker'} (sun, sky, tone mapping)`);
  const contrast = r.contrast - p.contrast;
  if (Math.abs(contrast) > 0.3) notes.push(`contrast is ${contrast > 0 ? 'higher' : 'lower'} (${round(r.contrast)} vs ${round(p.contrast)} stops of spread)`);
  if (detailRatio < 0.7) notes.push(`the render has ${detailRatio}x the fine detail of the photo (too smooth or too clean: textures, wear, clutter, geometry)`);
  if (detailRatio > 1.4) notes.push(`the render has ${detailRatio}x the fine detail of the photo (noise, aliasing or over-sharpening)`);
  const wb = r.whiteBalance.blueGreen / Math.max(r.whiteBalance.redGreen, 1e-6) / (p.whiteBalance.blueGreen / Math.max(p.whiteBalance.redGreen, 1e-6));
  if (Math.abs(Math.log2(wb)) > 0.15) notes.push(`the render is ${wb > 1 ? 'cooler (bluer)' : 'warmer (redder)'} than the photo`);
  if (Math.abs(r.saturation - p.saturation) > 0.08) notes.push(`colors are ${r.saturation > p.saturation ? 'more' : 'less'} saturated (${round(r.saturation)} vs ${round(p.saturation)})`);
  const worst = [...grid].sort((x, y) => x.detailRatio - y.detailRatio)[0];
  if (worst && worst.detailRatio < 0.5) notes.push(`the least detailed region is row ${worst.row}, column ${worst.column} (${worst.detailRatio}x)`);
  return { photo: p, render: r, exposureStops, detailRatio, ssim: round(ssim(a.values, b.values, a.width, a.height), 3), grid, notes };
}

/** 拼图：照片 | 渲染 | 两张各一半叠在一起，各缩到 width 宽。 */
export function photoComposite(photo: Image, render: Image, width = 640): Image {
  const scale = width / photo.width, height = Math.round(photo.height * scale);
  const data = new Uint8Array(width * 3 * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sx = Math.min(photo.width - 1, Math.floor(x / scale)), sy = Math.min(photo.height - 1, Math.floor(y / scale));
      const i = (sy * photo.width + sx) * 4;
      for (let c = 0; c < 4; c++) {
        const pv = photo.data[i + c]!, rv = render.data[i + c]!;
        data[(y * width * 3 + x) * 4 + c] = c === 3 ? 255 : pv;
        data[(y * width * 3 + width + x) * 4 + c] = c === 3 ? 255 : rv;
        data[(y * width * 3 + 2 * width + x) * 4 + c] = c === 3 ? 255 : (pv + rv) >> 1;
      }
    }
  }
  return { width: width * 3, height, data };
}
