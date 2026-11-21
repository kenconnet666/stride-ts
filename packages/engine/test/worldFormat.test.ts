import { describe, expect, test } from 'vitest';
import { cellAt, cellOrigin, checkWorldFile, distanceToCell, worldCellPath } from '../src/content/worldFormat';

const world = { name: 'Island', cellSize: 100, layers: [{ name: 'terrain', loadRadius: 800 }, { name: 'props', loadRadius: 200 }], cells: { props: [[0, 0], [-1, 2]] } };

describe('世界的格子', () => {
  test('格子的路径、原点，世界坐标落在哪个格子（负的往下取整）', () => {
    expect(worldCellPath('Worlds/Island', 'props', -1, 2)).toBe('Worlds/Island/props/-1_2');
    expect(cellOrigin(world, -1, 2)).toEqual([-100, 0, 200]);
    expect(cellAt(world, 99.9, 0)).toEqual([0, 0]);
    expect(cellAt(world, -0.1, 250)).toEqual([-1, 2]);
  });

  test('点到格子的距离：在格子里是 0，在角外是到角的距离', () => {
    expect(distanceToCell(world, 50, 50, 0, 0)).toBe(0);
    expect(distanceToCell(world, 150, 50, 0, 0)).toBe(50);
    expect(distanceToCell(world, 130, 140, 0, 0)).toBeCloseTo(50, 5);
    expect(distanceToCell(world, -30, -40, 0, 0)).toBeCloseTo(50, 5);
  });

  test('检查世界文件：图层名、加载半径、格子坐标', () => {
    expect(checkWorldFile({ ...world, cells: undefined }, 'w').cells).toEqual({});
    expect(() => checkWorldFile({ ...world, cellSize: 0 }, 'w')).toThrow(/cellSize/);
    expect(() => checkWorldFile({ ...world, layers: [] }, 'w')).toThrow(/at least one layer/);
    expect(() => checkWorldFile({ ...world, layers: [{ name: 'a b', loadRadius: 1 }] }, 'w')).toThrow(/letters, digits/);
    expect(() => checkWorldFile({ ...world, layers: [{ name: 'a', loadRadius: 1 }, { name: 'a', loadRadius: 2 }] }, 'w')).toThrow(/twice/);
    expect(() => checkWorldFile({ ...world, cells: { roads: [[0, 0]] } }, 'w')).toThrow(/unknown layer 'roads'/);
    expect(() => checkWorldFile({ ...world, cells: { props: [[0.5, 0]] } }, 'w')).toThrow(/integers/);
  });
});
