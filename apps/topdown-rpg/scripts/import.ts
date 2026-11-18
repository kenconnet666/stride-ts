// 从 Stride 仓库导入 TopDownRPG 模板的主场景、分块子场景和资源，写进 public/content（不提交）。
// Stride 仓库默认在 ~/IdeaProjects/stride（和 ~/WebstormProjects 并列），可以用 STRIDE_REPO 改。
//   pnpm --filter @stride-ts/topdown-rpg import:stride
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stride = process.env.STRIDE_REPO ?? path.resolve(app, '..', '..', '..', '..', 'IdeaProjects', 'stride');
const templates = path.join(stride, 'samples', 'Templates');
const cli = path.resolve(app, '..', '..', 'packages', 'pipeline', 'src', 'cli.ts');

execFileSync(process.execPath, [
  cli, 'import-stride',
  '--package', `TopDownRPG=${path.join(templates, 'TopDownRPG', 'TopDownRPG', 'Assets')}`,
  ...['PrototypingBlocks', 'mannequinModel', 'SamplesAssetPackage', 'VFXPackage'].flatMap((pack) => ['--package', `${pack}=${path.join(templates, 'Packs', pack, 'Assets')}`]),
  '--scene', 'TopDownRPG/MainScene',
  '--out', path.join(app, 'public', 'content'),
  '--textures', 'source',
], { stdio: 'inherit' });
