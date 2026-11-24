/**
 * 烘焙时读字体资源（3D 文字、包装的标签共用）：字体的 FontFile 加上要用到的字形块，从内容目录读，换成引擎排版用的 TextFont。
 */
import { decodeGlyphBlock, EXTENSIONS, parseJsonc, type FontFile, type GlyphBlock } from '@stride-ts/engine/content-format';
import type { TextFont } from '@stride-ts/engine/modeling';

/** 读字体 font（内容路径）和 text 里的字所在的字形块（加上默认字符的）；读不到时报错（where 是报错的前缀）。 */
export async function loadTextFont(font: string, text: string, readContent: (path: string) => Promise<Uint8Array>, where: string): Promise<TextFont> {
  let file: FontFile;
  try {
    file = parseJsonc(new TextDecoder().decode(await readContent(font + EXTENSIONS.font)), font + EXTENSIONS.font) as FontFile;
  } catch (error) {
    throw new Error(`${where}: cannot read the font ${font}: ${(error as Error).message}`, { cause: error });
  }
  // 用到的字形块先读进来（排版是同步的）
  const blocks = new Map<number, GlyphBlock>();
  const wanted = new Set([...text].map((character) => character.codePointAt(0)! >> 8));
  wanted.add(file.defaultCharacter >> 8);
  for (const block of wanted) {
    if (!file.blocks.includes(block)) continue;
    const bytes = await readContent(`${font}.${block}${EXTENSIONS.glyphs}`);
    blocks.set(block, decodeGlyphBlock(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, `${font}.${block}`));
  }
  return { file, block: (block) => blocks.get(block) };
}
