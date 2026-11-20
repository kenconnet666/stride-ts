import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { readModelFile, type SceneFile } from '@stride-ts/engine/content-format';
import { checkEntity } from '@stride-ts/engine';
import { createProject } from '../src/server/template.ts';

// 新建工程：在临时目录里搭一个最小的"仓库"（pnpm-workspace.yaml、apps、引擎的 package.json、.gitignore）。

let repo: string;

beforeAll(async () => {
  repo = await mkdtemp(path.join(tmpdir(), 'stride-template-'));
  await writeFile(path.join(repo, 'pnpm-workspace.yaml'), 'packages: []\n');
  await mkdir(path.join(repo, 'apps', 'old-game'), { recursive: true });
  await writeFile(path.join(repo, 'apps', 'old-game', 'vite.config.ts'), "export default strideApp(5210);\n");
  await mkdir(path.join(repo, 'packages', 'engine'), { recursive: true });
  await writeFile(path.join(repo, 'packages', 'engine', 'package.json'), JSON.stringify({ dependencies: { '@stride-ts/native': '^0.29.0' } }));
  await writeFile(path.join(repo, '.gitignore'), 'node_modules/\n/apps/*/public/content/\n/apps/*/src/assets.gen.ts\n');
});

afterAll(() => rm(repo, { recursive: true, force: true }));

describe('stride-editor new', () => {
  test('建出能跑的工程：端口接着已有的往后排，场景的每个实体都过字段检查，地面是 JSON 写的平面模型，内容在 .gitignore 里放行', async () => {
    const root = path.join(repo, 'apps', 'coin-run');
    const created = await createProject(root);
    expect(created.port).toBe(5212);
    expect(created.files).toContain('src/game/CoinRunGame.ts');
    expect(await readFile(path.join(root, 'vite.config.ts'), 'utf8')).toContain('strideApp(5212)');
    const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as { name: string; dependencies: Record<string, string> };
    expect(pkg.name).toBe('@stride-ts/coin-run');
    expect(pkg.dependencies['@stride-ts/native']).toBe('^0.29.0');

    const scene = JSON.parse(await readFile(path.join(root, 'public/content/MainScene.scene.json'), 'utf8')) as SceneFile;
    expect(scene.entities.map((e) => e.name)).toEqual(['Camera', 'Sun', 'Sky', 'Ground']);
    for (const entity of scene.entities) expect(checkEntity(entity), entity.name).toEqual([]);
    // 天空的太阳指向 Sun 实体
    expect(scene.entities[2]!.components.skyAtmosphere?.sun).toBe(scene.entities[1]!.id);
    const ground = await readFile(path.join(root, 'public/content/Models/Ground.model'));
    expect(readModelFile(ground.buffer.slice(ground.byteOffset, ground.byteOffset + ground.byteLength)).materials).toEqual(['Materials/Ground']);

    const ignore = await readFile(path.join(repo, '.gitignore'), 'utf8');
    expect(ignore).toContain('/apps/*/public/content/\n# 手搭的工程，内容要提交\n!/apps/coin-run/public/content/\n');
    // 再建一个：例外放在同一行注释下面，不再重复注释
    await createProject(path.join(repo, 'apps', 'coin-dash'));
    expect(await readFile(path.join(repo, '.gitignore'), 'utf8')).toContain('/apps/*/public/content/\n# 手搭的工程，内容要提交\n!/apps/coin-dash/public/content/\n!/apps/coin-run/public/content/\n');
  });

  test('目录已经有了、不在 apps 下面、名字不是小写加横线时拒绝', async () => {
    await expect(createProject(path.join(repo, 'apps', 'old-game'))).rejects.toThrow(/already exists/);
    await expect(createProject(path.join(repo, 'elsewhere'))).rejects.toThrow(/right under/);
    await expect(createProject(path.join(repo, 'apps', 'Bad_Name'))).rejects.toThrow(/lowercase letters/);
  });
});
