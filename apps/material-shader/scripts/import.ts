// 从 Stride 仓库导入 MaterialShader 样例：游戏设置和场景（程序化平面、水面材质、贴图、背景），写进 public/content（不提交）。
// Stride 仓库默认在 ~/IdeaProjects/stride（和 ~/WebstormProjects 并列），可以用 STRIDE_REPO 改。
//   pnpm --filter @stride-ts/material-shader import:stride
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stride = process.env.STRIDE_REPO ?? path.resolve(app, '..', '..', '..', '..', 'IdeaProjects', 'stride');
const cli = path.resolve(app, '..', '..', 'packages', 'pipeline', 'src', 'cli.ts');

execFileSync(process.execPath, [
  cli, 'import-stride',
  '--package', `MaterialShader=${path.join(stride, 'samples', 'Graphics', 'MaterialShader', 'Assets')}`,
  '--asset', 'MaterialShader/Shared/GameSettings',
  '--scene', 'MaterialShader/Shared/Scene',
  '--out', path.join(app, 'public', 'content'),
], { stdio: 'inherit' });
