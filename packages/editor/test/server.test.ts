import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { encodeModel, plainMesh, VERTEX_FLOATS, type MaterialFile, type SceneFile, type UIFile } from '@stride-ts/engine/content-format';
import {
  AssetDatabase, classifyAssetFile, EDITOR_API_PATH, EDITOR_HEADER, EditorBackend, generateAssetTypes, loadProject, PROJECT_FILE, projectInfo,
  type AssetChanges, type AssetRecord,
} from '../src/server/index.ts';

// 编辑器的后端：工程清单、资源数据库、资源句柄的生成、HTTP 接口。用临时目录里的真文件。

const entity = (id: string, components: SceneFile['entities'][number]['components']) =>
  ({ id, name: id, parent: null, position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], components }) as const;

const scene: SceneFile = {
  name: 'Main',
  entities: [
    entity('wall', { model: { model: 'Game/Models/Wall', materials: ['Game/Materials/Red', null] } }),
    entity('sky', { light: { type: 'skybox', skybox: 'Game/Sky', intensity: 1 }, background: { type: 'cubemap', texture: 'Game/SkyCube', intensity: 1 } }),
    entity('menu', { ui: { page: 'Game/UI/Menu', resolution: [1280, 720, 1000], size: [1, 1, 1], resolutionStretch: 'fixedWidthAdaptableHeight' } as SceneFile['entities'][number]['components']['ui'] & object }),
    entity('player', { scripts: [{ type: 'Game.Player', props: { bullet: { $asset: 'Game/Prefabs/Bullet', kind: 'prefab' }, hud: { $asset: 'Game/UI/Shared', kind: 'uiLibrary' } } }] }),
  ],
};

const ui = (page: boolean): UIFile => ({
  name: 'UI', designResolution: [1280, 720], ...(page ? { root: 0 } : { templates: { button: 0 } }),
  elements: [{ type: 'ImageElement', props: { source: { sheet: 'Game/UI/Icons', frame: 0 }, font: { $asset: 'Game/Fonts/Body', kind: 'font' } } }],
} as UIFile);

const vertices = new Float32Array(3 * VERTEX_FLOATS);

async function writeContent(contentDir: string): Promise<void> {
  const files: Record<string, string | Uint8Array> = {
    'Game/Main.scene.json': JSON.stringify(scene),
    'Game/Models/Wall.model': encodeModel({ materials: ['Game/Materials/Grid'], meshes: [plainMesh('wall', 0, vertices, new Uint16Array([0, 1, 2]))], skeleton: 'Game/Models/Wall' }),
    'Game/Models/Wall.skeleton': new Uint8Array(4),
    'Game/Materials/Red.material.json': JSON.stringify({ name: 'Red', baseColor: [1, 0, 0, 1], baseColorTexture: { texture: 'Game/Textures/Bricks', encoding: 'png', scale: [1, 1], offset: [0, 0] } } satisfies MaterialFile),
    'Game/Materials/Grid.material.json': JSON.stringify({ name: 'Grid', baseColor: [1, 1, 1, 1] } satisfies MaterialFile),
    'Game/Textures/Bricks.png': new Uint8Array(8),
    'Game/Sky.skybox.json': JSON.stringify({ diffuseSH: [], radiance: 'Game/SkyCube', specularSize: 256 }),
    'Game/SkyCube.cubemap': new Uint8Array(16),
    'Game/UI/Menu.ui.json': JSON.stringify(ui(true)),
    'Game/UI/Shared.ui.json': JSON.stringify(ui(false)),
    'Game/Fonts/Body.font.json': JSON.stringify({ name: 'Body' }),
    'Game/Fonts/Body.0.glyphs': new Uint8Array(100),
    'Game/Fonts/Body.37.glyphs': new Uint8Array(50),
    'Game/Sounds/Jump.sound.json': JSON.stringify({ name: 'Jump', encoding: 'wav', streamFromDisk: false, spatialized: false }),
    'Game/Sounds/Jump.wav': new Uint8Array(32),
    'Game/Broken.material.json': '{ not json',
    'Game/notes.txt': 'not an asset',
    'Game.game.json': JSON.stringify({ name: 'Game', defaultScene: 'Game/Main', renderer: null }),
  };
  for (const [file, data] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(contentDir, file)), { recursive: true });
    await writeFile(path.join(contentDir, file), data);
  }
}

let root: string;
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'stride-editor-'));
});
afterAll(() => rm(root, { recursive: true, force: true }));

const project = async (name: string) => {
  const directory = path.join(root, name);
  await writeContent(path.join(directory, 'public', 'content'));
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: `@test/${name}` }));
  return directory;
};

describe('工程清单', () => {
  test('没有清单文件时用默认值；写了的覆盖；内容目录不能跑到工程外面', async () => {
    const directory = await project('manifest');
    const defaults = await loadProject(directory);
    expect(defaults.manifest).toEqual({ format: 1, name: '@test/manifest', content: 'public/content', assetTypes: 'src/assets.gen.ts' });
    expect(projectInfo(defaults, path.join(directory, 'public')).contentUrl).toBe('content/');
    await writeFile(path.join(directory, PROJECT_FILE), JSON.stringify({ format: 1, name: 'My game', content: 'assets' }));
    const custom = await loadProject(directory);
    expect([custom.manifest.name, custom.contentDir, projectInfo(custom, path.join(directory, 'public')).contentUrl]).toEqual(['My game', path.join(directory, 'assets'), null]);
    await writeFile(path.join(directory, PROJECT_FILE), JSON.stringify({ content: '../elsewhere' }));
    await expect(loadProject(directory)).rejects.toThrow(/inside the project/);
    await writeFile(path.join(directory, PROJECT_FILE), JSON.stringify({ format: 2 }));
    await expect(loadProject(directory)).rejects.toThrow(/format 2 is not supported/);
  });
});

describe('资源数据库', () => {
  test('文件按扩展名认成资源：长的扩展名优先，字形块算字体的，认不出的不管', () => {
    expect(classifyAssetFile('Game/Main.scene.json')).toEqual({ kind: 'scene', path: 'Game/Main', part: false });
    expect(classifyAssetFile('a/B.texture.json')).toEqual({ kind: 'texture', path: 'a/B', part: false });
    expect(classifyAssetFile('a/B.ktx2')).toEqual({ kind: 'image', path: 'a/B', part: false });
    expect(classifyAssetFile('a/Body.37.glyphs')).toEqual({ kind: 'font', path: 'a/Body', part: true });
    expect(classifyAssetFile('a/Jump.ogg')).toEqual({ kind: 'audio', path: 'a/Jump', part: false });
    expect([classifyAssetFile('a/notes.txt'), classifyAssetFile('a/plain.json'), classifyAssetFile('.model')]).toEqual([undefined, undefined, undefined]);
  });

  test('扫目录：资源、它的文件、谁引用了谁、指向不存在的资源的引用；读不了的记下原因', async () => {
    const database = new AssetDatabase(path.join(await project('scan'), 'public', 'content'));
    await database.scan();
    const summary = (asset: AssetRecord | undefined) => asset && { files: asset.files, references: asset.references.map((r) => `${r.kind}:${r.path}`), handle: asset.handle };
    expect(database.list().map((asset) => `${asset.kind}:${asset.path}`)).toEqual([
      'audio:Game/Sounds/Jump', 'cubemap:Game/SkyCube', 'font:Game/Fonts/Body', 'gameSettings:Game', 'image:Game/Textures/Bricks',
      'material:Game/Broken', 'material:Game/Materials/Grid', 'material:Game/Materials/Red', 'model:Game/Models/Wall', 'scene:Game/Main',
      'skeleton:Game/Models/Wall', 'skybox:Game/Sky', 'sound:Game/Sounds/Jump', 'ui:Game/UI/Menu', 'ui:Game/UI/Shared',
    ]);
    expect(summary(database.get('scene', 'Game/Main'))).toEqual({
      files: ['Game/Main.scene.json'], handle: 'scene',
      references: ['model:Game/Models/Wall', 'material:Game/Materials/Red', 'skybox:Game/Sky', 'cubemap:Game/SkyCube', 'ui:Game/UI/Menu', 'prefab:Game/Prefabs/Bullet', 'ui:Game/UI/Shared'],
    });
    expect(summary(database.get('model', 'Game/Models/Wall'))).toEqual({ files: ['Game/Models/Wall.model'], handle: 'model', references: ['material:Game/Materials/Grid', 'skeleton:Game/Models/Wall'] });
    expect(summary(database.get('material', 'Game/Materials/Red'))!.references).toEqual(['image:Game/Textures/Bricks']);
    expect(summary(database.get('ui', 'Game/UI/Menu'))).toEqual({ files: ['Game/UI/Menu.ui.json'], handle: 'uiPage', references: ['spriteSheet:Game/UI/Icons', 'font:Game/Fonts/Body'] });
    expect([database.get('ui', 'Game/UI/Shared')!.handle, database.get('skybox', 'Game/Sky')!.handle, database.get('image', 'Game/Textures/Bricks')!.handle]).toEqual(['uiLibrary', undefined, undefined]);
    // 字体带着它的字形块；声音引用同名的音频文件
    const font = database.get('font', 'Game/Fonts/Body')!;
    expect([font.files, font.bytes]).toEqual([['Game/Fonts/Body.font.json', 'Game/Fonts/Body.0.glyphs', 'Game/Fonts/Body.37.glyphs'], JSON.stringify({ name: 'Body' }).length + 150]);
    expect(database.get('sound', 'Game/Sounds/Jump')!.references).toEqual([{ kind: 'audio', path: 'Game/Sounds/Jump' }]);
    expect(database.get('gameSettings', 'Game')!.references).toEqual([{ kind: 'scene', path: 'Game/Main' }]);
    expect(database.get('material', 'Game/Broken')).toMatchObject({ references: [], error: expect.stringMatching(/JSON/) });
    // 反过来查
    expect(database.referrers('material', 'Game/Materials/Grid').map((a) => a.path)).toEqual(['Game/Models/Wall']);
    expect(database.referrers('cubemap', 'Game/SkyCube').map((a) => `${a.kind}:${a.path}`).sort()).toEqual(['scene:Game/Main', 'skybox:Game/Sky']);
    expect(database.missing().map(({ from, to }) => `${from.path} -> ${to.kind}:${to.path}`).sort()).toEqual([
      'Game/Main -> prefab:Game/Prefabs/Bullet', 'Game/UI/Menu -> spriteSheet:Game/UI/Icons', 'Game/UI/Shared -> spriteSheet:Game/UI/Icons',
    ]);
  });

  test('文件变了只重读变了的：改、加、删，字体的块删了字体还在，主文件删光了资源才没', async () => {
    const contentDir = path.join(await project('refresh'), 'public', 'content');
    const database = new AssetDatabase(contentDir);
    await database.scan();
    const count = database.size;
    const names = ({ changed, removed }: AssetChanges) => ({ changed: changed.map((a) => `${a.kind}:${a.path}`), removed: removed.map((a) => `${a.kind}:${a.path}`) });

    await writeFile(path.join(contentDir, 'Game/Materials/Grid.material.json'), JSON.stringify({ name: 'Grid', baseColor: [1, 1, 1, 1], baseColorTexture: { texture: 'Game/Textures/Bricks', scale: [1, 1], offset: [0, 0] } }));
    await mkdir(path.join(contentDir, 'Game/Prefabs'));
    await writeFile(path.join(contentDir, 'Game/Prefabs/Bullet.prefab.json'), JSON.stringify({ name: 'Bullet', entities: [] }));
    expect(names(await database.refresh(['Game/Materials/Grid.material.json', 'Game/Prefabs/Bullet.prefab.json', 'Game/notes.txt', 'Game/Gone.model']))).toEqual({
      changed: ['material:Game/Materials/Grid', 'prefab:Game/Prefabs/Bullet'], removed: [],
    });
    expect(database.referrers('image', 'Game/Textures/Bricks').map((a) => a.path).sort()).toEqual(['Game/Materials/Grid', 'Game/Materials/Red']);
    // 没变的文件再报一次：什么都不做
    expect(names(await database.refresh(['Game/Materials/Grid.material.json', 'Game/Main.scene.json']))).toEqual({ changed: [], removed: [] });
    expect(database.missing().some(({ to }) => to.kind === 'prefab')).toBe(false);

    await rm(path.join(contentDir, 'Game/Fonts/Body.37.glyphs'));
    await rm(path.join(contentDir, 'Game/Textures/Bricks.png'));
    expect(names(await database.refresh(['Game/Fonts/Body.37.glyphs', 'Game/Textures/Bricks.png']))).toEqual({ changed: ['font:Game/Fonts/Body'], removed: ['image:Game/Textures/Bricks'] });
    expect(database.get('font', 'Game/Fonts/Body')!.files).toEqual(['Game/Fonts/Body.font.json', 'Game/Fonts/Body.0.glyphs']);
    expect([database.size, database.missing().filter(({ to }) => to.kind === 'image').length]).toEqual([count, 2]);
    // 字体的主文件没了，块还在：资源留着、记着原因
    await rm(path.join(contentDir, 'Game/Fonts/Body.font.json'));
    await database.refresh(['Game/Fonts/Body.font.json']);
    expect(database.get('font', 'Game/Fonts/Body')).toMatchObject({ files: ['Game/Fonts/Body.0.glyphs'], error: 'the main file is missing' });
  });
});

describe('资源句柄的生成（assets.gen.ts）', () => {
  test('按种类、目录分层，顺序固定；不是标识符的名字加引号，同名的资源和目录分开', () => {
    const asset = (handle: string, assetPath: string): AssetRecord => ({ kind: 'scene', path: assetPath, files: [], bytes: 0, modified: 0, references: [], handle });
    const text = generateAssetTypes([
      asset('scene', 'Game/Main'), asset('model', 'Game/Models/Car/Wheel'), asset('model', 'Game/Models/Car'), asset('model', 'Game/Models/big rock'),
      asset('uiPage', 'Menu'), { ...asset('scene', 'x'), handle: undefined } as unknown as AssetRecord,
    ], 'public/content');
    expect(text.split('\n').slice(2)).toEqual([
      "import { assetRef } from '@stride-ts/engine';",
      '',
      'export const assets = {',
      '  scenes: {',
      '    Game: {',
      "      Main: assetRef('scene', \"Game/Main\"),",
      '    },',
      '  },',
      '  models: {',
      '    Game: {',
      '      Models: {',
      "        Car: assetRef('model', \"Game/Models/Car\"),",
      '        "Car/": {',
      "          Wheel: assetRef('model', \"Game/Models/Car/Wheel\"),",
      '        },',
      "        \"big rock\": assetRef('model', \"Game/Models/big rock\"),",
      '      },',
      '    },',
      '  },',
      '  uiPages: {',
      "    Menu: assetRef('uiPage', \"Menu\"),",
      '  },',
      '} as const;',
      '',
    ]);
    // 一个能引用的资源都没有：不导入引擎
    expect(generateAssetTypes([], 'public/content').split('\n').slice(2)).toEqual(['export const assets = {', '} as const;', '']);
  });
});

describe('后端（EditorBackend）', () => {
  let directory: string, backend: EditorBackend, server: Server, base: string;
  const events: AssetChanges[] = [];
  beforeAll(async () => {
    directory = await project('backend');
    backend = await EditorBackend.open(directory, path.join(directory, 'public'));
    backend.onAssetsChanged((changes) => events.push(changes));
    server = createServer((request, response) => backend.handle(request, response, () => {
      response.statusCode = 404;
      response.end('next');
    }));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise((resolve) => server.close(resolve)));

  const api = (route: string, init: RequestInit = {}) => fetch(`${base}${EDITOR_API_PATH}${route}`, { ...init, headers: { [EDITOR_HEADER]: '1', ...init.headers } });

  test('打开工程就生成资源句柄；HTTP 接口：工程、资源列表、读和保存 JSON 资源', async () => {
    const generated = await readFile(path.join(directory, 'src', 'assets.gen.ts'), 'utf8');
    expect(generated).toContain("Main: assetRef('scene', \"Game/Main\"),");
    expect(generated).toContain("Shared: assetRef('uiLibrary', \"Game/UI/Shared\"),");
    expect(await (await api('/project')).json()).toEqual({ format: 1, name: '@test/backend', content: 'public/content', assetTypes: 'src/assets.gen.ts', contentUrl: 'content/' });
    const assets = await (await api('/assets')).json() as AssetRecord[];
    expect(assets).toHaveLength(backend.database.size);
    expect(await (await api('/asset?kind=scene&path=Game/Main')).json()).toEqual(scene);

    // 保存：文件写好（格式同导入器）、数据库跟上、通知、句柄重新生成
    const edited = { ...scene, entities: [...scene.entities, entity('extra', { model: { model: 'Game/Models/Wall', materials: [] } })] };
    const saved = await (await api('/asset?kind=scene&path=Game/Main', { method: 'PUT', body: JSON.stringify(edited) })).json() as AssetRecord;
    expect(saved).toEqual(backend.database.get('scene', 'Game/Main'));
    expect(await readFile(path.join(directory, 'public/content/Game/Main.scene.json'), 'utf8')).toBe(JSON.stringify(edited, null, 1));
    expect(events.at(-1)).toEqual({ changed: [saved], removed: [] });
    // 监视器再把这个文件报一次：没变，不再通知
    const notified = events.length;
    backend.fileChanged(path.join(directory, 'public', 'content', 'Game', 'Main.scene.json'));
    await backend.settled();
    expect(events).toHaveLength(notified);
    const created = await api('/asset?kind=prefab&path=Game/Prefabs/Bullet', { method: 'PUT', body: JSON.stringify({ name: 'Bullet', entities: [] }) });
    expect(created.status).toBe(200);
    expect(await readFile(path.join(directory, 'src', 'assets.gen.ts'), 'utf8')).toContain("Bullet: assetRef('prefab', \"Game/Prefabs/Bullet\"),");
  });

  test('别的程序改了文件（监视器报进来）：攒一批处理，通知一次；内容目录外面的不管', async () => {
    const before = events.length;
    const contentDir = path.join(directory, 'public', 'content');
    await writeFile(path.join(contentDir, 'Game/Materials/Blue.material.json'), JSON.stringify({ name: 'Blue', baseColor: [0, 0, 1, 1] }));
    await rm(path.join(contentDir, 'Game/Materials/Grid.material.json'));
    backend.fileChanged(path.join(contentDir, 'Game', 'Materials', 'Blue.material.json'));
    backend.fileChanged(path.join(contentDir, 'Game', 'Materials', 'Grid.material.json'));
    backend.fileChanged(path.join(directory, 'src', 'main.ts'));
    await backend.settled();
    expect(events.slice(before).map(({ changed, removed }) => [changed.map((a) => a.path), removed.map((a) => a.path)])).toEqual([[['Game/Materials/Blue'], ['Game/Materials/Grid']]]);
    const generated = await readFile(path.join(directory, 'src', 'assets.gen.ts'), 'utf8');
    expect([generated.includes('Blue: assetRef'), generated.includes('Grid: assetRef')]).toEqual([true, false]);
  });

  test('只认本机同源、带着约定的头的请求；路径不能跑出内容目录，二进制资源不能经接口读写', async () => {
    const status = async (route: string, init: RequestInit = {}) => (await fetch(`${base}${EDITOR_API_PATH}${route}`, init)).status;
    expect(await status('/assets')).toBe(403);
    expect(await status('/assets', { headers: { [EDITOR_HEADER]: '1', origin: 'https://evil.example' } })).toBe(403);
    expect(await status('/assets', { headers: { [EDITOR_HEADER]: '1', origin: base } })).toBe(200);
    expect((await api('/asset?kind=scene&path=../../package')).status).toBe(400);
    expect((await api('/asset?kind=scene&path=Game/../../x', { method: 'PUT', body: '{}' })).status).toBe(400);
    expect((await api('/asset?kind=model&path=Game/Models/Wall')).status).toBe(400);
    expect((await api('/asset?kind=scene&path=Game/Nope')).status).toBe(404);
    expect((await api('/asset?kind=scene&path=Game/Main', { method: 'PUT', body: 'not json' })).status).toBe(400);
    expect((await api('/nope')).status).toBe(404);
    // 不是编辑器接口的请求交给后面的中间件
    expect(await (await fetch(`${base}/index.html`)).text()).toBe('next');
  });
});
