/**
 * 精灵表的切图（编辑器的精灵表面板、MCP 用）：从一张贴图上切出精灵的区域。纯函数，像素是 RGBA8（行优先，左上角起）。
 *
 * - gridRegions：按网格切（Unity 的 Grid By Cell Count / Cell Size）；给了像素时全透明的格子不要；
 * - autoRegions：自动找（Unity 的 Automatic、Stride 的"魔棒"）：不透明的像素按 8 邻接连成块，每块的外接矩形一个区域，
 *   太小的（噪点）不要，按从上到下、从左到右排。
 *
 * 区域是 [x, y, 宽, 高]（像素），同精灵表文件的 region。replaceSprites 把切出来的放进精灵表。
 */
import type { SpriteSheetFile, TextureRef } from '../content/format';

/** 一个区域：x、y（左上角）、宽、高，像素。 */
export type SpriteRegion = readonly [number, number, number, number];

/** 贴图的像素：RGBA8，行优先。 */
export interface SpritePixels {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array | Uint8ClampedArray;
}

/** 按网格切：columns × rows 个格子，或者每格 cellWidth × cellHeight（贴图边上不满一格的不要）；offset 是第一格的左上角，spacing 是格子之间的空隙。 */
export interface GridSlice {
  readonly columns?: number | undefined;
  readonly rows?: number | undefined;
  readonly cellWidth?: number | undefined;
  readonly cellHeight?: number | undefined;
  readonly offset?: readonly [number, number];
  readonly spacing?: readonly [number, number];
}

/**
 * 按网格切出区域，按行排（从上到下、每行从左到右）。给了 pixels 时跳过全透明（alpha 都不超过 alphaThreshold）的格子。
 * 格子数或格子大小不对（不是正数）时报错。
 */
export function gridRegions(width: number, height: number, grid: GridSlice, pixels?: SpritePixels, alphaThreshold = 0): SpriteRegion[] {
  const [offsetX, offsetY] = grid.offset ?? [0, 0];
  const [spaceX, spaceY] = grid.spacing ?? [0, 0];
  const usableWidth = width - offsetX, usableHeight = height - offsetY;
  const cellWidth = grid.cellWidth ?? Math.floor((usableWidth - spaceX * ((grid.columns ?? 1) - 1)) / (grid.columns ?? 1));
  const cellHeight = grid.cellHeight ?? Math.floor((usableHeight - spaceY * ((grid.rows ?? 1) - 1)) / (grid.rows ?? 1));
  if (!(cellWidth > 0) || !(cellHeight > 0)) throw new Error(`gridRegions: cells must be at least 1 pixel (got ${cellWidth}x${cellHeight})`);
  const columns = grid.columns ?? Math.floor((usableWidth + spaceX) / (cellWidth + spaceX));
  const rows = grid.rows ?? Math.floor((usableHeight + spaceY) / (cellHeight + spaceY));
  const regions: SpriteRegion[] = [];
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const region: SpriteRegion = [offsetX + column * (cellWidth + spaceX), offsetY + row * (cellHeight + spaceY), cellWidth, cellHeight];
      if (region[0] + cellWidth > width || region[1] + cellHeight > height) continue;
      if (pixels && !hasOpaque(pixels, region, alphaThreshold)) continue;
      regions.push(region);
    }
  }
  return regions;
}

/**
 * 自动切：alpha 超过 alphaThreshold 的像素按 8 邻接连成块，每块的外接矩形一个区域；宽或高小于 minSize 的块不要。相互重叠的
 * 外接矩形（一个字母的两笔、带阴影的图标）合成一个。按从上到下、再从左到右排（同一行的：上边相差不到半个高度的算一行）。
 */
export function autoRegions(pixels: SpritePixels, { alphaThreshold = 0, minSize = 2 }: { readonly alphaThreshold?: number; readonly minSize?: number } = {}): SpriteRegion[] {
  const { width, height, data } = pixels;
  const seen = new Uint8Array(width * height);
  const boxes: [number, number, number, number][] = [];
  const stack: number[] = [];
  for (let start = 0; start < width * height; start++) {
    if (seen[start] || data[start * 4 + 3]! <= alphaThreshold) continue;
    let minX = width, minY = height, maxX = -1, maxY = -1;
    seen[start] = 1;
    stack.push(start);
    while (stack.length > 0) {
      const index = stack.pop()!;
      const x = index % width, y = (index - x) / width;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const next = ny * width + nx;
          if (seen[next] || data[next * 4 + 3]! <= alphaThreshold) continue;
          seen[next] = 1;
          stack.push(next);
        }
      }
    }
    boxes.push([minX, minY, maxX + 1, maxY + 1]);
  }
  const merged = mergeOverlapping(boxes).filter(([x0, y0, x1, y1]) => x1 - x0 >= minSize && y1 - y0 >= minSize);
  merged.sort((a, b) => (Math.abs(a[1] - b[1]) < Math.min(a[3] - a[1], b[3] - b[1]) / 2 ? a[0] - b[0] : a[1] - b[1]));
  return merged.map(([x0, y0, x1, y1]) => [x0, y0, x1 - x0, y1 - y0]);
}

/** 外接矩形（[x0, y0, x1, y1)）里有重叠的合成一个，直到没有重叠。 */
function mergeOverlapping(boxes: [number, number, number, number][]): [number, number, number, number][] {
  const result = boxes.map((box) => [...box] as [number, number, number, number]);
  for (let changed = true; changed;) {
    changed = false;
    for (let i = 0; i < result.length; i++) {
      for (let j = i + 1; j < result.length; j++) {
        const a = result[i]!, b = result[j]!;
        if (a[0] >= b[2] || b[0] >= a[2] || a[1] >= b[3] || b[1] >= a[3]) continue;
        result[i] = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
        result.splice(j, 1);
        changed = true;
        j--;
      }
    }
  }
  return result;
}

/** 区域里有没有 alpha 超过 alphaThreshold 的像素。 */
function hasOpaque({ width, data }: SpritePixels, [x0, y0, w, h]: SpriteRegion, alphaThreshold: number): boolean {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) if (data[(y * width + x) * 4 + 3]! > alphaThreshold) return true;
  return false;
}

/** 切出来的精灵默认的每单位像素（同 Stride 新建精灵的默认）。 */
export const DEFAULT_PIXELS_PER_UNIT = 100;

/**
 * 切出来的区域替换精灵表里这张贴图（texture.texture）上原来的精灵，别的贴图的留着（排在前面）。新精灵名字是贴图名加序号，
 * 原点在区域中心，每单位像素照 pixelsPerUnit（没给时照这张贴图上原来的第一个精灵，再没有是 DEFAULT_PIXELS_PER_UNIT）。
 * 返回新的精灵表和第一个新精灵的下标。
 */
export function replaceSprites(sheet: SpriteSheetFile, texture: TextureRef, regions: readonly SpriteRegion[], pixelsPerUnit?: number): { sheet: SpriteSheetFile; first: number } {
  const others = sheet.sprites.filter((sprite) => sprite.texture.texture !== texture.texture);
  const unit = pixelsPerUnit ?? sheet.sprites.find((sprite) => sprite.texture.texture === texture.texture)?.pixelsPerUnit ?? DEFAULT_PIXELS_PER_UNIT;
  const base = texture.texture.slice(texture.texture.lastIndexOf('/') + 1);
  const sliced = regions.map((region, i) => ({ name: `${base}_${i}`, texture, region: [...region] as [number, number, number, number], pixelsPerUnit: unit, center: [0, 0] as [number, number], centerFromMiddle: true }));
  return { sheet: { ...sheet, sprites: [...others, ...sliced] }, first: others.length };
}
