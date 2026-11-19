// 从 Stride 仓库导入 GameMenu 样例的两个场景（启动页、主菜单）和 UI 资源，写进 public/content（不提交）。
// Stride 仓库默认在 ~/IdeaProjects/stride（和 ~/WebstormProjects 并列），可以用 STRIDE_REPO 改。
//   pnpm --filter @stride-ts/game-menu import:stride
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stride = process.env.STRIDE_REPO ?? path.resolve(app, '..', '..', '..', '..', 'IdeaProjects', 'stride');
const cli = path.resolve(app, '..', '..', 'packages', 'pipeline', 'src', 'cli.ts');

execFileSync(process.execPath, [
  cli, 'import-stride',
  '--package', `GameMenu=${path.join(stride, 'samples', 'UI', 'GameMenu', 'Assets')}`,
  '--scene', 'GameMenu/Shared/SplashScene',
  '--scene', 'GameMenu/Shared/MainScene',
  '--out', path.join(app, 'public', 'content'),
  '--textures', 'source',
], { stdio: 'inherit' });
