/**
 * 富文本的排版：把 markdown.ts 解析出来的块排成行，一行里可以有不同的字体、字号、颜色（基线对齐，行高取这一行最高的字），
 * 按宽度换行，列表项缩进、记号挂在左边。结果的坐标是虚拟像素，原点在文字框的左上角；对齐（居中、右对齐）画的时候按框宽
 * 加到每一行上（lineOffset），所以框宽变了不用重排。
 *
 * 字号和单字的排版跟 layout.ts（普通文字）一样：运行时字体按 虚拟字号 · pixelRatio（真实像素）量，再除回虚拟像素；编译期
 * 字体只能按自己的字号（同 Stride）。
 *
 * 粗体、斜体优先用控件给的同族字体（RichFonts）；没给时合成，做法同 FreeType：粗体是轮廓往外扩 em/48（FT_GlyphSlot_Embolden，
 * 前进宽度加两倍），斜体是往右斜切 0.2126（12°，FT_GlyphSlot_Oblique）。
 *
 * 换行（wrapWidth 给了时）在空白后面断开，中日韩的字之间也能断；一行里一个断点都没有时按字断开。和 Stride 的 TextBlock 不同：
 * 它只认空白（中文一整句没有空格时只能按字硬断，标点也会跑到行首）。
 */
import { glyphAdvance, glyphOrDefault, glyphScale, kerning } from './layout';
import type { RichBlock, RichDocument, RichStyle } from './markdown';
import type { FontGlyph, SpriteFont } from './SpriteFont';

/** 合成粗体每边往外扩多少 em。 */
export const SYNTHETIC_BOLD_EM = 1 / 48;
/** 合成斜体的斜率。 */
export const SYNTHETIC_ITALIC_SLANT = 0.2126;
/** 列表每一层缩进多少个字号。 */
const INDENT_EMS = 1.5;
/** 块和块之间空出几行（列表项之间不空）。 */
const BLOCK_GAP_LINES = 0.5;

/** 一种样式用的字体；没给的按 regular 合成。 */
export interface RichFonts {
  readonly regular: SpriteFont;
  readonly bold?: SpriteFont | null | undefined;
  readonly italic?: SpriteFont | null | undefined;
  readonly boldItalic?: SpriteFont | null | undefined;
  readonly code?: SpriteFont | null | undefined;
}

export interface RichLayoutOptions {
  /** 控件的字号，虚拟像素。 */
  readonly fontSize: number;
  /** 真实像素 / 虚拟像素（纵向的比例，同 TextBlock）。 */
  readonly pixelRatio: number;
  /** 按这个宽度（虚拟像素）换行；不给时只在硬换行、块之间换行。 */
  readonly wrapWidth?: number | undefined;
}

/** 排好的一个字（空白不在里面）。 */
export interface RichGlyph {
  readonly glyph: FontGlyph;
  readonly font: SpriteFont;
  /** 排版用的字号（字体像素）；一个字体像素是 unit 个虚拟像素。 */
  readonly fontPx: number;
  readonly unit: number;
  /** 字的原点（笔的位置、基线），虚拟像素，不含对齐的偏移。 */
  readonly x: number;
  readonly y: number;
  readonly line: number;
  readonly style: RichStyle;
  readonly syntheticBold: boolean;
  readonly syntheticItalic: boolean;
}

/** 下划线、删除线、行内代码的底色：一个矩形，虚拟像素，不含对齐的偏移。 */
export interface RichDecoration {
  readonly kind: 'underline' | 'strikethrough' | 'code';
  readonly line: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly style: RichStyle;
}

/** 一行。segments 是这一行的文字按链接分的段（读屏、影子 DOM 用）。 */
export interface RichLine {
  readonly y: number;
  readonly height: number;
  /** 去掉行尾空白的宽度（从文字框的左边算，含缩进）。 */
  readonly width: number;
  readonly text: string;
  readonly segments: readonly { readonly text: string; readonly link?: number }[];
}

export interface RichTextLayout {
  readonly glyphs: readonly RichGlyph[];
  readonly decorations: readonly RichDecoration[];
  readonly lines: readonly RichLine[];
  /** 链接点得到的地方：每个链接在每行上的矩形（虚拟像素，不含对齐的偏移）。 */
  readonly linkAreas: readonly { readonly link: number; readonly line: number; readonly x: number; readonly y: number; readonly width: number; readonly height: number }[];
  /** 最宽的一行、最后一行的底。 */
  readonly size: readonly [number, number];
}

/** 对齐时这一行往右挪多少（虚拟像素）；boxWidth 是文字框的宽。取整同 layout.ts。 */
export function lineOffset(line: RichLine, alignment: 'left' | 'center' | 'right', boxWidth: number): number {
  if (alignment === 'left') return 0;
  return alignment === 'center' ? (boxWidth - line.width) / 2 : boxWidth - line.width;
}

/** 排好一个字之前的样子。 */
interface Atom {
  readonly character: string;
  readonly glyph: FontGlyph | undefined;
  readonly font: SpriteFont;
  readonly fontPx: number;
  readonly unit: number;
  readonly style: RichStyle;
  readonly syntheticBold: boolean;
  readonly syntheticItalic: boolean;
  readonly advance: number;
  readonly ascent: number;
  readonly descent: number;
  /** 在它后面可以断行。 */
  readonly breakAfter: boolean;
  readonly space: boolean;
  /** 硬换行（不画、不占宽）。 */
  readonly newline: boolean;
}

export function layoutRichText(document: RichDocument, fonts: RichFonts, options: RichLayoutOptions): RichTextLayout {
  const glyphs: RichGlyph[] = [], decorations: RichDecoration[] = [], lines: RichLine[] = [];
  const linkAreas: Mutable<RichTextLayout['linkAreas'][number]>[] = [];
  const base = atomFor(' ', PLAIN_STYLE, fonts, options);
  const baseLine = base.ascent + base.descent;
  let y = 0, width = 0;
  let previous: RichBlock | undefined;
  for (const block of document.blocks) {
    if (previous && !(previous.kind === 'item' && block.kind === 'item')) y += baseLine * BLOCK_GAP_LINES;
    previous = block;
    const indent = block.kind === 'item' ? block.level * INDENT_EMS * options.fontSize : 0;
    const atoms = atomize(block, fonts, options);
    const wrapAt = options.wrapWidth === undefined ? Infinity : options.wrapWidth - indent;
    for (const [lineIndex, line] of breakLines(atoms, wrapAt).entries()) {
      const marker = lineIndex === 0 && block.marker ? [...block.marker].map((character) => atomFor(character, PLAIN_STYLE, fonts, options)) : [];
      const placed = placeLine(line, marker, indent, y, lines.length, options.fontSize, base);
      glyphs.push(...placed.glyphs);
      decorations.push(...placed.decorations);
      linkAreas.push(...placed.linkAreas);
      lines.push(placed.line);
      width = Math.max(width, placed.line.width);
      y += placed.line.height;
    }
  }
  return { glyphs, decorations, lines, linkAreas, size: [width, y] };
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

const PLAIN_STYLE: RichStyle = { bold: false, italic: false, code: false, underline: false, strikethrough: false, scale: 1 };

/** 一块的文字拆成一个个字，量好宽度和上下的高度。 */
function atomize(block: RichBlock, fonts: RichFonts, options: RichLayoutOptions): Atom[] {
  const atoms: Atom[] = [];
  for (const run of block.runs) {
    for (const character of run.text) {
      const atom = atomFor(character, run.style, fonts, options);
      const last = atoms.at(-1);
      // 同一个字体、字号接着排时加字距
      if (last?.glyph && atom.glyph && last.font === atom.font && last.fontPx === atom.fontPx) {
        const kern = kerning(atom.font, last.glyph, atom.glyph, [atom.fontPx, atom.fontPx]) * atom.unit;
        if (kern !== 0) atoms[atoms.length - 1] = { ...last, advance: last.advance + kern };
      }
      atoms.push(atom);
    }
  }
  // 中日韩的字前面也能断
  for (let i = 0; i + 1 < atoms.length; i++) {
    if (!atoms[i]!.breakAfter && isCjk(atoms[i + 1]!.character) && !atoms[i + 1]!.space) atoms[i] = { ...atoms[i]!, breakAfter: true };
  }
  return atoms;
}

function atomFor(character: string, style: RichStyle, fonts: RichFonts, options: RichLayoutOptions): Atom {
  const { font, syntheticBold, syntheticItalic } = fontFor(style, fonts);
  const size = (style.px ?? options.fontSize) * style.scale;
  const ratio = font.isStatic ? 1 : options.pixelRatio;
  const fontPx = size * ratio, unit = 1 / ratio;
  const newline = character === '\n';
  const glyph = newline || character === '\r' ? undefined : glyphOrDefault(font, character);
  const fontSize = [fontPx, fontPx] as const;
  const bold = syntheticBold && glyph ? 2 * SYNTHETIC_BOLD_EM * glyphScale(font, fontSize)[0] : 0;
  const advance = glyph ? (glyphAdvance(font, glyph, fontSize) + font.extraSpacing(fontPx) + bold) * unit : 0;
  const ascent = font.baseOffset(fontPx) * unit, line = font.totalLineSpacing(fontPx) * unit;
  const space = /\s/u.test(character);
  return { character, glyph, font, fontPx, unit, style, syntheticBold, syntheticItalic, advance, ascent, descent: line - ascent, breakAfter: space || isCjk(character), space, newline };
}

/** 这种样式用哪个字体、要不要合成粗体斜体。 */
function fontFor(style: RichStyle, fonts: RichFonts): { font: SpriteFont; syntheticBold: boolean; syntheticItalic: boolean } {
  if (style.code && fonts.code) return { font: fonts.code, syntheticBold: style.bold, syntheticItalic: style.italic };
  if (style.bold && style.italic) {
    if (fonts.boldItalic) return { font: fonts.boldItalic, syntheticBold: false, syntheticItalic: false };
    if (fonts.bold) return { font: fonts.bold, syntheticBold: false, syntheticItalic: true };
    if (fonts.italic) return { font: fonts.italic, syntheticBold: true, syntheticItalic: false };
  } else if (style.bold && fonts.bold) {
    return { font: fonts.bold, syntheticBold: false, syntheticItalic: false };
  } else if (style.italic && fonts.italic) {
    return { font: fonts.italic, syntheticBold: false, syntheticItalic: false };
  }
  return { font: fonts.regular, syntheticBold: style.bold, syntheticItalic: style.italic };
}

/** 中日韩的字（和全角符号）：之间可以断行。 */
function isCjk(character: string): boolean {
  const code = character.codePointAt(0)!;
  return (code >= 0x2e80 && code <= 0x9fff) || (code >= 0xac00 && code <= 0xd7af) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xff00 && code <= 0xffef) || (code >= 0x20000 && code <= 0x3134f);
}

/** 按宽度把字分成行：硬换行处断开；超宽时在最后一个断点断开，没有断点就按字断开。换行处的空白丢掉。 */
function breakLines(atoms: readonly Atom[], wrapAt: number): Atom[][] {
  const lines: Atom[][] = [];
  let line: Atom[] = [], x = 0, wrapped = false;
  for (const atom of atoms) {
    if (atom.newline) {
      lines.push(line);
      line = [];
      x = 0;
      wrapped = false;
      continue;
    }
    // 折过来的行首不要空白
    if (atom.space && wrapped && line.length === 0) continue;
    if (!atom.space && x + atom.advance > wrapAt && line.some((placed) => !placed.space)) {
      const at = line.findLastIndex((placed) => placed.breakAfter);
      const carry = at >= 0 ? line.splice(at + 1) : [];
      lines.push(line);
      line = carry;
      x = carry.reduce((sum, placed) => sum + placed.advance, 0);
      wrapped = true;
    }
    line.push(atom);
    x += atom.advance;
  }
  lines.push(line);
  return lines;
}

/** 摆好一行：基线对齐，记下字、装饰、链接的矩形和读屏用的文字。 */
function placeLine(atoms: readonly Atom[], marker: readonly Atom[], indent: number, top: number, lineIndex: number, fontSize: number, base: Atom) {
  // 空行（连着的硬换行）按控件的字号
  const metrics = marker.length + atoms.length > 0 ? [...marker, ...atoms] : [base];
  const ascent = Math.max(...metrics.map((atom) => atom.ascent)), descent = Math.max(...metrics.map((atom) => atom.descent));
  const baseline = top + ascent;
  const glyphs: RichGlyph[] = [], decorations: RichDecoration[] = [], linkAreas: Mutable<RichTextLayout['linkAreas'][number]>[] = [];
  // 记号挂在缩进的左边，和正文之间空 0.4 个字号
  let markerX = indent - 0.4 * fontSize - marker.reduce((sum, atom) => sum + atom.advance, 0);
  for (const atom of marker) {
    if (atom.glyph) glyphs.push(glyphOf(atom, markerX, baseline, lineIndex));
    markerX += atom.advance;
  }
  let x = indent, end = indent;
  const positions: number[] = [];
  for (const atom of atoms) {
    positions.push(x);
    // 空白不画
    if (atom.glyph && !atom.space) glyphs.push(glyphOf(atom, x, baseline, lineIndex));
    x += atom.advance;
    if (!atom.space) end = x;
  }
  // 连着的同一种装饰并成一个矩形（行尾的空白不算）
  const spans = (test: (atom: Atom) => boolean, emit: (from: number, to: number, run: readonly Atom[]) => void) => {
    let start = -1;
    for (let i = 0; i <= atoms.length; i++) {
      const on = i < atoms.length && test(atoms[i]!);
      if (on && start < 0) start = i;
      if (!on && start >= 0) {
        let last = i - 1;
        while (last > start && atoms[last]!.space) last--;
        emit(positions[start]!, positions[last]! + atoms[last]!.advance, atoms.slice(start, last + 1));
        start = -1;
      }
    }
  };
  const em = (run: readonly Atom[]) => Math.max(...run.map((atom) => atom.fontPx * atom.unit));
  spans((atom) => atom.style.code, (from, to, run) => {
    const up = Math.max(...run.map((atom) => atom.ascent)), down = Math.max(...run.map((atom) => atom.descent));
    decorations.push({ kind: 'code', line: lineIndex, x: from, y: baseline - up, width: to - from, height: up + down, style: run[0]!.style });
  });
  spans((atom) => atom.style.underline || atom.style.link !== undefined, (from, to, run) => {
    const size = em(run);
    decorations.push({ kind: 'underline', line: lineIndex, x: from, y: baseline + 0.1 * size, width: to - from, height: 0.06 * size, style: run[0]!.style });
  });
  spans((atom) => atom.style.strikethrough, (from, to, run) => {
    const size = em(run);
    decorations.push({ kind: 'strikethrough', line: lineIndex, x: from, y: baseline - 0.3 * size, width: to - from, height: 0.06 * size, style: run[0]!.style });
  });
  // 链接：每个链接在这一行上一个矩形，高是整行
  const height = ascent + descent;
  for (let i = 0; i < atoms.length;) {
    const link = atoms[i]!.style.link;
    let j = i + 1;
    while (j < atoms.length && atoms[j]!.style.link === link) j++;
    if (link !== undefined) linkAreas.push({ link, line: lineIndex, x: positions[i]!, y: top, width: positions[j - 1]! + atoms[j - 1]!.advance - positions[i]!, height });
    i = j;
  }
  // 读屏的文字：按链接分段，记号算在第一段
  const segments: { text: string; link?: number }[] = [];
  if (marker.length > 0) segments.push({ text: `${marker.map((atom) => atom.character).join('')} ` });
  for (const atom of atoms) {
    const link = atom.style.link;
    const last = segments.at(-1);
    if (last && last.link === link) last.text += atom.character;
    else segments.push(link === undefined ? { text: atom.character } : { text: atom.character, link });
  }
  const text = segments.map((segment) => segment.text).join('').trimEnd();
  return { glyphs, decorations, linkAreas, line: { y: top, height, width: end, text, segments } satisfies RichLine };
}

function glyphOf(atom: Atom, x: number, y: number, line: number): RichGlyph {
  return { glyph: atom.glyph!, font: atom.font, fontPx: atom.fontPx, unit: atom.unit, x, y, line, style: atom.style, syntheticBold: atom.syntheticBold, syntheticItalic: atom.syntheticItalic };
}
