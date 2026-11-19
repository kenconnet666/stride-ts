// 从 Stride 仓库导入 CustomEffect 样例：游戏设置（合成器的根是游戏的 CustomEffectRenderer，属性 Background、Logo 是贴图），写进 public/content（不提交）。
// Stride 仓库默认在 ~/IdeaProjects/stride（和 ~/WebstormProjects 并列），可以用 STRIDE_REPO 改。
//   pnpm --filter @stride-ts/custom-effect import:stride
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stride = process.env.STRIDE_REPO ?? path.resolve(app, '..', '..', '..', '..', 'IdeaProjects', 'stride');
const cli = path.resolve(app, '..', '..', 'packages', 'pipeline', 'src', 'cli.ts');

execFileSync(process.execPath, [
  cli, 'import-stride',
  '--package', `CustomEffect=${path.join(stride, 'samples', 'Graphics', 'CustomEffect', 'Assets')}`,
  '--asset', 'CustomEffect/Shared/GameSettings',
  '--out', path.join(app, 'public', 'content'),
], { stdio: 'inherit' });
