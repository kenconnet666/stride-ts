// 从 Stride 仓库导入 MorphTargets 样例：游戏设置和主场景（甜甜圈、立方体、二十面球，glTF 和 FBX 的模型、形变动画），写进 public/content（不提交）。
// Stride 仓库默认在 ~/IdeaProjects/stride，可以用 STRIDE_REPO 改。
//   pnpm --filter @stride-ts/morph-targets import:stride
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stride = process.env.STRIDE_REPO ?? path.join(os.homedir(), 'IdeaProjects', 'stride');
const cli = path.resolve(app, '..', '..', 'packages', 'pipeline', 'src', 'cli.ts');

execFileSync(process.execPath, [
  cli, 'import-stride',
  '--package', `MorphTargets=${path.join(stride, 'samples', 'Graphics', 'MorphTargets', 'Assets')}`,
  '--asset', 'MorphTargets/Shared/GameSettings',
  '--scene', 'MorphTargets/Shared/MainScene',
  // 默认的启动画面、UI 的默认字体在 Stride 自带的包里
  '--stride', stride,
  '--out', path.join(app, 'public', 'content'),
], { stdio: 'inherit' });
