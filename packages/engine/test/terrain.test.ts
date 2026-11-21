import { describe, expect, test } from 'vitest';
import { checkTerrainFile } from '../src/content/terrainFormat';
import { changedRegions } from '../src/terrain/TerrainSystem';
import { terrainPaths } from '../src/terrain/Terrain';
import type { SplineFile } from '../src/content/splineFormat';
import { heightfieldGrid, selectTiles, TILE_QUADS, tileId, tilePageHeader, tileRect, type TileKey } from '../src/terrain/terrainTiles';

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

  test('共用的高度场网格：格坐标、裙边的顶点 y 是 1；块的页头是取过模的 UV 原点、每格的 UV 步长和裙边深度', () => {
    const { vertices, indices } = heightfieldGrid();
    const side = TILE_QUADS + 1;
    expect(vertices.length / 8).toBe(side * side + 4 * side);
    expect(indices.length).toBe(TILE_QUADS * TILE_QUADS * 6 + 4 * TILE_QUADS * 12);
    expect([...vertices.subarray(3 * 8, 3 * 8 + 3)]).toEqual([3, 0, 0]);
    // 第一圈裙边在 z = 0 那条边下面
    expect([...vertices.subarray(side * side * 8, side * side * 8 + 3)]).toEqual([0, 1, 0]);
    expect(Math.max(...indices)).toBe(vertices.length / 8 - 1);
    // 块的原点 (1030, -6) 米，每 4 米一个周期、按 1024 米取模：UV 原点 (1.5, 254.5)；32 米的块每格 1 米 = 0.25 个周期
    expect(tilePageHeader(1030, -6, 32, 4, 1024)).toEqual([1.5, 254.5, 0.25, 4]);
  });
});

describe('地形的改动范围（雕刻时只重算盖到的块）', () => {
  const base = { name: 'Hills', noise: { octaves: 4 }, strokes: [{ op: 'raise' as const, x: 10, z: 20, radius: 5, strength: 2 }] };

  test('底、材质、UV 变了：整个重算', () => {
    expect(changedRegions(base, { ...base, noise: { octaves: 5 } })).toBeUndefined();
    expect(changedRegions(base, { ...base, material: 'Materials/Grass' })).toBeUndefined();
  });

  test('加一笔、去一笔：那一笔的范围；地物按包围盒加过渡；没改：空', () => {
    expect(changedRegions(base, base)).toEqual([]);
    const added = { ...base, strokes: [...base.strokes, { op: 'lower' as const, x: -100, z: 0, radius: 10, strength: 1 }] };
    expect(changedRegions(base, added)).toEqual([[-110, -10, -90, 10]]);
    expect(changedRegions(added, base)).toEqual([[-110, -10, -90, 10]]);
    const flat = { ...base, features: [{ type: 'flatten' as const, points: [[0, 0], [10, 0], [10, 10]] as [number, number][], height: 1, falloff: 2 }] };
    expect(changedRegions(base, flat)).toEqual([[-2, -2, 12, 12]]);
  });

  test('同样的笔画换了顺序：这些笔画的范围都算改了', () => {
    const two = { ...base, strokes: [...base.strokes, { op: 'lower' as const, x: 0, z: 0, radius: 1, strength: 1 }] };
    const swapped = { ...two, strokes: [two.strokes[1]!, two.strokes[0]!] };
    expect(changedRegions(two, swapped)).toEqual([[-1, -1, 1, 1], [5, 15, 15, 25]]);
  });
});

describe('地形文件', () => {
  test('结构不对时报出位置', () => {
    const ok = { name: 'Hills', noise: { octaves: 4 }, features: [{ type: 'flatten', points: [[0, 0], [1, 0], [0, 1]], height: 2 }] };
    expect(checkTerrainFile(ok, 'Hills')).toBe(ok);
    expect(() => checkTerrainFile({ name: 'Hills', noise: { octave: 4 } }, 'Hills')).toThrow('Hills: noise.octave is not a noise parameter');
    const gullies = { name: 'Hills', noise: { gullies: { strength: 30, scale: 500, valley: -100 } } };
    expect(checkTerrainFile(gullies, 'Hills')).toBe(gullies);
    expect(() => checkTerrainFile({ name: 'Hills', noise: { gullies: { depth: 3 } } }, 'Hills')).toThrow('noise.gullies.depth is not a gully parameter');
    expect(() => checkTerrainFile({ name: 'Hills', noise: { gullies: 5 } }, 'Hills')).toThrow('noise.gullies must be an object');
    expect(() => checkTerrainFile({ name: 'Hills', noise: {}, features: [{ type: 'flatten', points: [[0, 0]], height: 0 }] }, 'Hills')).toThrow('features[0].points must be at least 3');
    expect(() => checkTerrainFile({ name: 'Hills', noise: {}, strokes: [{ op: 'dig', x: 0, z: 0, radius: 1, strength: 1 }] }, 'Hills')).toThrow('strokes[0].op must be one of');
  });
});

describe('地形贴着样条（道路压平）', () => {
  const road: SplineFile = { name: 'Road', materials: [null], profile: { type: 'road', width: 6, shoulder: 0.5 }, points: [{ position: [0, 10, 0] }, { position: [40, 12, 0] }] };

  test('解析：按弧长取点、挪 position，宽度按横截面（路面加路肩），默认偏移、过渡、模式', () => {
    const path = terrainPaths({ spline: 'Roads/Road', position: [100, 0, 50] }, road)[0]!;
    expect(path.points[0]).toEqual([100, 10, 50]);
    expect(path.points.at(-1)).toEqual([140, 12, 50]);
    // 40.05 米（爬了 2 米）每 4 米一个点：11 段、12 个点
    expect(path.points.length).toBe(12);
    expect(path).toMatchObject({ width: 7, offset: -0.1, falloff: 10, strength: 1, mode: 'conform' });
    expect(terrainPaths({ spline: 'Roads/Road', width: 20, mode: 'carve' }, road)[0]).toMatchObject({ width: 20, mode: 'carve' });
  });

  test('样条改了（地形文件没改）：路径的包围盒加半宽和过渡', () => {
    const file = { name: 'Hills', noise: {}, splines: [{ spline: 'Roads/Road' }] };
    const before = terrainPaths({ spline: 'Roads/Road' }, road)[0]!;
    const after = terrainPaths({ spline: 'Roads/Road' }, { ...road, points: [{ position: [0, 10, 0] }, { position: [40, 20, 0] }] })[0]!;
    expect(changedRegions(file, file, [before], [before])).toEqual([]);
    expect(changedRegions(file, file, [before], [after])).toEqual([[-13.5, -13.5, 53.5, 13.5], [-13.5, -13.5, 53.5, 13.5]]);
    expect(() => checkTerrainFile({ ...file, splines: [{ spline: '' }] }, 'Hills')).toThrow('splines[0].spline must be a spline path');
  });
});
