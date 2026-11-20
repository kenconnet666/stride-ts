// 从 Stride 仓库导入 AnimatedModel 样例的场景和资源，写进 public/content（不提交）。
// Stride 仓库默认在 ~/IdeaProjects/stride，可以用 STRIDE_REPO 改。
//   pnpm --filter @stride-ts/animated-model import:stride
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stride = process.env.STRIDE_REPO ?? path.join(os.homedir(), 'IdeaProjects', 'stride');
const cli = path.resolve(app, '..', '..', 'packages', 'pipeline', 'src', 'cli.ts');

execFileSync(process.execPath, [
  cli, 'import-stride',
  '--package', `AnimatedModel=${path.join(stride, 'samples', 'Graphics', 'AnimatedModel', 'Assets', 'Shared')}`,
  '--scene', 'AnimatedModel/Scene',
  '--out', path.join(app, 'public', 'content'),
  '--textures', 'source',
], { stdio: 'inherit' });
