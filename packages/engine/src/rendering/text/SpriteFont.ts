/**
 * 字体（Stride 的 SpriteFont）：度量和字形。字形是轮廓（Slug 的点和带，见 content/format.ts 的 GlyphBlock），按码位块
 * （码位 >> 8）分文件，用到哪块才下载哪块：glyph() 碰到没下载的块时开始下载、这一次返回 undefined，下载完以后就有了；
 * 一开始就要齐的文字先 await ensure(text)。
 *
 * 度量照 Stride：编译期字体（static）的行距 = (行间距 · LineGapFactor + 上升 + 下降) · size，基线 = (行间距 · LineGapFactor ·
 * LineGapBaseLineFactor + 上升) · size（FreeTypeFontImporter），都不随字号变（OfflineRasterizedSpriteFont 重写了 GetFontDefaultLineSpacing
 * 这些）；运行时字体（dynamic）的两个因子都按 1（FontManager.GetFontInfo），按 字号 / size 缩放。字距取 kern 表（kerning()）。
 */
import { GLYPH_RECORD, GLYPH_WORDS, type FontFile, type GlyphBlock } from '../../content/format';

/** 一个字形：em 单位，y 向上。points、bands 是它所在块的数组，pointStart、bandStart 是字形在里面的起点。 */
export interface FontGlyph {
  readonly codepoint: number;
  readonly advance: number;
  /** 轮廓的 x0 y0 x1 y1；没有轮廓（空格）时都是 0，hBands 是 0。 */
  readonly bounds: readonly [number, number, number, number];
  readonly hBands: number;
  readonly vBands: number;
  /** 竖带、横带的缩放和偏移：scaleX scaleY offsetX offsetY。 */
  readonly bandTransform: readonly [number, number, number, number];
  readonly pointStart: number;
  readonly bandStart: number;
  readonly block: LoadedGlyphBlock;
  /** 在块里的序号（GPU 的字形表里是块的起点加它）。 */
  readonly index: number;
}

/** 下载好的码位块（GPU 那边按它上传一次，见 GlyphStore）。 */
export interface LoadedGlyphBlock {
  readonly font: SpriteFont;
  readonly index: number;
  readonly data: GlyphBlock;
}

export class SpriteFont {
  readonly name: string;
  readonly kind: FontFile['kind'];
  /** 默认字号（像素）。 */
  readonly size: number;
  readonly antiAlias: FontFile['antiAlias'];
  readonly defaultCharacter: number;
  /** 栅格化时 ppem 取整（见 FontFile.integerPpem）。 */
  readonly integerPpem: boolean;
  /** 做不做字距（Stride 的 UseKerning）；默认做。和桌面 Stride 比对时关掉，看字距以外的差。 */
  useKerning = true;
  /** 下载完的块数：每多一块，能用的字形就变了（排版的缓存按它作废）。 */
  loadedBlocks = 0;
  readonly #file: FontFile;
  readonly #blocks = new Set<number>();
  readonly #loaded = new Map<number, Promise<void>>();
  readonly #glyphs = new Map<number, FontGlyph>();
  /** kern 表：左码位 · 0x110000 + 右码位 → 调整量（em）。 */
  readonly #kerning = new Map<number, number>();
  /** 下载并解开了的块。 */
  readonly #blockReady = new Set<number>();
  readonly #loadBlock: (block: number) => Promise<GlyphBlock>;

  /** loadBlock 取一个码位块（ContentManager 从 `<字体>.<块号>.glyphs` 读）。 */
  constructor(file: FontFile, loadBlock: (block: number) => Promise<GlyphBlock>) {
    this.#file = file;
    this.name = file.name;
    this.kind = file.kind;
    this.size = file.size;
    this.antiAlias = file.antiAlias;
    this.defaultCharacter = file.defaultCharacter;
    this.integerPpem = file.integerPpem;
    for (const block of file.blocks) this.#blocks.add(block);
    for (let i = 0; i + 2 < file.kerning.length; i += 3) this.#kerning.set(file.kerning[i]! * 0x110000 + file.kerning[i + 1]!, file.kerning[i + 2]!);
    this.#loadBlock = loadBlock;
  }

  /** 编译期字体只能按自己的字号画（Stride 的 OfflineRasterized：不跟着虚拟分辨率缩放，字形大小不随字号变）。 */
  get isStatic(): boolean {
    return this.kind === 'static';
  }

  /** 左右两个字之间的字距（em，负数是靠近）；kern 表里没有是 0。 */
  kerning(left: number, right: number): number {
    return this.#kerning.get(left * 0x110000 + right) ?? 0;
  }

  /** 字号 fontSize 时一行的高度，不含额外行距（Stride 的 GetFontDefaultLineSpacing）。 */
  defaultLineSpacing(fontSize: number): number {
    const { ascent, descent, lineGap, lineGapFactor } = this.#file;
    const gapFactor = this.isStatic ? lineGapFactor : 1;
    return (lineGap * gapFactor + ascent + descent) * this.#effective(fontSize);
  }

  /** 行顶到基线的距离（Stride 的 GetBaseOffsetY）。 */
  baseOffset(fontSize: number): number {
    const { ascent, lineGap, lineGapFactor, lineGapBaseLineFactor } = this.#file;
    const factor = this.isStatic ? lineGapFactor * lineGapBaseLineFactor : 1;
    return (lineGap * factor + ascent) * this.#effective(fontSize);
  }

  /** 字符之间额外的距离（Stride 的 GetExtraSpacing：运行时字体的 Spacing 按 字号 / size 缩放）。 */
  extraSpacing(fontSize: number): number {
    return (this.#effective(fontSize) / this.size) * this.#file.spacing;
  }

  /** 行之间额外的距离（Stride 的 GetExtraLineSpacing）。 */
  extraLineSpacing(fontSize: number): number {
    return (this.#effective(fontSize) / this.size) * this.#file.lineSpacing;
  }

  /** 度量用的字号：编译期字体总是自己的 size。 */
  #effective(fontSize: number): number {
    return this.isStatic ? this.size : fontSize;
  }

  /** 一行占的总高度（Stride 的 GetTotalLineSpacing）。 */
  totalLineSpacing(fontSize: number): number {
    return this.extraLineSpacing(fontSize) + this.defaultLineSpacing(fontSize);
  }

  /**
   * 码位的字形。字体里没有这个字时是 null；所在的块还没下载时是 undefined，并开始下载（下载完再调用就有了）。
   */
  glyph(codepoint: number): FontGlyph | null | undefined {
    const glyph = this.#glyphs.get(codepoint);
    if (glyph) return glyph;
    const block = codepoint >> 8;
    if (!this.#blocks.has(block)) return null;
    if (!this.#loaded.has(block)) {
      void this.#load(block).catch(() => undefined);
      return undefined;
    }
    // 块下载了还找不到：字体里没有
    return this.#blockReady.has(block) ? null : undefined;
  }

  /** 文字里的字（加上默认字符）所在的块都下载好。 */
  async ensure(text: string): Promise<void> {
    const blocks = new Set<number>([this.defaultCharacter >> 8]);
    for (const character of text) blocks.add(character.codePointAt(0)! >> 8);
    await Promise.all([...blocks].filter((block) => this.#blocks.has(block)).map((block) => this.#load(block)));
  }

  #load(block: number): Promise<void> {
    let pending = this.#loaded.get(block);
    if (!pending) {
      pending = this.#loadBlock(block).then((data) => {
        const loaded: LoadedGlyphBlock = { font: this, index: block, data };
        const u32 = new Uint32Array(data.glyphs);
        const f32 = new Float32Array(data.glyphs);
        for (let i = 0; i < data.glyphCount; i++) {
          const r = i * GLYPH_WORDS;
          const b = r + GLYPH_RECORD.bounds;
          const t = r + GLYPH_RECORD.bandTransform;
          const codepoint = u32[r + GLYPH_RECORD.codepoint]!;
          this.#glyphs.set(codepoint, {
            codepoint,
            advance: f32[r + GLYPH_RECORD.advance]!,
            bounds: [f32[b]!, f32[b + 1]!, f32[b + 2]!, f32[b + 3]!],
            hBands: u32[r + GLYPH_RECORD.hBands]!,
            vBands: u32[r + GLYPH_RECORD.vBands]!,
            bandTransform: [f32[t]!, f32[t + 1]!, f32[t + 2]!, f32[t + 3]!],
            pointStart: u32[r + GLYPH_RECORD.pointStart]!,
            bandStart: u32[r + GLYPH_RECORD.bandStart]!,
            block: loaded,
            index: i,
          });
        }
        this.#blockReady.add(block);
        this.loadedBlocks++;
      });
      // 失败的块下次再试
      pending.catch(() => this.#loaded.delete(block));
      this.#loaded.set(block, pending);
    }
    return pending;
  }
}
