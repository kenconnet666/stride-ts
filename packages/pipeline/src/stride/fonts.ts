/**
 * Stride 的字体资源（.sdfnt）导入成运行时的字体（content/format.ts 的 FontFile 加按码位分块的 .glyphs）：
 * - 字体文件：FileFontProvider 是相对资源文件的路径；SystemFontProvider 照 Stride 在系统字体目录里按家族名和粗斜体找，
 *   找不到时依次试度量兼容的字体（Arial、Liberation Sans……，同 Stride 的 GetFontNameCandidates），用了替代的记警告。
 * - 字符：编译期字体（OfflineRasterized、SignedDistanceField）只要 CharacterRegions 和 CharacterSet 列出的字符，运行时
 *   字体（RuntimeRasterized）要字体里所有的字符（大的 CJK 字体分成很多块，运行时用到哪块下哪块）。
 * - 字形的编码和编辑器导入字体文件共用（../fontAsset.ts）。
 */
import { readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { StrideTools } from '@stride-ts/native/tools';
import type { FontFile } from '@stride-ts/engine/content-format';
import { encodeFont } from '../fontAsset.ts';
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
    const fontType = asObject(asset.data['FontType']) ?? {};
    const kind = FONT_TYPES[fontType.$type ?? 'OfflineRasterizedSpriteFontType'];
    if (!kind) throw new Error(`${asset.file}: font type ${fontType.$type} is not supported`);
    const bytes = await this.#source(asset);
    const defaultCharacter = typeof asset.data['DefaultCharacter'] === 'string' ? asset.data['DefaultCharacter'].codePointAt(0)! : 32;
    const characters = kind === 'dynamic' ? undefined : await this.#characters(asset, fontType, defaultCharacter);
    const { files, missing } = await encodeFont(this.#context.tools, bytes, asset.path, {
      name: path.basename(asset.path),
      kind,
      size: asNumber(fontType['Size'], 20),
      antiAlias: ANTI_ALIAS[String(fontType['AntiAlias'] ?? 'Default')] ?? 'default',
      spacing: asNumber(asset.data['Spacing'], 0),
      lineSpacing: asNumber(asset.data['LineSpacing'], 0),
      lineGapFactor: asNumber(asset.data['LineGapFactor'], 1),
      lineGapBaseLineFactor: asNumber(asset.data['LineGapBaseLineFactor'], 1),
      defaultCharacter,
    }, characters);
    if (missing > 0 && characters) this.#context.warnings.push(`${asset.file}: ${missing} characters are not in the font; they use the default character`);
    for (const file of files) await this.#context.write(file.path, file.content);
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
