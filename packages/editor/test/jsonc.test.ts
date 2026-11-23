import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { strideJsonc } from '../src/server/vite.ts';

describe('带注释的 JSON 资源给页面（strideJsonc）', () => {
  test('构建完把输出目录里的 .jsonc 换成同名的 .json（去掉注释），同名的 .json 已经有了的不覆盖', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'stride-jsonc-'));
    await writeFile(path.join(root, 'A.scene.jsonc'), '{ // 说明\n "a": 1, }\n');
    await writeFile(path.join(root, 'B.material.jsonc'), '{ "b": 2 }');
    await writeFile(path.join(root, 'B.material.json'), '{ "b": 3 }');
    const plugin = strideJsonc();
    (plugin.configResolved as (config: unknown) => void)({ root, build: { outDir: '.' } });
    await (plugin.closeBundle as { handler: () => Promise<void> }).handler();
    expect(JSON.parse(await readFile(path.join(root, 'A.scene.json'), 'utf8'))).toEqual({ a: 1 });
    expect(JSON.parse(await readFile(path.join(root, 'B.material.json'), 'utf8'))).toEqual({ b: 3 });
    expect(existsSync(path.join(root, 'A.scene.jsonc'))).toBe(false);
    expect(existsSync(path.join(root, 'B.material.jsonc'))).toBe(false);
  });
});
