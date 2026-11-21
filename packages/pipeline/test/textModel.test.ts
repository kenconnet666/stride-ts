import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { decodeGlyphBlock, decodeModel, type FontFile, type GlyphBlock, type TextModelFile } from '@stride-ts/engine/content-format';
import { textContours } from '@stride-ts/engine/modeling';
import { createStrideTools, type StrideTools } from '@stride-ts/native/tools';
import { bakeTextModel } from '../src/textModel.ts';

/** collect-dodge 里提交着的 OpenSans 字体资源。 */
const CONTENT = path.resolve(import.meta.dirname, '../../../apps/collect-dodge/public/content');
const read = async (file: string) => new Uint8Array(await readFile(path.join(CONTENT, file)));

describe('3D 文字', () => {
  let tools: StrideTools;
  let font: FontFile;
  const blocks = new Map<number, GlyphBlock>();
  beforeAll(async () => {
    tools = await createStrideTools({ workerThreads: 2 });
    font = JSON.parse(new TextDecoder().decode(await read('UI/OpenSans-Regular.font.json'))) as FontFile;
    const bytes = await read('UI/OpenSans-Regular.0.glyphs');
    blocks.set(0, decodeGlyphBlock(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer));
  });
  afterAll(() => tools.shutdown());

  test('轮廓：A、o 各一个外轮廓一个洞，I 只有外轮廓；整段以中心为原点，按 align 对齐', () => {
    const contours = textContours({ file: font, block: (block) => blocks.get(block) }, 'AoI', { size: 1 });
    const byGlyph = [0, 1, 2].map((glyph) => contours.filter((contour) => contour.glyph === glyph).map((contour) => contour.hole));
    expect(byGlyph).toEqual([[false, true], [false, true], [false]]);
    const xs = contours.flatMap((contour) => contour.points.map(([x]) => x)), ys = contours.flatMap((contour) => contour.points.map(([, y]) => y));
    expect(Math.abs(Math.min(...xs) + Math.max(...xs))).toBeLessThan(0.1);
    // 字高 1 米（上升加下降）：A、I 的顶到底是大写字高，OpenSans 是一行的 0.53 左右
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(0.53, 1);
    const left = textContours({ file: font, block: (block) => blocks.get(block) }, 'AoI\nA', { size: 1, align: 'left' });
    // 第二行的 A 和第一行的 A 左边对齐、低一行（1.2 倍字高）
    const minX = (glyph: number) => Math.min(...left.filter((contour) => contour.glyph === glyph).flatMap((contour) => contour.points.map(([x]) => x)));
    const minY = (glyph: number) => Math.min(...left.filter((contour) => contour.glyph === glyph).flatMap((contour) => contour.points.map(([, y]) => y)));
    expect(minX(3)).toBeCloseTo(minX(0), 5);
    expect(minY(0) - minY(3)).toBeCloseTo(1.2, 5);
  });

  test('烘焙：字面（朝 +Z）一个网格、侧面和背面一个；没有字体、空文字报错', async () => {
    const file: TextModelFile = { name: 'Open', text: 'OPEN', font: 'UI/OpenSans-Regular', size: 0.5, depth: 0.08, materials: ['Materials/Neon', 'Materials/Metal'] };
    const start = performance.now();
    const model = decodeModel((await bakeTextModel(tools, file, read)).buffer as ArrayBuffer);
    console.log(`baked OPEN in ${(performance.now() - start).toFixed(0)} ms`);
    expect(model.materials).toEqual(['Materials/Neon', 'Materials/Metal']);
    expect(model.meshes.map((mesh) => mesh.material)).toEqual([0, 1]);
    const [face, sides] = model.meshes;
    // O、P、E、N 的字面三角化以后几十个顶点，侧面（每段轮廓一个四边形）多得多
    expect(face!.vertexCount).toBeGreaterThan(30);
    expect(sides!.vertexCount).toBeGreaterThan(face!.vertexCount);
    await expect(bakeTextModel(tools, { ...file, font: '' }, read)).rejects.toThrow(/choose a font/);
    await expect(bakeTextModel(tools, { ...file, text: '   ' }, read)).rejects.toThrow(/no outlines/);
  }, 60_000);
});
