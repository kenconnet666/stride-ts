import { describe, expect, test } from 'vitest';
import { checkBuilding, parseFacadePattern, type BuildingFile } from '../src/content/buildingFormat';
import { buildingMeshes, insetPolygon, layoutFloor } from '../src/modeling/building';

const modules = {
  Pillar: { kind: 'pillar', width: 0.5, depth: 0.2 },
  Window: { kind: 'window', width: 2, mullions: 1 },
  Shop: { kind: 'window', width: 3, sill: 0.2 },
  Glass: { kind: 'curtain', width: 1.5 },
} as const;

const house: BuildingFile = {
  name: 'House', materials: [null, null, null, null],
  masses: [
    { footprint: { rect: [12, 8] }, floors: 3, floorHeight: 3, facade: 'Main', roof: { kind: 'flat', parapet: 1 } },
    { inset: 2, floors: 2, floorHeight: 3, facade: 'Tower', roof: { kind: 'dome', height: 2 } },
  ],
  facades: {
    Main: { floors: [{ where: 'ground', pattern: 'Pillar Shop* Pillar' }, { pattern: 'Pillar [Window Window]* Pillar', ledge: { height: 0.2, depth: 0.1 } }] },
    Tower: { floors: [{ pattern: 'Glass*' }] },
  },
  modules,
};

/** 网格里所有顶点的位置。 */
function positions(vertices: Float32Array): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (let i = 0; i < vertices.length; i += 8) out.push([vertices[i]!, vertices[i + 1]!, vertices[i + 2]!]);
  return out;
}

describe('程序化建筑', () => {
  test('图案：构件名、带 * 的重复、方括号的组；语法不对时说清楚哪里', () => {
    expect(parseFacadePattern('Pillar [Window Door]* Pillar')).toEqual([
      { modules: ['Pillar'], repeat: false },
      { modules: ['Window', 'Door'], repeat: true },
      { modules: ['Pillar'], repeat: false },
    ]);
    expect(parseFacadePattern(' Window* ')).toEqual([{ modules: ['Window'], repeat: true }]);
    expect(() => parseFacadePattern('Window (Door)')).toThrow("unexpected '(Door)'");
    expect(() => parseFacadePattern('[]*')).toThrow('empty group');
  });

  test('一层铺满整条边：重复项取最接近的整数，按比例拉伸', () => {
    const tiles = layoutFloor(parseFacadePattern('Pillar Window* Pillar'), modules, 12);
    // 12 − 1 = 11 米给窗，5.5 个取 6 个
    expect(tiles.map((t) => t.module)).toEqual(['Pillar', ...Array<string>(6).fill('Window'), 'Pillar']);
    expect(tiles[0]!.u0).toBe(0);
    expect(tiles.at(-1)!.u1).toBeCloseTo(12);
    for (let i = 1; i < tiles.length; i++) expect(tiles[i]!.u0).toBeCloseTo(tiles[i - 1]!.u1);
    // 地方不够：重复项一个都不放，固定的压窄
    expect(layoutFloor(parseFacadePattern('Pillar Window* Pillar'), modules, 0.8).map((t) => t.module)).toEqual(['Pillar', 'Pillar']);
  });

  test('退台：每条边往里挪同样的距离', () => {
    const inset = insetPolygon([[-6, -4], [6, -4], [6, 4], [-6, 4]], 1);
    expect(inset.map(([x, z]) => [Math.round(x * 1e6) / 1e6, Math.round(z * 1e6) / 1e6])).toEqual([[-5, -3], [5, -3], [5, 3], [-5, 3]]);
    // 反着绕的多边形一样往里
    expect(insetPolygon([[-6, 4], [6, 4], [6, -4], [-6, -4]], 1)[0]).toEqual([-5, 3]);
  });

  test('生成：墙、玻璃、窗框、屋顶四个槽；高度是各段加起来、女儿墙、穹顶；玻璃凹在墙里面', () => {
    const meshes = buildingMeshes(house);
    expect(meshes.map((m) => m.material)).toEqual([0, 1, 2, 3]);
    const all = meshes.flatMap((m) => positions(m.vertices));
    const top = Math.max(...all.map((p) => p[1]));
    // 3 × 3 + 2 × 3 + 2（穹顶）
    expect(top).toBeCloseTo(17);
    expect(Math.min(...all.map((p) => p[1]))).toBeCloseTo(0);
    // 第一段的女儿墙顶在 10 米
    const wall = positions(meshes[0]!.vertices);
    expect(wall.some((p) => Math.abs(p[1] - 10) < 1e-6)).toBe(true);
    // 第一段的玻璃（9 米以下）都在底面里面（凹进去），朝外的法线
    const glass = meshes[1]!;
    for (let i = 0; i < glass.vertices.length; i += 8) {
      const [x, y, z] = [glass.vertices[i]!, glass.vertices[i + 1]!, glass.vertices[i + 2]!];
      const [nx, , nz] = [glass.vertices[i + 3]!, glass.vertices[i + 4]!, glass.vertices[i + 5]!];
      if (y > 9) continue;
      expect(Math.abs(x) <= 6 + 1e-6 && Math.abs(z) <= 4 + 1e-6).toBe(true);
      expect(nx * x + nz * z).toBeGreaterThan(0);
    }
    // 三角形的绕向和法线一致（逆时针朝着法线是正面）
    for (const mesh of meshes) {
      const v = mesh.vertices, idx = mesh.indices;
      for (let k = 0; k < idx.length; k += 3) {
        const [a, b, c] = [idx[k]! * 8, idx[k + 1]! * 8, idx[k + 2]! * 8];
        const e1 = [v[b]! - v[a]!, v[b + 1]! - v[a + 1]!, v[b + 2]! - v[a + 2]!], e2 = [v[c]! - v[a]!, v[c + 1]! - v[a + 1]!, v[c + 2]! - v[a + 2]!];
        const n = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!];
        expect(n[0]! * v[a + 3]! + n[1]! * v[a + 4]! + n[2]! * v[a + 5]!).toBeGreaterThanOrEqual(-1e-9);
      }
    }
  });

  test('同样的文件生成同样的网格；尖顶、圆的底面', () => {
    expect(buildingMeshes(house)[0]!.vertices).toEqual(buildingMeshes(house)[0]!.vertices);
    const tower: BuildingFile = { name: 'T', materials: [], masses: [{ footprint: { circle: 5, segments: 12 }, floors: 4, floorHeight: 3, roof: { kind: 'pyramid', height: 6 } }] };
    const all = buildingMeshes(tower).flatMap((m) => positions(m.vertices));
    expect(Math.max(...all.map((p) => p[1]))).toBeCloseTo(18);
    expect(Math.max(...all.map((p) => Math.hypot(p[0], p[2])))).toBeCloseTo(5);
  });

  test('检查：没有的构件、立面规则，第一段没有底面，屋顶不对', () => {
    expect(() => checkBuilding({ ...house, facades: { Main: { floors: [{ pattern: 'Pillar Door*' }] } } })).toThrow("uses the module 'Door'");
    expect(() => checkBuilding({ ...house, masses: [{ ...house.masses[0]!, facade: 'Missing' }] })).toThrow("'Missing' is not in facades");
    expect(() => checkBuilding({ ...house, masses: [house.masses[1]!] })).toThrow('masses[0].footprint is needed on the first mass');
    expect(() => checkBuilding({ ...house, masses: [{ ...house.masses[0]!, roof: { kind: 'pyramid', height: 0 } }] })).toThrow('roof.height must be positive');
    expect(() => checkBuilding({ ...house, modules: { ...modules, Window: { kind: 'window', width: 0.5 } } })).toThrow('leaves no room for the opening');
  });
});
