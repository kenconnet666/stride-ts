import { describe, expect, test } from 'vitest';
import { autoRegions, gridRegions, type SpritePixels } from '../src/editor/spriteSlicing';

/** width × height 的透明图，rects 里的矩形（[x, y, 宽, 高]）涂成不透明。 */
function image(width: number, height: number, ...rects: readonly (readonly [number, number, number, number])[]): SpritePixels {
  const data = new Uint8Array(width * height * 4);
  for (const [x0, y0, w, h] of rects) for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) data[(y * width + x) * 4 + 3] = 255;
  return { width, height, data };
}

describe('精灵表的切图', () => {
  test('按格子数、按格子大小切，按行排；边上不满一格的不要；给了像素时跳过全透明的格子', () => {
    expect(gridRegions(64, 32, { columns: 2, rows: 1 })).toEqual([[0, 0, 32, 32], [32, 0, 32, 32]]);
    expect(gridRegions(70, 40, { cellWidth: 32, cellHeight: 32 })).toEqual([[0, 0, 32, 32], [32, 0, 32, 32]]);
    expect(gridRegions(36, 16, { cellWidth: 16, cellHeight: 16, offset: [2, 0], spacing: [2, 0] })).toEqual([[2, 0, 16, 16], [20, 0, 16, 16]]);
    expect(gridRegions(64, 32, { columns: 2, rows: 1 }, image(64, 32, [40, 4, 2, 2]))).toEqual([[32, 0, 32, 32]]);
    expect(() => gridRegions(8, 8, { columns: 20 })).toThrow(/at least 1 pixel/);
  });

  test('自动切：不透明的块的外接矩形，8 邻接相连的算一块，重叠的合并，太小的不要，按行从左到右排', () => {
    const pixels = image(40, 30,
      [20, 2, 6, 6], // 第一行右边
      [2, 3, 5, 5], // 第一行左边
      [2, 20, 3, 3], [5, 23, 3, 3], // 斜着挨着（8 邻接）：一块
      [20, 20, 8, 4], [24, 22, 2, 6], // 重叠的两笔：一块
      [35, 28, 1, 1], // 一个像素的噪点
    );
    expect(autoRegions(pixels)).toEqual([[2, 3, 5, 5], [20, 2, 6, 6], [2, 20, 6, 6], [20, 20, 8, 8]]);
    expect(autoRegions(pixels, { minSize: 1 })).toContainEqual([35, 28, 1, 1]);
  });
});
