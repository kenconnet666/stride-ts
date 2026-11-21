import { describe, expect, test } from 'vitest';
import { checkTerrainFile } from '../src/content/terrainFormat';
import { buildTileMesh, selectTiles, TILE_QUADS, TILE_SAMPLES, tileId, tileRect, type TileKey } from '../src/terrain/terrainTiles';

const all = () => true;

describe('地形的分块', () => {
  test('块的范围：地形以实体为中心，每层边长减半', () => {
    expect(tileRect(1024, { level: 0, x: 0, z: 0 })).toEqual({ x0: -512, z0: -512, edge: 1024 });
    expect(tileRect(1024, { level: 2, x: 3, z: 1 })).toEqual({ x0: 256, z0: -256, edge: 256 });
  });

  test('近处细、远处粗，画的块不重叠、正好铺满', () => {
    const { draw, want } = selectTiles({ size: 1024, leafEdge: 32, lodFactor: 2, eye: [0, 10, 0], ground: 0, ready: all });
    expect(want).toEqual([]);
    expect(Math.max(...draw.map((key) => key.level))).toBe(5);
    expect(Math.min(...draw.map((key) => key.level))).toBeLessThan(5);
    // 面积加起来等于整块，任何两块不重叠
    expect(draw.reduce((sum, key) => sum + tileRect(1024, key).edge ** 2, 0)).toBe(1024 * 1024);
    const rects = draw.map((key) => tileRect(1024, key));
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i]!, b = rects[j]!;
        const overlap = a.x0 < b.x0 + b.edge && b.x0 < a.x0 + a.edge && a.z0 < b.z0 + b.edge && b.z0 < a.z0 + a.edge;
        expect(overlap).toBe(false);
      }
    }
    // 观察点所在的块是最细的
    const under = draw.find((key) => {
      const { x0, z0, edge } = tileRect(1024, key);
      return x0 <= 0 && 0 < x0 + edge && z0 <= 0 && 0 < z0 + edge;
    });
    expect(under?.level).toBe(5);
  });

  test('子块没全好之前画父块，要的块粗的、近的在前', () => {
    const ready = new Set(['0/0_0']);
    const { draw, want } = selectTiles({ size: 1024, leafEdge: 32, lodFactor: 2, eye: [100, 10, 100], ground: 0, ready: (key: TileKey) => ready.has(tileId(key)) });
    expect(draw.map(tileId)).toEqual(['0/0_0']);
    // 观察点在 1/1_1 里：它最近，另外三块一样远
    expect(want.map(tileId)[0]).toBe('1/1_1');
    expect(new Set(want.map(tileId))).toEqual(new Set(['1/0_0', '1/1_0', '1/0_1', '1/1_1']));
    // 根都没好时什么也不画，根排第一个要（要细分的子块一起要，并行算）
    const empty = selectTiles({ size: 1024, leafEdge: 32, lodFactor: 2, eye: [0, 0, 0], ground: 0, ready: () => false });
    expect(empty.draw).toEqual([]);
    expect(empty.want[0]).toEqual({ level: 0, x: 0, z: 0 });
  });

  test('块的网格：顶点相对块的原点，法线朝上偏向下坡，裙边垂下去', () => {
    // 往 +x 每米升 1 米的斜坡（间距 1 米）
    const heights = Float32Array.from({ length: TILE_SAMPLES * TILE_SAMPLES }, (_, i) => (i % TILE_SAMPLES) - 1);
    const { vertices, indices } = buildTileMesh(heights, TILE_QUADS, [0, 0], 4, 2);
    const side = TILE_QUADS + 1;
    expect(vertices.length / 12).toBe(side * side + 4 * side);
    expect(indices.length).toBe(TILE_QUADS * TILE_QUADS * 6 + 4 * TILE_QUADS * 12);
    // 第 (3, 0) 个顶点：x = 3、高 3，法线 (-1, 1, 0) / √2，UV 每 4 米一个周期
    const v = vertices.subarray(3 * 12, 4 * 12);
    expect([...v.subarray(0, 3)]).toEqual([3, 3, 0]);
    expect(v[3]).toBeCloseTo(-Math.SQRT1_2);
    expect(v[4]).toBeCloseTo(Math.SQRT1_2);
    expect(v[6]).toBeCloseTo(0.75);
    // 第一圈裙边在 z = 0 那条边下面 2 米
    const skirt = vertices.subarray(side * side * 12, side * side * 12 + 3);
    expect([...skirt]).toEqual([0, -2, 0]);
    expect(Math.max(...indices)).toBe(vertices.length / 12 - 1);
  });
});

describe('地形文件', () => {
  test('结构不对时报出位置', () => {
    const ok = { name: 'Hills', noise: { octaves: 4 }, features: [{ type: 'flatten', points: [[0, 0], [1, 0], [0, 1]], height: 2 }] };
    expect(checkTerrainFile(ok, 'Hills')).toBe(ok);
    expect(() => checkTerrainFile({ name: 'Hills', noise: { octave: 4 } }, 'Hills')).toThrow('Hills: noise.octave is not a noise parameter');
    expect(() => checkTerrainFile({ name: 'Hills', noise: {}, features: [{ type: 'flatten', points: [[0, 0]], height: 0 }] }, 'Hills')).toThrow('features[0].points must be at least 3');
    expect(() => checkTerrainFile({ name: 'Hills', noise: {}, strokes: [{ op: 'dig', x: 0, z: 0, radius: 1, strength: 1 }] }, 'Hills')).toThrow('strokes[0].op must be one of');
  });
});
