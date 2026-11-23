import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { EditorBackend } from '../src/server/index.ts';
import { extensionAssetKind, extensionLabel } from '../src/shared/extension.ts';

/**
 * 工程的扩展模块：一种自定义资源"台灯"（.lamp.json），引用一个材质，烘成同名的 JSON 模型（一个立方体）。临时工程在仓库外，
 * 模块不能导入包，直接写对象（defineEditorExtension 只是补类型）。
 */
const EXTENSION = `export default {
  assetKinds: [{
    kind: 'lamp',
    extension: '.lamp.json',
    label: { 'zh-CN': '台灯', en: 'Lamp' },
    references: (file, refs) => { if (file.material) refs.add('material', file, 'material'); },
    template: { name: 'NewLamp', content: (name) => ({ name, material: null, height: 0.5 }) },
    bake: (file, { assetPath, where }) => {
      if (!(file.height > 0)) throw new Error(where + ': height must be positive');
      return [{ path: assetPath + '.model', bytes: JSON.stringify({ format: 1, procedural: { type: 'cube', size: [0.2, file.height, 0.2] }, materials: [file.material] }) }];
    },
  }],
};
`;

describe('工程的编辑器扩展：自定义的资源种类', () => {
  let directory: string;
  let backend: EditorBackend;

  beforeAll(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'stride-editor-extension-'));
    await mkdir(path.join(directory, 'editor'), { recursive: true });
    await mkdir(path.join(directory, 'public', 'content', 'Lamps'), { recursive: true });
    await mkdir(path.join(directory, 'public', 'content', 'Materials'), { recursive: true });
    await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: '@test/extension' }));
    await writeFile(path.join(directory, 'stride.project.json'), JSON.stringify({ format: 1, extension: 'editor/extension.ts' }));
    await writeFile(path.join(directory, 'editor', 'extension.ts'), EXTENSION);
    await writeFile(path.join(directory, 'public', 'content', 'Materials', 'Brass.material.json'), JSON.stringify({ name: 'Brass', baseColor: [0.8, 0.6, 0.2, 1], metalness: 1, roughness: 0.3 }));
    await writeFile(path.join(directory, 'public', 'content', 'Lamps', 'Desk.lamp.json'), JSON.stringify({ name: 'Desk', material: 'Materials/Brass', height: 0.4 }));
    backend = await EditorBackend.open(directory, path.join(directory, 'public'));
  });

  afterAll(async () => {
    await backend.close();
    await rm(directory, { recursive: true, force: true });
  });

  test('打开工程时装上扩展：认得新种类的文件和引用，名字、模板记下来，停着时没烘过的补烘', async () => {
    const lamp = backend.database.get('lamp' as never, 'Lamps/Desk');
    expect(lamp?.references).toEqual([{ kind: 'material', path: 'Materials/Brass' }]);
    const kind = extensionAssetKind('lamp')!;
    expect(extensionLabel(kind, 'zh-CN')).toBe('台灯');
    expect(extensionLabel(kind, 'fr')).toBe('Lamp');
    expect(kind.template?.content('NewLamp')).toEqual({ name: 'NewLamp', material: null, height: 0.5 });
    // 打开工程时补烘了同名的模型
    expect(JSON.parse(await readFile(path.join(directory, 'public', 'content', 'Lamps', 'Desk.model'), 'utf8'))).toMatchObject({ procedural: { size: [0.2, 0.4, 0.2] } });
  });

  test('经接口存下就烘，参数不对时报错、什么也不写；挪动时同名的模型跟着走，引用它的不变', async () => {
    await backend.saveAsset('lamp' as never, 'Lamps/Floor', { name: 'Floor', material: 'Materials/Brass', height: 1.6 }, { create: true });
    expect(JSON.parse(await readFile(path.join(directory, 'public', 'content', 'Lamps', 'Floor.model'), 'utf8'))).toMatchObject({ procedural: { size: [0.2, 1.6, 0.2] } });
    await expect(backend.saveAsset('lamp' as never, 'Lamps/Bad', { name: 'Bad', material: null, height: 0 })).rejects.toThrow(/height must be positive/);
    expect(existsSync(path.join(directory, 'public', 'content', 'Lamps', 'Bad.lamp.jsonc'))).toBe(false);

    await backend.moveAssets({ assets: [{ kind: 'lamp' as never, from: 'Lamps/Floor', to: 'Lamps/Tall' }] });
    expect(existsSync(path.join(directory, 'public', 'content', 'Lamps', 'Tall.lamp.jsonc'))).toBe(true);
    expect(existsSync(path.join(directory, 'public', 'content', 'Lamps', 'Tall.model'))).toBe(true);
    expect(existsSync(path.join(directory, 'public', 'content', 'Lamps', 'Floor.model'))).toBe(false);
    // 挪材质：台灯文件里的引用跟着改写
    await backend.moveAssets({ assets: [{ kind: 'material', from: 'Materials/Brass', to: 'Materials/Metal/Brass' }] });
    expect(JSON.parse(await readFile(path.join(directory, 'public', 'content', 'Lamps', 'Desk.lamp.json'), 'utf8')).material).toBe('Materials/Metal/Brass');
  });
});
