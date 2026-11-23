import { afterEach, describe, expect, test, vi } from 'vitest';
import { ContentManager } from '../../src/content/ContentManager';

const ROOT = 'https://game.example/content/';

describe('内容文件的清单（带哈希的地址）', () => {
  afterEach(() => vi.unstubAllGlobals());

  test('resolveUrl：清单里有的换成带哈希的路径，没有的、内容根以外的原样', () => {
    const content = new ContentManager({ root: ROOT, manifest: { 'Valley.scene.json': 'Valley.scene.3fa9c2d1b0e4.json', 'Models/Tree.model': 'Models/Tree.aa11bb22cc33.model', 'Fonts/中文.font.json': 'Fonts/%E4%B8%AD%E6%96%87.x.font.json' } });
    expect(content.resolveUrl(new URL('Valley.scene.json', ROOT)).href).toBe(`${ROOT}Valley.scene.3fa9c2d1b0e4.json`);
    expect(content.resolveUrl(new URL('Models/Tree.model', ROOT)).href).toBe(`${ROOT}Models/Tree.aa11bb22cc33.model`);
    expect(content.resolveUrl(new URL('Missing.model', ROOT)).href).toBe(`${ROOT}Missing.model`);
    expect(content.resolveUrl(new URL('https://other.example/a.model')).href).toBe('https://other.example/a.model');
    // 查询串不影响查找
    expect(content.resolveUrl(new URL('Valley.scene.json?x=1', ROOT)).href).toBe(`${ROOT}Valley.scene.3fa9c2d1b0e4.json`);
  });

  test('没有清单：地址原样', () => {
    const content = new ContentManager({ root: ROOT });
    const url = new URL('Valley.scene.json', ROOT);
    expect(content.resolveUrl(url)).toBe(url);
  });

  test('默认读文件：换成带哈希的地址时让浏览器直接用缓存（force-cache），没换的照旧', async () => {
    const fetched: [string, unknown][] = [];
    vi.stubGlobal('fetch', async (url: URL, init?: unknown) => {
      fetched.push([url.href, init]);
      return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode('{"name":"Material","baseColor":[1,1,1,1]}').buffer };
    });
    const content = new ContentManager({ root: ROOT, manifest: { 'Materials/Hashed.material.json': 'Materials/Hashed.material.aabbccddeeff.json' } });
    await content.loadMaterialFile('Materials/Hashed');
    await content.loadMaterialFile('Materials/Plain');
    expect(fetched[0]).toEqual([`${ROOT}Materials/Hashed.material.aabbccddeeff.json`, { cache: 'force-cache' }]);
    expect(fetched[1]).toEqual([`${ROOT}Materials/Plain.material.json`, undefined]);
  });

  test('自己给了 read 的不换地址（测试、虚拟文件自己管）', async () => {
    const read = vi.fn(async (_url: URL) => new TextEncoder().encode('{"name":"M","baseColor":[1,1,1,1]}').buffer as ArrayBuffer);
    const content = new ContentManager({ root: ROOT, read, manifest: { 'Materials/A.material.json': 'Materials/A.material.1234567890ab.json' } });
    await content.loadMaterialFile('Materials/A');
    expect(read.mock.calls[0]![0].href).toBe(`${ROOT}Materials/A.material.json`);
  });
});
