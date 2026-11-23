import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { embedManifest, hashContentFiles, MANIFEST_ELEMENT_ID } from '../src/contentHash.ts';

let directory: string | undefined;
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

async function fixture(): Promise<string> {
  directory = await mkdtemp(path.join(tmpdir(), 'stride-content-'));
  await mkdir(path.join(directory, 'Models'), { recursive: true });
  await writeFile(path.join(directory, 'Valley.scene.json'), '{"a":1}');
  await writeFile(path.join(directory, 'Copy.scene.json'), '{"a":1}');
  await writeFile(path.join(directory, 'Models', 'Tree.model'), 'binary');
  await writeFile(path.join(directory, 'Models', 'Tree.model.br'), 'compressed');
  await writeFile(path.join(directory, 'LICENSE'), 'text');
  return directory;
}

describe('内容文件的哈希命名', () => {
  test('改名成 名字.哈希.扩展名，清单是原路径到新路径（正斜杠）；预压缩文件不动', async () => {
    const dir = await fixture();
    const manifest = await hashContentFiles(dir);
    expect(Object.keys(manifest).sort()).toEqual(['Copy.scene.json', 'LICENSE', 'Models/Tree.model', 'Valley.scene.json']);
    expect(manifest['Valley.scene.json']).toMatch(/^Valley\.scene\.[0-9a-f]{12}\.json$/);
    expect(manifest['Models/Tree.model']).toMatch(/^Models\/Tree\.[0-9a-f]{12}\.model$/);
    expect(manifest['LICENSE']).toMatch(/^LICENSE\.[0-9a-f]{12}$/);
    // 同样的内容同样的哈希，不同内容不同
    expect(manifest['Valley.scene.json']!.split('.')[2]).toBe(manifest['Copy.scene.json']!.split('.')[2]);
    expect(manifest['Valley.scene.json']!.split('.')[2]).not.toBe(manifest['Models/Tree.model']!.split('/')[1]!.split('.')[1]);
    // 磁盘上：原名没有了，新名有内容，.br 原样
    const names = (await readdir(dir, { recursive: true })).map((name) => name.split(path.sep).join('/'));
    expect(names).not.toContain('Valley.scene.json');
    expect(await readFile(path.join(dir, manifest['Valley.scene.json']!), 'utf8')).toBe('{"a":1}');
    expect(names).toContain('Models/Tree.model.br');
  });

  test('清单嵌进页面的 head 末尾，路径里的 < 转义，已经有的不重复嵌', () => {
    const html = '<html><head><title>x</title></head><body></body></html>';
    const once = embedManifest(html, { 'a<b.json': 'a<b.1234567890ab.json' });
    expect(once).toContain(`id="${MANIFEST_ELEMENT_ID}"`);
    expect(once.indexOf(MANIFEST_ELEMENT_ID)).toBeLessThan(once.indexOf('</head>'));
    expect(once).not.toContain('a<b');
    // 转义成 反斜杠 u003c（script 元素里不会被当成标签）
    expect(once).toContain('a' + String.fromCharCode(92) + 'u003cb');
    expect(embedManifest(once, { x: 'y' })).toBe(once);
  });
});
