import { describe, expect, test } from 'vitest';
import { entityAssetReferences } from '../../src/content/references';
import { checkEntity } from '../../src/editor/fields';
import type { SceneEntityFile } from '../../src/content/formats/format';
import { Matrix } from '../../src/data/Matrix';
import { DECAL_FLOATS, decalBounds, packAtlas, packDecal, tileSize } from '../../src/rendering/mesh/Decals';
import { CLUSTER_GRID, clusterIndex, clusterParams } from '../../src/rendering/lighting/Clusters';
import { RenderView } from '../../src/rendering/RenderSystem';

describe('贴花', () => {
  test('图集按行装箱：高的先放，四周留边，装不下返回 undefined', () => {
    const placed = packAtlas([[100, 50], [200, 120], [100, 50]], 512, 8)!;
    // 最高的放在左上角（留边 8）
    expect(placed[1]).toEqual([8, 8, 200, 120]);
    expect(placed[0]).toEqual([224, 8, 100, 50]);
    expect(placed[2]).toEqual([340, 8, 100, 50]);
    // 一行放不下就换行
    const rows = packAtlas([[300, 100], [300, 100]], 512, 8)!;
    expect(rows[1]).toEqual([8, 124, 300, 100]);
    expect(packAtlas([[600, 10]], 512, 8)).toBeUndefined();
    expect(packAtlas(Array.from({ length: 20 }, () => [200, 200] as const), 512, 8)).toBeUndefined();
  });

  test('放进图集的大小：最长边缩到 512 以内，保持比例', () => {
    expect(tileSize(256, 128)).toEqual([256, 128]);
    expect(tileSize(2048, 1024)).toEqual([512, 256]);
  });

  test('打包：世界到盒子的矩阵把盒子映到 -1..1，轴是单位向量，没有贴图时位置是 0', () => {
    // 盒子 4x2x6，放在 (10, 0, -5)，绕 Y 转 90°
    const world = Matrix.compose(Matrix.identity(), [10, 0, -5], [0, Math.SQRT1_2, 0, Math.SQRT1_2], [1, 1, 1]);
    const out = new Float32Array(DECAL_FLOATS);
    packDecal({ world, size: [4, 2, 6], albedo: [0.25, 0.5, 0.125, 0.125], normal: undefined, color: [1, 0.5, 0], opacity: 0.8, albedoMix: 1, normalFade: 0.3, upperFade: 0.2, lowerFade: 0.1 }, out, 0);
    const toBox = out.subarray(0, 16);
    // 盒子的中心映到原点；本地的 +X 角（转 90° 后在世界的 -Z）映到 x = 1
    expect(Matrix.transformPoint(toBox, 10, 0, -5).map((v) => +v.toFixed(5) + 0)).toEqual([0, 0, 0]);
    expect(Matrix.transformPoint(toBox, 10, 0, -7).map((v) => +v.toFixed(5) + 0)).toEqual([1, 0, 0]);
    expect(Matrix.transformPoint(toBox, 10, 1, -5).map((v) => +v.toFixed(5) + 0)).toEqual([0, 1, 0]);
    expect(Array.from(out.subarray(16, 24))).toEqual([0.25, 0.5, 0.125, 0.125, 0, 0, 0, 0]);
    expect(Array.from(out.subarray(24, 28)).map((v) => +v.toFixed(5))).toEqual([1, 0.5, 0, 0.8]);
    // 轴：x 转到世界的 -Z，y 还是 +Y
    expect(Array.from(out.subarray(32, 35)).map((v) => +v.toFixed(5) + 0)).toEqual([0, 0, -1]);
    expect(Array.from(out.subarray(36, 39)).map((v) => +v.toFixed(5) + 0)).toEqual([0, 1, 0]);
  });

  test('场景文件里的贴花：颜色贴图按 sRGB、法线贴图默认按线性读；编辑器的字段描述照它检查', () => {
    const entity: SceneEntityFile = {
      id: 'd', name: 'Decal', parent: null, position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1],
      components: { decal: { size: [2, 1, 2], albedo: { texture: 'Textures/Mud' }, normal: { texture: 'Textures/MudNormal' }, opacity: 0.5 } },
    };
    const refs = entityAssetReferences([entity]);
    expect(refs.map((ref) => [ref.kind, ref.path, 'texture' in ref && 'srgb' in ref.texture ? ref.texture.srgb : undefined])).toEqual([
      ['image', 'Textures/Mud', undefined],
      ['image', 'Textures/MudNormal', false],
    ]);
    expect(checkEntity(entity)).toEqual([]);
    expect(checkEntity({ ...entity, components: { decal: { opacity: 2 } } }).length).toBeGreaterThan(0);
  });
});

describe('分簇', () => {
  const view = () => {
    const v = new RenderView();
    Matrix.lookAtRH(v.view, [0, 0, 0], [0, 0, -1], [0, 1, 0]);
    Matrix.perspectiveFovRH(v.projection, Math.PI / 3, 16 / 9, 0.1, 1000);
    v.nearClipPlane = 0.1;
    v.farClipPlane = 1000;
    v.width = 1600;
    v.height = 900;
    v.update();
    return v;
  };

  test('没分簇的视图参数全是 0；分了的：每格的像素比例、层的比例、视图的前方', () => {
    const v = view();
    expect(clusterParams(v)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    v.clusterSlot = 0;
    const [sx, sy, scale, on, fx, fy, fz, logNear] = clusterParams(v);
    expect([sx, sy, on]).toEqual([16 / 1600, 9 / 900, 1]);
    expect(scale).toBeCloseTo(CLUSTER_GRID[2] / Math.log(10000), 6);
    expect([fx, fy, fz].map((c) => +c.toFixed(6) + 0)).toEqual([0, 0, -1]);
    expect(logNear).toBeCloseTo(Math.log(0.1), 6);
  });

  test('像素和深度到簇：左上角最近的是 0，层按深度指数地分，右下角最远的是最后一个', () => {
    const v = view();
    v.clusterSlot = 0;
    expect(clusterIndex(v, 0, 0, 0.1)).toBe(0);
    expect(clusterIndex(v, 1599, 899, 1000)).toBe(CLUSTER_GRID[0] * CLUSTER_GRID[1] * CLUSTER_GRID[2] - 1);
    // 1 米：ln(1 / 0.1) / ln(10000) · 24 = 6 层
    expect(Math.floor(clusterIndex(v, 0, 0, 1.0001) / (CLUSTER_GRID[0] * CLUSTER_GRID[1]))).toBe(6);
    expect(clusterIndex(v, 150, 0, 0.1)).toBe(1);
  });

  test('贴花的包围球：球心是实体的位置，半径是带缩放的盒子的半个对角线', () => {
    const world = Matrix.compose(Matrix.identity(), [1, 2, 3], [0, 0, 0, 1], [2, 1, 1]);
    const [x, y, z, r] = decalBounds(world, [1, 2, 2]);
    expect([x, y, z]).toEqual([1, 2, 3]);
    // 半边长 (1, 1, 1)
    expect(r).toBeCloseTo(Math.sqrt(3), 6);
  });
});
