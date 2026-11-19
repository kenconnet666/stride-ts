// 从 Stride 仓库导入 CSharpBeginner 教程：游戏设置、主场景和 15 个教程场景（加上 Child entities 用的 subscene），用到的
// PrototypingBlocks、SamplesAssetPackage、mannequinModel 资源包和 Stride 自带的包（UI 库），写进 public/content（不提交）。
// Stride 仓库默认在 ~/IdeaProjects/stride（和 ~/WebstormProjects 并列），可以用 STRIDE_REPO 改。
//   pnpm --filter @stride-ts/csharp-beginner import:stride
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stride = process.env.STRIDE_REPO ?? path.resolve(app, '..', '..', '..', '..', 'IdeaProjects', 'stride');
const cli = path.resolve(app, '..', '..', 'packages', 'pipeline', 'src', 'cli.ts');
const tutorial = path.join(stride, 'samples', 'Tutorials', 'CSharpBeginner', 'CSharpBeginner', 'Assets');
const packs = path.join(stride, 'samples', 'Templates', 'Packs');
const basics = readdirSync(path.join(tutorial, 'Scenes', 'Basics')).filter((file) => file.endsWith('.sdscene')).map((file) => file.slice(0, -'.sdscene'.length));

execFileSync(process.execPath, [
  cli, 'import-stride',
  '--package', `CSharpBeginner=${tutorial}`,
  ...['PrototypingBlocks', 'SamplesAssetPackage', 'mannequinModel'].flatMap((pack) => ['--package', `${pack}=${path.join(packs, pack, 'Assets')}`]),
  '--stride', stride,
  '--asset', 'CSharpBeginner/GameSettings',
  '--scene', 'CSharpBeginner/Scenes/MainScene',
  ...basics.flatMap((scene) => ['--scene', `CSharpBeginner/Scenes/Basics/${scene}`]),
  '--out', path.join(app, 'public', 'content'),
  '--textures', 'source',
], { stdio: 'inherit' });
