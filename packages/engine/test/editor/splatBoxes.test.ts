import { describe, expect, test } from 'vitest';
import type { SplatEditFile } from '../../src/content/formats/splatEditFormat';
import { insideBox, splatEditMask } from '../../src/content/splatEdit';
import { addPart, addSplatBox, applyPartChange, applySplatBoxChange, deleteSplatBox, extendStroke, partBox, splatBoxes, splatExtent } from '../../src/editor/viewport/tools/splatBoxes';
import { Quaternion, Vector3 } from '../../src/data/vectors';

const file: SplatEditFile = { name: 'Edit', source: 'Scans/Room' };
const bounds = { min: [-2, 0, -3] as const, max: [2, 3, 1] as const };

/** 照着 GPU 上 masked 的写法用遮罩判断一个点（和 applySplatEdit 的裁剪、删掉、刷掉要一致）。 */
function maskedOnCpu(mask: Float32Array, p: readonly number[]): boolean {
  const [keep, remove, spheres] = [mask[0]!, mask[1]!, mask[2]!];
  const inside = (at: number) => [0, 1, 2].every((k) => Math.abs(mask[at + k * 4]! * p[0]! + mask[at + k * 4 + 1]! * p[1]! + mask[at + k * 4 + 2]! * p[2]! + mask[at + k * 4 + 3]!) <= 0.5 + 1e-6);
  let at = 4;
  if (keep > 0 && !Array.from({ length: keep }, (_, k) => inside(at + k * 12)).some(Boolean)) return true;
  at += keep * 12;
  if (Array.from({ length: remove }, (_, k) => inside(at + k * 12)).some(Boolean)) return true;
  at += remove * 12;
  return Array.from({ length: spheres }, (_, k) => Math.hypot(p[0]! - mask[at + k * 4]!, p[1]! - mask[at + k * 4 + 1]!, p[2]! - mask[at + k * 4 + 2]!) <= mask[at + k * 4 + 3]!).some(Boolean);
}

describe('扫描场景编辑的框和刷', () => {
  test('加框：裁剪框盖住扫描的主体、删掉的框放在看着的地方；删框；框排成一串（先裁剪框）', () => {
    const keep = addSplatBox(file, 'keep', bounds, [0, 0, 0], 1);
    expect(keep.file.keep).toEqual([{ center: [0, 1.5, -1], size: [4, 3, 4] }]);
    const both = addSplatBox(keep.file, 'remove', bounds, [0.5, 1, -2], 0.8);
    expect(both.selection).toEqual({ list: 'remove', index: 0 });
    expect(both.file.remove![0]).toEqual({ center: [0.5, 1, -2], size: [0.8, 0.8, 0.8] });
    expect(splatBoxes(both.file).map((entry) => entry.selection.list)).toEqual(['keep', 'remove']);
    expect(deleteSplatBox(both.file, { list: 'remove', index: 0 }).remove).toBeUndefined();
  });

  test('操纵器：移动按实体的统一缩放换进泼溅坐标，改大小按框的轴乘、最小 1 厘米', () => {
    const { file: boxed, selection } = addSplatBox(file, 'remove', bounds, [0, 1.5, -1], 1);
    const moved = applySplatBoxChange(boxed, selection, { type: 'translate', delta: new Vector3(2, 0, 0) } as never, [0, 0, 0, 1], 2);
    expect(moved.remove![0]!.center).toEqual([1, 1.5, -1]);
    const scaled = applySplatBoxChange(boxed, selection, { type: 'scale', factor: new Vector3(2, 0, 1) } as never, [0, 0, 0, 1], 1);
    expect(scaled.remove![0]!.size).toEqual([2, 0.01, 1]);
    const turn = new Quaternion(0, Math.SQRT1_2, 0, Math.SQRT1_2);
    const rotated = applySplatBoxChange(boxed, selection, { type: 'rotate', rotation: turn } as never, [0, 0, 0, 1], 1);
    expect(rotated.remove![0]!.rotation![1]).toBeCloseTo(Math.SQRT1_2, 5);
  });

  test('扫描的主体：远处几个飘着的点撑大的包围盒不算，按叶子节点的泼溅数取 1% 到 99%', () => {
    const leaf = (x: number, count: number) => ({ min: [x - 0.25, 0, -0.25] as const, max: [x + 0.25, 0.5, 0.25] as const, first: 0, count, firstChild: 0, childCount: 0, detail: 0 });
    const nodes = [{ min: [-30, 0, -1] as const, max: [30, 1, 1] as const, first: 0, count: 0, firstChild: 1, childCount: 22, detail: 1 }, ...Array.from({ length: 20 }, (_, i) => leaf(i * 0.5 - 5, 1000)), leaf(-29, 5), leaf(29, 5)];
    const { min, max } = splatExtent(nodes);
    expect(min[0]).toBeGreaterThan(-6);
    expect(max[0]).toBeLessThan(5.5);
  });

  test('合并的一段：框是它的主体按变换放过来的；移动挪位置，转、缩绕框的中心，位置跟着变；知道范围的才在框的一串里', () => {
    const { file: merged, selection } = addPart(file, 'Scans/Hall');
    expect(selection).toEqual({ list: 'merge', index: 0 });
    const extent = { min: [-1, 0, -1] as const, max: [1, 2, 1] as const };
    const placed = { ...merged, merge: [{ source: 'Scans/Hall', position: [3, 0, 0] as [number, number, number], scale: 2 }] };
    expect(partBox(placed.merge[0]!, extent)).toMatchObject({ center: [3, 2, 0], half: [2, 2, 2] });
    expect(splatBoxes(placed).map((entry) => entry.selection.list)).toEqual([]);
    expect(splatBoxes(placed, () => extent).map((entry) => entry.selection.list)).toEqual(['merge']);
    const moved = applyPartChange(placed, 0, { type: 'translate', delta: new Vector3(0, 1, 0) } as never, [0, 0, 0, 1], 1, [3, 2, 0]);
    expect(moved.merge![0]!.position).toEqual([3, 1, 0]);
    // 绕框的中心 (3, 2, 0) 放大一倍：原点从 (3, 0, 0) 挪到 (3, -2, 0)，框的中心不动
    const grown = applyPartChange(placed, 0, { type: 'scale', factor: new Vector3(2, 2, 2) } as never, [0, 0, 0, 1], 1, [3, 2, 0]);
    expect(grown.merge![0]).toMatchObject({ scale: 4, position: [3, -2, 0] });
    expect(partBox(grown.merge![0]!, extent).center.map((v) => Math.round(v * 1e4) / 1e4)).toEqual([3, 2, 0]);
    // 绕框的中心转半圈（Y 轴）：框的中心还在原地
    const turned = applyPartChange(placed, 0, { type: 'rotate', rotation: new Quaternion(0, 1, 0, 0) } as never, [0, 0, 0, 1], 1, [3, 2, 0]);
    expect(partBox(turned.merge![0]!, extent).center.map((v) => Math.round(v * 1e4) / 1e4)).toEqual([3, 2, 0]);
    expect(deleteSplatBox(placed, { list: 'merge', index: 0 }).merge).toBeUndefined();
  });

  test('刷：一笔按半径的一半的间距放球，挪得快时中间补上，挪得近时不加，跳得远时不补', () => {
    let step = extendStroke(file, undefined, [0, 0, 0], 0.2);
    expect(step.file.erase).toHaveLength(1);
    step = extendStroke(step.file, step.last, [0.05, 0, 0], 0.2);
    expect(step.file.erase).toHaveLength(1);
    step = extendStroke(step.file, step.last, [0.5, 0, 0], 0.2);
    expect(step.file.erase).toHaveLength(6);
    expect(step.last).toEqual([0.5, 0, 0]);
    expect(step.file.erase!.every((sphere) => sphere.radius === 0.2)).toBe(true);
    // 从近处跳到 2 米外的墙上：只加那一个
    const jumped = extendStroke(step.file, step.last, [0.5, 0, -2], 0.2);
    expect(jumped.file.erase).toHaveLength(7);
  });

  test('GPU 的遮罩和 CPU 的判断一致：裁剪框外、转了的删除框里、刷过的球里藏掉', () => {
    const turn: [number, number, number, number] = [0, Math.sin(Math.PI / 8), 0, Math.cos(Math.PI / 8)];
    const edit: SplatEditFile = {
      ...file,
      keep: [{ center: [0, 1, 0], size: [3, 2, 3] }],
      remove: [{ center: [0.5, 1, 0.5], size: [1.2, 0.4, 0.2], rotation: turn }],
      erase: [{ center: [-1, 1, -1], radius: 0.3 }],
    };
    const mask = splatEditMask(edit);
    expect(Array.from(mask.subarray(0, 3))).toEqual([1, 1, 1]);
    let seed = 3;
    const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let n = 0; n < 2000; n++) {
      const p = [random() * 4 - 2, random() * 2.4 - 0.2, random() * 4 - 2];
      const expected = !insideBox(edit.keep![0]!, p) || insideBox(edit.remove![0]!, p) || Math.hypot(p[0]! + 1, p[1]! - 1, p[2]! + 1) <= 0.3;
      expect(maskedOnCpu(mask, p)).toBe(expected);
    }
    expect(Array.from(splatEditMask(file))).toEqual([0, 0, 0, 0]);
  });
});
