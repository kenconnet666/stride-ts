import { describe, expect, test } from 'vitest';
import { decodeGlyphBlock, encodeGlyphBlock, GLYPH_RECORD, GLYPH_WORDS, glyphPointStep, snapGlyphPoints, type FontFile, type GlyphBlock } from '../src/content/format';
import { glyphScale, layoutText, measureText, SpriteFont } from '../src/index';

// 一个合成的字体：A 宽 0.5 em、B 宽 0.6 em、空格 0.25 em，都在第 0 块；第 0x30 块有一个日文假名
const ADVANCES: Readonly<Record<number, number>> = { 32: 0.25, 65: 0.5, 66: 0.6, 0x3042: 1 };
const metrics = { ascent: 0.9, descent: 0.2, lineGap: 0.1 };

function block(codepoints: readonly number[]): GlyphBlock {
  const glyphs = new ArrayBuffer(codepoints.length * GLYPH_WORDS * 4);
  const u32 = new Uint32Array(glyphs);
  const f32 = new Float32Array(glyphs);
  codepoints.forEach((codepoint, i) => {
    u32[i * GLYPH_WORDS + GLYPH_RECORD.codepoint] = codepoint;
    f32[i * GLYPH_WORDS + GLYPH_RECORD.advance] = ADVANCES[codepoint]!;
  });
  return { glyphs, glyphCount: codepoints.length, points: new Float32Array(0), bands: new Uint32Array(0), pointStep: 1 / 8192 };
}

function font(kind: FontFile['kind'], extra: Partial<FontFile> = {}): { font: SpriteFont; loads: number[] } {
  const loads: number[] = [];
  const file: FontFile = {
    name: 'Test', kind, size: 20, antiAlias: 'default', integerPpem: false, ...metrics, spacing: 0, lineSpacing: 0, lineGapFactor: 1, lineGapBaseLineFactor: 1,
    defaultCharacter: 32, blocks: [0, 0x30], kerning: [65, 66, -0.1], ...extra,
  };
  return {
    font: new SpriteFont(file, (index) => {
      loads.push(index);
      return Promise.resolve(block(index === 0 ? [32, 65, 66] : [0x3042]));
    }),
    loads,
  };
}

describe('字形块的文件', () => {
  test('点是网格上的 16 位整数、存差分，带存成 16 位：网格上的点读回来一模一样，带一样', () => {
    // 两个字形：第一个 4 个点，第二个 3 个点；步长 1/8192（2048 个单位的字体网格的四分之一）
    const step = 1 / 8192;
    const glyphs = new ArrayBuffer(2 * GLYPH_WORDS * 4);
    const u32 = new Uint32Array(glyphs);
    u32[GLYPH_RECORD.pointStart] = 0;
    u32[GLYPH_WORDS + GLYPH_RECORD.pointStart] = 4;
    u32[GLYPH_WORDS + GLYPH_RECORD.bandStart] = 5;
    // 第二个字形里相邻两点的差超过 16 位（-3.9 到 3.9 是 63898 级）：差按 16 位回绕着存
    const points = snapGlyphPoints(Float32Array.from([0.1, -0.2, 0.7, -0.2, 0.7, 0.9, 0.33333, 0.5, -3.9, 3, 3.9, 3.5, 2.25, -3.9]), step);
    const bands = Uint32Array.from([1, 2, 0, 1, 65535, 3, 2, 1]);
    const bytes = encodeGlyphBlock({ glyphs, glyphCount: 2, points, bands, pointStep: step });
    const decoded = decodeGlyphBlock(bytes.buffer as ArrayBuffer);
    expect([decoded.glyphCount, decoded.pointStep]).toEqual([2, step]);
    expect([...decoded.bands]).toEqual([...bands]);
    expect([...decoded.points]).toEqual([...points]);
    // 数据区：记录 128 字节、点 7×4、带 8×2（32 位存法是 128 + 56 + 32）
    expect(bytes.byteLength % 4).toBe(0);
    expect(bytes.byteLength).toBeLessThan(128 + 28 + 16 + 100);
    // 放不下的不悄悄截断
    expect(() => encodeGlyphBlock({ glyphs, glyphCount: 2, points, bands: Uint32Array.from([70000]), pointStep: step })).toThrow(/16 bits/);
    expect(() => encodeGlyphBlock({ glyphs, glyphCount: 2, points: Float32Array.from([5, 0]), bands, pointStep: step })).toThrow(/16 bits/);
  });

  test('对齐到网格：不在网格上的点挪不到半步；步长从字体网格的四分之一起，坐标放不下就翻倍', () => {
    const step = glyphPointStep(1 / (4 * 2048), 1.5);
    expect(step).toBe(1 / 8192);
    // 坐标到 ±9 em 的字体：1/8192 的网格只放得下 ±4 em，翻两倍
    expect(glyphPointStep(1 / 8192, 9)).toBe(1 / 2048);
    const curve = Float32Array.from([0.123456, 0.5, 0.300001, 0.50001, 0.9, 0.2]);
    const snapped = snapGlyphPoints(curve, step);
    snapped.forEach((value, i) => expect(Math.abs(value - curve[i]!)).toBeLessThanOrEqual(step / 2 + 1e-9));
    // 差不到半步的两个 y 对齐以后相等（这条线成了水平的，分带时就按水平的处理）
    expect(snapped[1]).toBe(snapped[3]);
    // TrueType 的点（整数单位）和中点（半个单位）本来就在网格上
    const exact = Float32Array.from([100 / 2048, 1433 / 2048, 200.5 / 2048, -300 / 2048]);
    expect([...snapGlyphPoints(exact, step)]).toEqual([...exact]);
  });
});

describe('SpriteFont', () => {
  test('度量照 Stride：运行时字体的行距是上升 + 下降 + 行间距，基线是上升 + 行间距，按字号缩放；编译期字体乘 LineGapFactor 和 LineGapBaseLineFactor，不随字号变', () => {
    const dynamic = font('dynamic', { lineGapFactor: 3, lineGapBaseLineFactor: 0.5 }).font;
    expect(dynamic.defaultLineSpacing(10)).toBeCloseTo(12, 5);
    expect(dynamic.baseOffset(10)).toBeCloseTo(10, 5);
    const fixed = font('static', { lineGapFactor: 3, lineGapBaseLineFactor: 0.5, spacing: 2, lineSpacing: 4 }).font;
    // 编译期字体按自己的 size 20（OfflineRasterizedSpriteFont 重写了这些，给的字号不起作用）
    expect(fixed.defaultLineSpacing(10)).toBeCloseTo((0.3 + 1.1) * 20, 5);
    expect(fixed.baseOffset(10)).toBeCloseTo((0.1 * 3 * 0.5 + 0.9) * 20, 5);
    expect(fixed.extraSpacing(40)).toBe(2);
    expect(fixed.totalLineSpacing(40)).toBeCloseTo(4 + 1.4 * 20, 5);
    // 运行时字体的额外间距按 字号 / size 缩放
    expect(font('dynamic', { spacing: 2 }).font.extraSpacing(40)).toBe(4);
  });

  test('字形按块下载：没下载的块这一次是 undefined、开始下载；字体里没有的字是 null；ensure 下载文字用到的块', async () => {
    const { font: f, loads } = font('dynamic');
    expect(f.glyph(65)).toBeUndefined();
    expect(loads).toEqual([0]);
    await f.ensure('あ');
    expect(loads).toEqual([0, 0x30]);
    expect(f.glyph(65)?.advance).toBe(0.5);
    expect(f.glyph(67)).toBeNull();
    // 没有的块不下载
    expect(f.glyph(0x4e00)).toBeNull();
    expect(loads).toEqual([0, 0x30]);
  });
});

describe('文字排版', () => {
  test('运行时字体：前进宽度按字号取整，额外间距按字号缩放，\\n 换行、\\r 跳过，没有的字用默认字符（空格）', async () => {
    const { font: f } = font('dynamic', { spacing: 1, kerning: [] });
    await f.ensure('AB');
    // 字号 30：A = 15，B = 18，空格 7.5 进位成 8（同 FreeType 的像素取整），额外间距 1.5
    const glyphs = layoutText(f, 'AB\r\nAC', [30, 30]);
    expect(glyphs.map((g) => [String.fromCodePoint(g.glyph.codepoint), g.x, g.y, g.nextX])).toEqual([
      ['A', 0, 0, 16.5], ['B', 16.5, 0, 36], ['A', 0, 36, 16.5], [' ', 16.5, 36, 26],
    ]);
    // 宽是最远的 nextX，高是最后一行的行顶加行高
    expect(measureText(f, 'AB\nA', [30, 30])).toEqual([36, 72]);
  });

  test('字号超过 256 时按 256 取整再放大；编译期字体的宽度不随字号变', async () => {
    const dynamic = font('dynamic', { kerning: [] }).font;
    await dynamic.ensure('B');
    // round(0.6 · 256) · 512 / 256
    expect(layoutText(dynamic, 'B', [512, 512])[0]!.nextX).toBe(154 * 2);
    const fixed = font('static', { spacing: 2, kerning: [] }).font;
    await fixed.ensure('AB');
    // 宽度按 size 20：A = 10、B = 12，额外间距 2（SpriteBatch 给编译期字体的字号总是 size）
    expect(layoutText(fixed, 'AB', [20, 20]).map((g) => g.nextX)).toEqual([12, 26]);
  });

  test('字体要求整数 ppem 时（同 FreeType）：字号 33.33 按 33 排、按 33 画；46.67 按 47', async () => {
    const { font: f } = font('dynamic', { integerPpem: true, kerning: [] });
    await f.ensure('B');
    expect(glyphScale(f, [100 / 3, 100 / 3])).toEqual([33, 33]);
    expect(glyphScale(f, [140 / 3, 140 / 3])).toEqual([47, 47]);
    // B = 0.6 em：round(0.6 · 33) = 20
    expect(layoutText(f, 'B', [100 / 3, 100 / 3])[0]!.nextX).toBe(20);
    // 不要求时按原样
    expect(glyphScale(font('dynamic').font, [100 / 3, 100 / 3])[0]).toBeCloseTo(100 / 3, 6);
  });

  test('字距按 kern 表推后面所有的字（和 Stride 不同），换行后重新开始', async () => {
    const { font: f } = font('dynamic');
    await f.ensure('AB');
    // 字号 30：A = 15，AB 之间 -0.1 em = -3，B 从 12 开始
    const glyphs = layoutText(f, 'ABB\nB', [30, 30]);
    expect(glyphs.map((g) => [g.x, g.nextX])).toEqual([[0, 15], [12, 30], [30, 48], [0, 18]]);
    expect(f.kerning(65, 66)).toBeCloseTo(-0.1, 6);
    expect(measureText(f, 'AB', [30, 30])[0]).toBe(30);
  });

  test('居中、右对齐：每行的起点按整段的宽度算，取整', async () => {
    const { font: f } = font('dynamic', { kerning: [] });
    await f.ensure('AB');
    // 字号 10：A = 5，B = 6；整段宽 11
    const center = layoutText(f, 'AB\nA', [10, 10], 'center');
    expect(center.map((g) => g.x)).toEqual([0, 5, 3]);
    const right = layoutText(f, 'AB\nA', [10, 10], 'right');
    expect(right.map((g) => g.x)).toEqual([0, 5, 6]);
  });
});
