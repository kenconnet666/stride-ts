/**
 * 文字排版，照 Stride 的 SpriteFont.GlyphEnumerator 和 MeasureString：一个个字往右排，`\n` 换行（行高是 totalLineSpacing），
 * `\r` 跳过；字体里没有的字用默认字符。左对齐以外的对齐先量整段文字，每行的起点 = (整段宽 - 行宽) / 2 或 整段宽 - 行宽，取整。
 * 坐标是字体像素（字号 fontSize 下的像素），y 向下，一行的 y 是行顶。
 *
 * 前进宽度照 FreeType 开着 hinting 的结果：按栅格化时的像素字号取整。运行时字体按要画的字号栅格化（最大 256，超出的部分按比例
 * 放大，同 RuntimeRasterizedSpriteFont.GetGlyph）；编译期字体只有自己的 size，给别的字号也按 size 排（见 SpriteBatch）。
 *
 * 和 Stride 不同：做字距（kern 表，同 FreeType 的 FT_KERNING_DEFAULT 取整到像素），而且字距推后面所有的字。Stride 的两种字体
 * 都没有填 KerningMap，字距实际上不生效；就算填了，GlyphEnumerator 也只挪这一个字、不挪后面的（下一个字的位置不含字距）。
 */
import type { FontGlyph, SpriteFont } from './SpriteFont';

export type TextAlignment = 'left' | 'center' | 'right';

/** 排好的一个字：x 是字的原点（笔的位置），y 是行顶，nextX 是下一个字的原点。 */
export interface PositionedGlyph {
  readonly glyph: FontGlyph;
  readonly x: number;
  readonly y: number;
  readonly nextX: number;
  /** 在文字里的位置（按码位数，不是 UTF-16 单元）。 */
  readonly index: number;
}

/** 字号：x 决定宽度和字间距，y 决定行距（Stride 允许两个不一样；画的时候字形也按两个方向分别缩放）。 */
export type FontSize = readonly [number, number];

const MAX_RASTER_SIZE = 256;

/** 字体像素下这个字的前进宽度。 */
export function glyphAdvance(font: SpriteFont, glyph: FontGlyph, fontSize: FontSize): number {
  return toPixels(font, glyph.advance, fontSize);
}

/** em 换成字体像素：按栅格化的字号取整，运行时字体超过 256 的部分按比例放大。 */
function toPixels(font: SpriteFont, em: number, fontSize: FontSize): number {
  if (font.isStatic) return Math.round(em * font.size);
  const raster = Math.min(fontSize[0], MAX_RASTER_SIZE);
  return Math.round(em * raster) * (fontSize[0] / raster);
}

/** 两个字之间的字距（字体像素）。 */
function kerning(font: SpriteFont, previous: FontGlyph | undefined, glyph: FontGlyph, fontSize: FontSize): number {
  return previous ? toPixels(font, font.kerning(previous.codepoint, glyph.codepoint), fontSize) : 0;
}

/** 排好的字（包括空格这样没有轮廓的，画的时候跳过）。 */
export function layoutText(font: SpriteFont, text: string, fontSize: FontSize, alignment: TextAlignment = 'left'): PositionedGlyph[] {
  const characters = [...text];
  const boxWidth = alignment === 'left' ? 0 : measureText(font, text, fontSize)[0];
  const lineStart = (start: number): number => {
    if (alignment === 'left') return 0;
    let end = start;
    while (end < characters.length && characters[end] !== '\n') end++;
    const width = lineWidth(font, characters, start, end, fontSize);
    return Math.round(alignment === 'center' ? (boxWidth - width) / 2 : boxWidth - width);
  };
  const result: PositionedGlyph[] = [];
  let x = lineStart(0);
  let y = 0;
  let previous: FontGlyph | undefined;
  characters.forEach((character, index) => {
    if (character === '\r') return;
    if (character === '\n') {
      x = lineStart(index + 1);
      y += font.totalLineSpacing(fontSize[1]);
      previous = undefined;
      return;
    }
    const glyph = glyphOrDefault(font, character);
    if (!glyph) return;
    x += kerning(font, previous, glyph, fontSize);
    const nextX = x + glyphAdvance(font, glyph, fontSize) + font.extraSpacing(fontSize[0]);
    result.push({ glyph, x, y, nextX, index });
    x = nextX;
    previous = glyph;
  });
  return result;
}

/** 文字占的大小（Stride 的 SpriteFont.MeasureString）：最远的 nextX，最后一行的行顶加行高。 */
export function measureText(font: SpriteFont, text: string, fontSize: FontSize): [number, number] {
  let width = 0, height = 0;
  for (const { y, nextX } of layoutText(font, text, fontSize)) {
    width = Math.max(width, nextX);
    height = Math.max(height, y + font.totalLineSpacing(fontSize[1]));
  }
  return [width, height];
}

function lineWidth(font: SpriteFont, characters: readonly string[], start: number, end: number, fontSize: FontSize): number {
  let x = 0;
  let previous: FontGlyph | undefined;
  for (let i = start; i < end; i++) {
    if (characters[i] === '\r') continue;
    const glyph = glyphOrDefault(font, characters[i]!);
    if (!glyph) continue;
    x += kerning(font, previous, glyph, fontSize) + glyphAdvance(font, glyph, fontSize) + font.extraSpacing(fontSize[0]);
    previous = glyph;
  }
  return x;
}

/** 字体里没有（或者所在的块还在下载）时用默认字符。 */
function glyphOrDefault(font: SpriteFont, character: string): FontGlyph | undefined {
  return font.glyph(character.codePointAt(0)!) ?? font.glyph(font.defaultCharacter) ?? undefined;
}
