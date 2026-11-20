// 从 Stride 仓库导入 JumpyJet 样例（Bepu 版，在 Stride 的 master 上）：游戏设置（合成器的根相机下面是游戏的 JumpyJetRenderer，
// 视差背景的精灵表随它的属性导入）、场景和它引用的预制体、精灵表、字体，写进 public/content（不提交）。
// Stride 仓库默认在 ~/IdeaProjects/stride，可以用 STRIDE_REPO 改。
//   pnpm --filter @stride-ts/jumpy-jet import:stride
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stride = process.env.STRIDE_REPO ?? path.join(os.homedir(), 'IdeaProjects', 'stride');
const cli = path.resolve(app, '..', '..', 'packages', 'pipeline', 'src', 'cli.ts');

execFileSync(process.execPath, [
  cli, 'import-stride',
  '--package', `JumpyJet=${path.join(stride, 'samples', 'Games', 'JumpyJet', 'Assets')}`,
  '--asset', 'JumpyJet/Shared/GameSettings',
  '--scene', 'JumpyJet/Shared/Scene',
  '--out', path.join(app, 'public', 'content'),
], { stdio: 'inherit' });
