import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { SceneFile } from '@stride-ts/engine/content-format';
import { createProject } from '../src/server/template.ts';
import { McpProcess } from '../src/server/mcp/mcpClient.ts';

describe('编辑器的 MCP 服务', () => {
  let repo: string;
  let project: string;
  let mcp: McpProcess;

  beforeAll(async () => {
    repo = await mkdtemp(path.join(tmpdir(), 'stride-mcp-'));
    // 模板要在仓库里建（找 pnpm-workspace.yaml、引擎的原生版本）
    await writeFile(path.join(repo, 'pnpm-workspace.yaml'), 'packages: []\n');
    await mkdir(path.join(repo, 'apps'), { recursive: true });
    await mkdir(path.join(repo, 'packages', 'engine'), { recursive: true });
    await writeFile(path.join(repo, 'packages', 'engine', 'package.json'), JSON.stringify({ dependencies: { '@stride-ts/native': '^0.29.0' } }));
    await writeFile(path.join(repo, '.gitignore'), 'node_modules/\n/apps/*/public/content/\n');
    project = (await createProject(path.join(repo, 'apps', 'game'))).root;
    mcp = new McpProcess(project);
    await mcp.start();
  }, 30_000);

  afterAll(async () => {
    await mcp?.stop();
    await rm(repo, { recursive: true, force: true });
  });

  test('列出工具；读工程和资源；建材质；场景的修改照字段描述检查，过了才存', async () => {
    const tools = (await mcp.rpc('tools/list', {})).result.tools.map((tool: { name: string }) => tool.name);
    expect(tools).toEqual(expect.arrayContaining(['project', 'list_assets', 'read_asset', 'write_asset', 'delete_asset', 'move_asset', 'import_file', 'edit_scene', 'field_schemas', 'screenshot', 'render', 'game_command']));
    expect((await mcp.call('project', {})).value.assets).toMatchObject({ scene: 1 });

    const material = { name: 'Red', baseColor: [1, 0, 0, 1], metalness: 0, roughness: 0.5 };
    expect((await mcp.call('write_asset', { kind: 'material', path: 'Materials/Red', content: material, create: true })).value).toEqual({ kind: 'material', path: 'Materials/Red' });
    expect((await mcp.call('write_asset', { kind: 'material', path: 'Materials/Red', content: material, create: true })).error).toBe(true);

    const scene = (await mcp.call('read_asset', { kind: 'scene', path: 'MainScene' })).value as SceneFile;
    const sun = scene.entities.find((entity) => entity.name === 'Sun')!;
    const bad = await mcp.call('edit_scene', { kind: 'scene', path: 'MainScene', edits: [{ type: 'set', entity: sun.id, path: ['components', 'light', 'intensity'], value: 'bright' }] });
    expect(bad.error).toBe(true);
    expect(bad.value).toMatch(/intensity: expected a number/);

    const cube = { id: 'cube-1', name: 'Cube', parent: null, position: [0, 1, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], components: { model: { model: 'Models/Cube', materials: ['Materials/Red'] } } };
    const added = await mcp.call('edit_scene', { kind: 'scene', path: 'MainScene', edits: [{ type: 'add', entities: [{ entity: cube, index: scene.entities.length }] }] });
    expect(added.value).toMatchObject({ changed: [{ id: 'cube-1', name: 'Cube' }], removed: [], issues: [] });
    const saved = JSON.parse(await readFile(path.join(project, 'public/content/MainScene.scene.json'), 'utf8')) as SceneFile;
    expect(saved.entities.at(-1)).toMatchObject({ name: 'Cube', components: { model: { materials: ['Materials/Red'] } } });

    const removed = await mcp.call('edit_scene', { kind: 'scene', path: 'MainScene', edits: [{ type: 'remove', entities: ['cube-1'] }] });
    expect(removed.value).toMatchObject({ changed: [], removed: [{ id: 'cube-1', name: 'Cube' }] });

    const decal = (await mcp.call('field_schemas', { of: 'components', name: 'decal' })).value;
    expect(decal).toMatchObject({ title: 'Decal', type: 'object' });
    expect((await mcp.call('field_schemas', { of: 'components', name: 'nope' })).error).toBe(true);
  }, 60_000);

  test('切精灵表：导入一张两块不透明的图，自动切出两个精灵（精灵表不存在时建），按网格切（全透明的格子不要）替换同一张贴图上的', async () => {
    const file = path.join(repo, 'sheet.png');
    await writeFile(file, rgbaPng(16, 8, (x) => (x < 4 || x >= 12 ? 255 : 0)));
    expect((await mcp.call('import_file', { file, folder: 'Sprites' })).error).toBe(false);
    const auto = await mcp.call('slice_sprites', { path: 'Sprites/Hero', texture: 'Sprites/sheet', mode: 'auto' });
    expect(auto.value).toMatchObject({ sliced: 2, sprites: 2, regions: [[0, 0, 4, 8], [12, 0, 4, 8]] });
    const grid = await mcp.call('slice_sprites', { path: 'Sprites/Hero', texture: 'Sprites/sheet', mode: 'grid', columns: 4, rows: 1, pixelsPerUnit: 8 });
    // 中间两格全透明，不要
    expect(grid.value).toMatchObject({ sliced: 2, sprites: 2 });
    const sheet = (await mcp.call('read_asset', { kind: 'spriteSheet', path: 'Sprites/Hero' })).value;
    expect(sheet.sprites.map((sprite: { name: string; region: number[]; pixelsPerUnit: number }) => [sprite.name, sprite.region, sprite.pixelsPerUnit])).toEqual([
      ['sheet_0', [0, 0, 4, 8], 8], ['sheet_1', [12, 0, 4, 8], 8],
    ]);
  }, 60_000);

  test('库：列出材质和特效；材质拷进工程（已有的留着）、用在实体的每个材质槽上，特效加成场景里一个带粒子系统的实体', async () => {
    const library = (await mcp.call('list_library', {})).value;
    expect(library.materials).toContainEqual({ id: 'gold', category: 'metal', path: 'Materials/Library/Gold' });
    expect(library.effects).toContainEqual({ id: 'campfire', category: 'fire' });

    const ball = { id: 'ball-1', name: 'Ball', parent: null, position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], components: { model: { model: 'Models/Ball', materials: [null, null] } } };
    const scene = (await mcp.call('read_asset', { kind: 'scene', path: 'MainScene' })).value as SceneFile;
    await mcp.call('edit_scene', { kind: 'scene', path: 'MainScene', edits: [{ type: 'add', entities: [{ entity: ball, index: scene.entities.length }] }] });
    const used = await mcp.call('use_library', { id: 'gold', scene: 'MainScene', entities: ['ball-1'] });
    expect(used.value).toMatchObject({ material: 'Materials/Library/Gold', used: [{ id: 'ball-1', name: 'Ball' }] });
    expect((await mcp.call('read_asset', { kind: 'material', path: 'Materials/Library/Gold' })).value).toMatchObject({ name: 'Gold', metalness: 1 });
    // 工程里那份改过了：再用一次不覆盖
    await mcp.call('write_asset', { kind: 'material', path: 'Materials/Library/Gold', content: { name: 'Gold', baseColor: [1, 0, 0, 1], metalness: 1, roughness: 0.5 } });
    await mcp.call('use_library', { id: 'gold' });
    expect((await mcp.call('read_asset', { kind: 'material', path: 'Materials/Library/Gold' })).value.baseColor).toEqual([1, 0, 0, 1]);

    const added = await mcp.call('use_library', { id: 'campfire', scene: 'MainScene', position: [1, 0, 2] });
    expect(added.value.added.name).toBe('Campfire');
    const saved = (await mcp.call('read_asset', { kind: 'scene', path: 'MainScene' })).value as SceneFile;
    expect(saved.entities.find((entity) => entity.id === 'ball-1')!.components['model']).toMatchObject({ materials: ['Materials/Library/Gold', 'Materials/Library/Gold'] });
    expect(saved.entities.find((entity) => entity.name === 'Campfire')).toMatchObject({ position: [1, 0, 2], components: { particleSystem: { particleSystem: { emitters: [{ emitterName: 'Flames' }, { emitterName: 'Embers' }] } } } });
    expect((await mcp.call('use_library', { id: 'campfire' })).error).toBe(true);
    expect((await mcp.call('use_library', { id: 'nope' })).error).toBe(true);
  }, 60_000);

  test('合成音效：按类别生成（同一个种子出同一组参数，没有音频文件也不报引用缺失），在它附近变一点，没有的声音不能变', async () => {
    const first = await mcp.call('generate_sound', { path: 'Sounds/Coin', preset: 'pickup', seed: 7 });
    const again = await mcp.call('generate_sound', { path: 'Sounds/Coin2', preset: 'pickup', seed: 7 });
    expect(first.value.synth).toEqual(again.value.synth);
    expect(first.value.seconds).toBeGreaterThan(0.05);
    const saved = (await mcp.call('read_asset', { kind: 'sound', path: 'Sounds/Coin' })).value;
    expect(saved).toMatchObject({ name: 'Coin', encoding: 'synth', streamFromDisk: false, synth: first.value.synth });
    expect((await mcp.call('list_assets', { kind: 'sound' })).value).toEqual([{ kind: 'sound', path: 'Sounds/Coin' }, { kind: 'sound', path: 'Sounds/Coin2' }]);
    const mutated = await mcp.call('generate_sound', { path: 'Sounds/Coin', mutate: true, seed: 3 });
    expect(mutated.value.synth).not.toEqual(first.value.synth);
    expect(mutated.value.synth.wave).toBe(first.value.synth.wave);
    expect((await mcp.call('generate_sound', { path: 'Sounds/Nope', mutate: true })).error).toBe(true);
  }, 60_000);

  test('雕刻地形：追加笔画和地物、撤掉最后几笔，存回文件', async () => {
    await mcp.call('write_asset', { kind: 'terrain', path: 'Terrains/Hills', content: { name: 'Hills', noise: { octaves: 4 } }, create: true });
    expect((await mcp.call('sculpt_terrain', { path: 'Terrains/Hills', strokes: [{ op: 'raise', x: 0, z: 0, radius: 20, strength: 5 }, { op: 'lower', x: 30, z: 0, radius: 10, strength: 2 }] })).value).toEqual({ strokes: 2, features: 0 });
    expect((await mcp.call('sculpt_terrain', { path: 'Terrains/Hills', undo: 1, features: [{ type: 'flatten', points: [[0, 0], [10, 0], [10, 10]], height: 3, falloff: 4 }] })).value).toEqual({ strokes: 1, features: 1 });
    const file = (await mcp.call('read_asset', { kind: 'terrain', path: 'Terrains/Hills' })).value;
    expect(file.strokes).toEqual([{ op: 'raise', x: 0, z: 0, radius: 20, strength: 5 }]);
    expect(file.features[0]).toMatchObject({ type: 'flatten', height: 3, falloff: 4 });
  });

  test('程序化建筑：写文法就生成同名的模型，规则不对时报错', async () => {
    const building = {
      name: 'House', materials: [null, null, null, null],
      masses: [{ footprint: { rect: [10, 8] }, floors: 2, floorHeight: 3, facade: 'Main', roof: { kind: 'pyramid', height: 2 } }],
      facades: { Main: { floors: [{ pattern: 'Wall Window* Wall' }] } },
      modules: { Wall: { kind: 'wall', width: 1 }, Window: { kind: 'window', width: 2 } },
    };
    expect((await mcp.call('write_asset', { kind: 'building', path: 'Buildings/House', content: building, create: true })).value).toEqual({ kind: 'building', path: 'Buildings/House' });
    const models = (await mcp.call('list_assets', { kind: 'model' })).value as { path: string }[];
    expect(models.some((asset) => asset.path === 'Buildings/House')).toBe(true);
    expect((await mcp.call('write_asset', { kind: 'building', path: 'Buildings/House', content: { ...building, facades: { Main: { floors: [{ pattern: 'Door*' }] } } } })).error).toBe(true);
  }, 60_000);

  test('一个服务能换到仓库里别的工程：project 列出别的工程，switch_project 以后别的工具都对着新工程', async () => {
    const other = (await createProject(path.join(repo, 'apps', 'other'))).root;
    expect((await mcp.call('project', {})).value.otherProjects).toEqual(['apps/game', 'apps/other']);
    expect((await mcp.call('switch_project', { project: 'other' })).value).toMatchObject({ root: other });
    expect((await mcp.call('project', {})).value.root).toBe(other);
    // 新工程里没有前一个工程建的材质
    expect((await mcp.call('list_assets', { kind: 'material' })).value.some((asset: { path: string }) => asset.path === 'Materials/Red')).toBe(false);
    expect((await mcp.call('switch_project', { project: 'apps/missing' })).error).toBe(true);
    // 换回来：前面建的材质还在
    await mcp.call('switch_project', { project: 'apps/game' });
    expect((await mcp.call('list_assets', { kind: 'material' })).value.some((asset: { path: string }) => asset.path === 'Materials/Red')).toBe(true);
  }, 30_000);
});

/** width × height 的 RGBA PNG，alpha 按列给（每个像素灰色）。 */
function rgbaPng(width: number, height: number, alpha: (x: number) => number): Uint8Array {
  const chunk = (type: string, data: Uint8Array) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const length = Buffer.alloc(4), crc = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const rows = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) rows.set([128, 128, 128, alpha(x)], y * (1 + width * 4) + 1 + x * 4);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', new Uint8Array(0))]);
}
