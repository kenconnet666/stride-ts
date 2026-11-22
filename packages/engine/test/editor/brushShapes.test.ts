import { describe, expect, test } from 'vitest';
import type { BrushFile } from '../../src/content/formats/assetFormat';
import { addBoxOnFace, brushBox, clickBrush, deleteBrush, faceCenter, pickBrushFace, resizeBrushFace } from '../../src/editor/viewport/tools/brushShapes';

const room: BrushFile = {
  name: 'Room', materials: [null, null],
  brushes: [
    { kind: 'box', operation: 'add', position: [0, 1, 0], size: [4, 2, 6] },
    { kind: 'box', operation: 'subtract', position: [0, 1, 0], size: [3, 1.5, 5], material: 1 },
  ],
};

/** 绕 Y 转 90 度的四元数。 */
const turn: [number, number, number, number] = [0, Math.SQRT1_2, 0, Math.SQRT1_2];
const near = (v: readonly number[]) => v.map((x) => Math.round(x * 1e6) / 1e6 + 0);

describe('白盒编辑', () => {
  test('包围盒：方块是自己，挤出从底面往上、取底面点的外包，圆柱取大的半径', () => {
    expect(brushBox(room.brushes[0]!).half).toEqual([2, 1, 3]);
    const prism = brushBox({ kind: 'prism', operation: 'add', position: [1, 0, 0], points: [[0, 0], [2, 0], [2, 4], [0, 4]], height: 3 });
    expect(prism.center).toEqual([2, 1.5, 2]);
    expect(prism.half).toEqual([1, 1.5, 2]);
    expect(brushBox({ kind: 'cylinder', operation: 'add', position: [0, 0, 0], height: 2, radius: 1, topRadius: 1.5 }).half).toEqual([1.5, 1, 1.5]);
  });

  test('面的中心和法线跟着笔刷转', () => {
    const box = brushBox({ kind: 'box', operation: 'add', position: [0, 0, 0], size: [2, 2, 4], rotation: turn });
    // 本地 +X 转到世界 -Z
    const { center, normal } = faceCenter(box, 1);
    expect(near(normal)).toEqual([0, 0, -1]);
    expect(near(center)).toEqual([0, 0, -1]);
  });

  test('点选：射线打到最近的笔刷，报进入的那个面', () => {
    // 从 +X 往 -X 打：先进外面方块的 +X 面（x = 2）
    expect(pickBrushFace(room, [10, 1, 0], [-1, 0, 0])).toEqual({ index: 0, face: 1, distance: 8 });
    // 从上往下
    expect(pickBrushFace(room, [0, 10, 0], [0, -1, 0])!.face).toBe(3);
    expect(pickBrushFace(room, [10, 10, 0], [1, 0, 0])).toBeUndefined();
    // 转过的笔刷：本地的面编号
    const turned: BrushFile = { name: 'T', materials: [null], brushes: [{ kind: 'box', operation: 'add', position: [0, 0, 0], size: [2, 2, 4], rotation: turn }] };
    expect(pickBrushFace(turned, [0, 0, -10], [0, 0, 1])).toMatchObject({ index: 0, face: 1, distance: 9 });
  });

  test('同一处再点一下换成射线上后面的笔刷，转一圈回来', () => {
    const at = [10, 1, 0] as const, toward = [-1, 0, 0] as const;
    expect(clickBrush(room, at, toward, undefined)).toBe(0);
    expect(clickBrush(room, at, toward, 0)).toBe(1);
    expect(clickBrush(room, at, toward, 1)).toBe(0);
    expect(clickBrush(room, [10, 10, 0], toward, 1)).toBeUndefined();
  });

  test('在面外侧贴着加一个同样大小的方块，材质槽跟着，选中新的', () => {
    const { brush, index } = addBoxOnFace(room, 0, 1);
    expect(index).toBe(2);
    expect(brush.brushes[2]).toEqual({ kind: 'box', operation: 'add', position: [4, 1, 0], size: [4, 2, 6] });
    const top = addBoxOnFace(room, 1, 3).brush.brushes[2]!;
    expect(top).toMatchObject({ position: [0, 2.5, 0], material: 1, operation: 'add' });
    // 原来的不动
    expect(room.brushes.length).toBe(2);
  });

  test('拖手柄改尺寸：方块那一边变长，对面不动；不会翻过去', () => {
    const grown = resizeBrushFace(room, 0, 1, 1).brushes[0]!;
    expect(grown).toMatchObject({ size: [5, 2, 6], position: [0.5, 1, 0] });
    const box = brushBox(grown);
    expect(box.center[0] - box.half[0]).toBe(-2);
    const lower = resizeBrushFace(room, 0, 2, 0.5).brushes[0]!;
    expect(lower).toMatchObject({ size: [4, 2.5, 6], position: [0, 0.75, 0] });
    const flat = resizeBrushFace(room, 0, 1, -10).brushes[0]!;
    expect(flat).toMatchObject({ size: [0.01, 2, 6] });
  });

  test('改尺寸：球、圆柱、挤出', () => {
    const sphere: BrushFile = { name: 'S', materials: [null], brushes: [{ kind: 'sphere', operation: 'add', position: [0, 0, 0], radius: 1 }] };
    expect(resizeBrushFace(sphere, 0, 3, 1).brushes[0]).toMatchObject({ radius: 1.5, position: [0, 0.5, 0] });
    const cylinder: BrushFile = { name: 'C', materials: [null], brushes: [{ kind: 'cylinder', operation: 'add', position: [0, 1, 0], height: 2, radius: 1 }] };
    expect(resizeBrushFace(cylinder, 0, 3, 2).brushes[0]).toMatchObject({ height: 4, position: [0, 2, 0] });
    expect(resizeBrushFace(cylinder, 0, 0, 1).brushes[0]).toMatchObject({ radius: 1.5, position: [-0.5, 1, 0] });
    const prism: BrushFile = { name: 'P', materials: [null], brushes: [{ kind: 'prism', operation: 'add', position: [0, 0, 0], points: [[0, 0], [2, 0], [1, 2]], height: 1 }] };
    // 顶面往上只改高；底面往下 position 跟着下来
    expect(resizeBrushFace(prism, 0, 3, 1).brushes[0]).toMatchObject({ height: 2, position: [0, 0, 0] });
    expect(resizeBrushFace(prism, 0, 2, 1).brushes[0]).toMatchObject({ height: 2, position: [0, -1, 0] });
    // +X 面往外 2：x 按左边（0）缩放成两倍
    expect(resizeBrushFace(prism, 0, 1, 2).brushes[0]).toMatchObject({ points: [[0, 0], [4, 0], [2, 2]] });
  });

  test('删笔刷，至少留一个', () => {
    expect(deleteBrush(room, 0).brushes).toEqual([room.brushes[1]]);
    expect(() => deleteBrush(deleteBrush(room, 0), 0)).toThrow();
  });
});
