import { describe, expect, test } from 'vitest';
import { ContentManager } from '../../src/content/ContentManager';
import type { TableFile } from '../../src/content/formats/tableFormat';
import { assetReferences } from '../../src/content/references';
import { s } from '../../src/content/schema/schema';

const SHOPS: TableFile = {
  name: 'Shops',
  columns: [
    { type: 'string', name: 'title' },
    { type: 'number', name: 'opens', min: 0, max: 24, default: 8 },
    { type: 'enum', name: 'kind', values: ['food', 'tools'] },
    { type: 'asset', name: 'sign', asset: 'model', default: null },
  ],
  rows: [
    { id: 'bakery', title: 'Bakery', opens: 6, kind: 'food', sign: 'Signs/Bakery' },
    { id: 'hardware', title: 'Hardware', kind: 'tools' },
  ],
};

const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).buffer;

describe('数据表', () => {
  test('加载：按 id 取行，没写的列补 default；as 按代码里的行模式给出有类型的行', async () => {
    const content = new ContentManager({ root: 'https://game.test/content/', read: async () => json(SHOPS) });
    const table = await content.loadTable('Data/Shops');
    expect(table.rows.map((row) => row.id)).toEqual(['bakery', 'hardware']);
    expect(table.require('hardware')).toEqual({ id: 'hardware', title: 'Hardware', opens: 8, kind: 'tools', sign: null });
    expect(table.get('nope')).toBeUndefined();
    expect(() => table.require('nope')).toThrow("table Data/Shops: no row 'nope'");
    const typed = table.as(s.object({ id: s.string(), title: s.string(), opens: s.number(), kind: s.oneOf('food', 'tools'), sign: s.string().nullable() }));
    const opens: number = typed.require('bakery').opens;
    expect(opens).toBe(6);
  });

  test('检查：类型不对、超出范围、id 重复、多出的列、缺了没有 default 的列都报错，说是哪一行', async () => {
    const load = (patch: Partial<TableFile>) => new ContentManager({ root: 'https://game.test/content/', read: async () => json({ ...SHOPS, ...patch }) }).loadTable('Bad');
    await expect(load({ rows: [{ id: 'a', title: 'A', opens: 30, kind: 'food' }] })).rejects.toThrow("row 0 ('a'): 'opens' is 30, above the maximum 24");
    await expect(load({ rows: [{ id: 'a', title: 'A', kind: 'toys' }] })).rejects.toThrow("'kind' should be one of food, tools");
    await expect(load({ rows: [{ id: 'a', title: 'A', kind: 'food' }, { id: 'a', title: 'B', kind: 'food' }] })).rejects.toThrow("the id 'a' is used twice");
    await expect(load({ rows: [{ id: 'a', title: 'A', kind: 'food', price: 1 }] })).rejects.toThrow("no column 'price'");
    await expect(load({ rows: [{ id: 'a', kind: 'food' }] })).rejects.toThrow("'title' is missing and the column has no default");
  });

  test('资源列的每个路径算引用（编辑器挪、改名资源时改写）', () => {
    expect(assetReferences('table', 'Data/Shops', SHOPS)).toEqual([{ kind: 'model', path: 'Signs/Bakery' }]);
  });
});
