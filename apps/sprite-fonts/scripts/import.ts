// 从 Stride 仓库导入 SpriteFonts 样例的游戏设置，写进 public/content（不提交）。样例没有场景：合成器的根是 FontRenderer，
// 它属性里的十个字体和背景图随游戏设置导入。
// Stride 仓库默认在 ~/IdeaProjects/stride，可以用 STRIDE_REPO 改。
//   pnpm --filter @stride-ts/sprite-fonts import:stride
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stride = process.env.STRIDE_REPO ?? path.join(os.homedir(), 'IdeaProjects', 'stride');
const cli = path.resolve(app, '..', '..', 'packages', 'pipeline', 'src', 'cli.ts');

execFileSync(process.execPath, [
  cli, 'import-stride',
  '--package', `SpriteFonts=${path.join(stride, 'samples', 'Graphics', 'SpriteFonts', 'Assets')}`,
  '--asset', 'SpriteFonts/Shared/GameSettings',
  '--out', path.join(app, 'public', 'content'),
  '--textures', 'source',
], { stdio: 'inherit' });
