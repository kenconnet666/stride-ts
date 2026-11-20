// 从 Stride 仓库导入 CSharpIntermediate 教程：游戏设置、主场景和 Scenes 下各主题的场景（Start-、Completed- 等，共 25 个），
// 用到的 PrototypingBlocks、SamplesAssetPackage、mannequinModel 资源包和 Stride 自带的包（UI 库），写进 public/content（不提交）。
// Stride 仓库默认在 ~/IdeaProjects/stride，可以用 STRIDE_REPO 改。
//   pnpm --filter @stride-ts/csharp-intermediate import:stride
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stride = process.env.STRIDE_REPO ?? path.join(os.homedir(), 'IdeaProjects', 'stride');
const cli = path.resolve(app, '..', '..', 'packages', 'pipeline', 'src', 'cli.ts');
const tutorial = path.join(stride, 'samples', 'Tutorials', 'CSharpIntermediate', 'CSharpIntermediate', 'Assets');
const packs = path.join(stride, 'samples', 'Templates', 'Packs');
// Scenes/<主题>/<场景>.sdscene
const scenes = readdirSync(path.join(tutorial, 'Scenes'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .flatMap((topic) => readdirSync(path.join(tutorial, 'Scenes', topic.name)).filter((file) => file.endsWith('.sdscene')).map((file) => `${topic.name}/${file.slice(0, -'.sdscene'.length)}`));

/** 脚本里 Content.Load 的资源：UIByCode 的字体、AsyncCollisionTriggerDemo 的黄色材质。 */
const CODE_ASSETS = ['UI/OpenSans-font', 'Materials/Yellow'];

execFileSync(process.execPath, [
  cli, 'import-stride',
  '--package', `CSharpIntermediate=${tutorial}`,
  ...['PrototypingBlocks', 'SamplesAssetPackage', 'mannequinModel'].flatMap((pack) => ['--package', `${pack}=${path.join(packs, pack, 'Assets')}`]),
  '--stride', stride,
  '--asset', 'CSharpIntermediate/GameSettings',
  // 脚本用代码加载的资源（场景里没有引用）
  ...CODE_ASSETS.flatMap((asset) => ['--asset', `CSharpIntermediate/${asset}`]),
  '--scene', 'CSharpIntermediate/Scenes/IntermediateTutorials',
  ...scenes.flatMap((scene) => ['--scene', `CSharpIntermediate/Scenes/${scene}`]),
  '--out', path.join(app, 'public', 'content'),
  '--textures', 'source',
], { stdio: 'inherit' });
