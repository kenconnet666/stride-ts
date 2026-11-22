import { describe, expect, test } from 'vitest';
import type { DebrisFile } from '../../src/content/formats/debrisFormat';
import type { ProductFile } from '../../src/content/formats/productFormat';
import { debrisBoards, debrisModel, debrisSpawn } from '../../src/modeling/debris';

const products = new Map<string, ProductFile>([
  ['D/Pebble', { name: 'Pebble', shape: 'nut', size: [0.02, 0.015, 0.018], colors: { background: '#8a8780' } }],
  ['D/Leaf', { name: 'Leaf', shape: 'leaf', size: [0.05, 0.01, 0.08] }],
]);
const file: DebrisFile = { name: 'Edge', area: [4, 2], items: [{ product: 'D/Pebble', count: 300 }, { product: 'D/Leaf', count: 100 }], edges: { sides: ['back'], width: 0.4, share: 0.7 }, seed: 3 };

describe('地上的碎石杂物', () => {
  test('都在范围里、地面以上；靠边的大约占 share，越靠边越密；同一个种子一样', () => {
    const spawn = debrisSpawn(file, products);
    expect(spawn).toHaveLength(400);
    for (const { position: [x, y, z] } of spawn) {
      expect(Math.abs(x)).toBeLessThanOrEqual(2);
      expect(Math.abs(z)).toBeLessThanOrEqual(1);
      expect(y).toBeGreaterThan(0);
    }
    // 后边（z = −1）往里 0.4 米以内：靠边的七成加均匀撒的那份里落在这一条的（0.3 × 0.4 / 2）
    const near = spawn.filter((item) => item.position[2] < -1 + 0.42).length / spawn.length;
    expect(near).toBeGreaterThan(0.65);
    expect(near).toBeLessThan(0.85);
    const closest = spawn.filter((item) => item.position[2] < -1 + 0.12).length, nextBand = spawn.filter((item) => item.position[2] >= -1 + 0.12 && item.position[2] < -1 + 0.24).length;
    expect(closest).toBeGreaterThan(nextBand);
    expect(debrisSpawn(file, products)).toEqual(spawn);
    expect(debrisSpawn({ ...file, seed: 4 }, products)).not.toEqual(spawn);
  });

  test('没写靠边时均匀撒；物理的板是地面和四周的矮墙', () => {
    const { edges: _, ...even } = file;
    const spawn = debrisSpawn(even, products);
    const near = spawn.filter((item) => item.position[2] < -1 + 0.42).length / spawn.length;
    expect(near).toBeLessThan(0.35);
    const boards = debrisBoards(file);
    expect(boards).toHaveLength(5);
    expect(boards[0]!.center[1]).toBeLessThan(0);
  });

  test('合成时落到范围外、掉到地下的不要；参数不对时报错', () => {
    const settled = debrisSpawn(file, products).map((item, i) => ({ ...item, position: [item.position[0], i % 50 === 0 ? -1 : 0.003, i % 77 === 0 ? 5 : item.position[2]] as const }));
    const model = debrisModel(file, { products, font: () => undefined }, settled);
    const lost = settled.filter((_, i) => i % 50 === 0 || i % 77 === 0).length;
    expect(model.items).toBe(400 - lost);
    expect(model.indices.length).toBeGreaterThan(0);
    expect(() => debrisSpawn({ ...file, area: [0, 1] }, products)).toThrow(/area/);
    expect(() => debrisSpawn({ ...file, items: [{ product: 'D/Nope', count: 1 }] }, products)).toThrow(/unknown product/);
    expect(() => debrisSpawn({ ...file, edges: { sides: ['up' as 'back'] } }, products)).toThrow(/unknown edge/);
  });
});
