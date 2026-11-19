import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { DerivedDataCache } from '../src/cache.ts';

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'stride-cache-'));
});
afterAll(() => rm(dir, { recursive: true, force: true }));

describe('派生数据缓存', () => {
  test('同样的做法和输入只算一次，换一个对象（下一次导入）也取得到；做法或输入变了重新算', async () => {
    let computed = 0;
    const compute = async () => Uint8Array.of(++computed);
    const pixels = Uint8Array.of(1, 2, 3, 4);
    const first = new DerivedDataCache(dir);
    expect([...await first.get('encode/1', [pixels, '2x2'], compute)]).toEqual([1]);
    expect([...await first.get('encode/1', [pixels, '2x2'], compute)]).toEqual([1]);
    expect([first.hits, first.misses]).toEqual([1, 1]);

    const second = new DerivedDataCache(dir);
    expect([...await second.get('encode/1', [Uint8Array.of(1, 2, 3, 4), '2x2'], compute)]).toEqual([1]);
    expect([...await second.get('encode/2', [pixels, '2x2'], compute)]).toEqual([2]);
    expect([...await second.get('encode/1', [pixels, '4x1'], compute)]).toEqual([3]);
    expect([...await second.get('encode/1', [Uint8Array.of(1, 2, 3, 5), '2x2'], compute)]).toEqual([4]);
    // 输入怎么切分也算在内：['ab', 'c'] 和 ['a', 'bc'] 不是同一个
    expect([...await second.get('encode/1', ['ab', 'c'], compute)]).toEqual([5]);
    expect([...await second.get('encode/1', ['a', 'bc'], compute)]).toEqual([6]);
    expect([second.hits, second.misses]).toEqual([1, 5]);
    // 没有留下临时文件
    const files = (await Promise.all((await readdir(dir)).map((sub) => readdir(path.join(dir, sub))))).flat();
    expect(files.filter((file) => file.endsWith('.tmp'))).toEqual([]);
    expect(files).toHaveLength(6);
  });
});
