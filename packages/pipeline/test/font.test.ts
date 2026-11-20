import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { decodeGlyphBlock, GLYPH_RECORD, GLYPH_WORDS, type FontFile, type GameSettingsFile } from '@stride-ts/engine/content-format';
import { createStrideTools, type StrideTools } from '@stride-ts/native/tools';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { fontNameCandidates, slugGlyph, StrideImporter, StrideProject } from '../src/index';

const exists = (file: string) => access(file).then(() => true, () => false);
const ARIAL = 'C:/Windows/Fonts/arial.ttf';
// Stride 仓库里 SpriteFonts 样例带的 CFF 字体（有三次曲线）
const CFF_FONT = path.resolve(import.meta.dirname, '../../../../../IdeaProjects/stride/samples/Graphics/SpriteFonts/Resources/Fonts/SourceHanSans-Light.otf');

describe('slugGlyph', () => {
  // 边长 1 的正方形（逆时针）：四条直线，直线写成控制点等于终点的二次曲线
  const square = Float32Array.from([0, 0, 1, 0, 1, 0, 1, 0, 1, 1, 1, 1, 1, 1, 0, 1, 0, 1, 0, 1, 0, 0, 0, 0]);

  test('相连的曲线共用端点；水平线不进横带、竖直线不进竖带；带的头指向相对偏移', () => {
    const glyph = slugGlyph(square, [0, 0, 1, 1]);
    // 起点 + 每条曲线两个点
    expect(glyph.points.length / 2).toBe(1 + 4 * 2);
    expect(glyph.hBands).toBe(1);
    expect(glyph.vBands).toBe(1);
    const [hCount, hOffset, vCount, vOffset] = glyph.bands;
    // 横带只有两条竖边，竖带只有两条横边
    expect([hCount, vCount]).toEqual([2, 2]);
    const pointAt = (index: number) => [glyph.points[index * 2], glyph.points[index * 2 + 1]];
    const hCurves = [...glyph.bands.subarray(hOffset!, hOffset! + 2)];
    const vCurves = [...glyph.bands.subarray(vOffset!, vOffset! + 2)];
    // 横带按最大 x 从大到小：右边（x = 1）的竖边在前
    expect(hCurves.map((p) => pointAt(p)[0])).toEqual([1, 0]);
    // 竖带按最大 y 从大到小：上边（y = 1）在前
    expect(vCurves.map((p) => pointAt(p)[1])).toEqual([1, 0]);
    expect(glyph.bandScale).toEqual([1, 1]);
    expect(glyph.bandOffset.map((v) => v + 0)).toEqual([0, 0]);
  });

  test('曲线多时切成多条带，每条带的曲线都和它相交；没有曲线时是空的', () => {
    // 一排 32 个竖条（每个是 4 条直线的矩形）
    const curves: number[] = [];
    for (let i = 0; i < 32; i++) {
      const [x0, x1] = [i / 32, i / 32 + 0.01];
      curves.push(x0, 0, x1, 0, x1, 0, x1, 0, x1, 1, x1, 1, x1, 1, x0, 1, x0, 1, x0, 1, x0, 0, x0, 0);
    }
    const glyph = slugGlyph(Float32Array.from(curves), [0, 0, 1, 1]);
    expect(glyph.vBands).toBeGreaterThan(4);
    // 竖带切开后每条带里的曲线比全部（64 条横边）少得多
    const counts = Array.from({ length: glyph.vBands }, (_, b) => glyph.bands[(glyph.hBands + b) * 2]!);
    expect(Math.max(...counts)).toBeLessThan(64 / 2);
    expect(slugGlyph(new Float32Array(0), [0, 0, 0, 0])).toMatchObject({ hBands: 0, vBands: 0 });
  });
});

describe('字体导入', () => {
  let tools: StrideTools;
  let dir: string;
  beforeAll(async () => {
    tools = await createStrideTools({ workerThreads: 2 });
    dir = await mkdtemp(path.join(tmpdir(), 'stride-font-'));
  });
  afterAll(async () => {
    tools.shutdown();
    await rm(dir, { recursive: true, force: true });
  });

  test('度量兼容的替代字体同 Stride：Arial 找不到时试 Liberation Sans，Times 一组、Courier 一组', () => {
    expect(fontNameCandidates('Arial')).toEqual(['Arial', 'Liberation Sans', 'DejaVu Sans']);
    expect(fontNameCandidates('Times New Roman')).toEqual(['Times New Roman', 'Liberation Serif', 'DejaVu Serif']);
    expect(fontNameCandidates('Consolas')).toEqual(['Consolas', 'Courier New', 'Liberation Mono', 'DejaVu Sans Mono']);
  });

  test('编译期字体（系统字体 Arial）：只有区段里的字符，度量换成 em，kern 表按码位排序，码位块里的字形带着 Slug 数据', async (context) => {
    if (!(await exists(ARIAL))) return context.skip();
    await mkdir(path.join(dir, 'Assets'), { recursive: true });
    await writeFile(path.join(dir, 'Assets/Static.sdfnt'), `!SpriteFont
Id: 11111111-1111-1111-1111-111111111111
SerializedVersion: {Stride: 2.0.0.0}
Tags: []
FontSource: !SystemFontProvider
    FontName: Arial
    Style: Regular
FontType: !OfflineRasterizedSpriteFontType
    Size: 40.0
    CharacterSet: null
    CharacterRegions:
        a1:
            Start: 'A'
            End: 'Z'
    AntiAlias: Aliased
Spacing: 2.0
`);
    const project = await StrideProject.open([{ package: 'Game', dir: path.join(dir, 'Assets') }]);
    const out = path.join(dir, 'content');
    const importer = new StrideImporter(project, tools, out, { systemFontDirs: [path.dirname(ARIAL)] });
    expect(await importer.importAsset(project.byPath('Game/Static')!)).toBe('Game/Static');
    const font = JSON.parse(await readFile(path.join(out, 'Game/Static.font.json'), 'utf8')) as FontFile;
    expect(font).toMatchObject({ kind: 'static', size: 40, antiAlias: 'aliased', spacing: 2, defaultCharacter: 32, blocks: [0] });
    expect(font.ascent).toBeCloseTo(1854 / 2048, 5);
    expect(font.descent).toBeCloseTo(434 / 2048, 5);
    // 区段 A..Z 加默认字符（空格）
    const block = decodeGlyphBlock((await readFile(path.join(out, 'Game/Static.0.glyphs'))).buffer as ArrayBuffer);
    expect(block.glyphCount).toBe(27);
    const u32 = new Uint32Array(block.glyphs);
    const f32 = new Float32Array(block.glyphs);
    const record = (codepoint: number) => {
      for (let i = 0; i < block.glyphCount; i++) if (u32[i * GLYPH_WORDS + GLYPH_RECORD.codepoint] === codepoint) return i * GLYPH_WORDS;
      throw new Error(`no glyph for ${codepoint}`);
    };
    const a = record('A'.codePointAt(0)!);
    expect(f32[a + GLYPH_RECORD.advance]).toBeGreaterThan(0.5);
    expect(u32[a + GLYPH_RECORD.hBands]).toBeGreaterThan(0);
    expect(u32[record(32) + GLYPH_RECORD.hBands]).toBe(0);
    // kern 表只留这些字符（A..Z 和空格）之间的，按左、右码位排序（Arial 有 "AV" 这类字距）
    const included = (c: number) => c === 32 || (c >= 65 && c <= 90);
    expect(font.kerning.length % 3).toBe(0);
    const pairs = Array.from({ length: font.kerning.length / 3 }, (_, i) => font.kerning.slice(i * 3, i * 3 + 3));
    expect(pairs.some(([l, r]) => l === 65 && r === 86)).toBe(true);
    for (const [left, right] of pairs) expect(included(left!) && included(right!)).toBe(true);
    expect(pairs.map(([l, r]) => l! * 0x110000 + r!)).toEqual(pairs.map(([l, r]) => l! * 0x110000 + r!).sort((x, y) => x - y));
  });

  test('游戏设置：默认场景只记路径，合成器的游戏渲染器写出类型名和属性，属性引用的字体一起导入', async (context) => {
    if (!(await exists(ARIAL))) return context.skip();
    const assets = path.join(dir, 'GameAssets');
    await mkdir(assets, { recursive: true });
    // 只看引用怎么写，字体用只有一个字符的编译期字体：运行时字体要导入整套字形（Arial 要 5 秒多，机器忙时超过默认的超时）
    await writeFile(path.join(assets, 'Font.sdfnt'), `!SpriteFont
Id: 22222222-2222-2222-2222-222222222222
FontSource: !SystemFontProvider
    FontName: Arial
FontType: !OfflineRasterizedSpriteFontType
    Size: 22.0
    CharacterSet: null
    CharacterRegions:
        a1:
            Start: 'A'
            End: 'A'
`);
    await writeFile(path.join(assets, 'Compositor.sdgfxcomp'), `!GraphicsCompositorAsset
Id: 33333333-3333-3333-3333-333333333333
Game*: !Demo.TextRenderer,Demo.Game
    Id: 44444444-4444-4444-4444-444444444444
    Font: 22222222-2222-2222-2222-222222222222:Font
    Speed: 2.5
`);
    await writeFile(path.join(assets, 'GameSettings.sdgamesettings'), `!GameSettingsAsset
Id: 55555555-5555-5555-5555-555555555555
DefaultScene: null
GraphicsCompositor: 33333333-3333-3333-3333-333333333333:Compositor
Defaults:
    - !Stride.Graphics.RenderingSettings,Stride.Graphics
        DefaultBackBufferWidth: 640
        DefaultBackBufferHeight: 1136
        AdaptBackBufferToScreen: false
`);
    const project = await StrideProject.open([{ package: 'Demo', dir: assets }]);
    const out = path.join(dir, 'game-content');
    const importer = new StrideImporter(project, tools, out, { systemFontDirs: [path.dirname(ARIAL)] });
    expect(await importer.importAsset(project.byPath('Demo/GameSettings')!)).toBe('Demo/GameSettings');
    const settings = JSON.parse(await readFile(path.join(out, 'Demo/GameSettings.game.json'), 'utf8')) as GameSettingsFile;
    expect(settings).toEqual({
      name: 'GameSettings',
      defaultScene: null,
      renderer: { type: 'Demo.TextRenderer', props: { font: { $asset: 'Demo/Font', kind: 'font' }, speed: 2.5 } },
      defaultBackBufferSize: [640, 1136],
    });
    expect(await exists(path.join(out, 'Demo/Font.font.json'))).toBe(true);
  });

  test('CFF 字体（Source Han Sans）的三次曲线拆成首尾相连的二次曲线', async (context) => {
    if (!(await exists(CFF_FONT))) return context.skip();
    const bytes = await readFile(CFF_FONT);
    const { codepoints, glyphs } = await tools.fontCodepoints(bytes);
    const glyph = glyphs[codepoints.indexOf('あ'.codePointAt(0)!)]!;
    const [outline] = await tools.glyphOutlines(bytes, [glyph], { tolerance: 1000 / 4096 });
    const curves = outline!.curves;
    expect(curves.length / 6).toBeGreaterThan(10);
    // 同一条轮廓里相邻的曲线首尾相接；轮廓的起点 = 终点
    let contourStart = 0;
    for (let i = 6; i <= curves.length; i += 6) {
      const ends = i === curves.length || curves[i] !== curves[i - 2] || curves[i + 1] !== curves[i - 1];
      if (!ends) continue;
      expect([curves[i - 2], curves[i - 1]]).toEqual([curves[contourStart], curves[contourStart + 1]]);
      contourStart = i;
    }
  });
});
