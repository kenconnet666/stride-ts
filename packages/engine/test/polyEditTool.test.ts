import { describe, expect, test } from 'vitest';
import { Quaternion, Vector3 } from '../src/data/vectors';
import { polyCube } from '../src/modeling/polyEdit';
import { clickSelection, EMPTY_POLY_SELECTION, meshEdges, pickEdge, pickFace, pickVertex, selectionCenter, transformVertices, worldVertices } from '../src/editor/PolyEditTool';

// 视口里编辑多边形网格的纯函数部分：边表、点选点边面、选择的增减、操纵器的结果落到顶点上。

const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
/** 往 x 挪 10 的世界矩阵（列主序）。 */
const shifted = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 0, 0, 1]);

describe('点选', () => {
  const cube = polyCube('Cube');

  test('立方体有 12 条边，每条一次、小的顶点在前', () => {
    const edges = meshEdges(cube);
    expect(edges).toHaveLength(12);
    expect(edges.every(([a, b]) => a < b)).toBe(true);
  });

  test('点：半径以内最近的；看不见的不算', () => {
    const projected = [[10, 10], undefined, [14, 10], [50, 50]] as const;
    expect(pickVertex(projected, [13, 10])).toBe(2);
    expect(pickVertex(projected, [30, 30])).toBeUndefined();
  });

  test('边：到线段的距离', () => {
    const projected = [[0, 0], [100, 0], [100, 100]] as const;
    expect(pickEdge([[0, 1], [1, 2]], projected, [50, 5])).toEqual([0, 1]);
    expect(pickEdge([[0, 1], [1, 2]], projected, [96, 60])).toEqual([1, 2]);
    expect(pickEdge([[0, 1]], projected, [50, 30])).toBeUndefined();
  });

  test('面：射线最先碰到的（顶点按世界矩阵挪过）', () => {
    const world = worldVertices(cube, shifted);
    // 从上往下打在 x = 10 的立方体上：先碰到顶面
    const down = { origin: new Vector3(10.1, 5, 0.2), direction: new Vector3(0, -1, 0) };
    const top = pickFace(cube, world, down)!;
    expect(cube.faces[top]!.vertices.every((v) => cube.vertices[v]![1] === 0.5)).toBe(true);
    // 打在原点（没挪之前的位置）碰不到
    expect(pickFace(cube, world, { origin: new Vector3(0, 5, 0), direction: new Vector3(0, -1, 0) })).toBeUndefined();
  });
});

test('点一下的选择：只选它、加选、再点去掉、点空处清空（加选时不变）', () => {
  let selection = clickSelection(EMPTY_POLY_SELECTION, 'face', 2, false);
  expect(selection.faces).toEqual([2]);
  selection = clickSelection(selection, 'face', 4, true);
  expect(selection.faces).toEqual([2, 4]);
  selection = clickSelection(selection, 'face', 2, true);
  expect(selection.faces).toEqual([4]);
  expect(clickSelection(selection, 'face', undefined, true)).toBe(selection);
  expect(clickSelection(selection, 'face', undefined, false)).toEqual(EMPTY_POLY_SELECTION);
  // 边不分方向
  const edges = clickSelection(clickSelection(EMPTY_POLY_SELECTION, 'edge', [1, 3], false), 'edge', [3, 1], true);
  expect(edges.edges).toEqual([]);
});

describe('操纵器的结果落到顶点上', () => {
  const cube = polyCube('Cube');
  const top = [3, 2, 6, 7];

  test('移动：世界里的位移换回本地（实体挪过也一样）', () => {
    const moved = transformVertices(cube, top, { type: 'translate', delta: new Vector3(0, 1, 0) }, new Vector3(10, 0.5, 0), new Quaternion(), shifted);
    expect(moved.vertices[3]).toEqual([-0.5, 1.5, -0.5]);
    expect(moved.vertices[0]).toEqual(cube.vertices[0]);
  });

  test('缩放：相对枢轴', () => {
    const center = selectionCenter(worldVertices(cube, identity), top)!;
    expect(center).toEqual([0, 0.5, 0]);
    const scaled = transformVertices(cube, top, { type: 'scale', factor: new Vector3(2, 1, 2) }, new Vector3(...center), new Quaternion(), identity);
    expect(scaled.vertices[6]).toEqual([1, 0.5, 1]);
  });

  test('旋转：绕枢轴转', () => {
    const rotation = new Quaternion().setAxisAngle(new Vector3(0, 1, 0), Math.PI / 2);
    const turned = transformVertices(cube, top, { type: 'rotate', rotation }, new Vector3(0, 0.5, 0), new Quaternion(), identity);
    // (0.5, 0.5, 0.5) 绕 y 转 90 度到 (0.5, 0.5, -0.5)
    expect(turned.vertices[6]).toEqual([0.5, 0.5, -0.5]);
  });
});
