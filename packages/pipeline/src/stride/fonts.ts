/**
 * Stride 的字体资源（.sdfnt）导入成运行时的字体（content/format.ts 的 FontFile 加按码位分块的 .glyphs）：
 * - 字体文件：FileFontProvider 是相对资源文件的路径；SystemFontProvider 照 Stride 在系统字体目录里按家族名和粗斜体找，
 *   找不到时依次试度量兼容的字体（Arial、Liberation Sans……，同 Stride 的 GetFontNameCandidates），用了替代的记警告。
 * - 字符：编译期字体（OfflineRasterized、SignedDistanceField）只要 CharacterRegions 和 CharacterSet 列出的字符，运行时
 *   字体（RuntimeRasterized）要字体里所有的字符（大的 CJK 字体分成很多块，运行时用到哪块下哪块）。
 * - 字形是轮廓：stride-tools 读出二次曲线（CFF 的三次曲线拆成二次），整理成 Slug 的点和带（../font.ts）。
 */
import { readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { StrideTools } from '@stride-ts/native/tools';
import { EXTENSIONS, encodeGlyphBlock, GLYPH_RECORD, GLYPH_WORDS, type FontFile } from '@stride-ts/engine/content-format';
import { slugGlyph } from '../font.ts';
import { once, type AssetEntry, type StrideProject } from './project.ts';
import { asNumber, asObject, type StrideObject } from './yaml.ts';

export interface FontImportContext {
  readonly project: StrideProject;
  readonly tools: StrideTools;
  readonly warnings: string[];
  write(contentPath: string, data: string | Uint8Array): Promise<void>;
  /** 找系统字体的目录；不给时按操作系统（同 Stride 的 SystemFontProvider）。 */
  readonly systemFontDirs?: readonly string[];
}

/** 系统字体目录里一个字体文件：家族名和粗斜体（只看集合里的第一个字体，同 Stride）。 */
interface InstalledFont {
  readonly file: string;
  readonly families: readonly string[];
  readonly bold: boolean;
  readonly italic: boolean;
}

const FONT_TYPES: Readonly<Record<string, FontFile['kind']>> = {
  OfflineRasterizedSpriteFontType: 'static',
  RuntimeRasterizedSpriteFontType: 'dynamic',
  SignedDistanceFieldSpriteFontType: 'sdf',
};
const ANTI_ALIAS: Readonly<Record<string, FontFile['antiAlias']>> = { Default: 'default', Aliased: 'aliased', ClearType: 'clearType' };

export class FontImporter {
  readonly #context: FontImportContext;
  readonly #fonts = new Map<string, Promise<string>>();
  #installed: Promise<InstalledFont[]> | undefined;

  constructor(context: FontImportContext) {
    this.#context = context;
  }

  /** 导入字体资源（.sdfnt），返回它的内容路径。 */
  font(asset: AssetEntry): Promise<string> {
    return once(this.#fonts, asset, () => this.#import(asset));
  }

  async #import(asset: AssetEntry): Promise<void> {
    const { tools } = this.#context;
    const fontType = asObject(asset.data['FontType']) ?? {};
    const kind = FONT_TYPES[fontType.$type ?? 'OfflineRasterizedSpriteFontType'];
    if (!kind) throw new Error(`${asset.file}: font type ${fontType.$type} is not supported`);
    const bytes = await this.#source(asset);
    const description = tools.describeFont(bytes);
    const em = description.unitsPerEm;
    const mapping = await tools.fontCodepoints(bytes);
    const glyphOf = new Map<number, number>();
    mapping.codepoints.forEach((codepoint, i) => glyphOf.set(codepoint, mapping.glyphs[i]!));

    const defaultCharacter = typeof asset.data['DefaultCharacter'] === 'string' ? asset.data['DefaultCharacter'].codePointAt(0)! : 32;
    const wanted = kind === 'dynamic' ? [...mapping.codepoints] : await this.#characters(asset, fontType, defaultCharacter);
    const codepoints = wanted.filter((codepoint) => glyphOf.has(codepoint)).sort((a, b) => a - b);
    // 控制字符（区段常写到 0x7F）字体里本来就没有，不算缺字
    const missing = wanted.filter((codepoint) => !glyphOf.has(codepoint) && !isControl(codepoint)).length;
    if (missing > 0 && kind !== 'dynamic') this.#context.warnings.push(`${asset.file}: ${missing} characters are not in the font; they use the default character`);

    const glyphs = [...new Set(codepoints.map((codepoint) => glyphOf.get(codepoint)!))];
    const outlines = new Map((await tools.glyphOutlines(bytes, glyphs, { tolerance: em / 4096 })).map((outline) => [outline.glyph, outline]));

    // 按码位块（码位 >> 8）分文件
    const blocks = new Map<number, number[]>();
    for (const codepoint of codepoints) {
      const block = codepoint >> 8;
      const list = blocks.get(block) ?? [];
      list.push(codepoint);
      blocks.set(block, list);
    }
    for (const [block, list] of blocks) {
      const records = new ArrayBuffer(list.length * GLYPH_WORDS * 4);
      const u32 = new Uint32Array(records);
      const f32 = new Float32Array(records);
      const points: number[] = [];
      const bands: number[] = [];
      list.forEach((codepoint, i) => {
        const outline = outlines.get(glyphOf.get(codepoint)!)!;
        const bounds = outline.bounds.map((v) => v / em) as [number, number, number, number];
        const slug = slugGlyph(outline.curves.map((v) => v / em), bounds);
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
      const data = encodeGlyphBlock({ glyphs: records, glyphCount: list.length, points: Float32Array.from(points), bands: Uint32Array.from(bands) });
      await this.#context.write(`${asset.path}.${block}${EXTENSIONS.glyphs}`, data);
    }

    const file: FontFile = {
      name: path.basename(asset.path),
      kind,
      size: asNumber(fontType['Size'], 20),
      antiAlias: ANTI_ALIAS[String(fontType['AntiAlias'] ?? 'Default')] ?? 'default',
      ascent: description.ascent / em,
      descent: -description.descent / em,
      lineGap: description.lineGap / em,
      spacing: asNumber(asset.data['Spacing'], 0),
      lineSpacing: asNumber(asset.data['LineSpacing'], 0),
      lineGapFactor: asNumber(asset.data['LineGapFactor'], 1),
      lineGapBaseLineFactor: asNumber(asset.data['LineGapBaseLineFactor'], 1),
      defaultCharacter,
      blocks: [...blocks.keys()].sort((a, b) => a - b),
      kerning: kerningPairs(mapping.kerning, codepoints, glyphOf, em),
    };
    await this.#context.write(asset.path + EXTENSIONS.font, JSON.stringify(file));
  }

  /** 编译期字体的字符：CharacterRegions（含两端）加 CharacterSet 文件里的字符，再加默认字符。 */
  async #characters(asset: AssetEntry, fontType: StrideObject, defaultCharacter: number): Promise<number[]> {
    const set = new Set<number>([defaultCharacter]);
    for (const region of Object.values(asObject(fontType['CharacterRegions']) ?? {})) {
      const r = asObject(region);
      const start = typeof r?.['Start'] === 'string' ? r['Start'].codePointAt(0) : undefined;
      const end = typeof r?.['End'] === 'string' ? r['End'].codePointAt(0) : undefined;
      if (start === undefined || end === undefined) continue;
      for (let c = start; c <= end; c++) set.add(c);
    }
    const characterSet = fontType['CharacterSet'];
    const file = typeof characterSet === 'string' ? characterSet : asObject(characterSet)?.['value'];
    if (typeof file === 'string' && file !== '') {
      const text = await readFile(path.resolve(path.dirname(asset.file), file), 'utf8');
      for (const character of text) set.add(character.codePointAt(0)!);
    }
    return [...set];
  }

  /** 字体文件的内容。 */
  async #source(asset: AssetEntry): Promise<Uint8Array> {
    const source = asObject(asset.data['FontSource']) ?? { $type: 'SystemFontProvider' };
    if (source.$type === 'FileFontProvider') {
      const value = source['Source'];
      const file = typeof value === 'string' ? value : asObject(value)?.['value'];
      if (typeof file !== 'string') throw new Error(`${asset.file}: FileFontProvider has no Source`);
      return readFile(path.resolve(path.dirname(asset.file), file));
    }
    if (source.$type !== 'SystemFontProvider') throw new Error(`${asset.file}: font source ${source.$type} is not supported`);
    const requested = typeof source['FontName'] === 'string' && source['FontName'].trim() !== '' ? source['FontName'] : defaultFontName();
    const style = String(source['Style'] ?? 'Regular');
    const bold = /Bold/.test(style), italic = /Italic/.test(style);
    const installed = await (this.#installed ??= this.#scanSystemFonts());
    for (const candidate of fontNameCandidates(requested)) {
      const found = findFont(installed, candidate, bold, italic);
      if (!found) continue;
      if (candidate.toLowerCase() !== requested.toLowerCase()) this.#context.warnings.push(`${asset.file}: cannot find font family '${requested}'; using metric-compatible fallback '${candidate}'`);
      return readFile(found);
    }
    throw new Error(`${asset.file}: cannot find system font '${requested}' (${style}) or a metric-compatible fallback`);
  }

  async #scanSystemFonts(): Promise<InstalledFont[]> {
    const fonts: InstalledFont[] = [];
    for (const dir of this.#context.systemFontDirs ?? systemFontDirs()) {
      const files = await readdir(dir, { recursive: true }).catch(() => [] as string[]);
      for (const name of files) {
        if (!/\.(ttf|otf|ttc)$/i.test(name)) continue;
        const file = path.join(dir, name);
        try {
          const d = this.#context.tools.describeFont(await readFile(file));
          const style = `${d.subfamily} ${d.typographicSubfamily}`;
          fonts.push({ file, families: [d.family, d.typographicFamily].filter((f) => f !== ''), bold: /Bold/i.test(style), italic: /Italic|Oblique/i.test(style) });
        } catch {
          // 读不了的文件（损坏、不是字体）跳过，同 Stride
        }
      }
    }
    return fonts;
  }
}

function isControl(codepoint: number): boolean {
  return codepoint < 0x20 || (codepoint >= 0x7f && codepoint < 0xa0);
}

/** 家族名完全相同的优先，其次是包含（"Liberation" 匹配 "Liberation Sans"），粗斜体要一致（同 Stride 的 ResolveFont）。 */
function findFont(fonts: readonly InstalledFont[], name: string, bold: boolean, italic: boolean): string | undefined {
  const lower = name.toLowerCase();
  const styled = fonts.filter((font) => font.bold === bold && font.italic === italic);
  return styled.find((font) => font.families.some((f) => f.toLowerCase() === lower))?.file
    ?? styled.find((font) => font.families.some((f) => f.toLowerCase().includes(lower)))?.file;
}

/** 要的字体和它度量兼容的替代（Stride 的 SystemFontProvider.GetFontNameCandidates）。 */
export function fontNameCandidates(requested: string): string[] {
  const key = requested.trim().toLowerCase();
  const group = ['times new roman', 'times', 'liberation serif', 'tinos', 'georgia', 'dejavu serif'].includes(key)
    ? ['Times New Roman', 'Liberation Serif', 'DejaVu Serif']
    : ['courier new', 'courier', 'liberation mono', 'cousine', 'consolas', 'dejavu sans mono'].includes(key)
      ? ['Courier New', 'Liberation Mono', 'DejaVu Sans Mono']
      : ['Arial', 'Liberation Sans', 'DejaVu Sans'];
  return [requested, ...group.filter((candidate) => candidate.toLowerCase() !== key)];
}

function defaultFontName(): string {
  return process.platform === 'linux' ? 'Liberation Sans' : 'Arial';
}

/** 系统字体目录（同 Stride 的 SystemFontProvider.GetFontPath）。 */
function systemFontDirs(): string[] {
  const home = os.homedir();
  if (process.platform === 'win32') return [path.join(process.env['WINDIR'] ?? 'C:\\Windows', 'Fonts')];
  if (process.platform === 'darwin') return [path.join(home, 'Library/Fonts'), '/Library/Fonts', '/System/Library/Fonts'];
  return ['/usr/share/fonts', '/usr/local/share/fonts', path.join(home, '.local/share/fonts')];
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
