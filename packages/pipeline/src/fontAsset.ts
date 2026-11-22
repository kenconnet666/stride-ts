/**
 * 字体文件（TTF、OTF、TTC 的第一个字体）转成运行时的字体：`<路径>.font.json`（content/formats/assetFormat.ts 的 FontFile）加按码位分块
 * （码位 >> 8）的 `<路径>.<块>.glyphs`，运行时用到哪块下哪块。字形是轮廓：stride-tools 读出二次曲线（CFF 的三次曲线拆成二次），
 * 整理成 Slug 的点和带（font.ts）。Stride 工程导入器（stride/fonts.ts）和编辑器的导入（拖进资源浏览器，`POST /import`）共用。
 */
import { EXTENSIONS, encodeGlyphBlock, GLYPH_RECORD, GLYPH_WORDS, glyphPointStep, snapGlyphPoints, type FontFile } from '@stride-ts/engine/content-format';
import type { StrideTools } from '@stride-ts/native/tools';
import { slugGlyph } from './font.ts';

/** 字体文件里读不出来、由资源决定的设置。 */
export type FontSettings = Omit<FontFile, 'integerPpem' | 'ascent' | 'descent' | 'lineGap' | 'blocks' | 'kerning'>;

export interface EncodedFont {
  /** 要写的文件：内容路径加扩展名，和内容。 */
  readonly files: readonly { readonly path: string; readonly content: Uint8Array | string }[];
  /** 要的字符里字体没有的个数（控制字符不算）。 */
  readonly missing: number;
}

/**
 * 把字体编成内容路径 path 下的字体资源。characters 是要的字符（编译期字体）；不给时是字体里的全部字符（运行时字体，
 * 大的 CJK 字体分成很多块）。
 */
export async function encodeFont(tools: StrideTools, bytes: Uint8Array, path: string, settings: FontSettings, characters?: Iterable<number>): Promise<EncodedFont> {
  const description = tools.describeFont(bytes);
  const em = description.unitsPerEm;
  const mapping = await tools.fontCodepoints(bytes);
  const glyphOf = new Map<number, number>();
  mapping.codepoints.forEach((codepoint, i) => glyphOf.set(codepoint, mapping.glyphs[i]!));

  const wanted = characters ? [...new Set([...characters, settings.defaultCharacter])] : [...mapping.codepoints];
  const codepoints = wanted.filter((codepoint) => glyphOf.has(codepoint)).sort((a, b) => a - b);
  // 控制字符（区段常写到 0x7F）字体里本来就没有，不算缺字
  const missing = wanted.filter((codepoint) => !glyphOf.has(codepoint) && !isControl(codepoint)).length;
  const glyphs = [...new Set(codepoints.map((codepoint) => glyphOf.get(codepoint)!))];
  const outlines = new Map((await tools.glyphOutlines(bytes, glyphs, { tolerance: em / 4096 })).map((outline) => [outline.glyph, outline]));

  const blocks = new Map<number, number[]>();
  for (const codepoint of codepoints) {
    const block = codepoint >> 8;
    const list = blocks.get(block) ?? [];
    list.push(codepoint);
    blocks.set(block, list);
  }
  // 点存在字体网格的四分之一上（TrueType 的点和中点正好在上面）；有坐标大到 16 位放不下的字体就用粗一些的网格
  let largest = 0;
  for (const outline of outlines.values()) for (const v of outline.curves) largest = Math.max(largest, Math.abs(v / em));
  const pointStep = glyphPointStep(1 / (4 * em), largest);
  const files: { path: string; content: Uint8Array | string }[] = [];
  for (const [block, list] of blocks) {
    const records = new ArrayBuffer(list.length * GLYPH_WORDS * 4);
    const u32 = new Uint32Array(records);
    const f32 = new Float32Array(records);
    const points: number[] = [];
    const bands: number[] = [];
    list.forEach((codepoint, i) => {
      const outline = outlines.get(glyphOf.get(codepoint)!)!;
      const bounds = outline.bounds.map((v) => v / em) as [number, number, number, number];
      // 曲线先对齐到文件里的网格，再分带
      const slug = slugGlyph(snapGlyphPoints(outline.curves.map((v) => v / em), pointStep), bounds);
      const r = i * GLYPH_WORDS;
      u32[r + GLYPH_RECORD.codepoint] = codepoint;
      f32[r + GLYPH_RECORD.advance] = outline.advance / em;
      f32.set(bounds, r + GLYPH_RECORD.bounds);
      f32.set([...slug.bandScale, ...slug.bandOffset], r + GLYPH_RECORD.bandTransform);
      u32[r + GLYPH_RECORD.pointStart] = points.length / 2;
      u32[r + GLYPH_RECORD.bandStart] = bands.length;
      u32[r + GLYPH_RECORD.hBands] = slug.hBands;
      u32[r + GLYPH_RECORD.vBands] = slug.vBands;
      for (const v of slug.points) points.push(v);
      for (const v of slug.bands) bands.push(v);
    });
    const content = encodeGlyphBlock({ glyphs: records, glyphCount: list.length, points: Float32Array.from(points), bands: Uint32Array.from(bands), pointStep });
    files.push({ path: `${path}.${block}${EXTENSIONS.glyphs}`, content });
  }

  const file: FontFile = {
    ...settings,
    integerPpem: (description.headFlags & 8) !== 0,
    ascent: description.ascent / em,
    descent: -description.descent / em,
    lineGap: description.lineGap / em,
    blocks: [...blocks.keys()].sort((a, b) => a - b),
    kerning: kerningPairs(mapping.kerning, codepoints, glyphOf, em),
  };
  files.push({ path: path + EXTENSIONS.font, content: JSON.stringify(file) });
  return { files, missing };
}

const FONT_EXTENSIONS = ['.ttf', '.otf', '.ttc'];

/** 这个文件名是不是能导入的字体文件。 */
export function isFontFile(fileName: string): boolean {
  return FONT_EXTENSIONS.some((extension) => fileName.toLowerCase().endsWith(extension));
}

/**
 * 编辑器导入一个字体文件：运行时字体（字体里的全部字符，字号可变），默认字号 24，放在 `<文件夹>/<名字>`（名字不给时取文件名）。
 * 返回字体的内容路径和要写的文件。
 */
export async function importFontFile(tools: StrideTools, bytes: Uint8Array, { fileName, folder, name }: { readonly fileName: string; readonly folder: string; readonly name?: string }): Promise<{ readonly font: string; readonly files: EncodedFont['files'] }> {
  if (!isFontFile(fileName)) throw new Error(`${fileName}: not a font file (ttf, otf, ttc)`);
  const base = (name ?? fileName.slice(0, fileName.lastIndexOf('.'))).replace(/[^A-Za-z0-9_-]+/g, '') || 'Font';
  const font = folder ? `${folder}/${base}` : base;
  const settings: FontSettings = {
    name: base, kind: 'dynamic', size: 24, antiAlias: 'default', spacing: 0, lineSpacing: 0, lineGapFactor: 1, lineGapBaseLineFactor: 1, defaultCharacter: 32,
  };
  const { files } = await encodeFont(tools, bytes, font, settings);
  return { font, files };
}

function isControl(codepoint: number): boolean {
  return codepoint < 0x20 || (codepoint >= 0x7f && codepoint < 0xa0);
}

/** kern 表的字形对换成码位对（一个字形对应几个码位时每个都写），调整量换成 em，按左、右码位排序。 */
function kerningPairs(kerning: Int32Array, codepoints: readonly number[], glyphOf: ReadonlyMap<number, number>, em: number): number[] {
  const codepointsOf = new Map<number, number[]>();
  for (const codepoint of codepoints) {
    const glyph = glyphOf.get(codepoint)!;
    codepointsOf.set(glyph, [...(codepointsOf.get(glyph) ?? []), codepoint]);
  }
  const pairs: [number, number, number][] = [];
  for (let i = 0; i < kerning.length; i += 3) {
    for (const left of codepointsOf.get(kerning[i]!) ?? []) {
      for (const right of codepointsOf.get(kerning[i + 1]!) ?? []) pairs.push([left, right, kerning[i + 2]! / em]);
    }
  }
  return pairs.sort((a, b) => a[0] - b[0] || a[1] - b[1]).flat();
}
