/**
 * 3D 文字的轮廓（店招、站名、门牌、警示贴；编辑器后端把 `.text.json` 烘成模型，pipeline/src/textModel.ts）：用字体资源本身
 * （FontFile 加字形块，同屏幕上的矢量文字）排版，把每个字的二次曲线拼回闭合的轮廓、按精度折成多边形，分出外轮廓和洞。
 * 纯函数，不依赖 DOM、原生模块：引擎、编辑器后端、测试都能用。
 *
 * 字形块里的点按 Slug 的格式存（相邻的曲线共用端点，曲线只在带的曲线表里记起点），所以先从带里收齐这个字形的曲线起点，
 * 每条曲线是起点开始的三个点。
 */
import { GLYPH_RECORD, GLYPH_WORDS, type FontFile, type GlyphBlock } from '../content/format.ts';

/** 一个字的轮廓：多边形的点（米，文字的平面里，y 向上），是不是洞（被奇数个别的轮廓包着），属于第几个字。 */
export interface TextContour {
  readonly points: readonly (readonly [number, number])[];
  readonly hole: boolean;
  readonly glyph: number;
}

export interface TextLayoutOptions {
  /** 一行字的高（米）：字体的上升加下降。 */
  readonly size: number;
  readonly align?: 'left' | 'center' | 'right';
  /** 行距是一行字高的多少倍（默认 1.2）。 */
  readonly lineSpacing?: number;
  /** 字和字之间额外加多少（字高的倍数）。 */
  readonly letterSpacing?: number;
  /** 曲线折成直线时的最大误差（米，默认字高的 1/400）。 */
  readonly tolerance?: number;
}

/** 字体资源：文件和按块号取字形块（编辑器后端从内容目录读，引擎从 ContentManager 读）。 */
export interface TextFont {
  readonly file: FontFile;
  readonly block: (block: number) => GlyphBlock | undefined;
}

/**
 * 排版并取出轮廓：多行（\n）、按 align 对齐，文字的原点在整段的中心（底边是最后一行的基线往下的下降）。找不到的字用字体的
 * 默认字符，再没有就空一个字宽。
 */
export function textContours(font: TextFont, text: string, options: TextLayoutOptions): TextContour[] {
  const { file } = font;
  const em = options.size / Math.max(file.ascent + file.descent, 1e-6);
  const lineHeight = options.size * (options.lineSpacing ?? 1.2);
  const tolerance = options.tolerance ?? options.size / 400;
  const lines = text.split('\n');
  const glyphs = lines.map((line) => layoutLine(font, line, em, (options.letterSpacing ?? 0) * options.size));
  const widest = Math.max(0, ...glyphs.map((line) => line.width));
  const height = lineHeight * (lines.length - 1) + options.size;
  const contours: TextContour[] = [];
  let glyphIndex = 0;
  glyphs.forEach((line, row) => {
    const shift = options.align === 'right' ? widest - line.width : options.align === 'left' ? 0 : (widest - line.width) / 2;
    // 第一行的基线在顶上往下一个上升的地方，原点挪到整段的中心
    const baseline = height / 2 - file.ascent * em - row * lineHeight;
    for (const placed of line.glyphs) {
      const x0 = placed.x + shift - widest / 2;
      const outlines = closedContours(placed.curves).map((contour) => flatten(contour, tolerance / em).map(([x, y]) => [x0 + x * em, baseline + y * em] as [number, number]));
      const kept = outlines.filter((points) => points.length >= 3 && Math.abs(signedArea(points)) > 1e-12);
      kept.forEach((points, i) => {
        // 被奇数个别的轮廓包着的是洞（不管字体按哪种绕向存的：TrueType 外顺内逆，CFF 反过来）
        const depth = kept.filter((other, j) => j !== i && contains(other, points[0]!)).length;
        contours.push({ points, hole: depth % 2 === 1, glyph: glyphIndex });
      });
      glyphIndex++;
    }
  });
  return contours;
}

interface PlacedGlyph {
  readonly x: number;
  /** 这个字的二次曲线（em）。 */
  readonly curves: Float32Array;
}

/** 一行字：每个字放在哪（米）和它的曲线，行宽。 */
function layoutLine(font: TextFont, line: string, em: number, letterSpacing: number): { glyphs: PlacedGlyph[]; width: number } {
  const glyphs: PlacedGlyph[] = [];
  let x = 0;
  let previous = -1;
  for (const character of line) {
    const codepoint = character.codePointAt(0)!;
    const found = findGlyph(font, codepoint) ?? findGlyph(font, font.file.defaultCharacter);
    if (previous >= 0) x += kerning(font.file, previous, codepoint) * em;
    if (found) {
      glyphs.push({ x, curves: found.curves });
      x += found.advance * em + letterSpacing;
    } else {
      x += 0.5 * (font.file.ascent + font.file.descent) * em + letterSpacing;
    }
    previous = codepoint;
  }
  return { glyphs, width: Math.max(0, x - letterSpacing) };
}

function kerning(file: FontFile, left: number, right: number): number {
  const table = file.kerning;
  for (let i = 0; i + 2 < table.length; i += 3) if (table[i] === left && table[i + 1] === right) return table[i + 2]!;
  return 0;
}

/** 码位的字形：字距（em）和曲线（em）；字体里没有时 undefined。 */
export function findGlyph(font: TextFont, codepoint: number): { advance: number; curves: Float32Array } | undefined {
  const block = font.block(codepoint >> 8);
  if (!block) return undefined;
  const u32 = new Uint32Array(block.glyphs), f32 = new Float32Array(block.glyphs);
  for (let g = 0; g < block.glyphCount; g++) {
    const r = g * GLYPH_WORDS;
    if (u32[r + GLYPH_RECORD.codepoint] !== codepoint) continue;
    return { advance: f32[r + GLYPH_RECORD.advance]!, curves: glyphCurves(block, g) };
  }
  return undefined;
}

/**
 * 字形块里第 g 个字形的二次曲线（x1 y1 x2 y2 x3 y3，em）：带的曲线表里记的是曲线起点（相对字形的点），收齐去重，每条是起点开始的
 * 三个点。和横带平行的直线不进横带、和竖带平行的不进竖带，两种带合起来每条曲线都在。
 */
export function glyphCurves(block: GlyphBlock, g: number): Float32Array {
  const u32 = new Uint32Array(block.glyphs), r = g * GLYPH_WORDS;
  const pointStart = u32[r + GLYPH_RECORD.pointStart]!, bandStart = u32[r + GLYPH_RECORD.bandStart]!;
  const bands = u32[r + GLYPH_RECORD.hBands]! + u32[r + GLYPH_RECORD.vBands]!;
  const starts = new Set<number>();
  for (let b = 0; b < bands; b++) {
    const count = block.bands[bandStart + b * 2]!, offset = block.bands[bandStart + b * 2 + 1]!;
    for (let k = 0; k < count; k++) starts.add(block.bands[bandStart + offset + k]!);
  }
  const sorted = [...starts].sort((a, b) => a - b);
  const curves = new Float32Array(sorted.length * 6);
  sorted.forEach((start, i) => curves.set(block.points.subarray((pointStart + start) * 2, (pointStart + start) * 2 + 6), i * 6));
  return curves;
}

/** 曲线按首尾相接拼成闭合的轮廓（每个轮廓是一串曲线）。 */
function closedContours(curves: Float32Array): Float32Array[] {
  const count = curves.length / 6;
  const used = new Uint8Array(count);
  const key = (x: number, y: number) => `${Math.round(x * 1e5)},${Math.round(y * 1e5)}`;
  const byStart = new Map<string, number[]>();
  for (let i = 0; i < count; i++) {
    const k = key(curves[i * 6]!, curves[i * 6 + 1]!);
    byStart.set(k, [...(byStart.get(k) ?? []), i]);
  }
  const contours: Float32Array[] = [];
  for (let first = 0; first < count; first++) {
    if (used[first]) continue;
    const chain: number[] = [];
    for (let current: number | undefined = first; current !== undefined && !used[current];) {
      used[current] = 1;
      chain.push(current);
      const next: number[] = byStart.get(key(curves[current * 6 + 4]!, curves[current * 6 + 5]!)) ?? [];
      current = next.find((candidate) => !used[candidate]);
    }
    const contour = new Float32Array(chain.length * 6);
    chain.forEach((curve, i) => contour.set(curves.subarray(curve * 6, curve * 6 + 6), i * 6));
    contours.push(contour);
  }
  return contours;
}

/** 一个轮廓的曲线折成多边形的点（不重复终点）：每条曲线按弯的程度分几段，误差不超过 tolerance（em）。 */
function flatten(contour: Float32Array, tolerance: number): [number, number][] {
  const points: [number, number][] = [];
  for (let i = 0; i < contour.length; i += 6) {
    const [x1, y1, x2, y2, x3, y3] = contour.subarray(i, i + 6) as unknown as number[];
    // 二次曲线离弦最远是控制点到弦中点距离的一半；分 n 段误差按 1/n² 降
    const deviation = Math.hypot(x2! - (x1! + x3!) / 2, y2! - (y1! + y3!) / 2) / 2;
    const segments = Math.max(1, Math.min(16, Math.ceil(Math.sqrt(deviation / Math.max(tolerance, 1e-9)))));
    points.push([x1!, y1!]);
    for (let s = 1; s < segments; s++) {
      const t = s / segments, u = 1 - t;
      points.push([u * u * x1! + 2 * u * t * x2! + t * t * x3!, u * u * y1! + 2 * u * t * y2! + t * t * y3!]);
    }
  }
  // 相邻重合的点去掉
  return points.filter((point, i) => {
    const next = points[(i + 1) % points.length]!;
    return Math.abs(point[0] - next[0]) > 1e-9 || Math.abs(point[1] - next[1]) > 1e-9;
  });
}

function signedArea(points: readonly (readonly [number, number])[]): number {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const [x0, y0] = points[i]!, [x1, y1] = points[(i + 1) % points.length]!;
    area += x0 * y1 - x1 * y0;
  }
  return area / 2;
}

/** 点在不在多边形里（偶奇规则）。 */
function contains(polygon: readonly (readonly [number, number])[], [x, y]: readonly [number, number]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i]!, [xj, yj] = polygon[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
