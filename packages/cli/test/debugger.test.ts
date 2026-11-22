import { describe, expect, it } from 'vitest';
import { generatedPosition, originalPosition, parseLocation, parseSourceMap, pathMatch } from '../src/debugger.ts';

describe('stride debug：source map 和位置', () => {
  // 生成的第 0 行 ← 源码第 0 行；第 1 行空；第 2 行第 0 列 ← 源码第 2 行，第 4 列 ← 源码第 2 行第 4 列
  const map = parseSourceMap({ sources: ['TerrainSystem.ts'], sourceRoot: '/src/world', mappings: 'AAAA;;AAEA,IAAI' });

  it('解码 mappings（VLQ，各字段相对上一段）', () => {
    expect(map.sources).toEqual(['/src/world/TerrainSystem.ts']);
    expect(map.lines[1]).toEqual([]);
    expect(map.lines[2]).toEqual([{ column: 0, source: 0, line: 2, sourceColumn: 0 }, { column: 4, source: 0, line: 2, sourceColumn: 4 }]);
  });

  it('源码行 → 生成代码的位置（没有映射的行往下找），反过来按列找最近的段', () => {
    expect(generatedPosition(map, 0, 2)).toEqual({ line: 2, column: 0 });
    expect(generatedPosition(map, 0, 1)).toEqual({ line: 2, column: 0 });
    expect(originalPosition(map, 2, 7)).toEqual({ source: '/src/world/TerrainSystem.ts', line: 2, column: 4 });
    expect(originalPosition(map, 1, 0)).toBeUndefined();
  });

  it('断点的位置和脚本地址的匹配按路径段从后往前比', () => {
    expect(parseLocation('packages\\engine\\src\\world\\TerrainSystem.ts:120')).toEqual({ file: 'packages/engine/src/world/TerrainSystem.ts', line: 120 });
    expect(() => parseLocation('TerrainSystem.ts')).toThrow(/<file>:<line>/);
    const url = 'http://localhost:5232/@fs/C:/code/stride-ts/packages/engine/src/world/TerrainSystem.ts?t=1';
    expect(pathMatch(url, 'packages/engine/src/world/TerrainSystem.ts')).toBe(5);
    expect(pathMatch(url, 'world/TerrainSystem.ts')).toBe(2);
    expect(pathMatch(url, 'world/WorldStreaming.ts')).toBe(0);
  });
});
