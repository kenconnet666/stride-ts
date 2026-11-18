// 从 Stride 仓库导入 Third Person Platformer 的场景和它用到的资源包，写进 public/content（不提交）。
// Stride 仓库默认在 ~/IdeaProjects/stride（和 ~/WebstormProjects 并列），可以用 STRIDE_REPO 改。
//   pnpm --filter @stride-ts/platformer import:stride
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stride = process.env.STRIDE_REPO ?? path.resolve(app, '..', '..', '..', '..', 'IdeaProjects', 'stride');
const templates = path.join(stride, 'samples', 'Templates');
const cli = path.resolve(app, '..', '..', 'packages', 'pipeline', 'src', 'cli.ts');

execFileSync(process.execPath, [
  cli, 'import-stride',
  '--package', `ThirdPersonPlatformer=${path.join(templates, 'ThirdPersonPlatformer', 'ThirdPersonPlatformer', 'Assets')}`,
  '--package', `PrototypingBlocks=${path.join(templates, 'Packs', 'PrototypingBlocks', 'Assets')}`,
  '--package', `mannequinModel=${path.join(templates, 'Packs', 'mannequinModel', 'Assets')}`,
  '--scene', 'ThirdPersonPlatformer/MainScene',
  '--out', path.join(app, 'public', 'content'),
], { stdio: 'inherit' });
