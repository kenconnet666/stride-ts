import { describe, expect, test } from 'vitest';
import { GLYPH_RECORD, GLYPH_WORDS, type FontFile, type GlyphBlock } from '../src/content/format';
import { parseColor, parseMarkdown, plainText, type RichDocument } from '../src/rendering/text/markdown';
import { layoutRichText, lineOffset, type RichFonts, type RichLayoutOptions, type RichTextLayout } from '../src/rendering/text/richLayout';
import { SpriteFont } from '../src/rendering/text/SpriteFont';
import { Button } from '../src/ui/controls/Button';
import { RichTextBlock } from '../src/ui/controls/RichTextBlock';
import { collectSemantics } from '../src/ui/semantics';
import { IDENTITY } from '../src/ui/UIElement';

/** 每块的文字段，样式只留写了的（true 的开关、颜色、字号、链接）。 */
function runs(document: RichDocument, block = 0) {
  return document.blocks[block]!.runs.map(({ text, style }) => {
    const flags = (['bold', 'italic', 'code', 'underline', 'strikethrough'] as const).filter((key) => style[key]);
    return [text, ...flags, ...(style.link !== undefined ? [`link${style.link}`] : []), ...(style.color ? [style.color.map((c) => +c.toFixed(2)).join(',')] : []),
      ...(style.scale !== 1 ? [`x${style.scale}`] : []), ...(style.px !== undefined ? [`${style.px}px`] : [])].join('|');
  });
}

describe('富文本的 Markdown 子集', () => {
  test('强调照 CommonMark 配对：粗、斜、粗斜嵌套、删除线；单词中间的下划线不算，配不上的符号原样留着', () => {
    expect(runs(parseMarkdown('普通 **粗** 和 *斜* 和 ***都有***'))).toEqual(['普通 ', '粗|bold', ' 和 ', '斜|italic', ' 和 ', '都有|bold|italic']);
    expect(runs(parseMarkdown('**粗里面 _斜_ 一段** ~~删掉~~'))).toEqual(['粗里面 |bold', '斜|bold|italic', ' 一段|bold', ' ', '删掉|strikethrough']);
    expect(runs(parseMarkdown('snake_case_name 和 2 * 3 * 4 和 **没关'))).toEqual(['snake_case_name 和 2 * 3 * 4 和 **没关']);
    // 三的倍数规则：*foo**bar* 是一段斜体，里面的 ** 留着
    expect(runs(parseMarkdown('*foo**bar*'))).toEqual(['foo**bar|italic']);
  });

  test('行内代码、转义；代码里的符号不解析', () => {
    expect(runs(parseMarkdown('按 `**Ctrl**` 加 \\*号\\*'))).toEqual(['按 ', '**Ctrl**|code', ' 加 *号*']);
    expect(runs(parseMarkdown('``有 ` 反引号``'))).toEqual(['有 ` 反引号|code']);
  });

  test('链接和方括号属性：颜色、字号（像素、百分比）、下划线；不认识的属性忽略，普通的方括号原样留着', () => {
    const document = parseMarkdown('看 [文档](https://example.com/a) 和 [警告]{color=#ff8000 size=150% .underline} [小字]{size=12 font=x} [不是链接]');
    expect(runs(document)).toEqual(['看 ', '文档|link0', ' 和 ', '警告|underline|1,0.5,0,1|x1.5', ' ', '小字|12px', ' [不是链接]']);
    expect(document.links).toEqual([{ href: 'https://example.com/a' }]);
    // 链接后面也可以跟属性，链接里面可以有强调
    expect(runs(parseMarkdown('[**开始**游戏](start){color=red}'))).toEqual(['开始|bold|link0|1,0,0,1', '游戏|link0|1,0,0,1']);
  });

  test('块：空行分段，段落里的单个换行是空格、行尾两个空格或反斜杠是硬换行；标题加粗放大；列表按缩进分层，有序列表保留编号', () => {
    const document = parseMarkdown('# 标题 #\n第一行\n第二行  \n第三行\\\n第四行\n\n- 一\n  - 一点一\n续行\n3) 三\n\n### 小标题');
    expect(document.blocks.map((block) => [block.kind, block.level, block.marker ?? ''])).toEqual([
      ['heading', 1, ''], ['paragraph', 0, ''], ['item', 1, '•'], ['item', 2, '•'], ['item', 1, '3.'], ['heading', 3, ''],
    ]);
    expect(runs(document, 0)).toEqual(['标题|bold|x2']);
    expect(runs(document, 1)).toEqual(['第一行 第二行\n第三行\n第四行']);
    expect(runs(document, 3)).toEqual(['一点一 续行']);
    expect(runs(document, 5)).toEqual(['小标题|bold|x1.25']);
    expect(plainText(document)).toBe('标题\n第一行 第二行\n第三行\n第四行\n• 一\n• 一点一 续行\n3. 三\n小标题');
  });

  test('颜色：#rgb、#rrggbb、#rrggbbaa、颜色名；认不出的是 undefined', () => {
    expect(parseColor('#f80')).toEqual([1, 0x88 / 255, 0, 1]);
    expect(parseColor('#00000080')).toEqual([0, 0, 0, 0x80 / 255]);
    expect(parseColor('Orange')).toEqual([1, 0xa5 / 255, 0, 1]);
    expect([parseColor('#12345'), parseColor('chartreuse')]).toEqual([undefined, undefined]);
  });

  test('解析一段 4 KB 的文字不到 1 毫秒量级（只在文字变了时解析）', () => {
    const source = Array.from({ length: 40 }, (_, i) => `- 第 ${i} 项：**粗体** *斜体* \`代码\` [链接](#${i}) [彩色]{color=#f80}`).join('\n');
    parseMarkdown(source);
    const start = performance.now();
    for (let i = 0; i < 20; i++) parseMarkdown(source);
    expect((performance.now() - start) / 20).toBeLessThan(5);
  });
});

// 合成的字体（同 text.test.ts 的做法）：小写字母、数字、点宽 0.5 em，空格 0.25 em，• 0.4 em，汉字 1 em；字号 20 时一行 24、基线在 20
const ADVANCES = new Map<number, number>([[32, 0.25], [0x2022, 0.4], [0x4e00, 1], ...[...'abcdefghijklmnopqrstuvwxyz0123456789.'].map((c) => [c.codePointAt(0)!, 0.5] as [number, number])]);

function glyphBlock(index: number): GlyphBlock {
  const codepoints = [...ADVANCES.keys()].filter((codepoint) => codepoint >> 8 === index);
  const glyphs = new ArrayBuffer(codepoints.length * GLYPH_WORDS * 4);
  const u32 = new Uint32Array(glyphs), f32 = new Float32Array(glyphs);
  codepoints.forEach((codepoint, i) => {
    u32[i * GLYPH_WORDS + GLYPH_RECORD.codepoint] = codepoint;
    f32[i * GLYPH_WORDS + GLYPH_RECORD.advance] = ADVANCES.get(codepoint)!;
  });
  return { glyphs, glyphCount: codepoints.length, points: new Float32Array(0), bands: new Uint32Array(0), pointStep: 1 / 8192 };
}

async function testFont(name = 'Test'): Promise<SpriteFont> {
  const file: FontFile = {
    name, kind: 'dynamic', size: 20, antiAlias: 'default', integerPpem: false, ascent: 0.9, descent: 0.2, lineGap: 0.1, spacing: 0, lineSpacing: 0,
    lineGapFactor: 1, lineGapBaseLineFactor: 1, defaultCharacter: 32, blocks: [0, 0x20, 0x4e], kerning: [],
  };
  const font = new SpriteFont(file, (index) => Promise.resolve(glyphBlock(index)));
  await font.ensure('a•一');
  return font;
}

describe('富文本的排版', () => {
  const layout = async (source: string, options: Partial<RichLayoutOptions> = {}, fonts: Partial<RichFonts> = {}) =>
    layoutRichText(parseMarkdown(source), { regular: await testFont(), ...fonts }, { fontSize: 20, pixelRatio: 1, ...options });
  const xs = (result: RichTextLayout) => result.glyphs.map((glyph) => +glyph.x.toFixed(3));

  test('不同字号基线对齐，行高取最高的字；块之间空半行，列表项之间不空', async () => {
    const mixed = await layout('a [b]{size=200%} c');
    expect(mixed.glyphs.map((glyph) => [glyph.fontPx, glyph.y])).toEqual([[20, 40], [40, 40], [20, 40]]);
    expect(mixed.size).toEqual([10 + 5 + 20 + 5 + 10, 48]);
    const blocks = await layout('a\n\nb\n\n- c\n- d');
    expect(blocks.lines.map((line) => line.y)).toEqual([0, 36, 72, 96]);
  });

  test('按宽度在空白处换行，折过来的行首不留空白；汉字之间也能断；没有断点时按字断开', async () => {
    const words = await layout('abcd efgh ij', { wrapWidth: 60 });
    expect(words.lines.map((line) => [line.text, line.width])).toEqual([['abcd', 40], ['efgh', 40], ['ij', 20]]);
    expect(words.glyphs.filter((glyph) => glyph.line === 1).map((glyph) => glyph.x)).toEqual([0, 10, 20, 30]);
    const cjk = await layout('一一一一一', { wrapWidth: 50 });
    expect(cjk.lines.map((line) => line.text)).toEqual(['一一', '一一', '一']);
    const long = await layout('abcdefgh', { wrapWidth: 35 });
    expect(long.lines.map((line) => line.text)).toEqual(['abc', 'def', 'gh']);
  });

  test('粗体、斜体没有同族字体时合成（粗体的前进宽度加 2/48 em），有时用它；像素比 2 时按两倍的字号量、宽度换回虚拟像素', async () => {
    const synthetic = await layout('**a**a *a*');
    expect(synthetic.glyphs.map((glyph) => [glyph.syntheticBold, glyph.syntheticItalic])).toEqual([[true, false], [false, false], [false, true]]);
    expect(xs(synthetic)).toEqual([0, +(10 + 20 / 24).toFixed(3), +(20 + 20 / 24 + 5).toFixed(3)]);
    const bold = await testFont('Bold');
    const real = await layout('**a**a', {}, { bold });
    expect(real.glyphs.map((glyph) => [glyph.font, glyph.syntheticBold])).toEqual([[bold, false], [real.glyphs[1]!.font, false]]);
    const sharp = await layout('aa', { pixelRatio: 2 });
    expect(sharp.glyphs.map((glyph) => [glyph.fontPx, glyph.unit, glyph.x])).toEqual([[40, 0.5, 0], [40, 0.5, 10]]);
  });

  test('列表项缩进 1.5 个字号，记号挂在左边；下划线、删除线、代码的底色和链接的点击区域', async () => {
    const list = await layout('- ab\n  - c');
    expect(list.glyphs.map((glyph) => [String.fromCodePoint(glyph.glyph.codepoint), glyph.x])).toEqual([['•', 30 - 8 - 8], ['a', 30], ['b', 40], ['•', 60 - 8 - 8], ['c', 60]]);
    expect(list.lines.map((line) => line.text)).toEqual(['• ab', '• c']);
    const decorated = await layout('a [bc](x) ~~d~~ `e`');
    expect(decorated.decorations.map(({ kind, x, width }) => [kind, x, width])).toEqual([['code', 55, 10], ['underline', 15, 20], ['strikethrough', 40, 10]]);
    expect(decorated.linkAreas).toEqual([{ link: 0, line: 0, x: 15, y: 0, width: 20, height: 24 }]);
    expect(decorated.lines[0]!.segments).toEqual([{ text: 'a ' }, { text: 'bc', link: 0 }, { text: ' d e' }]);
  });

  test('对齐按框宽挪整行', async () => {
    const [line] = (await layout('ab')).lines;
    expect([lineOffset(line!, 'left', 100), lineOffset(line!, 'center', 100), lineOffset(line!, 'right', 100)]).toEqual([0, 40, 80]);
  });
});

describe('富文本控件（RichTextBlock）', () => {
  /** 宽 200 的框里排好（左上角在原点），返回控件。 */
  async function richText(source: string, configure: (element: RichTextBlock) => void = () => {}): Promise<RichTextBlock> {
    const element = new RichTextBlock();
    element.font = await testFont();
    element.textSize = 20;
    element.text = source;
    configure(element);
    element.measure([200, 1000]);
    element.arrange([200, 1000], false);
    element.updateWorldMatrix(IDENTITY);
    return element;
  }

  test('大小按排版；按宽度换行；纯文字去掉标记；只有链接点得到，点链接发 LinkClicked（冒泡）', async () => {
    const element = await richText('**ab** [cd](go:next) ef');
    expect(element.desiredSize).toEqual([10 * 2 + 20 / 24 * 2 + 5 + 20 + 5 + 20, 24]);
    expect(element.textToDisplay).toBe('ab cd ef');
    expect(element.canBeHitByUser).toBe(true);
    // 框宽 200，左对齐：链接在 x 26.67 到 46.67
    const linkX = 20 + 20 / 12 + 5;
    expect([element.intersects([linkX + 5, 12]), element.intersects([5, 12]), element.intersects([linkX + 5, 30])]).toEqual([true, false, false]);
    expect(element.linkAt([linkX + 5, 12])).toBe(0);
    const clicked: string[] = [];
    element.onLinkClick((href) => clicked.push(href));
    element.activateLink(0);
    element.activateLink(5);
    expect(clicked).toEqual(['go:next']);
    const wrapped = await richText('abcd efgh ijkl mnop qrst uvwx', (e) => (e.wrapText = true));
    expect([wrapped.richLayout!.lines.length, wrapped.desiredSize[1]]).toEqual([2, 48]);
    const plain = await richText('没有链接的字');
    expect(plain.canBeHitByUser).toBe(false);
  });

  test('居中时链接的点击区域跟着挪；颜色：写了的、链接的、代码的、普通的', async () => {
    const element = await richText('[ab](x)', (e) => (e.textAlignment = 'center'));
    // 框宽 200，链接宽 20：在 90 到 110
    expect([element.linkAt([95, 12]), element.linkAt([5, 12])]).toEqual([0, -1]);
    const [link] = element.document.blocks[0]!.runs;
    expect(element.colorOf(link!.style)).toBe(element.linkColor);
    const styled = parseMarkdown('[a]{color=#ff0000} `b` c').blocks[0]!.runs;
    expect(styled.map((run) => element.colorOf(run.style))).toEqual([[1, 0, 0, 1], element.textColor, element.codeColor, element.textColor]);
  });

  test('语义树：一行一个 span 的内容按链接分段，读的是去掉标记的文字；在按钮里时按钮读去掉标记的文字', async () => {
    const element = await richText('看 [文档](x) 吧\n\n- 一项');
    const [node] = collectSemantics(element);
    expect(node!.label).toBe('看 文档 吧\n• 一项');
    expect(node!.text!.lines.map((line) => line.segments)).toEqual([[{ text: '看 ' }, { text: '文档', link: 0 }, { text: ' 吧' }], [{ text: '• 一项' }]]);
    expect(node!.text!.lines[1]!.y).toBe(24 + 12);
    const button = new Button();
    button.content = await richText('**开始**');
    expect(collectSemantics(button)[0]!.label).toBe('开始');
  });
});
